'use client';

import { Alert, Badge, Button, Card, Field, Input, Skeleton } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';

import { staffApi, type ActivationStatus } from '@/lib/staff-client';
import { useMe } from './panel-shell';

const RECIPIENT_MISSING = ['escalationRecipient.configured', 'escalationRecipient.emailVerified', 'escalationRecipient.secondFactor'];

function Step({ title, done, children, id }: { title: string; done: boolean; children: ReactNode; id: string }) {
  const t = useTranslations('onboard.activation');
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-h3" id={id}>
          {title}
        </h2>
        <Badge tone={done ? 'success' : 'warning'} icon={done ? CircleCheck : Clock}>
          {done ? t('done') : t('pending')}
        </Badge>
      </div>
      {children}
    </Card>
  );
}

export function ActivationView({ tenant }: { tenant: string }) {
  const t = useTranslations('onboard.activation');
  const me = useMe();
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['activation', tenant], queryFn: () => api.get<ActivationStatus>('onboarding/activation'), enabled: me.role === 'ADMIN' });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['activation', tenant] }), qc.invalidateQueries({ queryKey: ['me', tenant] })]);

  const recipient = useMutation({
    mutationFn: (email: string) => api.put<{ devConfirmUrl?: string }>('onboarding/escalation-recipient', { email }),
    onSuccess: async (r) => {
      toast.success(t('recipientSaved'));
      setDevLink(r.devConfirmUrl ?? null);
      await refresh();
    },
    onError: () => setError(t('recipientError')),
  });
  const dpo = useMutation({
    mutationFn: (b: { name: string; email: string }) => api.put('onboarding/dpo', b),
    onSuccess: async () => {
      toast.success(t('dpoSaved'));
      await refresh();
    },
    onError: () => setError(t('dpoError')),
  });
  const activate = useMutation({
    mutationFn: () => api.post('onboarding/activate'),
    onSuccess: async () => {
      toast.success(t('activated'));
      await refresh();
    },
    onError: () => setError(t('activateError')),
  });

  if (me.role !== 'ADMIN') return <Alert tone="info">{t('adminOnly')}</Alert>;
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return <Alert tone="danger">{t('loadError')}</Alert>;

  const a = q.data;
  if (a.tenantStatus === 'ACTIVE') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-h1">{t('title')}</h1>
        <Alert tone="success" title={t('active')}>
          <p data-testid="activation-active">{t('activeBody')}</p>
        </Alert>
      </div>
    );
  }

  const mfaDone = !a.missing.includes('admin.mfa');
  const recipientDone = !a.missing.some((m) => RECIPIENT_MISSING.includes(m));
  const dpoDone = !a.missing.includes('dpo.informed');
  const recipientNote = a.missing.includes('escalationRecipient.configured')
    ? null
    : a.missing.includes('escalationRecipient.emailVerified')
      ? t('recipientAwaitingEmail')
      : a.missing.includes('escalationRecipient.secondFactor')
        ? t('recipientAwaitingFactor')
        : t('recipientDone', { email: a.escalationRecipientEmail ?? '' });

  function onRecipient(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const email = String(new FormData(ev.currentTarget).get('email') ?? '').trim();
    setError(null);
    if (!email) return setErrors({ email: t('required') });
    setErrors({});
    recipient.mutate(email);
  }
  function onDpo(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const body = { name: String(f.get('name') ?? '').trim(), email: String(f.get('email') ?? '').trim() };
    const next: Record<string, string> = {};
    if (!body.name) next.dpoName = t('required');
    if (!body.email) next.dpoEmail = t('required');
    setErrors(next);
    setError(null);
    if (Object.keys(next).length === 0) dpo.mutate(body);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h1">{t('title')}</h1>
        <p className="text-fg-2">{t('subtitle')}</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}

      <Step id="st-mfa" title={t('stepMfa')} done={mfaDone}>
        <p className="text-fg-2">{mfaDone ? t('stepMfaDone') : t('stepMfaPending')}</p>
      </Step>

      <Step id="st-rec" title={t('stepRecipient')} done={recipientDone}>
        <p className="max-w-prose text-fg-2">{t('stepRecipientHint')}</p>
        {recipientNote && <p data-testid="recipient-note">{recipientNote}</p>}
        <form onSubmit={onRecipient} noValidate className="flex flex-col gap-4">
          <Field label={t('recipientEmail')} error={errors.email}>
            {(f) => <Input {...f} name="email" type="email" autoComplete="off" autoCapitalize="none" data-testid="recipient-email" />}
          </Field>
          <Button type="submit" variant="secondary" className="self-start" loading={recipient.isPending} data-testid="recipient-save">
            {a.escalationRecipientEmail ? t('recipientResend') : t('recipientSend')}
          </Button>
        </form>
        {devLink && (
          <Alert tone="info" title={t('devLinkTitle')}>
            <p>{t('devLinkBody')}</p>
            <a href={devLink} className="break-all" data-testid="recipient-dev-link">
              {devLink}
            </a>
          </Alert>
        )}
      </Step>

      <Step id="st-dpo" title={t('stepDpo')} done={dpoDone}>
        <p className="text-fg-2">{t('stepDpoHint')}</p>
        {a.dpo && <p data-testid="dpo-note">{t('dpoDone', { name: a.dpo.name, email: a.dpo.email })}</p>}
        <form onSubmit={onDpo} noValidate className="grid gap-4 sm:grid-cols-2">
          <Field label={t('dpoName')} error={errors.dpoName}>
            {(f) => <Input {...f} name="name" autoComplete="off" data-testid="dpo-name" />}
          </Field>
          <Field label={t('dpoEmail')} error={errors.dpoEmail}>
            {(f) => <Input {...f} name="email" type="email" autoComplete="off" autoCapitalize="none" data-testid="dpo-email" />}
          </Field>
          <Button type="submit" variant="secondary" className="self-start sm:col-span-2" loading={dpo.isPending} data-testid="dpo-save">
            {t('dpoSave')}
          </Button>
        </form>
      </Step>

      <div className="flex flex-col gap-2">
        <Button size="lg" className="self-start" disabled={!a.ready} loading={activate.isPending} onClick={() => (setError(null), activate.mutate())} data-testid="activate">
          {t('activate')}
        </Button>
        {!a.ready && <p className="text-body-sm text-fg-2">{t('activateBlocked')}</p>}
      </div>
    </div>
  );
}
