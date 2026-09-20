'use client';

import { Alert, Badge, Card, EmptyState, Select, Skeleton } from '@ouvion/ui';
import { useQuery } from '@tanstack/react-query';
import { Ban, Building2, CircleCheck, Clock, XCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';

import { platformApi, type TenantRow } from '@/lib/platform-client';
import { RoleGate } from './shared';

const STATUSES = ['ACTIVE', 'TRIAL', 'SUSPENDED', 'CANCELLED'] as const;

/** Situação com ícone + texto (nunca só cor). */
export function TenantStatusBadge({ status }: { status: TenantRow['status'] }) {
  const t = useTranslations('platform.tenants');
  const map = {
    ACTIVE: { tone: 'success', icon: CircleCheck },
    TRIAL: { tone: 'info', icon: Clock },
    SUSPENDED: { tone: 'danger', icon: Ban },
    CANCELLED: { tone: 'neutral', icon: XCircle },
  } as const;
  const s = map[status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {t(status)}
    </Badge>
  );
}

export function TenantsView() {
  return (
    <RoleGate roles={['SUPER_ADMIN', 'SUPPORT']}>
      <TenantsList />
    </RoleGate>
  );
}

function TenantsList() {
  const t = useTranslations('platform.tenants');
  const locale = useLocale();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q.trim()) qs.set('q', q.trim());
  const list = useQuery({ queryKey: ['platform-tenants', qs.toString()], queryFn: () => platformApi.get<TenantRow[]>(`tenants${qs.size ? `?${qs}` : ''}`) });

  const count = (s: string) => (list.data ?? []).filter((x) => x.status === s).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="max-w-prose text-fg-2">{t('subtitle')}</p>
      </div>

      {!status && !q && list.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="tenant-stats">
          {STATUSES.map((s) => (
            <div key={s} className="flex flex-col gap-1 rounded-md border border-line bg-surface p-3">
              <span className="text-body-sm text-fg-2">{t(s)}</span>
              <span className="text-h2">{count(s)}</span>
            </div>
          ))}
        </div>
      )}

      <form role="search" className="flex flex-wrap items-end gap-4" onSubmit={(e) => e.preventDefault()}>
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <label htmlFor="t-search" className="text-body-sm font-medium text-fg-2">
            {t('search')}
          </label>
          <input
            id="t-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            className="min-h-touch w-full rounded-sm border border-line-strong bg-surface px-3 text-body text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex min-w-[10rem] flex-col gap-1">
          <label htmlFor="t-status" className="text-body-sm font-medium text-fg-2">
            {t('status')}
          </label>
          <Select id="t-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('all')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(s)}
              </option>
            ))}
          </Select>
        </div>
      </form>

      <p className="text-body-sm text-fg-2">{t('countsHint')}</p>
      {list.isPending && <Skeleton className="h-32 w-full" />}
      {list.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {list.data && list.data.length === 0 && <EmptyState icon={Building2}>{t('empty')}</EmptyState>}
      {list.data && list.data.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="tenant-list">
          {list.data.map((x) => (
            <li key={x.id}>
              <Card className="p-0">
                <Link
                  href={`/admin/empresas/${x.id}`}
                  aria-label={t('open', { name: x.companyName })}
                  className="flex flex-col gap-3 rounded-md p-4 no-underline hover:bg-sunken hover:no-underline lg:flex-row lg:items-center lg:justify-between"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-body font-semibold text-fg">{x.companyName}</span>
                    <span className="font-mono text-body-sm text-fg-2">{x.slug}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body-sm text-fg-2">
                    <TenantStatusBadge status={x.status} />
                    <span>
                      {t('colUsers')}: {x.counts.users}
                    </span>
                    <span>
                      {t('colComplaints')}: {x.counts.complaints}
                    </span>
                    <span>
                      {t('colCreated')}: {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(x.createdAt))}
                    </span>
                  </span>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
