import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { authenticator } from 'otplib';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { truncateToMinute } from '../common/client-info';
import { FieldCipher } from '../crypto/field-cipher';
import { Mailer } from '../mail/mailer';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';

const ACCESS_VALIDITY_MS = 72 * 3600_000; // validade do acesso (prorrogação = novo acionamento)
const SESSION_MINUTES = '60m'; // sessão curta, sem refresh
const MAX_FAILED_ATTEMPTS = 5;
const GENERIC = 'Link ou código inválido';

authenticator.options = { window: 1 };

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

interface Client {
  ip?: string;
  userAgent?: string;
}

export interface ExternalSession {
  accessId: string;
  complaintId: string;
}

/**
 * Acesso pontual do destinatário alternativo (doc §5.2.9): sem conta, sem contar em maxUsers,
 * link mágico de uso único + TOTP enrolado no onboarding, sessão de 60 min, escopo de UM caso.
 */
@Injectable()
export class ExternalAccessService {
  private readonly log = new Logger(ExternalAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly mailer: Mailer,
    private readonly jwt: JwtService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Aciona o acesso para um caso. `SYSTEM` (anti-paralisia) não duplica um acesso ainda vigente;
   * o acionamento por ADMIN sempre gera um novo (é a forma de prorrogar).
   */
  async trigger(complaintId: string, triggeredBy: 'SYSTEM' | string, reason: string, client: Client = {}) {
    const token = randomBytes(32).toString('base64url');
    const prepared = await this.prisma.run(async (tx) => {
      const complaint = await tx.complaint.findUniqueOrThrow({
        where: { id: complaintId },
        select: { id: true, tenantId: true, protocol: true, isAnonymous: true },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: complaint.tenantId } });
      const anon = complaint.isAnonymous && triggeredBy === 'SYSTEM';

      if (!tenant.escalationRecipientEmail || !tenant.escalationVerifiedAt || !tenant.escalationTotpEnrolledAt) {
        await this.audit.record(tx, {
          action: 'EXTERNAL_ACCESS',
          resource: 'complaint',
          resourceId: complaintId,
          details: { outcome: 'unavailable', cause: 'destinatário alternativo não verificado' },
          anonymousOrigin: anon,
        });
        return null;
      }
      if (triggeredBy === 'SYSTEM') {
        const active = await tx.externalAccess.count({
          where: { complaintId, revokedAt: null, expiresAt: { gt: new Date() } },
        });
        if (active > 0) return null;
      }
      const now = new Date();
      const access = await tx.externalAccess.create({
        data: {
          tenantId: complaint.tenantId,
          complaintId,
          recipientEmail: tenant.escalationRecipientEmail,
          triggeredBy,
          reason,
          tokenHash: sha256(token),
          // Caso anônimo: sem horário fino em evento derivado da criação.
          createdAt: anon ? truncateToMinute(now) : now,
          expiresAt: new Date(now.getTime() + ACCESS_VALIDITY_MS),
        },
      });
      await this.audit.record(tx, {
        action: 'EXTERNAL_ACCESS',
        resource: 'external_access',
        resourceId: access.id,
        details: { outcome: 'triggered', triggeredBy: triggeredBy === 'SYSTEM' ? 'SYSTEM' : 'ADMIN', complaintId },
        userId: triggeredBy === 'SYSTEM' ? undefined : triggeredBy,
        anonymousOrigin: anon,
        ...client,
      });
      return { access, tenantSlug: tenant.slug, protocol: complaint.protocol, to: tenant.escalationRecipientEmail };
    });
    if (!prepared) {
      this.log.warn('Acesso externo não acionado (já vigente ou destinatário alternativo não verificado)');
      return null;
    }
    const base = process.env.PUBLIC_WEB_URL ?? 'https://app.ouvion.local';
    try {
      // O e-mail não contém dados do caso: só protocolo e o link.
      await this.mailer.send({
        to: prepared.to,
        subject: 'Acesso pontual a um caso — OuviON',
        text: `Protocolo ${prepared.protocol}. Acesse (link de uso único): ${base}/external?tenant=${prepared.tenantSlug}&token=${token}`,
      });
    } catch (e) {
      this.log.error(`Falha no envio do link de acesso externo (${(e as Error).name})`);
    }
    return { id: prepared.access.id };
  }

  /** Link + TOTP => sessão curta. Falhas repetidas revogam o link. Resposta sempre genérica. */
  async verify(token: string, code: string, client: Client): Promise<{ accessToken: string }> {
    const tenantId = this.cls.get('tenantId')!;
    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      const access = await tx.externalAccess.findUnique({ where: { tokenHash: sha256(token) } });
      const now = new Date();
      if (!access || access.revokedAt || access.expiresAt <= now || access.linkUsedAt) return null;
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (!tenant.escalationTotpSecretEnc || !tenant.escalationTotpEnrolledAt) return null;
      const secret = await this.cipher.decrypt(tenantId, tenant.escalationTotpSecretEnc);

      if (!authenticator.check(code, secret)) {
        const attempts = access.failedAttempts + 1;
        await tx.externalAccess.update({
          where: { id: access.id },
          data: { failedAttempts: attempts, revokedAt: attempts >= MAX_FAILED_ATTEMPTS ? now : null },
        });
        await this.audit.record(tx, {
          action: 'LOGIN_FAILED',
          resource: 'external_access',
          resourceId: access.id,
          details: { attempts },
          ...client,
        });
        return null;
      }
      await tx.externalAccess.update({
        where: { id: access.id },
        data: { linkUsedAt: now, lastUsedAt: now, usedCount: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'EXTERNAL_ACCESS',
        resource: 'external_access',
        resourceId: access.id,
        details: { outcome: 'session_opened', complaintId: access.complaintId },
        ...client,
      });
      return access;
    });
    if (!result) throw new UnauthorizedException(GENERIC);
    // Cada sessão aberta pelo destinatário alternativo avisa AUDITOR/ADMIN elegíveis.
    await this.notifications.onExternalAccess(result.complaintId);
    const accessToken = await this.jwt.signAsync(
      { sub: result.id, tenantId, scope: 'external', complaintId: result.complaintId },
      { expiresIn: SESSION_MINUTES },
    );
    return { accessToken };
  }

  /** Valida a sessão externa a cada request: acesso vigente, não revogado, no caso certo. */
  async resolve(authorization: string | undefined): Promise<ExternalSession> {
    const token = authorization?.replace(/^Bearer /i, '');
    if (!token) throw new UnauthorizedException();
    let claims: { sub: string; tenantId: string; scope?: string; complaintId?: string };
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }
    const tenantId = this.cls.get('tenantId');
    if (claims.scope !== 'external' || !claims.complaintId || claims.tenantId !== tenantId) {
      throw new UnauthorizedException();
    }
    const access = await this.prisma.withTenant(tenantId!, async (tx) => {
      const a = await tx.externalAccess.findUnique({ where: { id: claims.sub } });
      if (a && !a.revokedAt && a.expiresAt > new Date() && a.complaintId === claims.complaintId) {
        await tx.externalAccess.update({ where: { id: a.id }, data: { lastUsedAt: new Date() } });
        return a;
      }
      return null;
    });
    if (!access) throw new UnauthorizedException();
    return { accessId: access.id, complaintId: access.complaintId };
  }

  async revoke(complaintId: string, accessId: string, adminId: string, client: Client) {
    return this.prisma.run(async (tx) => {
      const a = await tx.externalAccess.findFirst({ where: { id: accessId, complaintId } });
      if (!a) throw new NotFoundException('Acesso não encontrado');
      await tx.externalAccess.update({ where: { id: accessId }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, {
        action: 'EXTERNAL_ACCESS',
        resource: 'external_access',
        resourceId: accessId,
        details: { outcome: 'revoked' },
        userId: adminId,
        ...client,
      });
      return { id: accessId, revoked: true };
    });
  }
}
