'use client';

import { Alert, Badge, Button, Card, Field, Input, Select, Skeleton } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/staff/dialog';
import { ApiError } from '@/lib/api-client';
import { apiMessage } from '@/lib/staff-client';
import { platformApi, type InternalUser, type PlatformRole } from '@/lib/platform-client';
import { usePlatformMe } from './platform-shell';
import { RoleGate } from './shared';

const ROLES: PlatformRole[] = ['SUPER_ADMIN', 'SUPPORT', 'FINANCIAL'];
type Action = { kind: 'reset' | 'deactivate'; user: InternalUser };

export function InternalUsersView() {
  return (
    <RoleGate roles={['SUPER_ADMIN']}>
      <Users />
    </RoleGate>
  );
}

function Users() {
  const t = useTranslations('platform.users');
  const tr = useTranslations('platform.roles');
  const locale = useLocale();
  const me = usePlatformMe();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [tempPassword, setTempPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['platform-users'], queryFn: () => platformApi.get<InternalUser[]>('users') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-users'] });
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  const fail = (e: unknown) =>
    setError(e instanceof ApiError && e.status === 409 ? (apiMessage(e)?.includes('em uso') ? t('emailInUse') : t('lastAdmin')) : e instanceof ApiError && e.status === 400 ? t('passwordWeak') : t('actionError'));

  const closeAll = () => {
    setCreating(false);
    setAction(null);
    setTempPassword('');
    setErrors({});
    setError(null);
  };

  const create = useMutation({
    mutationFn: (b: { fullName: string; email: string; role: PlatformRole; password: string }) => platformApi.post('users', b),
    onSuccess: async () => {
      toast.success(t('created'));
      closeAll();
      await refresh();
    },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: PlatformRole; isActive?: boolean } }) => platformApi.patch(`users/${id}`, body),
    onSuccess: async () => {
      toast.success(t('updated'));
      closeAll();
      await refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.status === 409 ? t('lastAdmin') : t('actionError')),
  });
  const reset = useMutation({
    mutationFn: (id: string) => platformApi.post(`users/${id}/reset-password`, { password: tempPassword }),
    onSuccess: async () => {
      toast.success(t('resetDone'));
      closeAll();
      await refresh();
    },
    onError: fail,
  });

  function onCreate(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const body = { fullName: String(f.get('fullName') ?? '').trim(), email: String(f.get('email') ?? '').trim(), role: String(f.get('role')) as PlatformRole, password: String(f.get('password') ?? '') };
    const next: Record<string, string> = {};
    if (body.fullName.length < 2) next.fullName = t('required');
    if (!body.email) next.email = t('required');
    if (!body.password) next.password = t('required');
    setErrors(next);
    setError(null);
    if (Object.keys(next).length === 0) create.mutate(body);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-h1">{t('title')}</h1>
          <p className="text-fg-2">{t('subtitle')}</p>
        </div>
        <Button onClick={() => setCreating(true)} data-testid="iu-new">
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {t('new')}
        </Button>
      </div>

      <Alert tone="warning">
        <p data-testid="iu-banner">{t('banner')}</p>
      </Alert>

      {q.isPending && <Skeleton className="h-32 w-full" />}
      {q.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {q.data && (
        <ul className="flex flex-col gap-3" data-testid="iu-list">
          {q.data.map((u) => {
            const self = u.id === me.userId;
            return (
              <li key={u.id}>
                <Card className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-semibold">{u.fullName}</span>
                      {self && <span className="text-body-sm text-fg-2">{t('you')}</span>}
                      <Badge tone={u.isActive ? 'success' : 'danger'} icon={u.isActive ? CircleCheck : Ban}>
                        {u.isActive ? t('active') : t('inactive')}
                      </Badge>
                    </span>
                    <span className="break-all text-body-sm text-fg-2">{u.email}</span>
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-fg-2">
                      <span>{tr(u.role)}</span>
                      <span className="inline-flex items-center gap-1">
                        {u.mfaEnabled ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t('colMfa')}: {u.mfaEnabled ? t('mfaOn') : t('mfaOff')}
                      </span>
                      {u.mustChangePassword && <span>{t('mustChange')}</span>}
                      <span>
                        {t('colLast')}: {u.lastLoginAt ? fmt(u.lastLoginAt) : t('never')}
                      </span>
                      <span>
                        {t('colSince')}: {fmt(u.createdAt)}
                      </span>
                    </span>
                    <span className="text-body-sm text-fg-3">{t(`perms.${u.role}`)}</span>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`role-${u.id}`} className="sr-only">
                        {t('changeRole', { name: u.fullName })}
                      </label>
                      <Select id={`role-${u.id}`} value={u.role} disabled={self} onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as PlatformRole } })}>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {tr(r)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button variant="ghost" disabled={self} onClick={() => setAction({ kind: 'reset', user: u })}>
                      {t('resetPassword')}
                    </Button>
                    {u.isActive ? (
                      <Button variant="secondary" disabled={self} onClick={() => setAction({ kind: 'deactivate', user: u })}>
                        {t('deactivate')}
                      </Button>
                    ) : (
                      <Button variant="secondary" onClick={() => patch.mutate({ id: u.id, body: { isActive: true } })}>
                        {t('activate')}
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-body-sm text-fg-2">{t('notPerms')}</p>

      <ConfirmDialog open={creating} title={t('new')} confirmLabel={t('create')} busy={create.isPending} onClose={closeAll} onConfirm={() => (document.getElementById('iu-form') as HTMLFormElement | null)?.requestSubmit()}>
        <form id="iu-form" onSubmit={onCreate} noValidate className="flex flex-col gap-4">
          <Field label={t('fullName')} error={errors.fullName}>
            {(a) => <Input {...a} name="fullName" autoComplete="off" data-testid="iu-name" />}
          </Field>
          <Field label={t('email')} error={errors.email}>
            {(a) => <Input {...a} name="email" type="email" autoComplete="off" autoCapitalize="none" data-testid="iu-email" />}
          </Field>
          <Field label={t('role')}>
            {(a) => (
              <Select {...a} name="role" defaultValue="SUPPORT" data-testid="iu-role">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {tr(r)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('tempPassword')} hint={t('tempPasswordHint')} error={errors.password}>
            {(a) => <Input {...a} name="password" type="text" autoComplete="off" spellCheck={false} data-testid="iu-password" />}
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
        </form>
      </ConfirmDialog>

      <ConfirmDialog
        open={action !== null}
        title={action ? t(action.kind === 'reset' ? 'resetTitle' : 'deactivateTitle', { name: action.user.fullName }) : ''}
        confirmLabel={action ? t(action.kind === 'reset' ? 'resetPassword' : 'deactivate') : ''}
        danger
        busy={reset.isPending || patch.isPending}
        onClose={closeAll}
        onConfirm={() => {
          if (!action) return;
          if (action.kind === 'reset') {
            if (!tempPassword) return setErrors({ password: t('required') });
            setError(null);
            reset.mutate(action.user.id);
          } else patch.mutate({ id: action.user.id, body: { isActive: false } });
        }}
      >
        <p>{action ? t(action.kind === 'reset' ? 'resetBody' : 'deactivateBody') : ''}</p>
        {action?.kind === 'reset' && (
          <Field label={t('tempPassword')} hint={t('tempPasswordHint')} error={errors.password}>
            {(a) => <Input {...a} type="text" value={tempPassword} onChange={(e) => setTempPassword(e.target.value)} autoComplete="off" spellCheck={false} data-testid="iu-reset-password" />}
          </Field>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </ConfirmDialog>
    </div>
  );
}
