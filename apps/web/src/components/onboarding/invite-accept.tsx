'use client';

import { Alert, Button, Field, Input } from '@ouvion/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { api, ApiError } from '@/lib/api-client';
import { staffApi, type LoginResult } from '@/lib/staff-client';
import { Enroll, Recovery } from '@/components/staff/login-form';

type Step = { kind: 'password' } | { kind: 'enroll'; enrollToken: string } | { kind: 'recovery'; codes: string[] };

/**
 * Convite do primeiro ADMIN: define a PRÓPRIA senha (a OuviON nunca a conhece), abre a sessão e, se a política
 * exigir, cadastra o segundo fator — tudo neste primeiro acesso, antes de qualquer outra tela.
 */
export function InviteAccept({ tenant, token }: { tenant: string; token: string | null }) {
  const t = useTranslations('onboard.invite');
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step.kind]);

  const done = () => router.replace(`/${tenant}/painel/ativacao`);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!token) return;
    const f = new FormData(ev.currentTarget);
    const password = String(f.get('password') ?? '');
    const confirm = String(f.get('confirm') ?? '');
    const next: typeof errors = {};
    if (!password) next.password = t('required');
    if (password && confirm !== password) next.confirm = t('mismatch');
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const accepted = await api(tenant).post<{ email: string }>('public/onboarding/admin-invite', { token, password });
      try {
        const r = await staffApi(tenant).post<LoginResult>('auth/login', { email: accepted.email, password });
        if ('mfaEnrollmentRequired' in r) setStep({ kind: 'enroll', enrollToken: r.enrollToken });
        else if ('authenticated' in r) done();
        else router.replace(`/${tenant}/entrar`);
      } catch {
        setError(t('loginError'));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        const msg = (e.body as { message?: string } | null)?.message ?? '';
        setError(/inválido ou vencido/i.test(msg) ? t('invalid') : t('weak'));
      } else setError(t('generic'));
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === 'enroll') return <Enroll tenant={tenant} token={step.enrollToken} heading={heading} onCodes={(codes) => setStep({ kind: 'recovery', codes })} />;
  if (step.kind === 'recovery') return <Recovery codes={step.codes} heading={heading} onContinue={done} />;

  if (!token) {
    return (
      <div className="flex flex-col gap-4">
        <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
          {t('title')}
        </h1>
        <Alert tone="danger">{t('missingToken')}</Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
          {t('title')}
        </h1>
        <p className="text-fg-2">{t('intro')}</p>
      </div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <Field label={t('password')} hint={t('passwordHint')} error={errors.password}>
          {(a) => <Input {...a} name="password" type="password" autoComplete="new-password" data-testid="invite-password" />}
        </Field>
        <Field label={t('confirm')} error={errors.confirm}>
          {(a) => <Input {...a} name="confirm" type="password" autoComplete="new-password" data-testid="invite-confirm" />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" size="lg" loading={busy} data-testid="invite-submit">
          {t('submit')}
        </Button>
      </form>
    </div>
  );
}
