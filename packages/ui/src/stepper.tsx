import { Check } from 'lucide-react';

import { cn } from './cn';

/** Indicador de progresso por etapa do formulário de denúncia (Anonimato → Fato → Envolvidos → Anexos → Revisão). */
export function Stepper({
  steps,
  current,
  label,
  srDone,
  srCurrent,
}: {
  steps: string[];
  current: number;
  label: string;
  srDone: string;
  srCurrent: string;
}) {
  return (
    <nav aria-label={label}>
      <ol className="flex items-start gap-2">
        {steps.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s} className="flex min-w-0 flex-1 flex-col gap-2" aria-current={active ? 'step' : undefined}>
              <span className={cn('h-1 rounded-sm', done || active ? 'bg-brand' : 'bg-line-strong')} aria-hidden="true" />
              <span className={cn('flex items-center gap-1.5 truncate text-body-sm', active ? 'font-semibold text-fg' : 'text-fg-2')}>
                {done && <Check className="h-3.5 w-3.5 shrink-0 text-brand-text" aria-hidden="true" />}
                <span className={cn(active ? 'inline' : 'hidden sm:inline')}>{s}</span>
                <span className="sr-only">{done ? ` (${srDone})` : active ? ` (${srCurrent})` : ''}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
