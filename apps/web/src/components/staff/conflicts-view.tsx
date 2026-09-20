'use client';

import { Alert, Badge, Button, Card, EmptyState, Field, Select, Skeleton, Textarea } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clock, Handshake, Ban } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { apiMessage, staffApi, type ConflictFlag, type ManagedUser } from '@/lib/staff-client';
import { ConfirmDialog } from './dialog';
import { useMe } from './panel-shell';

type Status = ConflictFlag['status'];
const STATUSES: Status[] = ['PENDING', 'CONFIRMED', 'DISMISSED'];

export function ConflictsView({ tenant }: { tenant: string }) {
  const t = useTranslations('conflicts');
  const locale = useLocale();
  const me = useMe();
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const [status, setStatus] = useState<Status>('PENDING');
  const [decision, setDecision] = useState<{ flag: ConflictFlag; kind: 'CONFIRMED' | 'DISMISSED' } | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const isAdmin = me.role === 'ADMIN';

  const flags = useQuery({ queryKey: ['conflicts', tenant, status], queryFn: () => api.get<ConflictFlag[]>(`conflicts?status=${status}`), enabled: isAdmin });
  const users = useQuery({ queryKey: ['users-manage', tenant], queryFn: () => api.get<ManagedUser[]>('users/manage'), enabled: isAdmin });
  const nameOf = (id: string) => users.data?.find((u) => u.id === id)?.fullName ?? t('unknownUser');
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  const close = () => {
    setDecision(null);
    setNote('');
    setNoteError(undefined);
    setError(null);
  };
  const decide = useMutation({
    mutationFn: (d: NonNullable<typeof decision>) => api.post(`conflicts/${d.flag.id}/decide`, { decision: d.kind, note: note.trim() }),
    onSuccess: async () => {
      toast.success(t('decided'));
      close();
      await qc.invalidateQueries({ queryKey: ['conflicts', tenant] });
    },
    onError: (e) => {
      const forbidden = e instanceof ApiError && e.status === 403;
      const done = e instanceof ApiError && e.status === 409;
      setError(forbidden ? t('ownFlag') : done ? t('alreadyDecided') : (apiMessage(e) ?? t('actionError')));
    },
  });

  if (!isAdmin) return <Alert tone="info">{t('adminOnly')}</Alert>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="max-w-prose text-fg-2">{t('subtitle')}</p>
      </div>

      <div className="max-w-xs">
        <Field label={t('filter')}>
          {(a) => (
            <Select {...a} value={status} onChange={(e) => setStatus(e.target.value as Status)} data-testid="conflict-filter">
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {flags.isPending && <Skeleton className="h-24 w-full" />}
      {flags.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {flags.data && flags.data.length === 0 && <EmptyState icon={Handshake}>{t('empty')}</EmptyState>}

      {flags.data && flags.data.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="conflict-list">
          {flags.data.map((f) => (
            <li key={f.id}>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-semibold">{nameOf(f.userId)}</span>
                  <Badge tone={f.status === 'PENDING' ? 'warning' : f.status === 'CONFIRMED' ? 'danger' : 'neutral'} icon={f.status === 'PENDING' ? Clock : f.status === 'CONFIRMED' ? Ban : CircleCheck}>
                    {t(f.status)}
                  </Badge>
                </div>
                <p className="text-body-sm text-fg-2">
                  {f.matchType === 'EMAIL' ? t('matchEmail') : t('matchName')} · {t('detected', { date: fmt(f.createdAt) })}
                </p>
                {f.decidedAt && <p className="text-body-sm text-fg-2">{t('decidedAt', { date: fmt(f.decidedAt) })}</p>}
                {f.decisionNote && <p className="text-body-sm">{t('note', { note: f.decisionNote })}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="ghost">
                    <Link href={`/${tenant}/painel/casos/${f.complaintId}`} className="no-underline hover:no-underline">
                      {t('openCase')}
                    </Link>
                  </Button>
                  {f.status === 'PENDING' && (
                    <>
                      <Button variant="secondary" onClick={() => setDecision({ flag: f, kind: 'DISMISSED' })}>
                        {t('dismiss')}
                      </Button>
                      <Button variant="danger" onClick={() => setDecision({ flag: f, kind: 'CONFIRMED' })}>
                        {t('confirm')}
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={decision !== null}
        title={decision ? t(decision.kind === 'CONFIRMED' ? 'confirmTitle' : 'dismissTitle') : ''}
        confirmLabel={decision ? t(decision.kind === 'CONFIRMED' ? 'confirm' : 'dismiss') : ''}
        danger={decision?.kind === 'CONFIRMED'}
        busy={decide.isPending}
        onClose={close}
        onConfirm={() => {
          if (!decision) return;
          if (note.trim().length < 10) return setNoteError(t('noteMin'));
          setNoteError(undefined);
          setError(null);
          decide.mutate(decision);
        }}
      >
        <p>{decision ? t(decision.kind === 'CONFIRMED' ? 'confirmBody' : 'dismissBody') : ''}</p>
        <Field label={t('noteLabel')} hint={t('noteHint')} error={noteError}>
          {(a) => <Textarea {...a} value={note} onChange={(e) => setNote(e.target.value)} rows={3} data-testid="conflict-note" />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </ConfirmDialog>
    </div>
  );
}
