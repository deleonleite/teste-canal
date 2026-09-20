'use client';

import { Alert, Field, Input, Select, Textarea } from '@ouvion/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/staff/dialog';
import { ApiError } from '@/lib/api-client';
import { platformApi } from '@/lib/platform-client';

/** Pedido de quebra de vidro a partir do detalhe da empresa (§4.2): escopo de UM item, motivo e chamado. */
export function BreakGlassRequestDialog({ tenantId, tenantName, open, onClose }: { tenantId: string; tenantName: string; open: boolean; onClose: () => void }) {
  const t = useTranslations('platform.bg.request');
  const ts = useTranslations('platform.bg.scope');
  const router = useRouter();
  const qc = useQueryClient();
  const [scope, setScope] = useState<'COMPLAINT' | 'ATTACHMENT'>('COMPLAINT');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setScope('COMPLAINT');
    setErrors({});
    setError(null);
    onClose();
  };

  const send = useMutation({
    mutationFn: (b: Record<string, unknown>) => platformApi.post<{ id: string }>('break-glass', b),
    onSuccess: async () => {
      toast.success(t('sent'));
      await qc.invalidateQueries({ queryKey: ['break-glass'] });
      close();
      router.push('/admin/quebra-de-vidro');
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? ((e.body as { message?: string } | null)?.message ?? '') : '';
      if (e instanceof ApiError && e.status === 404) setError(t('notFound'));
      else if (/mais de um anexo/i.test(msg)) setError(t('ambiguous'));
      else setError(t('error'));
    },
  });

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const body: Record<string, unknown> = {
      tenantId,
      scope,
      protocol: String(f.get('protocol') ?? '').trim(),
      reason: String(f.get('reason') ?? '').trim(),
      ticketRef: String(f.get('ticket') ?? '').trim(),
    };
    const next: Record<string, string> = {};
    if (String(body.protocol).length < 3) next.protocol = t('required');
    if (String(body.reason).length < 20) next.reason = t('reasonMin');
    if (String(body.ticketRef).length < 3) next.ticket = t('required');
    if (scope === 'ATTACHMENT') {
      const filename = String(f.get('filename') ?? '').trim();
      if (!filename) next.filename = t('required');
      body.filename = filename;
    }
    setErrors(next);
    setError(null);
    if (Object.keys(next).length === 0) send.mutate(body);
  }

  return (
    <ConfirmDialog open={open} title={t('title')} confirmLabel={t('submit')} busy={send.isPending} onClose={close} onConfirm={() => (document.getElementById('bg-form') as HTMLFormElement | null)?.requestSubmit()}>
      <p>{t('intro', { name: tenantName })}</p>
      <form id="bg-form" onSubmit={onSubmit} noValidate className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
        <Field label={t('scope')}>
          {(a) => (
            <Select {...a} value={scope} onChange={(e) => setScope(e.target.value as 'COMPLAINT' | 'ATTACHMENT')} data-testid="bg-scope">
              <option value="COMPLAINT">{ts('COMPLAINT')}</option>
              <option value="ATTACHMENT">{ts('ATTACHMENT')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('protocol')} hint={t('protocolHint')} error={errors.protocol}>
          {(a) => <Input {...a} name="protocol" autoComplete="off" spellCheck={false} data-testid="bg-protocol" />}
        </Field>
        {scope === 'ATTACHMENT' && (
          <Field label={t('filename')} error={errors.filename}>
            {(a) => <Input {...a} name="filename" autoComplete="off" spellCheck={false} data-testid="bg-filename" />}
          </Field>
        )}
        <Field label={t('reason')} hint={t('reasonHint')} error={errors.reason}>
          {(a) => <Textarea {...a} name="reason" rows={3} data-testid="bg-reason" />}
        </Field>
        <Field label={t('ticket')} error={errors.ticket}>
          {(a) => <Input {...a} name="ticket" autoComplete="off" data-testid="bg-ticket" />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </ConfirmDialog>
  );
}

