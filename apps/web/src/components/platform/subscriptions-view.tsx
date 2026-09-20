'use client';

import { Card } from '@ouvion/ui';
import { useTranslations } from 'next-intl';

import { MetricCard, MockNotice, RoleGate } from './shared';

// DEMONSTRAÇÃO: nomes fictícios, sem relação com empresas reais do banco.
const ROWS = [
  { company: 'Empresa Exemplo A', plan: 'ENTERPRISE', status: 'ACTIVE', mrr: 'R$ 6.900', renews: '15/10/2026' },
  { company: 'Empresa Exemplo B', plan: 'PRO', status: 'ACTIVE', mrr: 'R$ 1.900', renews: '03/11/2026' },
  { company: 'Empresa Exemplo C', plan: 'BASIC', status: 'TRIAL', mrr: 'R$ 0', renews: '28/09/2026' },
  { company: 'Empresa Exemplo D', plan: 'FREE', status: 'ACTIVE', mrr: 'R$ 0', renews: '—' },
] as const;

export function SubscriptionsView() {
  const t = useTranslations('platform.subscriptions');
  const tt = useTranslations('platform.tenants');
  return (
    <RoleGate roles={['SUPER_ADMIN', 'FINANCIAL']}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-h1">{t('title')}</h1>
          <p className="max-w-prose text-fg-2">{t('subtitle')}</p>
        </div>
        <MockNotice />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label={t('mrr')} value="R$ 48.900" tone="success" mock />
          <MetricCard label={t('arr')} value="R$ 586.800" tone="success" mock />
          <MetricCard label={t('ticket')} value="R$ 1.630" tone="info" mock />
          <MetricCard label={t('churn')} value="2,1%" tone="warning" mock />
        </div>
        <Card className="flex flex-col gap-3 p-4 sm:p-6">
          <ul className="flex flex-col gap-2" data-testid="mock-subscriptions">
            {ROWS.map((r) => (
              <li key={r.company} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3">
                <span className="font-medium">{r.company}</span>
                <span className="flex flex-wrap items-center gap-4 text-body-sm text-fg-2">
                  <span className={r.plan === 'ENTERPRISE' ? 'rounded-sm bg-plan-enterprise px-2 py-1 font-medium text-white' : 'rounded-sm bg-tint-neutral px-2 py-1 font-medium text-neutral'}>
                    {t(`plans.${r.plan}`)}
                  </span>
                  <span>{tt(r.status)}</span>
                  <span>
                    {t('colMrr')}: {r.mrr}
                  </span>
                  <span>
                    {t('colRenews')}: {r.renews}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </RoleGate>
  );
}
