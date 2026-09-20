'use client';

import { Alert, Badge, Button, EmptyState, Select, Skeleton } from '@ouvion/ui';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, TriangleAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { platformApi, type PlatformAuditPage } from '@/lib/platform-client';
import { RoleGate } from './shared';

const ACTIONS = [
  'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'TENANT_CREATED', 'TENANT_SUSPENDED', 'TENANT_REACTIVATED', 'PLAN_CHANGED', 'SUBSCRIPTION_PAYMENT',
  'INTERNAL_USER_CREATED', 'INTERNAL_USER_UPDATED', 'INTERNAL_USER_PASSWORD_RESET', 'SETTINGS_CHANGED', 'BREAK_GLASS_REQUESTED',
  'BREAK_GLASS_APPROVED', 'BREAK_GLASS_USED', 'TENANT_ADMIN_TEMP_PASSWORD_ISSUED', 'TENANT_INVITE_SENT',
] as const;
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const TONE = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'warning', CRITICAL: 'danger' } as const;
const LIMIT = 25;

export function PlatformAuditView() {
  return (
    <RoleGate roles={['SUPER_ADMIN']}>
      <AuditList />
    </RoleGate>
  );
}

function AuditList() {
  const t = useTranslations('platform.audit');
  const ta = useTranslations('platform.audit.actions');
  const locale = useLocale();
  const [action, setAction] = useState('');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const qs = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
  if (action) qs.set('action', action);
  if (severity) qs.set('severity', severity);
  const q = useQuery({ queryKey: ['platform-audit', action, severity, page], queryFn: () => platformApi.get<PlatformAuditPage>(`audit?${qs}`) });
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="max-w-prose text-fg-2">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[14rem] flex-col gap-1">
          <label htmlFor="pa-action" className="text-body-sm font-medium text-fg-2">
            {t('filterAction')}
          </label>
          <Select
            id="pa-action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('all')}</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ta(a)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-[10rem] flex-col gap-1">
          <label htmlFor="pa-sev" className="text-body-sm font-medium text-fg-2">
            {t('filterSeverity')}
          </label>
          <Select
            id="pa-sev"
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('all')}</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {t(`sev.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        {q.data && <p className="text-body-sm text-fg-2">{t('total', { total: q.data.pagination.total })}</p>}
      </div>

      {q.isPending && <Skeleton className="h-40 w-full" />}
      {q.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {q.data && q.data.data.length === 0 && <EmptyState icon={ScrollText}>{t('empty')}</EmptyState>}
      {q.data && q.data.data.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="paudit-list">
          {q.data.data.map((r) => {
            const bg = r.action.startsWith('BREAK_GLASS');
            const expanded = open === r.id;
            return (
              <li key={r.id} className={bg ? 'rounded-md border-2 border-warning bg-tint-warning p-3' : 'rounded-md border border-line bg-surface p-3'} data-break-glass={bg || undefined}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="flex flex-col">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {ta(r.action as 'LOGIN')}
                      {bg && (
                        <Badge tone="warning" icon={TriangleAlert}>
                          {t('breakGlass')}
                        </Badge>
                      )}
                      <Badge tone={TONE[r.severity]} icon={TriangleAlert}>
                        {t(`sev.${r.severity}`)}
                      </Badge>
                    </span>
                    <span className="text-body-sm text-fg-2">
                      {r.actorName ?? t('system')} · {r.resource}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 text-body-sm text-fg-2">
                    {fmt(r.timestamp)}
                    <Button variant="ghost" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                      {expanded ? t('hide') : t('details')}
                    </Button>
                  </span>
                </div>
                {expanded && (
                  <dl className="mt-3 grid gap-1 rounded-md bg-sunken p-3 text-body-sm sm:grid-cols-[8rem_1fr]">
                    <dt className="text-fg-2">IP</dt>
                    <dd className="break-all">{r.ipAddress ?? '—'}</dd>
                    <dt className="text-fg-2">User-agent</dt>
                    <dd className="break-all">{r.userAgent ?? '—'}</dd>
                    <dt className="text-fg-2">JSON</dt>
                    <dd>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono">{JSON.stringify(r.details ?? {}, null, 2)}</pre>
                    </dd>
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {q.data && q.data.pagination.totalPages > 1 && (
        <nav aria-label="Paginação" className="flex items-center justify-between gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('prev')}
          </Button>
          <span className="text-body-sm text-fg-2">{t('pageOf', { page: q.data.pagination.page, pages: q.data.pagination.totalPages })}</span>
          <Button variant="secondary" disabled={page >= q.data.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
            {t('next')}
          </Button>
        </nav>
      )}
    </div>
  );
}
