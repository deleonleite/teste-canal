'use client';

import { Alert, Button, Card, Mono, StatusBadge, Timeline, type TimelineItem } from '@ouvion/ui';
import { CalendarClock, LogOut, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { api, type LookupResponse } from '@/lib/api-client';
import { useTracking } from '@/lib/stores';
import { approxParts, buildMilestones, longDate } from '@/lib/timeline';
import { LookupForm } from './lookup-form';
import { AddendumSection, MessagesPanel, RetaliationSection } from './panels';

export function TrackingView({ tenant, initialProtocol }: { tenant: string; initialProtocol: string }) {
  const tracking = useTracking();
  const [expired, setExpired] = useState(false);

  if (!tracking.data) {
    return <LookupForm tenant={tenant} initialProtocol={initialProtocol} onFound={(d) => tracking.set(d)} />;
  }
  return <Details tenant={tenant} data={tracking.data} expired={expired} setExpired={setExpired} />;
}

function Details({ tenant, data, expired, setExpired }: { tenant: string; data: LookupResponse; expired: boolean; setExpired: (b: boolean) => void }) {
  const t = useTranslations('tracking');
  const ts = useTranslations('status');
  const tt = useTranslations('types');
  const locale = useLocale();
  const tracking = useTracking();
  const token = tracking.sessionToken;
  const [refreshing, setRefreshing] = useState(false);

  const milestones = buildMilestones(data.timeline, data.status);
  const final = data.status === 'RESOLVED' || data.status === 'DISMISSED' ? data.status : null;

  const items: TimelineItem[] = milestones.map((m) => {
    const label = m.key === 'CLOSED' ? (final ? ts(final) : t('milestones.CLOSED')) : t(`milestones.${m.key}`);
    const body = m.state === 'current' || (m.key === 'CLOSED' && m.state === 'done') ? t(`milestoneBody.${m.key === 'CLOSED' ? (final ?? 'DISMISSED') : m.key}`) : undefined;
    const when = m.at ? (() => { const p = approxParts(m.at!, locale); return t('approxAt', { date: p.date, hour: p.hour }); })() : undefined;
    return {
      key: m.key,
      state: m.state,
      title: label,
      meta: [body, when].filter(Boolean).join(' · ') || undefined,
    };
  });

  // Atualiza a situação pela sessão do protocolo (sem pedir a chave de novo). 401 = sessão de 30 min expirou.
  const refresh = async () => {
    if (!token) return setExpired(true);
    setRefreshing(true);
    try {
      const s = await api(tenant).get<Omit<LookupResponse, 'sessionToken'>>('public/channel/summary', token);
      tracking.set({ ...s, sessionToken: token });
    } catch {
      setExpired(true);
    } finally {
      setRefreshing(false);
    }
  };

  if (expired) {
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="warning" title={t('sessionExpiredTitle')}>
          <p>{t('sessionExpiredBody')}</p>
        </Alert>
        <LookupForm
          tenant={tenant}
          initialProtocol={data.protocol}
          lockProtocol
          onFound={(d) => {
            tracking.set(d);
            setExpired(false);
            toast.success(t('reauthDone'));
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1>{t('yourReport')}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <Mono className="text-h2" data-testid="tracking-protocol">
              {data.protocol}
            </Mono>
            <StatusBadge status={data.status} label={ts(data.status)} />
          </div>
          <p className="text-body-sm text-fg-2">
            {t('type')}: {tt(data.type as 'FRAUD')} · {t('sentOn')} {longDate(data.createdAt, locale)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={refresh} loading={refreshing}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('refresh')}
          </Button>
          <Button variant="ghost" onClick={() => tracking.clear()}>
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t('leave')}
          </Button>
        </div>
      </div>

      <Card className="flex flex-col gap-6">
        <h2>{t('timelineTitle')}</h2>
        <Timeline items={items} srCurrent={t('sr.current')} srDone={t('sr.done')} srUpcoming={t('sr.upcoming')} />
        {(data.ackDueAt || data.feedbackDueAt) && (
          <div className="flex flex-col gap-2 border-t border-line pt-4 text-body-sm text-fg-2">
            {data.ackDueAt && (
              <p className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t('deadlineAck', { date: longDate(data.ackDueAt, locale) })}
              </p>
            )}
            {data.feedbackDueAt && (
              <p className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t('deadlineFeedback', { date: longDate(data.feedbackDueAt, locale) })}
              </p>
            )}
          </div>
        )}
      </Card>

      <MessagesPanel tenant={tenant} token={token} onExpired={() => setExpired(true)} onSent={refresh} />
      <AddendumSection tenant={tenant} token={token} onExpired={() => setExpired(true)} />
      {data.canReportRetaliation && <RetaliationSection tenant={tenant} token={token} onExpired={() => setExpired(true)} />}
    </div>
  );
}
