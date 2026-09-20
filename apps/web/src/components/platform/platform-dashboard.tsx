'use client';

import { Alert, Card, Skeleton } from '@ouvion/ui';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';

import { platformApi, type TenantRow } from '@/lib/platform-client';
import { usePlatformMe } from './platform-shell';
import { MetricCard, MockNotice } from './shared';
import { TenantStatusBadge } from './tenants-view';

// Valores de DEMONSTRAÇÃO (a cobrança real chega na fase 8 do roadmap). Sempre rotulados como mock.
const MOCK = { mrr: 'R$ 48.900', arr: 'R$ 586.800', newThisMonth: '3', churn: '2,1%', ltv: 'R$ 14.200' };

export function PlatformDashboard() {
  const t = useTranslations('platform.dashboard');
  const locale = useLocale();
  const me = usePlatformMe();
  const canSeeTenants = me.role === 'SUPER_ADMIN' || me.role === 'SUPPORT';
  const q = useQuery({ queryKey: ['platform-tenants', ''], queryFn: () => platformApi.get<TenantRow[]>('tenants'), enabled: canSeeTenants });

  const users = q.data?.reduce((n, x) => n + x.counts.users, 0);
  const month = q.data?.reduce((n, x) => n + x.counts.complaintsThisMonth, 0);
  const fmt = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString(locale));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="max-w-prose text-fg-2">{t('subtitle')}</p>
      </div>
      <MockNotice />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="dashboard-cards">
        <MetricCard label={t('mrr')} value={MOCK.mrr} tone="success" mock />
        <MetricCard label={t('arr')} value={MOCK.arr} tone="success" mock />
        <MetricCard label={t('churn')} value={MOCK.churn} tone="warning" mock />
        <MetricCard label={t('ltv')} value={MOCK.ltv} tone="info" mock />
        <MetricCard label={t('newThisMonth')} value={MOCK.newThisMonth} tone="info" mock />
        {canSeeTenants && <MetricCard label={t('tenants')} value={fmt(q.data?.length)} tone="neutral" hint={t('real')} />}
        {canSeeTenants && <MetricCard label={t('users')} value={fmt(users)} tone="neutral" hint={t('real')} />}
        {canSeeTenants && <MetricCard label={t('complaints')} value={fmt(month)} tone="neutral" hint={t('real')} />}
      </div>

      {canSeeTenants && (
        <Card className="flex flex-col gap-3 p-4 sm:p-6">
          <h2 className="text-h3">{t('recent')}</h2>
          {q.isPending && <Skeleton className="h-24 w-full" />}
          {q.isError && <Alert tone="danger">{t('noTenants')}</Alert>}
          {q.data && q.data.length === 0 && <p className="text-fg-2">{t('noTenants')}</p>}
          {q.data && q.data.length > 0 && (
            <ul className="flex flex-col gap-2" data-testid="recent-tenants">
              {q.data.slice(0, 5).map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3">
                  <Link href={`/admin/empresas/${x.id}`} className="font-medium">
                    {x.companyName}
                  </Link>
                  <span className="flex flex-wrap items-center gap-4 text-body-sm text-fg-2">
                    <TenantStatusBadge status={x.status} />
                    <span>
                      {t('colComplaints')}: {x.counts.complaints}
                    </span>
                    <span>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(x.createdAt))}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
