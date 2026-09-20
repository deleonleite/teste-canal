import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { passwordSchema } from '@ouvion/contracts';
import type { PlatformRole, PlatformUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';

import type { ClientInfo } from '../auth/refresh-tokens.service';
import { Kek } from '../crypto/field-cipher';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformPrismaService } from './platform-prisma.service';

authenticator.options = { window: 1 };

const ACCESS_SECONDS = 15 * 60;
const REFRESH_DAYS = 7;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const RECOVERY_CODES = 10;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Mensagem única para qualquer falha de entrada: não revela se o e-mail existe nem qual dado errou. */
export const RESTRICTED = 'Acesso restrito à equipe OuviON. Confira e-mail e senha.';

const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
const normalizeRecovery = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
function recoveryCode(): string {
  const chars = Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export interface PlatformSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
export type PlatformLoginResult =
  | { kind: 'session'; tokens: PlatformSession }
  | { kind: 'password_change_required'; token: string }
  | { kind: 'mfa_required'; mfaToken: string }
  | { kind: 'mfa_enrollment_required'; enrollToken: string };

type Scope = 'platform-access' | 'platform-mfa' | 'platform-mfa-enroll' | 'platform-pwd';

/**
 * Autenticação do painel da plataforma. Espaço 100% separado do login de tenant: tabela própria, segredo de
 * JWT próprio (token de tenant não vale aqui e vice-versa) e segundo fator SEMPRE obrigatório — não há
 * configuração que o desligue (tarefas.md §1).
 */
@Injectable()
export class PlatformAuthService {
  private readonly jwt: JwtService;

  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly audit: PlatformAuditService,
    private readonly kek: Kek,
  ) {
    const secret = process.env.PLATFORM_JWT_SECRET ?? (process.env.JWT_ACCESS_SECRET ? `${process.env.JWT_ACCESS_SECRET}:platform` : undefined);
    if (!secret || (process.env.NODE_ENV === 'production' && !process.env.PLATFORM_JWT_SECRET)) {
      throw new Error('PLATFORM_JWT_SECRET é obrigatório');
    }
    this.jwt = new JwtService({ secret });
  }

  private sign(sub: string, scope: Scope, ttl: number, extra: Record<string, unknown> = {}): Promise<string> {
    return this.jwt.signAsync({ sub, scope, aud: 'platform', ...extra }, { expiresIn: ttl });
  }

  /** Valida um token de escopo específico e devolve o id do usuário. */
  async verifyScoped(token: string, scope: Scope): Promise<string> {
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; scope: Scope; aud: string }>(token, { audience: 'platform' });
      if (p.scope !== scope) throw new Error('escopo');
      return p.sub;
    } catch {
      throw new UnauthorizedException();
    }
  }

  // ── Entrada ────────────────────────────────────────────────────────────────────────────────
  async login(email: string, password: string, client: ClientInfo): Promise<PlatformLoginResult> {
    const user = await this.prisma.db.platformUser.findUnique({ where: { email: email.toLowerCase() } });
    const fail = async (why: string): Promise<never> => {
      await this.audit.record({ action: 'LOGIN_FAILED', severity: 'MEDIUM', resource: 'platform_session', actorId: user?.id ?? null, details: { why }, ip: client.ip, userAgent: client.userAgent });
      throw new UnauthorizedException(RESTRICTED);
    };
    if (!user || !user.isActive) return fail(user ? 'inativo' : 'desconhecido');
    if (user.lockedUntil && user.lockedUntil > new Date()) return fail('bloqueado');
    if (!(await argon2.verify(user.passwordHash, password).catch(() => false))) {
      const failures = user.failedLoginCount + 1;
      await this.prisma.db.platformUser.update({
        where: { id: user.id },
        data: failures >= MAX_FAILURES ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLoginCount: failures },
      });
      return fail('senha');
    }
    await this.prisma.db.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    if (user.mustChangePassword) return { kind: 'password_change_required', token: await this.sign(user.id, 'platform-pwd', 600) };
    return this.nextStep(user);
  }

  private async nextStep(user: PlatformUser): Promise<PlatformLoginResult> {
    if (!user.mfaEnabled) return { kind: 'mfa_enrollment_required', enrollToken: await this.sign(user.id, 'platform-mfa-enroll', 600) };
    return { kind: 'mfa_required', mfaToken: await this.sign(user.id, 'platform-mfa', 300) };
  }

  /** Troca da senha temporária (obrigatória antes de qualquer sessão); em seguida segue para o 2º fator. */
  async changePassword(token: string, newPassword: string): Promise<PlatformLoginResult> {
    const userId = await this.verifyScoped(token, 'platform-pwd');
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Senha fraca');
    const user = await this.prisma.db.platformUser.findUniqueOrThrow({ where: { id: userId } });
    if (await argon2.verify(user.passwordHash, newPassword).catch(() => false)) throw new BadRequestException('Escolha uma senha diferente da temporária');
    const updated = await this.prisma.db.platformUser.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(newPassword, { type: argon2.argon2id }), mustChangePassword: false },
    });
    return this.nextStep(updated);
  }

  // ── Segundo fator ──────────────────────────────────────────────────────────────────────────
  async verifyMfa(mfaToken: string, input: { code?: string; recoveryCode?: string }, client: ClientInfo): Promise<PlatformSession> {
    const userId = await this.verifyScoped(mfaToken, 'platform-mfa');
    const user = await this.prisma.db.platformUser.findUniqueOrThrow({ where: { id: userId } });
    if (!user.isActive || !user.mfaEnabled || !user.mfaSecretEnc) throw new UnauthorizedException();
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException(RESTRICTED);

    let ok = false;
    if (input.code) {
      const secret = this.kek.unwrap(user.mfaSecretEnc, `platform-mfa:${user.id}`).toString('utf8');
      const step = this.stepOf(input.code, secret, user.mfaLastStep);
      if (step !== null) {
        // O passo só avança: o mesmo código não vale duas vezes.
        const r = await this.prisma.db.platformUser.updateMany({ where: { id: user.id, mfaLastStep: { lt: step } }, data: { mfaLastStep: step } });
        ok = r.count === 1;
      }
    } else if (input.recoveryCode) {
      const wanted = normalizeRecovery(input.recoveryCode);
      for (const hash of user.mfaRecoveryCodes) {
        if (await argon2.verify(hash, wanted).catch(() => false)) {
          const r = await this.prisma.db.platformUser.updateMany({ where: { id: user.id, mfaRecoveryCodes: { has: hash } }, data: { mfaRecoveryCodes: user.mfaRecoveryCodes.filter((h) => h !== hash) } });
          ok = r.count === 1;
          break;
        }
      }
    }
    if (!ok) {
      const failures = user.failedLoginCount + 1;
      await this.prisma.db.platformUser.update({
        where: { id: user.id },
        data: failures >= MAX_FAILURES ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLoginCount: failures },
      });
      await this.audit.record({ action: 'LOGIN_FAILED', severity: 'HIGH', resource: 'platform_session', actorId: user.id, details: { why: 'mfa' }, ip: client.ip, userAgent: client.userAgent });
      throw new UnauthorizedException('Código inválido');
    }
    return this.startSession(user.id, client);
  }

  /** Passo do TOTP aceito, ou null. Rejeita códigos já usados (passo <= último aceito). */
  private stepOf(code: string, secret: string, lastStep: number): number | null {
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return null;
    const step = Math.floor(Date.now() / 30_000) + delta;
    return step > lastStep ? step : null;
  }

  /**
   * Prova de 2º fator RECENTE para ações críticas (aprovar quebra de vidro): o código tem de ser digitado agora e
   * não pode ser reaproveitado (o passo avança), então não dá para usar o mesmo código do login.
   */
  async assertFreshMfa(userId: string, code: string): Promise<void> {
    const user = await this.prisma.db.platformUser.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw new BadRequestException('Código inválido');
    const secret = this.kek.unwrap(user.mfaSecretEnc, `platform-mfa:${user.id}`).toString('utf8');
    const step = this.stepOf(code, secret, user.mfaLastStep);
    const ok = step !== null && (await this.prisma.db.platformUser.updateMany({ where: { id: user.id, mfaLastStep: { lt: step } }, data: { mfaLastStep: step } })).count === 1;
    if (!ok) {
      // 400 (e não 401): é um dado inválido, não uma sessão vencida — a tela não pode deslogar por causa disso.
      await this.audit.record({ action: 'LOGIN_FAILED', severity: 'HIGH', resource: 'break_glass_step_up', actorId: userId, details: { why: 'mfa_step_up' } });
      throw new BadRequestException('Código inválido ou já utilizado');
    }
  }

  async enroll(enrollToken: string) {
    const userId = await this.verifyScoped(enrollToken, 'platform-mfa-enroll');
    const user = await this.prisma.db.platformUser.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw new ConflictException('MFA já está ativo');
    const secret = authenticator.generateSecret();
    await this.prisma.db.platformUser.update({ where: { id: userId }, data: { mfaSecretEnc: this.kek.wrap(Buffer.from(secret, 'utf8'), `platform-mfa:${userId}`) } });
    return { otpauthUri: authenticator.keyuri(user.email, 'OuviON Plataforma', secret) };
  }

  async activate(enrollToken: string, code: string, client: ClientInfo) {
    const userId = await this.verifyScoped(enrollToken, 'platform-mfa-enroll');
    const user = await this.prisma.db.platformUser.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw new ConflictException('MFA já está ativo');
    if (!user.mfaSecretEnc) throw new BadRequestException('Inicie o cadastro do segundo fator antes');
    const secret = this.kek.unwrap(user.mfaSecretEnc, `platform-mfa:${userId}`).toString('utf8');
    const step = this.stepOf(code, secret, user.mfaLastStep);
    if (step === null) throw new UnauthorizedException('Código inválido');
    const plain = Array.from({ length: RECOVERY_CODES }, recoveryCode);
    const hashes = await Promise.all(plain.map((c) => argon2.hash(normalizeRecovery(c), { type: argon2.argon2id })));
    await this.prisma.db.platformUser.update({ where: { id: userId }, data: { mfaEnabled: true, mfaRecoveryCodes: hashes, mfaLastStep: step } });
    return { recoveryCodes: plain, session: await this.startSession(userId, client) };
  }

  // ── Sessão: access curto + refresh rotativo ────────────────────────────────────────────────
  private async issue(user: Pick<PlatformUser, 'id' | 'role'>, familyId: string, client: ClientInfo): Promise<PlatformSession> {
    const refresh = randomBytes(32).toString('base64url');
    await this.prisma.db.platformRefreshToken.create({
      data: { userId: user.id, familyId, tokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000), ipAddress: client.ip ?? null, userAgent: client.userAgent ?? null },
    });
    return { accessToken: await this.sign(user.id, 'platform-access', ACCESS_SECONDS, { role: user.role, sid: familyId }), refreshToken: refresh, expiresIn: ACCESS_SECONDS };
  }

  async startSession(userId: string, client: ClientInfo): Promise<PlatformSession> {
    const user = await this.prisma.db.platformUser.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ action: 'LOGIN', resource: 'platform_session', actorId: userId, ip: client.ip, userAgent: client.userAgent });
    return this.issue(user, randomUUID(), client);
  }

  async refresh(token: string, client: ClientInfo): Promise<PlatformSession> {
    const current = await this.prisma.db.platformRefreshToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!current) throw new UnauthorizedException();
    if (current.revokedAt) {
      // Reuso de token já rotacionado: indício de roubo → derruba todas as sessões da pessoa.
      if (current.replacedById) await this.prisma.db.platformRefreshToken.updateMany({ where: { userId: current.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException();
    }
    if (current.expiresAt <= new Date() || !current.user.isActive) throw new UnauthorizedException();
    const next = await this.issue(current.user, current.familyId, client);
    const nextRow = await this.prisma.db.platformRefreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(next.refreshToken) } });
    await this.prisma.db.platformRefreshToken.update({ where: { id: current.id }, data: { revokedAt: new Date(), replacedById: nextRow.id } });
    return next;
  }

  async logout(userId: string, sessionId: string, client: ClientInfo): Promise<void> {
    await this.prisma.db.platformRefreshToken.updateMany({ where: { userId, familyId: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ action: 'LOGOUT', resource: 'platform_session', actorId: userId, ip: client.ip, userAgent: client.userAgent });
  }

  async revokeAll(userId: string): Promise<void> {
    await this.prisma.db.platformRefreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Valida o access token E se a sessão e o usuário continuam ativos (a cada chamada). */
  async resolve(token: string): Promise<{ userId: string; role: PlatformRole; sessionId: string }> {
    let p: { sub: string; scope: Scope; role: PlatformRole; sid: string };
    try {
      p = await this.jwt.verifyAsync(token, { audience: 'platform' });
    } catch {
      throw new UnauthorizedException();
    }
    if (p.scope !== 'platform-access') throw new UnauthorizedException();
    const [user, live] = await Promise.all([
      this.prisma.db.platformUser.findUnique({ where: { id: p.sub }, select: { isActive: true, role: true } }),
      this.prisma.db.platformRefreshToken.count({ where: { userId: p.sub, familyId: p.sid, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    if (!user?.isActive || live === 0) throw new UnauthorizedException();
    // O papel vale o do banco no momento, não o do token (mudança de perfil tem efeito imediato).
    return { userId: p.sub, role: user.role, sessionId: p.sid };
  }
}
