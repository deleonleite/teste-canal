'use client';

import { Alert, Button, Card, EmptyState, Select, Skeleton } from '@ouvion/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { AuditAction } from '@ouvion/contracts';
import { staffApi, type AuditPage, type AuditSeal, type ManagedUser, type VerificationReport } from '@/lib/staff-client';
import { useMe } from './panel-shell';

const LIMIT = 25;

function BreakGlassLine({ d }: { d: Record<string, unknown> }) {
  const t = useTranslations('audit');
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '—');
  const phase = s('phase');
  return (
    <span className="mt-1 flex flex-col text-body-sm" data-testid="bg-audit-line">
      <span className="font-medium text-fg">{t.has(`phase.${phase}` as 'phase.used') ? t(`phase.${phase}` as 'phase.used') : phase}</span>
      <span className="text-fg-2">
        {phase === 'approved'
          ? t('breakGlassLine', { target: s('target'), requestedBy: s('requestedBy'), approvedBy: s('approvedBy'), reason: s('reason') })
          : phase === 'used'
            ? t('breakGlassUsed', { target: s('target'), usedBy: s('usedBy') })
            : s('target')}
      </span>
    </span>
  );
}

export function AuditView({ tenant }: { tenant: string }) {
  const t = useTranslations('audit');
  const ta = useTranslations('audit.actions');
  const locale = useLocale();
  const me = useMe();
  const api = staffApi(tenant);
  const allowed = me.role === 'ADMIN' || me.role === 'AUDITOR';
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);

  const qs = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
  if (action) qs.set('action', action);
  const logs = useQuery({ queryKey: ['audit', tenant, action, page], queryFn: () => api.get<AuditPage>(`audit?${qs}`), enabled: allowed });
  const seals = useQuery({ queryKey: ['audit-seals', tenant], queryFn: () => api.get<AuditSeal[]>('audit/seals'), enabled: allowed });
  // Só o ADMIN pode listar a equipe; para o auditor o "quem" aparece sem nome.
  const users = useQuery({ queryKey: ['users-manage', tenant], queryFn: () => api.get<ManagedUser[]>('users/manage'), enabled: me.role === 'ADMIN' });
  const verify = useMutation({ mutationFn: () => api.post<VerificationReport>('audit/verify') });

  if (!allowed) return <Alert tone="info">{t('denied')}</Alert>;

  const who = (id: string | null, anon: boolean) => (anon ? t('anonymousOrigin') : id ? (users.data?.find((u) => u.id === id)?.fullName ?? id.slice(0, 8)) : t('system'));
  const fmt = (iso: string, anon: boolean) => new Intl.DateTimeFormat(locale, anon ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="text-fg-2">{t('subtitle')}</p>
      </div>

      <Card className="flex flex-col gap-3 p-4 sm:p-6">
        <div>
          <h2 className="text-h3">{t('integrity')}</h2>
          <p className="text-body-sm text-fg-2">{t('integrityHint')}</p>
          <p className="text-body-sm text-fg-2">{seals.data ? `${t('seals')}: ${t('sealsCount', { count: seals.data.length })}` : ''}</p>
        </div>
        <Button variant="secondary" className="self-start" loading={verify.isPending} onClick={() => verify.mutate()} data-testid="audit-verify">
          {verify.isPending ? t('verifying') : t('verify')}
        </Button>
        {verify.isError && <Alert tone="danger">{t('verifyError')}</Alert>}
        {verify.data &&
          (verify.data.ok ? (
            <Alert tone="success" title={t('okTitle')}>
              <p data-testid="audit-ok">{t('okBody', { rows: verify.data.rowsChecked, seals: verify.data.sealsChecked })}</p>
            </Alert>
          ) : (
            <Alert tone="danger" title={t('problemTitle')}>
              <ul className="list-disc pl-5">
                {verify.data.problems.map((p, i) => (
                  <li key={i}>{p.detail}</li>
                ))}
              </ul>
            </Alert>
          ))}
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-[14rem]">
          <label htmlFor="audit-action" className="text-body-sm font-medium text-fg-2">
            {t('filterAction')}
          </label>
          <Select
            id="audit-action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('all')}</option>
            {AuditAction.map((a) => (
              <option key={a} value={a}>
                {ta(a)}
              </option>
            ))}
          </Select>
        </div>
        {logs.data && <p className="text-body-sm text-fg-2">{t('total', { total: logs.data.pagination.total })}</p>}
      </div>

      {logs.isPending && <Skeleton className="h-40 w-full" />}
      {logs.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {logs.data && logs.data.data.length === 0 && <EmptyState icon={ScrollText}>{t('empty')}</EmptyState>}
      {logs.data && logs.data.data.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="audit-list">
          {logs.data.data.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 rounded-md border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex flex-col">
                <span className="font-medium">
                  {ta(r.action as 'READ')} <span className="font-normal text-fg-2">· {r.resource}</span>
                </span>
                <span className="text-body-sm text-fg-2">{who(r.userId, r.anonymousOrigin)}</span>
                {r.action === 'BREAK_GLASS_PLATFORM' && r.details && <BreakGlassLine d={r.details} />}
              </span>
              <span className="inline-flex items-center gap-1 text-body-sm text-fg-2">
                {fmt(r.timestamp, r.anonymousOrigin)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {logs.data && logs.data.pagination.totalPages > 1 && (
        <nav aria-label="Paginação" className="flex items-center justify-between gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('prev')}
          </Button>
          <span className="text-body-sm text-fg-2">{t('pageOf', { page: logs.data.pagination.page, pages: logs.data.pagination.totalPages })}</span>
          <Button variant="secondary" disabled={page >= logs.data.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
            {t('next')}
          </Button>
        </nav>
      )}
    </div>
  );
}
