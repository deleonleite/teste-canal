import type { TimelineEntry } from './api-client';

/** Marcos macro da linha do tempo pública (PROMPTFRONT §5.2): sem jargão interno, sem segundos. */
export type Milestone = 'PENDING' | 'IN_PROGRESS' | 'UNDER_REVIEW' | 'CLOSED';
export const MILESTONES: Milestone[] = ['PENDING', 'IN_PROGRESS', 'UNDER_REVIEW', 'CLOSED'];

const RANK: Record<string, number> = { PENDING: 0, IN_PROGRESS: 1, UNDER_REVIEW: 2, ESCALATED: 2, RESOLVED: 3, DISMISSED: 3 };

export interface MilestoneItem {
  key: Milestone;
  state: 'done' | 'current' | 'upcoming';
  /** Quando o caso chegou a este marco (aproximado). */
  at: string | null;
}

/**
 * Marco atual = o mais avançado já alcançado (o caso pode voltar de status internamente; o denunciante só
 * vê progresso). O marco final vale para RESOLVED e DISMISSED e, quando alcançado, aparece como concluído.
 */
export function buildMilestones(timeline: TimelineEntry[], status: string): MilestoneItem[] {
  const reached = Math.max(RANK[status] ?? 0, ...timeline.map((e) => RANK[e.status] ?? 0));
  const firstAt = (rank: number): string | null => timeline.find((e) => RANK[e.status] === rank)?.at ?? null;
  return MILESTONES.map((key, i) => ({
    key,
    state: i < reached || (i === reached && key === 'CLOSED') ? 'done' : i === reached ? 'current' : 'upcoming',
    at: i <= reached ? firstAt(i) : null,
  }));
}

/** "12 de setembro de 2026" + hora aproximada: "por volta das 14h" (nunca minuto/segundo). */
export function approxParts(iso: string, locale: string): { date: string; hour: number } {
  const d = new Date(iso);
  return { date: new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(d), hour: d.getHours() };
}

export function longDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(iso));
}
