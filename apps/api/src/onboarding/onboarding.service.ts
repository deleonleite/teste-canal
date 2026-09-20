import { randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { passwordSchema } from '@ouvion/contracts';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { RateLimiter, tooMany } from '../common/rate-limiter';
import { FieldCipher } from '../crypto/field-cipher';
import { SecurityConfig } from '../auth/security-config';
import { sha256 } from '../external/external-access.service';
import { Mailer, OutboxMailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';

const TOKEN_VALIDITY_MS = 7 * 86400_000;
const INVALID = 'Link ou código inválido';

authenticator.options = { window: 1 };

interface Client {
  userId?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Onboarding do destinatário alternativo (doc §3): e-mail confirmado por link + segundo fator (TOTP)
 * enrolado ANTES de existir necessidade — sem isso o cenário anti-paralisia travaria quando acionado.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly mailer: Mailer,
    private readonly config: SecurityConfig,
    private readonly limiter: RateLimiter,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private tenantId(): string {
    return this.cls.get('tenantId')!;
  }

  /** ADMIN define/troca o destinatário: zera verificação e TOTP e envia novo link de confirmação. */
  async setRecipient(email: string, client: Client) {
    const token = randomBytes(32).toString('base64url');
    const tenantId = this.tenantId();
    const slug = await this.prisma.withTenant(tenantId, async (tx) => {
      const t = await tx.tenant.update({
        where: { id: tenantId },
        data: {
          escalationRecipientEmail: email.toLowerCase(),
          escalationVerifiedAt: null,
          escalationTotpSecretEnc: null,
          escalationTotpEnrolledAt: null,
          escalationTokenHash: sha256(token),
          escalationTokenExpiresAt: new Date(Date.now() + TOKEN_VALIDITY_MS),
        },
      });
      await this.audit.record(tx, {
        action: 'UPDATE',
        resource: 'tenant',
        resourceId: tenantId,
        details: { changed: 'escalationRecipient' },
        ...client,
      });
      return t.slug;
    });
    const base = process.env.PUBLIC_WEB_URL ?? 'https://app.ouvion.local';
    const link = `${base}/${slug}/destinatario?token=${token}`;
    await this.mailer.send({
      to: email.toLowerCase(),
      subject: 'Confirme seu papel de destinatário alternativo — OuviON',
      text: `Confirme e configure seu segundo fator: ${link}`,
    });
    // Só dev/teste (e-mail em memória): devolve o link para quem está testando. Em produção nunca sai daqui.
    return { configured: true, verified: false, ...(this.mailer instanceof OutboxMailer && process.env.NODE_ENV !== 'production' ? { devConfirmUrl: link } : {}) };
  }

  private async byToken<T>(token: string, fn: (tx: Parameters<Parameters<PrismaService['withTenant']>[1]>[0], t: { id: string; escalationRecipientEmail: string | null; escalationTotpSecretEnc: string | null }) => Promise<T>): Promise<T> {
    const tenantId = this.tenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const t = await tx.tenant.findFirst({
        where: { id: tenantId, escalationTokenHash: sha256(token), escalationTokenExpiresAt: { gt: new Date() } },
      });
      if (!t) throw new UnauthorizedException(INVALID);
      return fn(tx, t);
    });
  }

  /** Passo 1 (link do e-mail): confirma o e-mail e devolve o segredo TOTP para o app autenticador. */
  async confirm(token: string) {
    return this.byToken(token, async (tx, t) => {
      const secret = t.escalationTotpSecretEnc
        ? await this.cipher.decrypt(t.id, t.escalationTotpSecretEnc)
        : authenticator.generateSecret();
      await tx.tenant.update({
        where: { id: t.id },
        data: { escalationVerifiedAt: new Date(), escalationTotpSecretEnc: await this.cipher.encrypt(t.id, secret) },
      });
      return { otpauthUri: authenticator.keyuri(t.escalationRecipientEmail!, 'OuviON', secret) };
    });
  }

  /** Passo 2: prova de posse do segundo fator; só então o destinatário fica apto. */
  async enroll(token: string, code: string) {
    return this.byToken(token, async (tx, t) => {
      if (!t.escalationTotpSecretEnc) throw new BadRequestException('Confirme o e-mail antes de enrolar o segundo fator');
      const ok = authenticator.check(code, await this.cipher.decrypt(t.id, t.escalationTotpSecretEnc));
      if (!ok) throw new UnauthorizedException(INVALID);
      await tx.tenant.update({
        where: { id: t.id },
        data: { escalationTotpEnrolledAt: new Date(), escalationTokenHash: null, escalationTokenExpiresAt: null },
      });
      await this.audit.record(tx, {
        action: 'MFA_ENROLL',
        resource: 'tenant',
        resourceId: t.id,
        details: { subject: 'escalationRecipient' },
      });
      return { ready: true };
    });
  }

  /** Requisitos pendentes para o tenant sair de TRIAL (cada um vale a partir da fase que o entrega). */
  async missingActivationRequirements(): Promise<string[]> {
    const t = await this.prisma.run((tx) => tx.tenant.findUniqueOrThrow({ where: { id: this.tenantId() } }));
    const missing: string[] = [];
    if (!t.escalationRecipientEmail) missing.push('escalationRecipient.configured');
    else if (!t.escalationVerifiedAt) missing.push('escalationRecipient.emailVerified');
    else if (!t.escalationTotpEnrolledAt) missing.push('escalationRecipient.secondFactor');
    // ADMIN com MFA ativo (só onde o MFA é obrigatório; staging/dev podem desligar).
    if (this.config.enforceMfa) {
      const admins = await this.prisma.run((tx) => tx.user.count({ where: { role: 'ADMIN', isActive: true, mfaEnabled: true } }));
      if (admins === 0) missing.push('admin.mfa');
    }
    // O DPO é exigido na ativação (ver `activation`), não aqui: este método é o requisito do destinatário/MFA.
    return missing;
  }

  async status() {
    const missing = await this.missingActivationRequirements();
    return { ready: missing.length === 0, missing };
  }

  // ── Convite do primeiro ADMIN (enviado pela plataforma) ────────────────────────────────────────
  /**
   * A pessoa abre o link e define a PRÓPRIA senha: a plataforma nunca a conhece. Uso único, 72 h; um reenvio
   * invalida os anteriores. Qualquer falha devolve a mesma mensagem (não revela se o link existiu, venceu ou já foi usado).
   */
  async acceptInvite(token: string, password: string, ip?: string) {
    if (this.limiter.hit(`invite:${ip ?? 'x'}`, 60_000) > 10) throw tooMany();
    const parsed = passwordSchema.safeParse(password);
    const tenantId = this.tenantId();
    const invalid = new BadRequestException('Convite inválido ou vencido. Peça um novo convite à equipe OuviON.');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const invite = await tx.tenantInvite.findFirst({ where: { tokenHash: sha256(token), usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (!invite) throw invalid;
      // Só depois de o convite ser válido a política de senha responde (assim o link inválido não vira oráculo).
      if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Senha fraca');
      const admin = await tx.user.findFirst({ where: { email: invite.email, role: 'ADMIN' } });
      if (!admin) throw invalid;
      await tx.user.update({
        where: { id: admin.id },
        data: { passwordHash: await argon2.hash(password, { type: argon2.argon2id }), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
      });
      await tx.tenantInvite.update({ where: { id: invite.id }, data: { usedAt: new Date() } });
      await this.audit.record(tx, { action: 'UPDATE', resource: 'admin_invite', resourceId: invite.id, userId: admin.id, details: { accepted: true }, ip });
      return { email: invite.email };
    });
  }

  // ── Ativação: sai de TRIAL só com os requisitos cumpridos ───────────────────────────────────────
  async setDpo(name: string, email: string, client: Client) {
    const tenantId = this.tenantId();
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { dpoName: name.trim(), dpoEmail: email.toLowerCase() } });
      await this.audit.record(tx, { action: 'UPDATE', resource: 'tenant', resourceId: tenantId, details: { changed: 'dpo' }, ...client });
    });
    return { dpoInformed: true };
  }

  /** Checklist completo de ativação (destinatário alternativo, MFA do ADMIN e DPO) + situação atual da empresa. */
  async activation() {
    const missing = await this.missingActivationRequirements();
    const t = await this.prisma.run((tx) => tx.tenant.findUniqueOrThrow({ where: { id: this.tenantId() } }));
    if (!t.dpoName || !t.dpoEmail) missing.push('dpo.informed');
    return {
      tenantStatus: t.status,
      ready: missing.length === 0,
      missing,
      escalationRecipientEmail: t.escalationRecipientEmail,
      dpo: t.dpoName && t.dpoEmail ? { name: t.dpoName, email: t.dpoEmail } : null,
    };
  }

  async activate(client: Client) {
    const a = await this.activation();
    if (a.tenantStatus !== 'TRIAL') throw new ConflictException('A empresa não está em período de teste');
    if (!a.ready) throw new BadRequestException({ message: 'Ainda há pendências para ativar a empresa', missing: a.missing });
    const tenantId = this.tenantId();
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
      await this.audit.record(tx, { action: 'UPDATE', resource: 'tenant', resourceId: tenantId, details: { activated: true }, ...client });
    });
    return { status: 'ACTIVE' as const };
  }
}
