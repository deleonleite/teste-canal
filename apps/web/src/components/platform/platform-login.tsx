'use client';

import { Alert, Button, Checkbox, Field, Input, Mono } from '@ouvion/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';

import { ApiError } from '@/lib/api-client';
import { platformApi, type PlatformLoginResult } from '@/lib/platform-client';

type Step =
  | { kind: 'credentials' }
  | { kind: 'change'; token: string }
  | { kind: 'mfa'; mfaToken: string; recovery: boolean }
  | { kind: 'enroll'; enrollToken: string }
  | { kind: 'recovery'; codes: string[] };

const secretOf = (uri: string): string => {
  try {
    return new URL(uri).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
};

/** Login da plataforma: senha → (troca da temporária) → 2º fator (sempre) → cadastro do 2º fator no primeiro acesso. */
export function PlatformLogin({ expired }: { expired: boolean }) {
  const t = useTranslations('platform.login');
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step.kind]);

  const done = () => router.replace('/admin/dashboard');
  const route = (r: PlatformLoginResult) => {
    if ('passwordChangeRequired' in r) setStep({ kind: 'change', token: r.token });
    else if ('mfaRequired' in r) setStep({ kind: 'mfa', mfaToken: r.mfaToken, recovery: false });
    else if ('mfaEnrollmentRequired' in r) setStep({ kind: 'enroll', enrollToken: r.enrollToken });
    else done();
  };

  async function onCredentials(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const email = String(f.get('email') ?? '').trim();
    const password = String(f.get('password') ?? '');
    const next: Record<string, string> = {};
    if (!email) next.email = t('required');
    if (!password) next.password = t('required');
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      route(await platformApi.post<PlatformLoginResult>('auth/login', { email, password }));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t('invalid') : t('generic'));
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
      route(await platformApi.post<PlatformLoginResult>('auth/change-password', { token: step.token, newPassword }));
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
      await platformApi.post('auth/mfa/verify', { mfaToken: step.mfaToken, ...(step.recovery ? { recoveryCode: value } : { code: value }) });
      done();
    } catch (e) {
      setError(e instanceof ApiError && (e.status === 401 || e.status === 400) ? t('mfaInvalid') : t('generic'));
    } finally {
      setBusy(false);
    }
  }

  const title = (key: string) => (
    <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
      {t(key as 'title')}
    </h1>
  );

  return (
    <div className="flex flex-col gap-6">
      {step.kind === 'credentials' && (
        <>
          <div className="flex flex-col gap-2">
            {title('title')}
            <p className="text-fg-2">{t('subtitle')}</p>
          </div>
          {expired && <Alert tone="info">{t('expired')}</Alert>}
          <form onSubmit={onCredentials} noValidate className="flex flex-col gap-5">
            <Field label={t('email')} error={errors.email}>
              {(a) => <Input {...a} name="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} data-testid="padm-email" />}
            </Field>
            <Field label={t('password')} error={errors.password}>
              {(a) => <Input {...a} name="password" type="password" autoComplete="current-password" data-testid="padm-password" />}
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" size="lg" loading={busy} data-testid="padm-submit">
              {t('submit')}
            </Button>
          </form>
        </>
      )}

      {step.kind === 'change' && (
        <>
          <div className="flex flex-col gap-2">
            {title('changeTitle')}
            <p className="text-fg-2">{t('changeIntro')}</p>
          </div>
          <form onSubmit={onChange} noValidate className="flex flex-col gap-5">
            <Field label={t('newPassword')} hint={t('newPasswordHint')} error={errors.newPassword}>
              {(a) => <Input {...a} name="newPassword" type="password" autoComplete="new-password" data-testid="padm-new-password" />}
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" size="lg" loading={busy} data-testid="padm-change-submit">
              {t('changeSubmit')}
            </Button>
          </form>
        </>
      )}

      {step.kind === 'mfa' && (
        <>
          <div className="flex flex-col gap-2">
            {title('mfaTitle')}
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
                  data-testid="padm-mfa-code"
                />
              )}
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" size="lg" loading={busy} data-testid="padm-mfa-submit">
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

      {step.kind === 'enroll' && <Enroll token={step.enrollToken} heading={heading} onCodes={(codes) => setStep({ kind: 'recovery', codes })} />}
      {step.kind === 'recovery' && <Recovery codes={step.codes} heading={heading} onContinue={done} />}
    </div>
  );
}

function Enroll({ token, heading, onCodes }: { token: string; heading: RefObject<HTMLHeadingElement | null>; onCodes: (c: string[]) => void }) {
  const t = useTranslations('platform.login');
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    platformApi
      .post<{ otpauthUri: string }>('auth/mfa/enroll', { enrollToken: token })
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
  }, [token, t]);

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const code = String(new FormData(ev.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setError(null);
    setBusy(true);
    try {
      const r = await platformApi.post<{ recoveryCodes: string[] }>('auth/mfa/activate', { enrollToken: token, code });
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
        <Field label={t('mfaCode')}>{(a) => <Input {...a} name="code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} data-testid="padm-enroll-code" />}</Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" size="lg" loading={busy} disabled={!uri} data-testid="padm-enroll-submit">
          {t('enrollSubmit')}
        </Button>
      </form>
    </>
  );
}

function Recovery({ codes, heading, onContinue }: { codes: string[]; heading: RefObject<HTMLHeadingElement | null>; onContinue: () => void }) {
  const t = useTranslations('platform.login');
  const [saved, setSaved] = useState(false);
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
          {t('recoveryTitle')}
        </h1>
        <p className="text-fg-2">{t('recoveryIntro')}</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 rounded-md border border-line bg-sunken p-4" data-testid="padm-recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <Mono>{c}</Mono>
          </li>
        ))}
      </ul>
      <Checkbox checked={saved} onCheckedChange={(c) => setSaved(c === true)} label={t('recoverySaved')} />
      <Button size="lg" disabled={!saved} onClick={onContinue} data-testid="padm-recovery-continue">
        {t('recoveryContinue')}
      </Button>
    </>
  );
}
