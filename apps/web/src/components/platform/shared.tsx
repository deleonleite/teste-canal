'use client';

import { Alert, Badge, cn } from '@ouvion/ui';
import { FlaskConical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import type { PlatformRole } from '@/lib/platform-client';
import { usePlatformMe } from './platform-shell';

/** Rótulo discreto: nada de mock pode ser confundido com operação real (tarefas.md §6). */
export function MockLabel() {
  const t = useTranslations('platform');
  return (
    <Badge tone="neutral" icon={FlaskConical}>
      {t('mock')}
    </Badge>
  );
}

export function MockNotice() {
  const t = useTranslations('platform');
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong bg-sunken p-3" data-testid="mock-notice">
      <MockLabel />
      <p className="text-body-sm text-fg-2">{t('mockHint')}</p>
    </div>
  );
}

/** Mostra a mensagem para perfis sem acesso (a API também nega; isto é só o texto). */
export function RoleGate({ roles, children }: { roles: PlatformRole[]; children: ReactNode }) {
  const t = useTranslations('platform');
  const me = usePlatformMe();
  if (!roles.includes(me.role)) return <Alert tone="info">{t('denied')}</Alert>;
  return <>{children}</>;
}

/** Card plano com borda superior de 2px na cor semântica (sem gradiente, sem glow). */
export function MetricCard({ label, value, tone = 'info', mock, hint }: { label: string; value: string; tone?: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; mock?: boolean; hint?: string }) {
  const top = { success: 'border-t-success', danger: 'border-t-danger', warning: 'border-t-warning', info: 'border-t-info', neutral: 'border-t-neutral' }[tone];
  return (
    <div className={cn('flex flex-col gap-1 rounded-md border border-line border-t-2 bg-surface p-4', top)}>
      <span className="text-body-sm font-medium text-fg-2">{label}</span>
      <span className="text-h1 text-fg">{value}</span>
      <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-3">
        {mock && <MockLabel />}
        {hint}
      </span>
    </div>
  );
}
