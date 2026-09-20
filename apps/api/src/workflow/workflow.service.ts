import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ALLOWED_TRANSITIONS,
  CLOSED_STATUSES,
  isReopen,
  type StatusChangeInput,
} from '@ouvion/contracts';
import type { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';

import { CaseAccessService, SAFE_OMIT } from '../access/case-access.service';
import { AuditService } from '../audit/audit.service';
import { systemMessage } from '../channel/messages.service';
import { truncateToMinute } from '../common/client-info';
import { RateLimiter, tooMany } from '../common/rate-limiter';
import type { Actor } from '../complaints/complaints.service';
import { generateAccessKey, generateProtocol, normalizeAccessKey, reportIntegrityHash } from '../complaints/integrity';
import { normalizeText } from '../conflicts/conflict.service';
import { NotificationsService, statusLabel } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { loadSlaSettings, slaDates } from './sla';

const DAY_MS = 86_400_000;

/** Fluxo do caso: máquina de estados, encerramento estruturado, SLA, casos relacionados e retaliação. */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CaseAccessService,
    private readonly notifications: NotificationsService,
    private readonly limiter: RateLimiter,
  ) {}

  private who(a: Actor) {
    return { userId: a.userId, ip: a.ip, userAgent: a.userAgent };
  }

  // ── Classificação e gestão (o relato original é imutável) ─────────────────────
  /**
   * Só classificação/gestão. Alterar a prioridade exige motivo (registrado em comentário INTERNO — texto
   * livre não entra na auditoria) e recalcula os prazos de SLA ainda não cumpridos.
   */
  async classify(
    actor: Actor,
    id: string,
    input: { type?: string; priority?: string; department?: string | null; tags?: string[]; reason?: string },
  ) {
    const { reason, ...changes } = input;
    return this.prisma.run(async (tx) => {
      const { complaint: before } = await this.access.requireDecide(tx, actor, id);
      const data: Prisma.ComplaintUpdateInput = { ...(changes as Prisma.ComplaintUpdateInput) };
      if (changes.priority && changes.priority !== before.priority) {
        const dates = slaDates(before.createdAt, changes.priority, await loadSlaSettings(tx));
        if (!before.acknowledgedAt) Object.assign(data, { ackDueAt: dates.ackDueAt, ackWarnAt: dates.ackWarnAt });
        if (!before.feedbackSentAt) Object.assign(data, { feedbackDueAt: dates.feedbackDueAt, feedbackWarnAt: dates.feedbackWarnAt });
        await tx.complaintComment.create({
          data: {
            tenantId: before.tenantId,
            complaintId: id,
            authorId: actor.userId,
            content: `Prioridade alterada de ${before.priority} para ${changes.priority}. Motivo: ${reason}`,
            visibility: 'INTERNAL',
          },
        });
      }
      const after = await tx.complaint.update({ where: { id }, data, omit: SAFE_OMIT });
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of Object.keys(changes) as Array<keyof typeof before>) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key as keyof typeof after])) {
          diff[key] = { from: before[key], to: after[key as keyof typeof after] };
        }
      }
      await this.audit.record(tx, { action: 'UPDATE', resource: 'complaint', resourceId: id, details: { changes: diff }, ...this.who(actor) });
      return after;
    });
  }

  // ── Máquina de estados (doc §5.2.7) ───────────────────────────────────────────
  async changeStatus(actor: Actor, id: string, input: StatusChangeInput) {
    const { updated, from } = await this.prisma.run(async (tx) => {
      const { complaint: c } = await this.access.requireDecide(tx, actor, id);
      const from = c.status;
      const to = input.status;
      if (from === to) throw new BadRequestException('A denúncia já está neste status');
      const reopen = isReopen(from, to);
      if (reopen) {
        if (actor.role !== 'ADMIN') throw new ForbiddenException('Somente ADMIN pode reabrir um caso encerrado');
      } else if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new BadRequestException(`Transição não permitida: ${statusLabel(from)} → ${statusLabel(to)}`);
      }
      const closing = CLOSED_STATUSES.includes(to);
      if (closing && !input.conclusion) throw new BadRequestException('Informe a conclusão ao encerrar o caso');
      if (to === 'ESCALATED' && !input.escalatedTo) throw new BadRequestException('Informe a instância que recebeu o caso escalado');

      const now = new Date();
      const settings = await loadSlaSettings(tx);
      const updated = await tx.complaint.update({
        where: { id },
        data: {
          status: to,
          resolvedAt: closing ? now : null,
          ...(closing
            ? {
                conclusion: input.conclusion,
                correctiveActions: input.correctiveActions ?? null,
                conclusionNotes: input.conclusionNotes ?? null,
                followUpUntil: new Date(now.getTime() + settings.followUpDays * DAY_MS),
                // O encerramento conta como retorno ao denunciante (doc §5.11).
                feedbackSentAt: c.feedbackSentAt ?? now,
              }
            : {}),
          ...(reopen ? { followUpUntil: null } : {}),
          acknowledgedAt: c.acknowledgedAt ?? now, // triagem = confirmação de recebimento
        },
        omit: SAFE_OMIT,
      });
      await tx.complaintStatusHistory.create({
        data: {
          tenantId: c.tenantId,
          complaintId: id,
          previousStatus: from,
          newStatus: to,
          changedBy: actor.userId,
          reason: input.escalatedTo ? `${input.reason} [Escalada para: ${input.escalatedTo}]` : input.reason,
        },
      });
      // Mensagem automática no canal seguro (o anônimo a vê com protocolo + chave). Sem detalhes do caso.
      await systemMessage(tx, c, closing ? 'Sua denúncia foi encerrada.' : `O status da sua denúncia foi atualizado: ${statusLabel(to)}.`);
      await this.audit.record(tx, {
        action: reopen ? 'REOPEN' : 'UPDATE',
        resource: 'complaint_status',
        resourceId: id,
        details: { from, to, ...(closing ? { conclusion: input.conclusion } : {}) },
        ...this.who(actor),
      });
      return { updated, from };
    });
    await this.notifications.onStatusChanged(id, input.status, actor.userId);
    return { ...updated, previousStatus: from };
  }

  /** "Remoção" é arquivamento: nunca exclui fisicamente (doc §5.2.8). Só ADMIN. */
  archive(actor: Actor, id: string) {
    return this.changeStatus(actor, id, { status: 'DISMISSED', reason: 'Denúncia removida', conclusion: 'INCONCLUSIVE' });
  }

  // ── Pausa do prazo ────────────────────────────────────────────────────────────
  async pauseSla(actor: Actor, id: string, reason: string) {
    return this.prisma.run(async (tx) => {
      const { complaint: c } = await this.access.requireDecide(tx, actor, id);
      if (c.slaPausedAt) throw new BadRequestException('O prazo já está pausado');
      if (CLOSED_STATUSES.includes(c.status)) throw new BadRequestException('Caso encerrado');
      await tx.complaint.update({ where: { id }, data: { slaPausedAt: new Date(), slaPauseReason: reason } });
      await this.audit.record(tx, { action: 'UPDATE', resource: 'complaint_sla', resourceId: id, details: { event: 'paused' }, ...this.who(actor) });
      return { id, paused: true };
    });
  }

  /** Retomar empurra os prazos ainda não cumpridos pelo tempo em que ficaram pausados. */
  async resumeSla(actor: Actor, id: string) {
    return this.prisma.run(async (tx) => {
      const { complaint: c } = await this.access.requireDecide(tx, actor, id);
      if (!c.slaPausedAt) throw new BadRequestException('O prazo não está pausado');
      const paused = Date.now() - c.slaPausedAt.getTime();
      const shift = (d: Date | null, satisfied: Date | null) => (d && !satisfied ? new Date(d.getTime() + paused) : d);
      await tx.complaint.update({
        where: { id },
        data: {
          slaPausedAt: null,
          slaPauseReason: null,
          ackDueAt: shift(c.ackDueAt, c.acknowledgedAt),
          ackWarnAt: shift(c.ackWarnAt, c.acknowledgedAt),
          feedbackDueAt: shift(c.feedbackDueAt, c.feedbackSentAt),
          feedbackWarnAt: shift(c.feedbackWarnAt, c.feedbackSentAt),
        },
      });
      await this.audit.record(tx, {
        action: 'UPDATE',
        resource: 'complaint_sla',
        resourceId: id,
        details: { event: 'resumed', pausedMs: paused },
        ...this.who(actor),
      });
      return { id, paused: false };
    });
  }

  // ── Casos relacionados/duplicados (doc §5.2.1) ────────────────────────────────
  /** Sugestões por citado em comum (+ local/período); o triador confirma o vínculo. */
  async suggestRelated(actor: Actor, id: string) {
    return this.prisma.run(async (tx) => {
      const { complaint: c } = await this.access.requireRead(tx, actor, id);
      const body = await tx.systemSetting.findFirst({ where: { key: 'encrypt_complaint_body' } });
      if (body?.value === 'true') return { enabled: false, suggestions: [] };

      const mine = new Set(c.involvedPeople.map(normalizeText));
      const candidates = await tx.complaint.findMany({
        where: { AND: [this.access.listWhere(actor), { id: { not: id } }] },
        select: { id: true, protocol: true, title: true, type: true, status: true, involvedPeople: true, location: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const suggestions = candidates
        .map((o) => {
          const shared = o.involvedPeople.filter((p) => mine.has(normalizeText(p))).length;
          const sameLocation = !!c.location && !!o.location && normalizeText(c.location) === normalizeText(o.location);
          const near = Math.abs(o.createdAt.getTime() - c.createdAt.getTime()) < 90 * DAY_MS;
          return { id: o.id, protocol: o.protocol, title: o.title, type: o.type, status: o.status, sharedPeople: shared, sameLocation, score: shared * 3 + (sameLocation ? 1 : 0) + (near ? 1 : 0) };
        })
        .filter((s) => s.sharedPeople > 0 && !c.linkedComplaintIds.includes(s.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      return { enabled: true, suggestions };
    });
  }

  async link(actor: Actor, id: string, relatedId: string) {
    if (id === relatedId) throw new BadRequestException('Um caso não pode ser vinculado a si mesmo');
    return this.prisma.run(async (tx) => {
      const { complaint: a } = await this.access.requireDecide(tx, actor, id);
      const { complaint: b } = await this.access.requireRead(tx, actor, relatedId);
      if (a.linkedComplaintIds.includes(relatedId)) throw new BadRequestException('Casos já vinculados');
      await tx.complaint.update({ where: { id }, data: { linkedComplaintIds: [...a.linkedComplaintIds, relatedId] } });
      await tx.complaint.update({ where: { id: relatedId }, data: { linkedComplaintIds: [...new Set([...b.linkedComplaintIds, id])] } });
      await this.audit.record(tx, { action: 'UPDATE', resource: 'complaint', resourceId: id, details: { linked: relatedId }, ...this.who(actor) });
      return { id, linked: relatedId };
    });
  }

  // ── Retaliação após o encerramento (doc §5.12) ────────────────────────────────
  /**
   * O denunciante relata retaliação pelo mesmo canal durante o acompanhamento (`followUpUntil`).
   * Gera um NOVO caso vinculado, prioridade HIGH, com o mesmo regime de anonimato e restrição.
   */
  async reportRetaliation(complaintId: string, content: string, opts: { anonymousSession: boolean; actorId?: string }) {
    if (this.limiter.hit(`channel:${complaintId}`, 15 * 60_000) > 30) throw tooMany();
    const accessKey = generateAccessKey();
    const accessKeyHash = await argon2.hash(normalizeAccessKey(accessKey), { type: argon2.argon2id });
    const created = await this.prisma.run(async (tx) => {
      const c = await tx.complaint.findUnique({ where: { id: complaintId } });
      if (!c) throw new NotFoundException('Denúncia não encontrada');
      if (opts.actorId && c.createdBy !== opts.actorId) throw new ForbiddenException();
      if (!CLOSED_STATUSES.includes(c.status) || !c.followUpUntil || c.followUpUntil < new Date()) {
        throw new BadRequestException('O relato de retaliação só é aceito após o encerramento e durante o período de acompanhamento');
      }
      const settings = await loadSlaSettings(tx);
      const now = new Date();
      const base = c.isAnonymous ? truncateToMinute(now) : now;
      const title = `Relato de retaliação — ${c.protocol}`;
      const n = await tx.complaint.create({
        data: {
          tenantId: c.tenantId,
          protocol: generateProtocol(),
          accessKeyHash,
          isAnonymous: c.isAnonymous,
          type: c.type,
          reportedType: c.type,
          priority: 'HIGH',
          title,
          description: content,
          involvedPeople: [],
          witnesses: [],
          isRestricted: c.isRestricted,
          createdBy: c.createdBy,
          reporterNameEnc: c.reporterNameEnc,
          reporterEmailEnc: c.reporterEmailEnc,
          reporterPhoneEnc: c.reporterPhoneEnc,
          linkedComplaintIds: [c.id],
          integrityHash: reportIntegrityHash({ title, description: content, reportedType: c.type, involvedPeople: [], witnesses: [], incidentDate: null, location: null }),
          acknowledgedAt: settings.autoAck ? base : null,
          ...slaDates(base, 'HIGH', settings),
        },
        omit: SAFE_OMIT,
      });
      await tx.complaint.update({ where: { id: c.id }, data: { retaliationReported: true, linkedComplaintIds: [...c.linkedComplaintIds, n.id] } });
      await tx.complaintStatusHistory.create({
        data: { tenantId: c.tenantId, complaintId: n.id, previousStatus: null, newStatus: 'PENDING', changedBy: null, reason: 'Denúncia criada (relato de retaliação)', createdAt: base },
      });
      if (settings.autoAck) await systemMessage(tx, n, 'Recebemos seu relato de retaliação. Ele será tratado com prioridade.');
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'complaint',
        resourceId: n.id,
        details: { source: 'WEB', retaliation: true },
        anonymousOrigin: c.isAnonymous,
        userId: c.isAnonymous ? undefined : opts.actorId,
      });
      return n;
    });
    await this.notifications.onComplaintCreated(created.id);
    return { complaintId: created.id, protocol: created.protocol, accessKey };
  }
}
