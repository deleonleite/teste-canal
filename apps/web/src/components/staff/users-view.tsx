'use client';

import { Alert, Badge, Button, Card, Field, Skeleton, Textarea } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Ban, ShieldCheck, ShieldOff } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { apiMessage, staffApi, type ManagedUser } from '@/lib/staff-client';
import { ConfirmDialog } from './dialog';
import { useMe } from './panel-shell';

type Action = { kind: 'block' | 'unblock' | 'reset'; user: ManagedUser };

export function UsersView({ tenant }: { tenant: string }) {
  const t = useTranslations('users');
  const tr = useTranslations('roles');
  const locale = useLocale();
  const me = useMe();
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['users-manage', tenant], queryFn: () => api.get<ManagedUser[]>('users/manage'), enabled: me.role === 'ADMIN' });

  const close = () => {
    setAction(null);
    setReason('');
    setReasonError(undefined);
    setError(null);
  };

  const run = useMutation({
    mutationFn: (a: Action) => {
      if (a.kind === 'block') return api.post(`users/${a.user.id}/block`, { reason: reason.trim() });
      if (a.kind === 'unblock') return api.post(`users/${a.user.id}/unblock`);
      return api.post(`users/${a.user.id}/mfa/reset`);
    },
    onSuccess: async (_d, a) => {
      toast.success(t(a.kind === 'block' ? 'blockDone' : a.kind === 'unblock' ? 'unblockDone' : 'resetDone'));
      close();
      await qc.invalidateQueries({ queryKey: ['users-manage', tenant] });
    },
    onError: (e) => setError(e instanceof ApiError && e.status === 409 ? t('lastAdmin') : (apiMessage(e) ?? t('actionError'))),
  });

  function confirm() {
    if (!action) return;
    if (action.kind === 'block' && reason.trim().length < 10) return setReasonError(t('reasonMin'));
    setError(null);
    run.mutate(action);
  }

  if (me.role !== 'ADMIN') return <Alert tone="info">{t('adminOnly')}</Alert>;

  const name = action?.user.fullName ?? '';
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="text-fg-2">{t('subtitle')}</p>
      </div>

      {q.isPending && (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}
      {q.isError && <Alert tone="danger">{t('loadError')}</Alert>}

      {q.data && (
        <ul className="flex flex-col gap-3" data-testid="users-list">
          {q.data.map((u) => {
            const self = u.id === me.userId;
            return (
              <li key={u.id}>
                <Card className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-semibold">{u.fullName}</span>
                      {self && <span className="text-body-sm text-fg-2">{t('you')}</span>}
                      <Badge tone={u.isBlocked ? 'danger' : 'success'} icon={u.isBlocked ? Ban : CircleCheck}>
                        {u.isBlocked ? t('blocked') : t('active')}
                      </Badge>
                    </span>
                    <span className="break-all text-body-sm text-fg-2">{u.email}</span>
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-fg-2">
                      <span>{tr(u.role as 'ADMIN')}</span>
                      <span className="inline-flex items-center gap-1">
                        {u.mfaEnabled ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t('colMfa')}: {u.mfaEnabled ? t('mfaOn') : t('mfaOff')}
                      </span>
                      <span>
                        {t('colLastLogin')}: {u.lastLoginAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(u.lastLoginAt)) : t('never')}
                      </span>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2" role="group" aria-label={t('actionsFor', { name: u.fullName })}>
                    {u.isBlocked ? (
                      <Button variant="secondary" onClick={() => setAction({ kind: 'unblock', user: u })}>
                        {t('unblock')}
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={self} onClick={() => setAction({ kind: 'block', user: u })}>
                        {t('block')}
                      </Button>
                    )}
                    {u.mfaEnabled && (
                      <Button variant="ghost" disabled={self} onClick={() => setAction({ kind: 'reset', user: u })}>
                        {t('resetMfa')}
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={action !== null}
        title={action ? t(action.kind === 'block' ? 'blockTitle' : action.kind === 'unblock' ? 'unblockTitle' : 'resetTitle', { name }) : ''}
        confirmLabel={action ? t(action.kind === 'block' ? 'block' : action.kind === 'unblock' ? 'unblock' : 'resetMfa') : ''}
        danger={action?.kind !== 'unblock'}
        busy={run.isPending}
        onConfirm={confirm}
        onClose={close}
      >
        <p>{action ? t(action.kind === 'block' ? 'blockBody' : action.kind === 'unblock' ? 'unblockBody' : 'resetBody') : ''}</p>
        {action?.kind === 'block' && (
          <Field label={t('blockReason')} hint={t('blockReasonHint')} error={reasonError}>
            {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="block-reason" />}
          </Field>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </ConfirmDialog>
    </div>
  );
}
