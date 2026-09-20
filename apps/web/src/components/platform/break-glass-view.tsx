'use client';

import { Alert, Badge, Button, Card, EmptyState, Field, Input, Skeleton, Textarea } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck, Clock, Hourglass, ShieldAlert, ShieldOff } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/staff/dialog';
import { ApiError } from '@/lib/api-client';
import { platformApi, type BreakGlassRow } from '@/lib/platform-client';
import { usePlatformMe } from './platform-shell';
import { RoleGate } from './shared';

const STATE_ICON = { PENDING: Clock, ACTIVE: ShieldAlert, EXPIRED: Hourglass, DENIED: Ban, REVOKED: ShieldOff } as const;
const STATE_TONE = { PENDING: 'warning', ACTIVE: 'danger', EXPIRED: 'neutral', DENIED: 'neutral', REVOKED: 'neutral' } as const;

export function StateBadge({ state }: { state: BreakGlassRow['state'] }) {
  const t = useTranslations('platform.bg.state');
  return (
    <Badge tone={STATE_TONE[state]} icon={STATE_ICON[state]}>
      {t(state)}
    </Badge>
  );
}

type Action = { kind: 'approve' | 'deny' | 'revoke'; row: BreakGlassRow };

export function BreakGlassView() {
  return (
    <RoleGate roles={['SUPER_ADMIN', 'SUPPORT']}>
      <List />
    </RoleGate>
  );
}

function List() {
  const t = useTranslations('platform.bg');
  const locale = useLocale();
  const me = usePlatformMe();
  const qc = useQueryClient();
  const isAdmin = me.role === 'SUPER_ADMIN';
  const [action, setAction] = useState<Action | null>(null);
  const [minutes, setMinutes] = useState('30');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['break-glass'], queryFn: () => platformApi.get<BreakGlassRow[]>('break-glass'), refetchInterval: 20_000 });
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  const close = () => {
    setAction(null);
    setMinutes('30');
    setCode('');
    setNote('');
    setErrors({});
    setError(null);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['break-glass'] });

  const run = useMutation({
    mutationFn: (a: Action) => {
      if (a.kind === 'approve') return platformApi.post(`break-glass/${a.row.id}/approve`, { minutes: Number(minutes), code });
      return platformApi.post(`break-glass/${a.row.id}/${a.kind}`, { reason: note.trim() });
    },
    onSuccess: async (_d, a) => {
      toast.success(t(a.kind === 'approve' ? 'approved' : a.kind === 'deny' ? 'denied' : 'revoked'));
      close();
      await refresh();
    },
    onError: (e, a) => {
      if (e instanceof ApiError && e.status === 400 && a.kind === 'approve') setError(t('codeInvalid'));
      else if (e instanceof ApiError && e.status === 403) setError(t('ownRequest'));
      else if (e instanceof ApiError && e.status === 409) setError(t('alreadyDecided'));
      else setError(t('actionError'));
    },
  });

  function confirm() {
    if (!action) return;
    const next: Record<string, string> = {};
    if (action.kind === 'approve') {
      const m = Number(minutes);
      if (!Number.isInteger(m) || m < 5 || m > 60) next.minutes = t('minutesInvalid');
      if (!/^\d{6}$/.test(code.trim())) next.code = t('codeRequired');
    } else if (note.trim().length < 10) next.note = t('noteMin');
    setErrors(next);
    setError(null);
    if (Object.keys(next).length === 0) run.mutate({ ...action, row: action.row });
  }

  const rows = q.data ?? [];
  const pending = rows.filter((r) => r.state === 'PENDING');
  const active = rows.filter((r) => r.state === 'ACTIVE');
  const history = rows.filter((r) => r.state !== 'PENDING' && r.state !== 'ACTIVE');

  const Item = ({ r }: { r: BreakGlassRow }) => (
    <li>
      <Card className="flex flex-col gap-3 p-4" data-testid="bg-item">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={r.state} />
          <span className="font-semibold">{r.target}</span>
          <span className="text-body-sm text-fg-2">
            {r.tenantName} · {t(`scope.${r.scope}`)}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words">{r.reason}</p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-fg-2">
          <span>
            {t('ticket')}: {r.ticketRef}
          </span>
          <span>{t('requestedBy', { name: r.requestedByName ?? '—' })}</span>
          {r.approvedByName && <span>{t('approvedBy', { name: r.approvedByName })}</span>}
          {r.expiresAt && <span>{t('expires', { date: date(r.expiresAt) })}</span>}
          <span>{t('uses', { count: r.uses })}</span>
        </p>
        {r.decisionNote && <p className="text-body-sm text-fg-2">{r.decisionNote}</p>}
        <div className="flex flex-wrap gap-2">
          {r.state === 'ACTIVE' && r.requestedBy === me.userId && (
            <Button asChild variant="secondary">
              <Link href={`/admin/quebra-de-vidro/${r.id}`} aria-label={t('openRequest', { target: r.target })} className="no-underline hover:no-underline">
                {t('open')}
              </Link>
            </Button>
          )}
          {isAdmin && r.state === 'PENDING' && (
            <>
              <Button variant="secondary" onClick={() => setAction({ kind: 'deny', row: r })}>
                {t('deny')}
              </Button>
              <Button onClick={() => setAction({ kind: 'approve', row: r })} data-testid="bg-approve">
                {t('approve')}
              </Button>
            </>
          )}
          {isAdmin && r.state === 'ACTIVE' && (
            <Button variant="danger" onClick={() => setAction({ kind: 'revoke', row: r })} data-testid="bg-revoke">
              {t('revoke')}
            </Button>
          )}
        </div>
      </Card>
    </li>
  );

  const Section = ({ title, items, empty, testId }: { title: string; items: BreakGlassRow[]; empty: string; testId: string }) => (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="text-h3">{title}</h2>
      {items.length === 0 ? <p className="text-fg-2">{empty}</p> : <ul className="flex flex-col gap-3" data-testid={testId}>{items.map((r) => <Item key={r.id} r={r} />)}</ul>}
    </section>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="max-w-prose text-fg-2">{t('subtitle')}</p>
      </div>
      <Alert tone="warning">
        <p data-testid="bg-rules">{t('rules')}</p>
      </Alert>

      {q.isPending && <Skeleton className="h-32 w-full" />}
      {q.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {q.data && rows.length === 0 && <EmptyState icon={CircleCheck}>{t('emptyHistory')}</EmptyState>}
      {q.data && rows.length > 0 && (
        <>
          <Section title={t('pendingTitle')} items={pending} empty={t('emptyPending')} testId="bg-pending" />
          <Section title={t('activeTitle')} items={active} empty={t('emptyActive')} testId="bg-active" />
          <Section title={t('historyTitle')} items={history} empty={t('emptyHistory')} testId="bg-history" />
        </>
      )}

      <ConfirmDialog
        open={action !== null}
        title={action ? t(action.kind === 'approve' ? 'approveTitle' : action.kind === 'deny' ? 'denyTitle' : 'revokeTitle', { target: action.row.target }) : ''}
        confirmLabel={action ? t(action.kind) : ''}
        danger={action?.kind !== 'approve'}
        busy={run.isPending}
        onClose={close}
        onConfirm={confirm}
      >
        <p>{action ? t(action.kind === 'approve' ? 'approveBody' : action.kind === 'deny' ? 'denyBody' : 'revokeBody') : ''}</p>
        {action?.kind === 'approve' ? (
          <>
            <Field label={t('minutes')} hint={t('minutesHint')} error={errors.minutes}>
              {(a) => <Input {...a} type="number" min={5} max={60} value={minutes} onChange={(e) => setMinutes(e.target.value)} data-testid="bg-minutes" />}
            </Field>
            <Field label={t('code')} hint={t('codeHint')} error={errors.code}>
              {(a) => <Input {...a} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} data-testid="bg-code" />}
            </Field>
          </>
        ) : action ? (
          <Field label={t('noteLabel')} hint={t('noteHint')} error={errors.note}>
            {(a) => <Textarea {...a} value={note} onChange={(e) => setNote(e.target.value)} rows={3} data-testid="bg-note" />}
          </Field>
        ) : null}
        {error && <Alert tone="danger">{error}</Alert>}
      </ConfirmDialog>
    </div>
  );
}
