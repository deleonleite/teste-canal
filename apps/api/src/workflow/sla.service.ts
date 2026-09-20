import { CLOSED_STATUSES } from '@ouvion/contracts';
import { Injectable } from '@nestjs/common';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../scan/attachment-scan.handler';

type Kind = 'ACK' | 'FEEDBACK';
type Level = 'WARNING' | 'BREACHED';

/**
 * Job periódico de SLA (doc §5.11): `SLA_WARNING` a 80% do prazo e `SLA_BREACHED` ao vencer, para o
 * investigador e os ADMINs elegíveis. Idempotente: um alerta por (denúncia, tipo, nível), então rodar
 * de novo nunca repete notificação. Casos encerrados ou com prazo pausado não geram alerta.
 */
@Injectable()
export class SlaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tenants: TenantContext,
  ) {}

  checkTenant(tenantId: string, now = new Date()): Promise<{ warnings: number; breaches: number }> {
    return this.tenants.run(tenantId, async () => {
      const due = await this.prisma.withTenant(tenantId, async (tx) => {
        const open = await tx.complaint.findMany({
          where: { status: { notIn: [...CLOSED_STATUSES] as never[] }, slaPausedAt: null },
          select: {
            id: true, tenantId: true, acknowledgedAt: true, ackDueAt: true, ackWarnAt: true,
            feedbackSentAt: true, feedbackDueAt: true, feedbackWarnAt: true,
          },
        });
        const fired: Array<{ complaintId: string; kind: Kind; level: Level }> = [];
        for (const c of open) {
          const checks: Array<[Kind, Date | null, Date | null, Date | null]> = [
            ['ACK', c.acknowledgedAt, c.ackWarnAt, c.ackDueAt],
            ['FEEDBACK', c.feedbackSentAt, c.feedbackWarnAt, c.feedbackDueAt],
          ];
          for (const [kind, done, warnAt, dueAt] of checks) {
            if (done || !dueAt) continue;
            const level: Level | null = now >= dueAt ? 'BREACHED' : warnAt && now >= warnAt ? 'WARNING' : null;
            if (!level) continue;
            const r = await tx.slaAlert.createMany({ data: [{ tenantId: c.tenantId, complaintId: c.id, kind, level }], skipDuplicates: true });
            if (r.count > 0) fired.push({ complaintId: c.id, kind, level });
          }
        }
        return fired;
      });
      for (const f of due) await this.notifications.onSla(f.complaintId, f.level, f.kind);
      return { warnings: due.filter((d) => d.level === 'WARNING').length, breaches: due.filter((d) => d.level === 'BREACHED').length };
    });
  }
}
