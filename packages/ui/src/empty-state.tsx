import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Estado vazio: ícone de traço (sem ilustração colorida), uma frase e, se existir, a ação possível (§8.5). */
export function EmptyState({ icon: Icon, children, action }: { icon: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-line-strong px-6 py-10 text-center">
      <Icon className="h-8 w-8 text-fg-3" strokeWidth={1.5} aria-hidden="true" />
      <p className="max-w-prose text-body text-fg-2">{children}</p>
      {action}
    </div>
  );
}
