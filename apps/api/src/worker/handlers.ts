import { Injectable, Logger } from '@nestjs/common';

import { AuditIntegrityService } from '../audit/integrity.service';
import { PrismaService } from '../prisma/prisma.service';
import { JobQueue, type JobName } from '../queue/job-queue';
import { NotificationsService } from '../notifications/notifications.service';
import { AttachmentScanHandler, TenantContext } from '../scan/attachment-scan.handler';
import { SlaService } from '../workflow/sla.service';

const SWEEP_MIN_AGE_MS = 30_000;

/**
 * Varredura periódica: reenfileira anexos ainda PENDING. É o único caminho dos anexos de denúncia
 * ANÔNIMA — enfileirar no ato do upload deixaria na fila o instante exato do evento anônimo; o sweep
 * agrupa por horário de varredura, sem relação com o instante do upload.
 */
@Injectable()
export class AttachmentSweepHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
  ) {}

  async handle(): Promise<number> {
    const list = await this.prisma.base.tenant.findMany({ select: { id: true } });
    let queued = 0;
    for (const { id: tenantId } of list) {
      const pending = await this.prisma.withTenant(tenantId, (tx) =>
        tx.attachment.findMany({
          where: { scanStatus: 'PENDING', deletedAt: null, uploadedAt: { lt: new Date(Date.now() - SWEEP_MIN_AGE_MS) } },
          select: { id: true },
          take: 500,
        }),
      );
      for (const a of pending) {
        await this.queue.enqueue('attachment-scan', { tenantId, attachmentId: a.id }, { jobId: `scan-${a.id}` });
        queued++;
      }
    }
    return queued;
  }
}

/** Despacha cada job da fila para o seu handler. Novos handlers entram aqui. */
@Injectable()
export class JobHandlers {
  constructor(
    private readonly scan: AttachmentScanHandler,
    private readonly sweep: AttachmentSweepHandler,
    private readonly integrity: AuditIntegrityService,
    private readonly sla: SlaService,
    private readonly notifications: NotificationsService,
    private readonly tenants: TenantContext,
  ) {}

  private readonly log = new Logger(JobHandlers.name);

  /** Fan-out por tenant; falha de um tenant não impede os demais, mas o job falha para ser retentado/alertado. */
  private async forEachTenant(data: Record<string, unknown>, fn: (tenantId: string) => Promise<unknown>): Promise<number> {
    const ids = typeof data.tenantId === 'string' ? [data.tenantId] : await this.integrity.allTenantIds();
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await fn(id);
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`);
        this.log.error(`Falha no tenant ${id} (${(e as Error).name})`);
      }
    }
    if (errors.length) throw new Error(`Falha em ${errors.length} tenant(s): ${errors.join('; ')}`);
    return ids.length;
  }

  async handle(name: JobName, data: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'attachment-scan':
        return this.scan.handle(data as { tenantId: string; attachmentId: string });
      case 'attachment-sweep':
        return this.sweep.handle();
      case 'audit-seal':
        return this.forEachTenant(data, (t) => this.integrity.sealTenant(t));
      case 'audit-anchor':
        return this.forEachTenant(data, (t) => this.integrity.anchorTenant(t));
      case 'audit-verify':
        return this.forEachTenant(data, (t) => this.integrity.verifyAndAlert(t));
      case 'sla-check':
        return this.forEachTenant(data, (t) => this.sla.checkTenant(t));
      case 'notification-email':
        // E-mail de evento anônimo só sai por aqui (o provedor não registra o instante do evento).
        return this.forEachTenant(data, (t) => this.tenants.run(t, () => this.notifications.flush()));
      default:
        throw new Error(`Job sem handler: ${name}`);
    }
  }
}
