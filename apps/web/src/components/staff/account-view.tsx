'use client';

import { Alert, Button, Card, Checkbox, Field, Input, Select, Skeleton } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DEFAULT_APPEARANCE, readAppearance, saveAppearance, type Appearance } from '@/lib/appearance';
import { staffApi, type NotificationPrefs, type SessionRow } from '@/lib/staff-client';
import { useMe } from './panel-shell';

export function AccountView({ tenant }: { tenant: string }) {
  const t = useTranslations('account');
  const tr = useTranslations('roles');
  const me = useMe();
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-h1">{t('title')}</h1>
      <AppearanceCard />
      <Card className="flex flex-col gap-4 p-4 sm:p-6">
        <h2 className="text-h3">{t('security')}</h2>
        <dl className="flex flex-col gap-2">
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-fg-2">{t('role')}</dt>
            <dd>{tr(me.role)}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-fg-2">{t('mfa')}</dt>
            <dd className="inline-flex items-center gap-1">
              {me.mfaEnabled ? <ShieldCheck className="h-4 w-4" aria-hidden="true" /> : <ShieldOff className="h-4 w-4" aria-hidden="true" />}
              {me.mfaEnabled ? t('mfaOn') : t('mfaOff')}
            </dd>
          </div>
        </dl>
      </Card>
      <SessionsCard tenant={tenant} />
      <NotificationsCard tenant={tenant} />
    </div>
  );
}

function AppearanceCard() {
  const t = useTranslations('account');
  const [a, setA] = useState<Appearance>(DEFAULT_APPEARANCE);
  useEffect(() => setA(readAppearance()), []);
  const set = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch };
    setA(next);
    saveAppearance(next);
  };
  return (
    <Card className="flex flex-col gap-5 p-4 sm:p-6">
      <div>
        <h2 className="text-h3">{t('appearance')}</h2>
        <p className="text-body-sm text-fg-2">{t('appearanceHint')}</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('theme')}>
          {(f) => (
            <Select {...f} value={a.theme} onChange={(e) => set({ theme: e.target.value as Appearance['theme'] })} data-testid="pref-theme">
              <option value="system">{t('themeSystem')}</option>
              <option value="light">{t('themeLight')}</option>
              <option value="dark">{t('themeDark')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('font')}>
          {(f) => (
            <Select {...f} value={a.font} onChange={(e) => set({ font: e.target.value as Appearance['font'] })} data-testid="pref-font">
              <option value="normal">{t('fontNormal')}</option>
              <option value="large">{t('fontLarge')}</option>
              <option value="xlarge">{t('fontXlarge')}</option>
            </Select>
          )}
        </Field>
      </div>
      <Checkbox checked={a.contrast === 'high'} onCheckedChange={(c) => set({ contrast: c === true ? 'high' : 'normal' })} label={t('contrast')} description={t('contrastHint')} data-testid="pref-contrast" />
      <Checkbox checked={a.motion === 'off'} onCheckedChange={(c) => set({ motion: c === true ? 'off' : 'system' })} label={t('motion')} description={t('motionHint')} data-testid="pref-motion" />
    </Card>
  );
}

function SessionsCard({ tenant }: { tenant: string }) {
  const t = useTranslations('account');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const q = useQuery({ queryKey: ['sessions', tenant], queryFn: () => api.get<SessionRow[]>('auth/sessions') });
  const end = useMutation({
    mutationFn: (id: string) => api.del(`auth/sessions/${id}`),
    onSuccess: async () => {
      toast.success(t('sessionEnded'));
      await qc.invalidateQueries({ queryKey: ['sessions', tenant] });
    },
  });
  const all = useMutation({
    mutationFn: () => api.post('auth/logout-all'),
    onSuccess: () => {
      toast.success(t('logoutAllDone'));
      router.replace(`/${tenant}/entrar`);
    },
  });
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6">
      <div>
        <h2 className="text-h3">{t('sessions')}</h2>
        <p className="text-body-sm text-fg-2">{t('sessionsHint')}</p>
      </div>
      {q.isPending && <Skeleton className="h-16 w-full" />}
      {q.isError && <Alert tone="danger">{t('sessionsError')}</Alert>}
      {q.data && (
        <ul className="flex flex-col gap-2" data-testid="sessions-list">
          {q.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3">
              <span className="flex flex-col">
                <span className="font-medium">{s.current ? t('sessionCurrent') : t('sessions')}</span>
                <span className="text-body-sm text-fg-2">{t('sessionCreated', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.createdAt)) })}</span>
              </span>
              {!s.current && (
                <Button variant="secondary" loading={end.isPending && end.variables === s.id} onClick={() => end.mutate(s.id)}>
                  {t('sessionEnd')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button variant="danger" className="self-start" loading={all.isPending} onClick={() => all.mutate()} data-testid="logout-all">
        {t('logoutAll')}
      </Button>
    </Card>
  );
}

function NotificationsCard({ tenant }: { tenant: string }) {
  const t = useTranslations('account');
  const api = staffApi(tenant);
  const q = useQuery({ queryKey: ['prefs', tenant], queryFn: () => api.get<NotificationPrefs>('notifications/preferences') });
  const [p, setP] = useState<NotificationPrefs | null>(null);
  useEffect(() => {
    if (q.data) setP(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (v: NotificationPrefs) =>
      api.put('notifications/preferences', {
        emailNotifications: v.emailNotifications,
        inAppNotifications: v.inAppNotifications,
        emailDigest: v.emailDigest,
        emailDigestTime: v.emailDigestTime,
      }),
    onSuccess: () => toast.success(t('notifSaved')),
  });
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-h3">{t('notifications')}</h2>
      {q.isPending && <Skeleton className="h-24 w-full" />}
      {q.isError && <Alert tone="danger">{t('notifError')}</Alert>}
      {p && (
        <>
          <Checkbox checked={p.inAppNotifications} onCheckedChange={(c) => setP({ ...p, inAppNotifications: c === true })} label={t('notifInApp')} />
          <Checkbox checked={p.emailNotifications} onCheckedChange={(c) => setP({ ...p, emailNotifications: c === true })} label={t('notifEmail')} />
          <Checkbox checked={p.emailDigest} onCheckedChange={(c) => setP({ ...p, emailDigest: c === true })} label={t('notifDigest')} />
          {p.emailDigest && (
            <Field label={t('notifDigestTime')} className="max-w-[12rem]">
              {(f) => <Input {...f} type="time" value={p.emailDigestTime} onChange={(e) => setP({ ...p, emailDigestTime: e.target.value })} />}
            </Field>
          )}
          <Alert tone="info">{t('notifCritical')}</Alert>
          {save.isError && <Alert tone="danger">{t('notifError')}</Alert>}
          <Button className="self-start" loading={save.isPending} onClick={() => save.mutate(p)} data-testid="prefs-save">
            {t('save')}
          </Button>
        </>
      )}
    </Card>
  );
}
