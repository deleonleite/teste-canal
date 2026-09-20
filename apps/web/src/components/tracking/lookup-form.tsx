'use client';

import { Alert, Button, Card, Field, Input } from '@ouvion/ui';
import { useTranslations } from 'next-intl';
import { useState, type ClipboardEvent, type FormEvent } from 'react';

import { api, classifyError, type LookupResponse } from '@/lib/api-client';
import { isAccessKeyComplete, isProtocolComplete, normalizeAccessKey, normalizeProtocol } from '@/lib/normalize';

/**
 * Consulta por protocolo + chave (§5.2.2). Todo erro de consulta mostra o MESMO texto genérico
 * (§8.4): nada diferencia protocolo inexistente de chave errada. Colar com espaços/hífens/quebras é normalizado.
 */
export function LookupForm({
  tenant, initialProtocol, lockProtocol, title, body, onFound,
}: {
  tenant: string;
  initialProtocol: string;
  lockProtocol?: boolean;
  title?: string;
  body?: string;
  onFound: (d: LookupResponse) => void;
}) {
  const t = useTranslations('tracking');
  const te = useTranslations('errors');
  const tv = useTranslations('validation');
  const [protocol, setProtocol] = useState(initialProtocol);
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<{ protocol?: string; key?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const paste = (setter: (v: string) => void, norm: (v: string) => string) => (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    setter(norm(e.clipboardData.getData('text')));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    const next = {
      protocol: isProtocolComplete(protocol) ? undefined : tv('protocol'),
      key: isAccessKeyComplete(key) ? undefined : tv('accessKey'),
    };
    setErrors(next);
    if (next.protocol || next.key) return;
    setBusy(true);
    try {
      const data = await api(tenant).post<LookupResponse>('public/complaints/lookup', { protocol: normalizeProtocol(protocol), accessKey: normalizeAccessKey(key) });
      setKey(''); // a chave não fica em estado depois de usada
      onFound(data);
    } catch (err) {
      const kind = classifyError(err);
      setFailure(kind === 'too_many' ? te('tooMany') : kind === 'network' ? te('offline') : kind === 'not_found' ? te('lookupNotFound') : te('generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1>{title ?? t('lookupTitle')}</h1>
        <p className="text-fg-2">{body ?? t('lookupBody')}</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label={t('protocol')} error={errors.protocol}>
          {(a) => (
            <Input
              {...a}
              value={protocol}
              readOnly={lockProtocol}
              onChange={(e) => setProtocol(normalizeProtocol(e.target.value))}
              onPaste={paste(setProtocol, normalizeProtocol)}
              onBlur={() => setErrors((s) => ({ ...s, protocol: protocol && !isProtocolComplete(protocol) ? tv('protocol') : undefined }))}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="DEN-2026-A1B2C3"
              className="font-mono uppercase tracking-wide"
              data-testid="lookup-protocol"
            />
          )}
        </Field>
        <Field label={t('key')} hint={t('keyHint')} error={errors.key}>
          {(a) => (
            <Input
              {...a}
              value={key}
              onChange={(e) => setKey(normalizeAccessKey(e.target.value))}
              onPaste={paste(setKey, normalizeAccessKey)}
              onBlur={() => setErrors((s) => ({ ...s, key: key && !isAccessKeyComplete(key) ? tv('accessKey') : undefined }))}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
              className="font-mono uppercase tracking-wide"
              type="text"
              data-testid="lookup-key"
            />
          )}
        </Field>
        {failure && (
          <Alert tone="danger">
            <p>{failure}</p>
          </Alert>
        )}
        <Button type="submit" size="lg" className="self-start" loading={busy}>
          {busy ? t('lookingUp') : t('lookup')}
        </Button>
      </form>
    </Card>
  );
}
