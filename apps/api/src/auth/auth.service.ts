import { createHash } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { RateLimiter, tooMany } from '../common/rate-limiter';
import { PrismaService } from '../prisma/prisma.service';
import { TenantAccessPolicy } from '../tenancy/tenant-access.policy';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { MfaService } from './mfa.service';
import { type ClientInfo, RefreshTokensService } from './refresh-tokens.service';
import { SecurityConfig } from './security-config';

const GENERIC_INVALID = 'Credenciais inválidas';
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const ACCESS_SECONDS = 900;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginOutcome =
  | { kind: 'session'; tokens: SessionTokens }
  | { kind: 'mfa_required'; mfaToken: string }
  | { kind: 'mfa_enrollment_required'; enrollToken: string };

type Scope = 'mfa' | 'mfa-enroll';

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly mfa: MfaService,
    private readonly config: SecurityConfig,
    private readonly limiter: RateLimiter,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });
  }

  private tenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('Contexto de tenant ausente');
    return id;
  }

  private signAccess(user: { id: string; role: string }, familyId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, tenantId: this.tenantId(), role: user.role, sid: familyId },
      { expiresIn: ACCESS_SECONDS },
    );
  }

  signScoped(userId: string, scope: Scope, ttl: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId, tenantId: this.tenantId(), scope }, { expiresIn: ttl });
  }

  /** Valida um token de escopo restrito (etapa de MFA ou cadastro de MFA) do tenant corrente. */
  async verifyScoped(token: string | undefined, scope: Scope): Promise<string> {
    try {
      const c = await this.jwt.verifyAsync<{ sub: string; tenantId: string; scope?: string }>(token ?? '');
      if (c.scope !== scope || c.tenantId !== this.tenantId()) throw new Error();
      return c.sub;
    } catch {
      throw new UnauthorizedException();
    }
  }

  private lockKey(email: string): string {
    return `login:${this.tenantId()}:${createHash('sha256').update(email).digest('hex').slice(0, 16)}`;
  }

  /**
   * Contabiliza falha: 5 seguidas travam por 15 min. A contagem vale também para e-mails
   * inexistentes (chave em memória) e a resposta de bloqueio é uniforme — não revela se a conta existe.
   */
  private async recordFailure(email: string, userId: string | null, reason: string, client: ClientInfo): Promise<void> {
    const key = this.lockKey(email);
    if (this.limiter.hit(key, LOCK_MS) >= MAX_FAILURES) this.limiter.block(key, LOCK_MS);
    await this.prisma.withTenant(this.tenantId(), async (tx) => {
      if (userId) {
        const u = await tx.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } });
        if (u.failedLoginCount >= MAX_FAILURES) {
          await tx.user.update({
            where: { id: userId },
            data: { lockedUntil: new Date(Date.now() + LOCK_MS), failedLoginCount: 0 },
          });
        }
      }
      await this.audit.record(tx, {
        action: 'LOGIN_FAILED',
        resource: 'user',
        resourceId: userId ?? undefined,
        details: { reason },
        userId: userId ?? undefined,
        ...client,
      });
    });
  }

  /** Login da equipe/REPORTER. Pode exigir 2º fator ou cadastro dele antes de abrir a sessão. */
  async login(email: string, password: string, client: ClientInfo): Promise<LoginOutcome> {
    const tenantId = this.tenantId();
    const tenant = await this.prisma.base.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!TenantAccessPolicy.canStaffLogin(tenant)) {
      throw new ForbiddenException('Acesso indisponível. Contate o administrador da plataforma.');
    }
    const emailN = email.toLowerCase();
    if (this.limiter.isBlocked(this.lockKey(emailN))) throw tooMany();

    const user = await this.prisma.withTenant(tenantId, (tx) => tx.user.findFirst({ where: { email: emailN } }));
    const ok = await argon2.verify(user?.passwordHash ?? this.dummyHash, password);
    if (user?.lockedUntil && user.lockedUntil > new Date()) throw tooMany();
    if (!user || !ok) {
      await this.recordFailure(emailN, user?.id ?? null, user ? 'bad_password' : 'unknown_user', client);
      throw new UnauthorizedException(GENERIC_INVALID);
    }
    if (!user.isActive) throw new ForbiddenException('Contate o administrador');
    // Mensagem genérica: o motivo da suspensão nunca é revelado ao suspenso.
    if (user.isBlocked) throw new ForbiddenException('Acesso suspenso. Contate o RH/administrador');

    if (user.mfaEnabled) return { kind: 'mfa_required', mfaToken: await this.signScoped(user.id, 'mfa', '5m') };
    if (this.config.requiresMfa(user.role)) {
      return { kind: 'mfa_enrollment_required', enrollToken: await this.signScoped(user.id, 'mfa-enroll', '15m') };
    }
    return { kind: 'session', tokens: await this.startSession(user.id, client) };
  }

  /** 2ª etapa do login: TOTP ou código de recuperação. Falhas contam para o mesmo bloqueio. */
  async verifyMfa(mfaToken: string, input: { code?: string; recoveryCode?: string }, client: ClientInfo): Promise<SessionTokens> {
    const userId = await this.verifyScoped(mfaToken, 'mfa');
    const user = await this.prisma.withTenant(this.tenantId(), (tx) => tx.user.findUnique({ where: { id: userId } }));
    if (!user || !user.isActive || user.isBlocked || !user.mfaEnabled) throw new UnauthorizedException();
    if (this.limiter.isBlocked(this.lockKey(user.email)) || (user.lockedUntil && user.lockedUntil > new Date())) {
      throw tooMany();
    }
    const valid = await this.prisma.withTenant(this.tenantId(), (tx) => this.mfa.verify(tx, user, input));
    if (!valid) {
      await this.recordFailure(user.email, user.id, 'mfa_failed', client);
      throw new UnauthorizedException('Código inválido');
    }
    return this.startSession(user.id, client);
  }

  /** Abre a sessão: zera contadores, audita LOGIN e emite access (15 min) + refresh rotativo (7 dias). */
  async startSession(userId: string, client: ClientInfo): Promise<SessionTokens> {
    const tenantId = this.tenantId();
    const user = await this.prisma.withTenant(tenantId, async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      });
      await this.audit.record(tx, { action: 'LOGIN', resource: 'user', resourceId: u.id, userId: u.id, ...client });
      return u;
    });
    this.limiter.reset(this.lockKey(user.email));
    const { token, row } = await this.refreshTokens.create(tenantId, user.id, client);
    return { accessToken: await this.signAccess(user, row.familyId), refreshToken: token, expiresIn: ACCESS_SECONDS };
  }

  /** Rotação do refresh. Reuso de token já rotacionado derruba todas as sessões do usuário. */
  async refresh(refreshToken: string, client: ClientInfo): Promise<SessionTokens> {
    const tenantId = this.tenantId();
    const rotated = await this.refreshTokens.rotate(tenantId, refreshToken, client);
    if (!rotated) throw new UnauthorizedException();
    if (rotated.reuse) {
      await this.prisma.withTenant(tenantId, (tx) =>
        this.audit.record(tx, {
          action: 'LOGIN_FAILED',
          resource: 'user',
          resourceId: rotated.userId,
          details: { reason: 'refresh_reuse', revokedAllSessions: true },
          userId: rotated.userId,
          ...client,
        }),
      );
      throw new UnauthorizedException();
    }
    const [user, tenant] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) => tx.user.findUnique({ where: { id: rotated.userId } })),
      this.prisma.base.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ]);
    if (!user || !user.isActive || user.isBlocked || !TenantAccessPolicy.canStaffLogin(tenant)) {
      await this.prisma.withTenant(tenantId, (tx) => this.refreshTokens.revokeAll(tx, rotated.userId));
      throw new UnauthorizedException();
    }
    return {
      accessToken: await this.signAccess(user, rotated.familyId),
      refreshToken: rotated.token,
      expiresIn: ACCESS_SECONDS,
    };
  }

  async logout(userId: string, sessionId: string | undefined, client: ClientInfo): Promise<void> {
    await this.prisma.run(async (tx) => {
      if (sessionId) await this.refreshTokens.revokeSession(tx, userId, sessionId);
      await this.audit.record(tx, { action: 'LOGOUT', resource: 'user', resourceId: userId, userId, ...client });
    });
  }

  async logoutAll(userId: string, client: ClientInfo): Promise<{ revoked: number }> {
    return this.prisma.run(async (tx) => {
      const revoked = await this.refreshTokens.revokeAll(tx, userId);
      await this.audit.record(tx, {
        action: 'LOGOUT',
        resource: 'user',
        resourceId: userId,
        details: { all: true },
        userId,
        ...client,
      });
      return { revoked };
    });
  }

  listSessions(userId: string) {
    return this.prisma.run((tx) => this.refreshTokens.listActive(tx, userId));
  }

  async revokeSession(userId: string, sessionId: string, client: ClientInfo) {
    return this.prisma.run(async (tx) => {
      const n = await this.refreshTokens.revokeSession(tx, userId, sessionId);
      if (n === 0) throw new UnauthorizedException('Sessão não encontrada');
      await this.audit.record(tx, {
        action: 'LOGOUT',
        resource: 'user',
        resourceId: userId,
        details: { revokedSession: sessionId },
        userId,
        ...client,
      });
      return { revoked: true };
    });
  }

  /** Cadastro público: sempre REPORTER; e-mail único por tenant; já retorna a sessão. */
  async register(
    input: { email: string; fullName: string; passwordHash: string },
    client: ClientInfo,
  ): Promise<SessionTokens> {
    const tenantId = this.tenantId();
    const email = input.email.toLowerCase();
    const user = await this.prisma.withTenant(tenantId, async (tx) => {
      if (await tx.user.findFirst({ where: { email } })) throw new ConflictException('Email já cadastrado');
      const created = await tx.user.create({
        data: { tenantId, email, fullName: input.fullName, passwordHash: input.passwordHash, role: 'REPORTER' },
      });
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'user',
        resourceId: created.id,
        userId: created.id,
        ...client,
      });
      return created;
    });
    return this.startSession(user.id, client);
  }
}
