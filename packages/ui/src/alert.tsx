import { CircleAlert, Info, ShieldCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

const TONES: Record<string, { box: string; icon: LucideIcon; role: 'status' | 'alert' }> = {
  info: { box: 'border-info/40 bg-tint-info', icon: Info, role: 'status' },
  warning: { box: 'border-warning/40 bg-tint-warning', icon: TriangleAlert, role: 'status' },
  success: { box: 'border-success/40 bg-tint-success', icon: ShieldCheck, role: 'status' },
  danger: { box: 'border-danger/40 bg-tint-danger', icon: CircleAlert, role: 'alert' },
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'success' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const t = TONES[tone]!;
  const Icon = t.icon;
  return (
    <div role={t.role} className={cn('flex gap-3 rounded-md border p-4', t.box, className)}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-fg" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1 text-body text-fg">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}
