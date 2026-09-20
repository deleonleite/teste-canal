'use client';

import { Button, Card, CharCounter, EmptyState, Field, Mono, Skeleton, Textarea } from '@ouvion/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, MessageSquare, Paperclip, Send } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { api, classifyError, type ChannelMessage, type RetaliationResponse } from '@/lib/api-client';
import { approxParts } from '@/lib/timeline';
import { checkFile, validateAddendum, validateMessage, validateRetaliation } from '@/lib/validation';

interface PanelProps {
  tenant: string;
  token: string | null;
  onExpired: () => void;
}

/** Erro de escrita → texto do dicionário (§8.4/§8.6). 401 = sessão do protocolo expirada. */
function useFailureText() {
  const te = useTranslations('errors');
  return (e: unknown, onExpired: () => void): string | null => {
    const k = classifyError(e);
    if (k === 'unauthorized') {
      onExpired();
      return null;
    }
    return k === 'too_many' ? te('tooMany') : k === 'network' ? te('offline') : te('generic');
  };
}

export function MessagesPanel({ tenant, token, onExpired, onSent }: PanelProps & { onSent: () => void }) {
  const t = useTranslations('tracking');
  const tv = useTranslations('validation');
  const te = useTranslations('errors');
  const tf = useTranslations('form.step3');
  const locale = useLocale();
  const qc = useQueryClient();
  const failure = useFailureText();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const q = useQuery({
    queryKey: ['channel-messages'],
    queryFn: () => api(tenant).get<ChannelMessage[]>('public/channel/messages', token!),
    enabled: Boolean(token),
    refetchInterval: 30_000, // o comitê responde por aqui; sem notificação ao denunciante anônimo
  });

  useEffect(() => {
    if (q.error && classifyError(q.error) === 'unauthorized') onExpired();
  }, [q.error, onExpired]);

  const send = async () => {
    const invalid = validateMessage(text, (k) => tv(k));
    setError(invalid);
    if (invalid || !token) return;
    setSending(true);
    try {
      await api(tenant).post('public/channel/messages', { content: text.trim() }, token);
      setText('');
      toast.success(t('messageSent'));
      await qc.invalidateQueries({ queryKey: ['channel-messages'] });
      onSent();
    } catch (e) {
      const msg = failure(e, onExpired);
      if (msg) setError(msg);
    } finally {
      setSending(false);
    }
  };

  const sendFile = async (file: File | undefined) => {
    if (!file || !token) return;
    const verdict = checkFile(file, { anonymous: true });
    if (verdict !== 'ok') {
      toast.error(verdict === 'doc_anonymous' ? tf('docAnonymous', { name: file.name }) : te('upload'));
      return;
    }
    try {
      await api(tenant).upload('public/channel/attachments', file, token);
      toast.success(t('fileSent'));
    } catch (e) {
      const msg = failure(e, onExpired);
      if (msg) toast.error(classifyError(e) === 'bad_request' ? te('upload') : msg);
    }
  };

  const messages = q.data ?? [];

  return (
    <Card className="flex flex-col gap-6" aria-labelledby="mensagens-titulo">
      <h2 id="mensagens-titulo">{t('messagesTitle')}</h2>

      <div role="log" aria-live="polite" aria-label={t('messagesTitle')} className="flex flex-col gap-3">
        {q.isLoading ? (
          <>
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </>
        ) : messages.length === 0 ? (
          <EmptyState icon={MessageSquare}>{t('messagesEmpty')}</EmptyState>
        ) : (
          messages.map((m) => {
            const mine = m.direction === 'FROM_REPORTER';
            const p = approxParts(m.createdAt, locale);
            return (
              <div key={m.id} className={mine ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`flex max-w-[85%] flex-col gap-1 rounded-md px-4 py-3 ${mine ? 'border border-line-strong bg-surface' : 'bg-sunken'}`}>
                  <p className="text-body-sm font-medium text-fg-2">{mine ? t('fromYou') : t('fromCommittee')}</p>
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  <p className="text-body-sm text-fg-3">{t('approxAt', { date: p.date, hour: p.hour })}</p>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-6">
        <Field label={t('messageLabel')} hint={t('messageHint')} error={error}>
          {(a) => (
            <>
              <Textarea {...a} value={text} onChange={(e) => setText(e.target.value)} rows={4} data-testid="message-input" />
              <CharCounter value={text.length} max={5000} label={tv('counterLabel')} />
            </>
          )}
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button onClick={send} loading={sending} data-testid="message-send">
            <Send className="h-4 w-4" aria-hidden="true" />
            {sending ? t('sending') : t('send')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            accept=".jpg,.jpeg,.png,.gif,.pdf,.docx,.zip,image/*"
            aria-label={t('sendFile')}
            onChange={(e) => {
              void sendFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button variant="secondary" onClick={() => fileInput.current?.click()}>
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            {t('sendFile')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function AddendumSection({ tenant, token, onExpired }: PanelProps) {
  const t = useTranslations('tracking');
  const tv = useTranslations('validation');
  const failure = useFailureText();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const invalid = validateAddendum(text, (k) => tv(k));
    setError(invalid);
    if (invalid || !token) return;
    setBusy(true);
    try {
      await api(tenant).post('public/channel/addenda', { content: text.trim() }, token);
      setText('');
      toast.success(t('addendumSent'));
    } catch (e) {
      const msg = failure(e, onExpired);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <details>
        <summary className="min-h-touch cursor-pointer text-h2 font-semibold">{t('addendumTitle')}</summary>
        <div className="mt-4 flex flex-col gap-4">
          <p className="max-w-prose text-fg-2">{t('addendumBody')}</p>
          <Field label={t('addendumLabel')} error={error}>
            {(a) => <Textarea {...a} value={text} onChange={(e) => setText(e.target.value)} rows={4} />}
          </Field>
          <Button onClick={send} loading={busy} className="self-start">
            {t('addendumSend')}
          </Button>
        </div>
      </details>
    </Card>
  );
}

export function RetaliationSection({ tenant, token, onExpired }: PanelProps) {
  const t = useTranslations('tracking');
  const tr = useTranslations('receipt');
  const tc = useTranslations('common');
  const tv = useTranslations('validation');
  const failure = useFailureText();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RetaliationResponse | null>(null);

  const send = async () => {
    const invalid = validateRetaliation(text, (k) => tv(k));
    setError(invalid);
    if (invalid || !token) return;
    setBusy(true);
    try {
      setDone(await api(tenant).post<RetaliationResponse>('public/channel/retaliation', { content: text.trim() }, token));
      setText('');
    } catch (e) {
      const msg = failure(e, onExpired);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      toast.success(tc('copied'));
    } catch {
      /* o texto segue selecionável */
    }
  };

  if (done) {
    return (
      <Card className="flex flex-col gap-4">
        <h2>{t('retaliationDoneTitle')}</h2>
        <p className="text-fg-2">{t('retaliationDoneBody')}</p>
        {[[tr('protocol'), done.protocol], [tr('key'), done.accessKey]].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <p className="text-body-sm font-medium text-fg-2">{label}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Mono className="select-all break-all text-h2">{value}</Mono>
              <Button variant="secondary" onClick={() => copy(value!)} aria-label={`${tc('copy')} ${label}`}>
                <Copy className="h-4 w-4" aria-hidden="true" />
                {tc('copy')}
              </Button>
            </div>
          </div>
        ))}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <h2>{t('retaliationTitle')}</h2>
      <p className="max-w-prose text-fg-2">{t('retaliationBody')}</p>
      <Field label={t('retaliationLabel')} error={error}>
        {(a) => <Textarea {...a} value={text} onChange={(e) => setText(e.target.value)} rows={4} />}
      </Field>
      <Button onClick={send} loading={busy} className="self-start">
        {t('retaliationSend')}
      </Button>
    </Card>
  );
}
