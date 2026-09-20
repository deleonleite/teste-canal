import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { CaseAccessService } from '../access/case-access.service';
import { AuditService } from '../audit/audit.service';
import { RateLimiter, tooMany } from '../common/rate-limiter';
import { addendumIntegrityHash } from '../complaints/integrity';
import type { Actor } from '../complaints/complaints.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';

const WINDOW_MS = 15 * 60_000;
const MAX_PER_WINDOW = 30;

/** Mensagem automática do sistema ao denunciante (sem autor; visível na consulta por protocolo + chave). */
export async function systemMessage(tx: Tx, c: { id: string; tenantId: string }, content: string): Promise<void> {
  await tx.complaintMessage.create({
    data: { tenantId: c.tenantId, complaintId: c.id, direction: 'TO_REPORTER', authorId: null, content },
  });
}

/**
 * Canal de mensagens (doc §5.3.2). Nunca grava IP/user-agent. As rotas por sessão de protocolo não
 * recebem o request: nada do cliente anônimo chega aqui além do conteúdo.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CaseAccessService,
    private readonly limiter: RateLimiter,
    private readonly notifications: NotificationsService,
  ) {}

  private throttle(complaintId: string): void {
    if (this.limiter.hit(`channel:${complaintId}`, WINDOW_MS) > MAX_PER_WINDOW) throw tooMany();
  }

  private async complaint(tx: Tx, id: string) {
    const c = await tx.complaint.findUnique({ where: { id }, select: { id: true, tenantId: true, isAnonymous: true } });
    if (!c) throw new NotFoundException('Denúncia não encontrada');
    return c;
  }

  // ── Denunciante por sessão de protocolo (anônimo ou não) ─────────────────────
  async sendAsReporterSession(complaintId: string, content: string) {
    this.throttle(complaintId);
    const sent = await this.prisma.run(async (tx) => {
      const c = await this.complaint(tx, complaintId);
      const m = await tx.complaintMessage.create({
        data: { tenantId: c.tenantId, complaintId, direction: 'FROM_REPORTER', authorId: null, content },
      });
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'complaint_message',
        resourceId: m.id,
        details: { direction: 'FROM_REPORTER' },
        anonymousOrigin: c.isAnonymous,
      });
      return { id: m.id, createdAt: m.createdAt };
    });
    await this.notifications.onReporterMessage(complaintId);
    return sent;
  }

  /** Conversa completa; marca como lidas as mensagens do comitê. */
  async readAsReporterSession(complaintId: string) {
    return this.prisma.run(async (tx) => {
      const c = await this.complaint(tx, complaintId);
      await tx.complaintMessage.updateMany({
        where: { complaintId, direction: 'TO_REPORTER', readAt: null },
        data: { readAt: new Date() },
      });
      const rows = await tx.complaintMessage.findMany({
        where: { complaintId },
        orderBy: { seq: 'asc' },
      });
      await this.audit.record(tx, {
        action: 'READ',
        resource: 'complaint_message',
        resourceId: c.id,
        anonymousOrigin: c.isAnonymous,
      });
      return rows.map((m) => ({ id: m.id, direction: m.direction, content: m.content, createdAt: m.createdAt, readAt: m.readAt }));
    });
  }

  /** Complemento ao relato enviado pelo denunciante: entra como addendum, o original não muda. */
  async addendumAsReporterSession(complaintId: string, content: string) {
    this.throttle(complaintId);
    return this.prisma.run(async (tx) => {
      const c = await this.complaint(tx, complaintId);
      const a = await tx.complaintAddendum.create({
        data: {
          tenantId: c.tenantId,
          complaintId,
          authorType: 'REPORTER',
          authorId: null,
          content,
          integrityHash: addendumIntegrityHash(complaintId, content),
        },
      });
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'complaint_addendum',
        resourceId: a.id,
        details: { authorType: 'REPORTER' },
        anonymousOrigin: c.isAnonymous,
      });
      return { id: a.id, integrityHash: a.integrityHash };
    });
  }

  // ── Equipe e REPORTER com conta ──────────────────────────────────────────────
  async list(actor: Actor, id: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireRead(tx, actor, id);
      const rows = await tx.complaintMessage.findMany({ where: { complaintId: id }, orderBy: { seq: 'asc' } });
      // `seq` é só para ordenar e nunca sai (em caso anônimo denunciaria o encaixe entre eventos).
      return rows.map(({ seq: _seq, ...m }) => m);
    });
  }

  /** INVESTIGATOR/ADMIN enviam TO_REPORTER; o REPORTER dono envia FROM_REPORTER. */
  async send(actor: Actor, id: string, content: string) {
    const result = await this.prisma.run(async (tx) => {
      const isReporter = actor.role === 'REPORTER';
      const { complaint } = isReporter
        ? await this.access.requireRead(tx, actor, id)
        : await this.access.requireDecide(tx, actor, id);
      const m = await tx.complaintMessage.create({
        data: {
          tenantId: complaint.tenantId,
          complaintId: id,
          direction: isReporter ? 'FROM_REPORTER' : 'TO_REPORTER',
          authorId: actor.userId,
          content,
        },
      });
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'complaint_message',
        resourceId: m.id,
        details: { direction: m.direction },
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      // Mensagem do comitê = confirmação de recebimento e retorno ao denunciante (SLA, doc §5.11).
      if (!isReporter) {
        const now = new Date();
        await tx.complaint.update({
          where: { id },
          data: { acknowledgedAt: complaint.acknowledgedAt ?? now, feedbackSentAt: complaint.feedbackSentAt ?? now },
        });
      }
      const { seq: _seq, ...safe } = m;
      return { safe, isReporter };
    });
    if (result.isReporter) await this.notifications.onReporterMessage(id);
    return result.safe;
  }

  assertCanUse(actor: Actor): void {
    if (actor.role === 'AUDITOR') throw new ForbiddenException();
  }
}
