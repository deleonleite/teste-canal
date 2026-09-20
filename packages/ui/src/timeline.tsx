import { Check, Circle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

export interface TimelineItem {
  key: string;
  title: ReactNode;
  /** Texto de apoio (data aproximada, motivo…). */
  meta?: ReactNode;
  state: 'done' | 'current' | 'upcoming';
  icon?: LucideIcon;
}

/**
 * Linha do tempo vertical única, reutilizada com densidades diferentes (público, comitê, dossiê).
 * O estado nunca depende só de cor: ícone + texto para leitores de tela ("etapa atual").
 */
export function Timeline({
  items,
  srCurrent,
  srDone,
  srUpcoming,
}: {
  items: TimelineItem[];
  srCurrent: string;
  srDone: string;
  srUpcoming: string;
}) {
  return (
    <ol className="flex flex-col">
      {items.map((it, i) => {
        const Icon = it.icon ?? (it.state === 'done' ? Check : Circle);
        const last = i === items.length - 1;
        return (
          <li key={it.key} className="flex gap-4" aria-current={it.state === 'current' ? 'step' : undefined}>
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2',
                  it.state === 'done' && 'border-brand bg-brand text-on-brand',
                  it.state === 'current' && 'border-brand bg-surface text-brand-text',
                  it.state === 'upcoming' && 'border-line-strong bg-surface text-fg-3',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              {!last && <span className={cn('my-1 w-0.5 flex-1', it.state === 'done' ? 'bg-brand' : 'bg-line')} aria-hidden="true" />}
            </div>
            <div className={cn('flex flex-col gap-0.5 pb-6', last && 'pb-0')}>
              <p className={cn('text-body', it.state === 'upcoming' ? 'text-fg-2' : 'font-semibold text-fg')}>
                {it.title}
                <span className="sr-only"> — {it.state === 'current' ? srCurrent : it.state === 'done' ? srDone : srUpcoming}</span>
              </p>
              {it.meta && <p className="text-body-sm text-fg-3">{it.meta}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
