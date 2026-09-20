'use client';

import { Alert, Button, Card, EmptyState, PriorityBadge, Select, Skeleton, SlaBadge, StatusBadge } from '@ouvion/ui';
import { useQuery } from '@tanstack/react-query';
import { EyeOff, FolderOpen, Lock, UserCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';

import { longDate } from '@/lib/timeline';
import { staffApi, type CaseList, type CaseRow } from '@/lib/staff-client';

const STATUSES = ['PENDING', 'IN_PROGRESS', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED', 'DISMISSED'] as const;
const TYPES = ['HARASSMENT', 'DISCRIMINATION', 'FRAUD', 'CORRUPTION', 'SAFETY', 'ETHICS', 'OTHER'] as const;
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const SLAS = ['on_time', 'at_risk', 'breached'] as const;
const LIMIT = 20;

interface Filters {
  status: string;
  type: string;
  priority: string;
  sla: string;
}
const NO_FILTERS: Filters = { status: '', type: '', priority: '', sla: '' };

/** Estado do prazo que mais urge: vencido > perto de vencer > pausado > no prazo (só casos abertos). */
export function worstSla(sla: CaseRow['sla']): string {
  const states = [sla.ack.state, sla.feedback.state];
  for (const s of ['BREACHED', 'AT_RISK', 'PAUSED', 'ON_TIME'] as const) if (states.includes(s)) return s;
  return states.includes('DONE') ? 'DONE' : 'N/A';
}

export function CaseListView({ tenant }: { tenant: string }) {
  const t = useTranslations('cases');
  const ts = useTranslations('status');
  const tt = useTranslations('types');
  const tp = useTranslations('priority');
  const tsla = useTranslations('slaState');
  const locale = useLocale();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);

  const qs = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);

  const q = useQuery({ queryKey: ['cases', tenant, filters, page], queryFn: () => staffApi(tenant).get<CaseList>(`complaints?${qs}`) });
  const hasFilter = Object.values(filters).some(Boolean);
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  const filterSelect = (k: keyof Filters, label: string, options: Array<[string, string]>) => (
    <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
      <label htmlFor={`f-${k}`} className="text-body-sm font-medium text-fg-2">
        {label}
      </label>
      <Select id={`f-${k}`} value={filters[k]} onChange={set(k)}>
        <option value="">{t('all')}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="text-fg-2" aria-live="polite">
          {q.data ? t('subtitle', { total: q.data.pagination.total }) : ' '}
        </p>
      </div>

      <form role="search" aria-label={t('filters')} className="flex flex-wrap items-end gap-4" onSubmit={(e) => e.preventDefault()}>
        {filterSelect('status', t('status'), STATUSES.map((s) => [s, ts(s)]))}
        {filterSelect('type', t('type'), TYPES.map((s) => [s, tt(s)]))}
        {filterSelect('priority', t('priority'), PRIORITIES.map((s) => [s, tp(s)]))}
        {filterSelect('sla', t('sla'), SLAS.map((s) => [s, t(`sla_${s}` as 'sla_on_time')]))}
        {hasFilter && (
          <Button
            variant="ghost"
            onClick={() => {
              setFilters(NO_FILTERS);
              setPage(1);
            }}
          >
            {t('clear')}
          </Button>
        )}
      </form>

      {q.isPending && (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {q.isError && (
        <Alert tone="danger">
          <p>{t('loadError')}</p>
          <Button variant="secondary" onClick={() => q.refetch()} className="mt-2 self-start">
            {t('retry')}
          </Button>
        </Alert>
      )}

      {q.data && q.data.data.length === 0 && <EmptyState icon={FolderOpen}>{hasFilter ? t('emptyFiltered') : t('emptyAll')}</EmptyState>}

      {q.data && q.data.data.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="case-list">
          {q.data.data.map((c) => {
            const sla = worstSla(c.sla);
            return (
              <li key={c.id}>
                <Card className="p-0">
                  <Link
                    href={`/${tenant}/painel/casos/${c.id}`}
                    aria-label={t('open', { protocol: c.protocol })}
                    className="flex flex-col gap-3 rounded-md p-4 no-underline hover:bg-sunken hover:no-underline lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-fg-2">
                        <span className="font-mono font-semibold text-fg">{c.protocol}</span>
                        <span>{tt(c.type as (typeof TYPES)[number])}</span>
                        <span>{longDate(c.createdAt, locale)}</span>
                        <span className="inline-flex items-center gap-1">
                          {c.isAnonymous ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />}
                          {c.isAnonymous ? t('anonymous') : t('identified')}
                        </span>
                        {c.isRestricted && (
                          <span className="inline-flex items-center gap-1">
                            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('restricted')}
                          </span>
                        )}
                      </span>
                      <span className="truncate text-body font-medium text-fg">{c.title}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={c.status} label={ts(c.status as (typeof STATUSES)[number])} />
                      <PriorityBadge priority={c.priority} label={tp(c.priority as (typeof PRIORITIES)[number])} />
                      {sla !== 'N/A' && <SlaBadge state={sla} label={tsla(sla as 'ON_TIME')} />}
                    </div>
                  </Link>
                </Card>
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
