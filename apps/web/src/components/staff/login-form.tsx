'use client';

import { Alert, Button, Checkbox, Field, Input, Mono } from '@ouvion/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '@/lib/api-client';
import { staffApi, type LoginResult } from '@/lib/staff-client';

type Step =
  | { kind: 'credentials' }
  | { kind: 'change'; token: string }
  | { kind: 'mfa'; mfaToken: string; recovery: boolean }
  | { kind: 'enroll'; enrollToken: string }
  | { kind: 'recovery'; codes: string[] };

/** Segredo (base32) dentro do otpauth://, para quem não consegue ler o QR. */
function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

export function LoginForm({ tenant, expired }: { tenant: string; expired: boolean }) {
  const t = useTranslations('login');
  const router = useRouter();
  const api = staffApi(tenant);
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string; code?: string; newPassword?: string }>({});
  const heading = useRef<HTMLHeadingElement>(null);

  // Ao trocar de etapa o foco vai ao título (leitor de tela anuncia a etapa nova).
  useEffect(() => heading.current?.focus(), [step.kind]);

  const done = () => router.replace(`/${tenant}/painel`);

  function failed(e: unknown, mfa = false) {
    if (e instanceof ApiError && e.status === 429) setError(t('locked'));
    else if (e instanceof ApiError && (e.status === 401 || e.status === 400)) setError(mfa ? t('mfaInvalid') : t('invalid'));
    else setError(t('generic'));
  }

  async function onCredentials(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const email = String(f.get('email') ?? '').trim();
    const password = String(f.get('password') ?? '');
    const next: typeof errors = {};
    if (!email) next.email = t('required');
    if (!password) next.password = t('required');
    setErrors(next);
    setError(null);
    if (next.email || next.password) return;
    setBusy(true);
    try {
      const r = await api.post<LoginResult>('auth/login', { email, password });
      if ('passwordChangeRequired' in r) setStep({ kind: 'change', token: r.token });
      else if ('mfaRequired' in r) setStep({ kind: 'mfa', mfaToken: r.mfaToken, recovery: false });
      else if ('mfaEnrollmentRequired' in r) setStep({ kind: 'enroll', enrollToken: r.enrollToken });
      else done();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  }

  async function onChange(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (step.kind !== 'change') return;
    const newPassword = String(new FormData(ev.currentTarget).get('newPassword') ?? '');
    setError(null);
    if (!newPassword) return setErrors({ newPassword: t('required') });
    setErrors({});
    setBusy(true);
    try {
      const r = await api.post<LoginResult>('auth/change-password', { token: step.token, newPassword });
      if ('mfaRequired' in r) setStep({ kind: 'mfa', mfaToken: r.mfaToken, recovery: false });
      else if ('mfaEnrollmentRequired' in r) setStep({ kind: 'enroll', enrollToken: r.enrollToken });
      else done();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t('invalid') : t('changeError'));
    } finally {
      setBusy(false);
    }
  }

  async function onMfa(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (step.kind !== 'mfa') return;
    const value = String(new FormData(ev.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setError(null);
    if (!value) return setErrors({ code: t('required') });
    setErrors({});
    setBusy(true);
    try {
      await api.post('auth/mfa/verify', { mfaToken: step.mfaToken, ...(step.recovery ? { recoveryCode: value } : { code: value }) });
      done();
    } catch (e) {
      failed(e, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {step.kind === 'credentials' && (
        <>
          <div className="flex flex-col gap-2">
            <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
              {t('title')}
            </h1>
            <p className="text-fg-2">{t('subtitle')}</p>
          </div>
          {expired && <Alert tone="info">{t('expired')}</Alert>}
          <form onSubmit={onCredentials} noValidate className="flex flex-col gap-5">
            <Field label={t('email')} error={errors.email}>
              {(a) => <Input {...a} name="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} data-testid="login-email" />}
            </Field>
            <Field label={t('password')} error={errors.password}>
              {(a) => <Input {...a} name="password" type="password" autoComplete="current-password" data-testid="login-password" />}
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" size="lg" loading={busy} data-testid="login-submit">
              {t('submit')}
            </Button>
          </form>
        </>
      )}

      {step.kind === 'change' && (
        <>
          <div className="flex flex-col gap-2">
            <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
              {t('changeTitle')}
            </h1>
            <p className="text-fg-2">{t('changeIntro')}</p>
          </div>
          <form onSubmit={onChange} noValidate className="flex flex-col gap-5">
            <Field label={t('newPassword')} hint={t('newPasswordHint')} error={errors.newPassword}>
              {(a) => <Input {...a} name="newPassword" type="password" autoComplete="new-password" data-testid="change-password" />}
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" size="lg" loading={busy} data-testid="change-submit">
              {t('changeSubmit')}
            </Button>
          </form>
        </>
      )}

      {step.kind === 'mfa' && (
        <>
          <div className="flex flex-col gap-2">
            <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
              {t('mfaTitle')}
            </h1>
            <p className="text-fg-2">{step.recovery ? t('mfaRecoveryHint') : t('mfaHint')}</p>
          </div>
          <form onSubmit={onMfa} noValidate className="flex flex-col gap-5">
            <Field label={step.recovery ? t('mfaRecovery') : t('mfaCode')} error={errors.code}>
              {(a) => (
                <Input
                  {...a}
                  key={step.recovery ? 'r' : 'c'}
                  name="code"
                  autoComplete="one-time-code"
                  inputMode={step.recovery ? 'text' : 'numeric'}
                  maxLength={step.recovery ? 20 : 6}
                  autoCapitalize="characters"
                  spellCheck={false}
                  data-testid="mfa-code"
                />
              )}
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" size="lg" loading={busy} data-testid="mfa-submit">
              {t('mfaSubmit')}
            </Button>
            <Button
              variant="link"
              onClick={() => {
                setError(null);
                setErrors({});
                setStep({ ...step, recovery: !step.recovery });
              }}
            >
              {step.recovery ? t('mfaAppLink') : t('mfaRecoveryLink')}
            </Button>
          </form>
        </>
      )}

      {step.kind === 'enroll' && <Enroll tenant={tenant} token={step.enrollToken} heading={heading} onCodes={(codes) => setStep({ kind: 'recovery', codes })} />}

      {step.kind === 'recovery' && <Recovery codes={step.codes} heading={heading} onContinue={done} />}
    </div>
  );
}

export function Enroll({ tenant, token, heading, onCodes }: { tenant: string; token: string; heading: React.RefObject<HTMLHeadingElement | null>; onCodes: (c: string[]) => void }) {
  const t = useTranslations('login');
  const api = staffApi(tenant);
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scoped = { 'x-ouvion-scoped': token };

  useEffect(() => {
    let alive = true;
    api
      .post<{ otpauthUri: string }>('auth/mfa/enroll', {}, scoped)
      .then(async (r) => {
        if (!alive) return;
        setUri(r.otpauthUri);
        // O QR é gerado aqui, no navegador: o segredo não passa por nenhum serviço externo.
        setQr(await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 }));
      })
      .catch(() => alive && setError(t('generic')));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const code = String(new FormData(ev.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('auth/mfa/activate', { code }, scoped);
      onCodes(r.recoveryCodes);
    } catch (e) {
      setError(e instanceof ApiError && (e.status === 401 || e.status === 400) ? t('mfaInvalid') : t('generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
          {t('enrollTitle')}
        </h1>
        <p className="text-fg-2">{t('enrollIntro')}</p>
      </div>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element -- data: URL gerado localmente
        <img src={qr} alt={t('enrollQrAlt')} width={220} height={220} className="self-start rounded-md border border-line bg-white p-2" />
      )}
      {uri && (
        <p className="text-body-sm text-fg-2">
          {t('enrollManual')} <Mono className="break-all text-fg">{secretOf(uri)}</Mono>
        </p>
      )}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <Field label={t('mfaCode')}>
          {(a) => <Input {...a} name="code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} data-testid="enroll-code" />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" size="lg" loading={busy} disabled={!uri} data-testid="enroll-submit">
          {t('enrollSubmit')}
        </Button>
      </form>
    </>
  );
}

export function Recovery({ codes, heading, onContinue }: { codes: string[]; heading: React.RefObject<HTMLHeadingElement | null>; onContinue: () => void }) {
  const t = useTranslations('login');
  const [saved, setSaved] = useState(false);
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
          {t('recoveryTitle')}
        </h1>
        <p className="text-fg-2">{t('recoveryIntro')}</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 rounded-md border border-line bg-sunken p-4" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <Mono>{c}</Mono>
          </li>
        ))}
      </ul>
      <Checkbox checked={saved} onCheckedChange={(c) => setSaved(c === true)} label={t('recoverySaved')} />
      <Button size="lg" disabled={!saved} onClick={onContinue} data-testid="recovery-continue">
        {t('recoveryContinue')}
      </Button>
    </>
  );
}
