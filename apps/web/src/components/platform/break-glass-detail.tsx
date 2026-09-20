'use client';

import { Alert, Button, Card, Skeleton } from '@ouvion/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { ApiError } from '@/lib/api-client';
import { platformApi, type BreakGlassContent, type BreakGlassRow } from '@/lib/platform-client';
import { StateBadge } from './break-glass-view';
import { usePlatformMe } from './platform-shell';
import { RoleGate } from './shared';

export function BreakGlassDetail({ id }: { id: string }) {
  return (
    <RoleGate roles={['SUPER_ADMIN', 'SUPPORT']}>
      <Detail id={id} />
    </RoleGate>
  );
}

const two = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => `${two(Math.floor(ms / 60_000))}:${two(Math.floor((ms % 60_000) / 1000))}`;

function Detail({ id }: { id: string }) {
  const t = useTranslations('platform.bg');
  const tv = useTranslations('platform.bg.view');
  const locale = useLocale();
  const me = usePlatformMe();
  const q = useQuery({ queryKey: ['break-glass', id], queryFn: () => platformApi.get<BreakGlassRow>(`break-glass/${id}`), refetchInterval: 15_000 });
  const [content, setContent] = useState<BreakGlassContent | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const expiresAt = q.data?.expiresAt ? new Date(q.data.expiresAt).getTime() : 0;
  const left = Math.max(0, expiresAt - now);
  const active = q.data?.state === 'ACTIVE' && left > 0;
  // Quando a janela acaba, o conteúdo some da tela na hora (nunca fica exposto depois do fim).
  useEffect(() => {
    if (q.data && !active) setContent(null);
  }, [active, q.data]);

  const read = useMutation({
    mutationFn: () => platformApi.post<BreakGlassContent>(`break-glass/${id}/read`),
    onSuccess: (c) => {
      setError(null);
      setContent(c);
      void q.refetch();
    },
    onError: () => setError(tv('readError')),
  });

  const back = (
    <Link href="/admin/quebra-de-vidro" className="inline-flex min-h-touch items-center gap-2 self-start text-body text-fg-2 no-underline hover:text-fg hover:no-underline">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {t('back')}
    </Link>
  );

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError || !q.data) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Alert tone="danger">{q.error instanceof ApiError && q.error.status === 404 ? t('notFound') : t('loadError')}</Alert>
      </div>
    );
  }

  const r = q.data;
  const mine = r.requestedBy === me.userId;
  const Row = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="flex flex-col gap-1 border-b border-line py-3 sm:flex-row sm:gap-6">
      <dt className="w-40 shrink-0 text-body-sm font-medium text-fg-2">{label}</dt>
      <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</dd>
    </div>
  );
  const none = <span className="text-fg-3">{tv('none')}</span>;

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1">{r.target}</h1>
          <StateBadge state={r.state} />
        </div>
        <p className="text-fg-2">
          {r.tenantName} · {t(`scope.${r.scope}`)} · {t('ticket')}: {r.ticketRef}
        </p>
        <p className="whitespace-pre-wrap break-words">{r.reason}</p>
      </header>

      <Alert tone="warning">
        <span className="inline-flex items-start gap-2" data-testid="bg-view-banner">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {tv('banner')}
        </span>
      </Alert>

      {active ? (
        <p className="text-h3" data-testid="bg-countdown" role="timer" aria-live="off">
          {tv('remaining', { time: clock(left) })}
        </p>
      ) : (
        <Alert tone="info">
          <p data-testid="bg-not-active">{r.state === 'ACTIVE' || r.state === 'EXPIRED' ? tv('ended') : tv('notActive')}</p>
        </Alert>
      )}

      {active && mine && !content && (
        <div className="flex flex-col gap-2">
          <Button className="self-start" loading={read.isPending} onClick={() => read.mutate()} data-testid="bg-open">
            {tv('openContent')}
          </Button>
          <p className="text-body-sm text-fg-2">{tv('openHint')}</p>
        </div>
      )}
      {active && !mine && <Alert tone="info">{tv('notYours')}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      {content?.kind === 'COMPLAINT' && (
        <Card className="p-4 sm:p-6" data-testid="bg-content">
          <dl>
            <Row label={tv('protocol')}>{content.protocol}</Row>
            <Row label={tv('title')}>{content.title}</Row>
            <Row label={tv('description')}>{content.description}</Row>
            <Row label={tv('involved')}>{content.involvedPeople.length ? content.involvedPeople.join(', ') : none}</Row>
            <Row label={tv('witnesses')}>{content.witnesses.length ? content.witnesses.join(', ') : none}</Row>
            <Row label={tv('date')}>{content.incidentDate ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(content.incidentDate)) : none}</Row>
            <Row label={tv('location')}>{content.location ?? none}</Row>
          </dl>
          <p className="pt-3 text-body-sm text-fg-2">{tv('identityNote')}</p>
          <Button variant="ghost" onClick={() => setContent(null)}>
            {tv('hideContent')}
          </Button>
        </Card>
      )}
      {content?.kind === 'ATTACHMENT' && (
        <Card className="flex flex-col gap-3 p-4 sm:p-6" data-testid="bg-content">
          <dl>
            <Row label={tv('fileName')}>{content.filename}</Row>
            <Row label={tv('fileType')}>{content.mimeType}</Row>
            <Row label={tv('fileSize')}>{(content.size / 1024).toFixed(1)} KB</Row>
          </dl>
          <Button asChild className="self-start">
            <a href={content.url} target="_blank" rel="noopener noreferrer" data-testid="bg-download">
              {tv('download')}
            </a>
          </Button>
          <p className="text-body-sm text-fg-2">{tv('downloadHint')}</p>
        </Card>
      )}
    </div>
  );
}
