'use client';

import { Alert, Button, Field, Input, Mono } from '@ouvion/ui';
import { CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { api, ApiError } from '@/lib/api-client';

type Step = { kind: 'start' } | { kind: 'scan'; uri: string; qr: string } | { kind: 'done' };

const secretOf = (uri: string): string => {
  try {
    return new URL(uri).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
};

/** Destinatário alternativo (sem conta): confirma o e-mail pelo link e cadastra o próprio segundo fator. */
export function RecipientConfirm({ tenant, token }: { tenant: string; token: string | null }) {
  const t = useTranslations('onboard.recipient');
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [step.kind]);

  async function confirm() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api(tenant).post<{ otpauthUri: string }>('public/onboarding/escalation/confirm', { token });
      // O QR é gerado aqui, no navegador: o segredo não passa por nenhum serviço externo.
      setStep({ kind: 'scan', uri: r.otpauthUri, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 }) });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t('invalid') : t('generic'));
    } finally {
      setBusy(false);
    }
  }

  async function enroll(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!token) return;
    const code = String(new FormData(ev.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setBusy(true);
    setError(null);
    try {
      await api(tenant).post('public/onboarding/escalation/enroll', { token, code });
      setStep({ kind: 'done' });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t('codeInvalid') : t('generic'));
    } finally {
      setBusy(false);
    }
  }

  const title = (key: 'title' | 'scanTitle' | 'doneTitle') => (
    <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
      {t(key)}
    </h1>
  );

  if (!token) {
    return (
      <div className="flex flex-col gap-4">
        {title('title')}
        <Alert tone="danger">{t('missingToken')}</Alert>
      </div>
    );
  }

  if (step.kind === 'done') {
    return (
      <div className="flex flex-col gap-4">
        {title('doneTitle')}
        <Alert tone="success">
          <span className="inline-flex items-start gap-2" data-testid="recipient-done">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t('doneBody')}
          </span>
        </Alert>
      </div>
    );
  }

  if (step.kind === 'scan') {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          {title('scanTitle')}
          <p className="text-fg-2">{t('scanIntro')}</p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL gerado localmente */}
        <img src={step.qr} alt={t('qrAlt')} width={220} height={220} className="self-start rounded-md border border-line bg-white p-2" />
        <p className="text-body-sm text-fg-2">
          {t('manual')} <Mono className="break-all text-fg">{secretOf(step.uri)}</Mono>
        </p>
        <form onSubmit={enroll} noValidate className="flex flex-col gap-5">
          <Field label={t('code')}>{(a) => <Input {...a} name="code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} data-testid="recipient-code" />}</Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" size="lg" loading={busy} data-testid="recipient-submit">
            {t('submit')}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        {title('title')}
        <p className="text-fg-2">{t('intro')}</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button size="lg" className="self-start" loading={busy} onClick={confirm} data-testid="recipient-confirm">
        {t('confirm')}
      </Button>
    </div>
  );
}
