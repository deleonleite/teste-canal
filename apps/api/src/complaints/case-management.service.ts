import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { CaseAccessService } from '../access/case-access.service';
import { AuditService } from '../audit/audit.service';
import { ExternalAccessService } from '../external/external-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './complaints.service';

/** Restrição de casos, concessões de acesso e acionamento do destinatário alternativo (ADMIN elegível). */
@Injectable()
export class CaseManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CaseAccessService,
    private readonly external: ExternalAccessService,
  ) {}

  private client(a: Actor) {
    return { userId: a.userId, ip: a.ip, userAgent: a.userAgent };
  }

  async setRestriction(actor: Actor, id: string, isRestricted: boolean) {
    return this.prisma.run(async (tx) => {
      await this.access.requireDecide(tx, actor, id);
      await tx.complaint.update({ where: { id }, data: { isRestricted } });
      await this.audit.record(tx, {
        action: 'UPDATE',
        resource: 'complaint',
        resourceId: id,
        details: { changes: { isRestricted: { to: isRestricted } } },
        ...this.client(actor),
      });
      return { id, isRestricted };
    });
  }

  async grantAccess(actor: Actor, id: string, input: { userId: string; reason: string; expiresAt: string }) {
    return this.prisma.run(async (tx) => {
      const { complaint } = await this.access.requireDecide(tx, actor, id);
      const target = await tx.user.findUnique({ where: { id: input.userId } });
      if (!target || !target.isActive || target.isBlocked || target.role === 'REPORTER' || target.role === 'PUBLIC') {
        throw new BadRequestException('Usuário inválido para concessão');
      }
      if ((await this.access.blockedUserIds(tx, id)).includes(input.userId)) {
        throw new BadRequestException('Usuário impedido ou sob suspeita neste caso');
      }
      const grant = await tx.complaintAccessGrant.create({
        data: {
          tenantId: complaint.tenantId,
          complaintId: id,
          userId: input.userId,
          grantedBy: actor.userId,
          reason: input.reason,
          expiresAt: new Date(input.expiresAt),
        },
      });
      await this.audit.record(tx, {
        action: 'ACCESS_GRANT',
        resource: 'complaint',
        resourceId: id,
        details: { grantId: grant.id, userId: input.userId, expiresAt: grant.expiresAt },
        ...this.client(actor),
      });
      return { id: grant.id, expiresAt: grant.expiresAt };
    });
  }

  async revokeGrant(actor: Actor, id: string, grantId: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireDecide(tx, actor, id);
      const grant = await tx.complaintAccessGrant.findFirst({ where: { id: grantId, complaintId: id } });
      if (!grant) throw new NotFoundException('Concessão não encontrada');
      await tx.complaintAccessGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, {
        action: 'ACCESS_GRANT',
        resource: 'complaint',
        resourceId: id,
        details: { grantId, revoked: true },
        ...this.client(actor),
      });
      return { id: grantId, revoked: true };
    });
  }

  /** ADMIN não suspeito aciona o destinatário alternativo para este caso (motivo registrado). */
  async triggerExternal(actor: Actor, id: string, reason: string) {
    await this.prisma.run((tx) => this.access.requireDecide(tx, actor, id));
    const result = await this.external.trigger(id, actor.userId, reason, { ip: actor.ip, userAgent: actor.userAgent });
    if (!result) {
      throw new BadRequestException('Destinatário alternativo não configurado ou não verificado');
    }
    return result;
  }

  async revokeExternal(actor: Actor, id: string, accessId: string) {
    await this.prisma.run((tx) => this.access.requireDecide(tx, actor, id));
    return this.external.revoke(id, accessId, actor.userId, { ip: actor.ip, userAgent: actor.userAgent });
  }
}
