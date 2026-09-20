import { CLOSED_STATUSES, slaByPrioritySchema } from '@ouvion/contracts';
import type { Prisma } from '@prisma/client';

import type { Tx } from '../prisma/prisma.service';

const DAY_MS = 86_400_000;
const DEFAULT_ACK_DAYS = 7;
const DEFAULT_FEEDBACK_DAYS = 90;
const WARN_RATIO = 0.8;

export interface SlaSettings {
  ackDays: number;
  feedbackDays: number;
  byPriority: Record<string, { ack?: number; feedback?: number }>;
  autoAck: boolean;
  followUpDays: number;
}

const int = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
};

export async function loadSlaSettings(tx: Tx): Promise<SlaSettings> {
  const rows = await tx.systemSetting.findMany({
    where: { key: { in: ['sla_ack_days', 'sla_feedback_days', 'sla_by_priority', 'auto_ack_message', 'retaliationFollowUpDays'] } },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  let byPriority: SlaSettings['byPriority'] = {};
  try {
    const raw = get('sla_by_priority');
    if (raw) byPriority = slaByPrioritySchema.parse(JSON.parse(raw));
  } catch {
    byPriority = {};
  }
  return {
    ackDays: int(get('sla_ack_days'), DEFAULT_ACK_DAYS),
    feedbackDays: int(get('sla_feedback_days'), DEFAULT_FEEDBACK_DAYS),
    byPriority,
    autoAck: get('auto_ack_message') !== 'false',
    followUpDays: int(get('retaliationFollowUpDays'), 180),
  };
}

/** Prazos (dias corridos) a partir da criação; o aviso vem a 80% do prazo. Prazo por prioridade pode ser mais curto. */
export function slaDates(createdAt: Date, priority: string, s: SlaSettings) {
  const ackDays = s.byPriority[priority]?.ack ?? s.ackDays;
  const feedbackDays = s.byPriority[priority]?.feedback ?? s.feedbackDays;
  const at = (days: number) => new Date(createdAt.getTime() + days * DAY_MS);
  const warn = (days: number) => new Date(createdAt.getTime() + days * DAY_MS * WARN_RATIO);
  return { ackDueAt: at(ackDays), ackWarnAt: warn(ackDays), feedbackDueAt: at(feedbackDays), feedbackWarnAt: warn(feedbackDays) };
}

export type SlaState = 'DONE' | 'ON_TIME' | 'AT_RISK' | 'BREACHED' | 'PAUSED' | 'N/A';

interface SlaFields {
  status: string;
  slaPausedAt: Date | null;
  acknowledgedAt: Date | null;
  ackDueAt: Date | null;
  ackWarnAt: Date | null;
  feedbackSentAt: Date | null;
  feedbackDueAt: Date | null;
  feedbackWarnAt: Date | null;
}

function state(done: Date | null, due: Date | null, warn: Date | null, paused: boolean, closed: boolean, now: Date): SlaState {
  if (done) return 'DONE';
  if (!due || closed) return 'N/A';
  if (paused) return 'PAUSED';
  if (now >= due) return 'BREACHED';
  if (warn && now >= warn) return 'AT_RISK';
  return 'ON_TIME';
}

/** Indicadores de SLA para lista/detalhe/dashboard. */
export function slaIndicators(c: SlaFields, now = new Date()) {
  const closed = CLOSED_STATUSES.includes(c.status as never);
  const paused = c.slaPausedAt !== null;
  return {
    ack: { state: state(c.acknowledgedAt, c.ackDueAt, c.ackWarnAt, paused, closed, now), dueAt: c.ackDueAt },
    feedback: { state: state(c.feedbackSentAt, c.feedbackDueAt, c.feedbackWarnAt, paused, closed, now), dueAt: c.feedbackDueAt },
  };
}

/** Filtro de listagem por situação de SLA (no prazo / próximo do vencimento / vencido). */
export function slaWhere(kind: 'on_time' | 'at_risk' | 'breached', now = new Date()): Prisma.ComplaintWhereInput {
  const open: Prisma.ComplaintWhereInput = { status: { notIn: [...CLOSED_STATUSES] as never[] }, slaPausedAt: null };
  const breached: Prisma.ComplaintWhereInput = {
    OR: [
      { acknowledgedAt: null, ackDueAt: { lte: now } },
      { feedbackSentAt: null, feedbackDueAt: { lte: now } },
    ],
  };
  const atRisk: Prisma.ComplaintWhereInput = {
    OR: [
      { acknowledgedAt: null, ackWarnAt: { lte: now } },
      { feedbackSentAt: null, feedbackWarnAt: { lte: now } },
    ],
  };
  if (kind === 'breached') return { AND: [open, breached] };
  if (kind === 'at_risk') return { AND: [open, atRisk, { NOT: breached }] };
  return { AND: [open, { NOT: atRisk }, { NOT: breached }] };
}
