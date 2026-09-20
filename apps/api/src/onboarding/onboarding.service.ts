import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { authenticator } from 'otplib';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { FieldCipher } from '../crypto/field-cipher';
import { SecurityConfig } from '../auth/security-config';
import { sha256 } from '../external/external-access.service';
import { Mailer } from '../mail/mailer';
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
    await this.mailer.send({
      to: email.toLowerCase(),
      subject: 'Confirme seu papel de destinatário alternativo — OuviON',
      text: `Confirme e configure seu segundo fator: ${base}/onboarding/escalation?tenant=${slug}&token=${token}`,
    });
    return { configured: true, verified: false };
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
    // Fase futura: DPO informado (fase 8).
    return missing;
  }

  async status() {
    const missing = await this.missingActivationRequirements();
    return { ready: missing.length === 0, missing };
  }
}
