'use client';

import { Alert, Button, EmptyState, Field, ScanBadge, Skeleton, Textarea } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Link2, Paperclip, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { apiMessage, staffApi, type AttachmentRow, type CaseDetail, type RelatedSuggestion } from '@/lib/staff-client';
import { ConfirmDialog } from './dialog';

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ── Anexos ───────────────────────────────────────────────────────────────────────
export function AttachmentsTab({ tenant, id, canWrite, canVerify }: { tenant: string; id: string; canWrite: boolean; canVerify: boolean }) {
  const t = useTranslations('attachments');
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const input = useRef<HTMLInputElement>(null);
  const [toRemove, setToRemove] = useState<AttachmentRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyMsg, setVerifyMsg] = useState<{ id: string; ok: boolean } | null>(null);
  const key = ['attachments', tenant, id];

  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<AttachmentRow[]>(`complaints/${id}/attachments`),
    // Enquanto algum arquivo espera a varredura, confere de novo a cada 5 s.
    refetchInterval: (query) => (query.state.data?.some((a) => a.scanStatus === 'PENDING') ? 5000 : false),
  });

  const upload = useMutation({
    mutationFn: (f: File) => api.upload(`complaints/${id}/attachments`, f),
    onSuccess: async () => {
      toast.success(t('uploaded'));
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: () => setError(t('uploadError')),
  });
  const remove = useMutation({
    mutationFn: (a: AttachmentRow) => api.del(`complaints/${id}/attachments/${a.id}`),
    onSuccess: async () => {
      toast.success(t('removed'));
      setToRemove(null);
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: () => setError(t('actionError')),
  });
  const verify = useMutation({
    mutationFn: (a: AttachmentRow) => api.post<{ ok: boolean }>(`complaints/${id}/attachments/${a.id}/verify`),
    onSuccess: (r, a) => setVerifyMsg({ id: a.id, ok: r.ok }),
    onError: () => setError(t('verifyError')),
  });

  async function download(a: AttachmentRow) {
    setError(null);
    try {
      // URL pré-assinada e temporária: o arquivo não passa pelo nosso servidor de páginas.
      const r = await api.get<{ url: string }>(`complaints/${id}/attachments/${a.id}/download`);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(apiMessage(e) ?? t('actionError'));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-fg-2">{t('hint')}</p>
      {canWrite && (
        <div>
          <input
            ref={input}
            type="file"
            className="sr-only"
            aria-label={t('choose')}
            data-testid="attachment-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) {
                setError(null);
                upload.mutate(f);
              }
            }}
          />
          <Button variant="secondary" loading={upload.isPending} onClick={() => input.current?.click()}>
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            {t('choose')}
          </Button>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {q.isPending && <Skeleton className="h-20 w-full" />}
      {q.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {q.data && q.data.length === 0 && <EmptyState icon={FileText}>{t('empty')}</EmptyState>}
      {q.data && q.data.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="attachment-list">
          {q.data.map((a) => (
            <li key={a.id} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-fg-3" aria-hidden="true" />
                  <span className="truncate font-medium">{a.filename}</span>
                </span>
                <span className="flex flex-wrap items-center gap-3 text-body-sm text-fg-2">
                  <span>{mb(a.size)}</span>
                  <ScanBadge status={a.scanStatus} label={t(`scan.${a.scanStatus}` as 'scan.CLEAN')} />
                  {a.scanStatus === 'PENDING' && <span>{t('notReady')}</span>}
                </span>
                {verifyMsg?.id === a.id && (
                  <span className="text-body-sm" role="status">
                    {verifyMsg.ok ? t('verifyOk') : t('verifyBad')}
                  </span>
                )}
              </span>
              <span className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={a.scanStatus !== 'CLEAN'} onClick={() => download(a)} aria-label={t('downloadName', { name: a.filename })}>
                  {t('download')}
                </Button>
                {canVerify && (
                  <Button variant="ghost" loading={verify.isPending && verify.variables?.id === a.id} onClick={() => verify.mutate(a)}>
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    {t('verify')}
                  </Button>
                )}
                {canWrite && (
                  <Button variant="ghost" onClick={() => setToRemove(a)} aria-label={t('removeName', { name: a.filename })}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    {t('remove')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={toRemove !== null} title={t('removeTitle')} confirmLabel={t('remove')} danger busy={remove.isPending} onClose={() => setToRemove(null)} onConfirm={() => toRemove && remove.mutate(toRemove)}>
        <p>{toRemove?.filename}</p>
        <p>{t('removeBody')}</p>
      </ConfirmDialog>
    </div>
  );
}

// ── Casos relacionados ───────────────────────────────────────────────────────────
export function RelatedTab({ tenant, id, canLink }: { tenant: string; id: string; canLink: boolean }) {
  const t = useTranslations('case');
  const tt = useTranslations('types');
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const q = useQuery({ queryKey: ['related', tenant, id], queryFn: () => api.get<{ enabled: boolean; suggestions: RelatedSuggestion[] }>(`complaints/${id}/related-suggestions`), enabled: canLink });
  const link = useMutation({
    mutationFn: (relatedId: string) => api.post(`complaints/${id}/links`, { relatedId }),
    onSuccess: async () => {
      toast.success(t('relatedLinked'));
      await Promise.all([qc.invalidateQueries({ queryKey: ['related', tenant, id] }), qc.invalidateQueries({ queryKey: ['case', tenant, id] })]);
    },
    onError: (e) => toast.error(apiMessage(e) ?? t('actionError')),
  });
  if (!canLink) return <p className="text-fg-2">{t('readOnly')}</p>;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-fg-2">{t('relatedHint')}</p>
      {q.isPending && <Skeleton className="h-20 w-full" />}
      {q.isError && <Alert tone="danger">{t('loadError')}</Alert>}
      {q.data && !q.data.enabled && <Alert tone="info">{t('relatedDisabled')}</Alert>}
      {q.data?.enabled && q.data.suggestions.length === 0 && <EmptyState icon={Link2}>{t('relatedEmpty')}</EmptyState>}
      {q.data?.enabled && q.data.suggestions.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="related-list">
          {q.data.suggestions.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 flex-col">
                <Link href={`/${tenant}/painel/casos/${s.id}`} aria-label={t('relatedOpen', { protocol: s.protocol })} className="font-mono font-semibold">
                  {s.protocol}
                </Link>
                <span className="truncate">{s.title}</span>
                <span className="text-body-sm text-fg-2">
                  {tt(s.type as 'FRAUD')} · {t('relatedShared', { count: s.sharedPeople })}
                  {s.sameLocation ? ` · ${t('relatedSameLocation')}` : ''}
                </span>
              </span>
              <Button variant="secondary" loading={link.isPending && link.variables === s.id} onClick={() => link.mutate(s.id)}>
                {t('relatedLink')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Prazos: pausar / retomar ─────────────────────────────────────────────────────
export function SlaSection({ tenant, c, onDone }: { tenant: string; c: CaseDetail; onDone: () => Promise<unknown> }) {
  const t = useTranslations('case');
  const api = staffApi(tenant);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const paused = c.slaPausedAt !== null;
  const pause = useMutation({
    mutationFn: () => api.post(`complaints/${c.id}/sla/pause`, { reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(t('slaPausedDone'));
      setReason('');
      await onDone();
    },
    onError: (e) => toast.error(apiMessage(e) ?? t('actionError')),
  });
  const resume = useMutation({
    mutationFn: () => api.post(`complaints/${c.id}/sla/resume`),
    onSuccess: async () => {
      toast.success(t('slaResumedDone'));
      await onDone();
    },
    onError: (e) => toast.error(apiMessage(e) ?? t('actionError')),
  });
  return (
    <section aria-labelledby="act-sla" className="flex flex-col gap-4 border-t border-line pt-6">
      <h3 id="act-sla" className="font-semibold">
        {t('slaSection')}
      </h3>
      {paused ? (
        <>
          <p className="text-fg-2">{t('slaPausedNow')}</p>
          <Button variant="secondary" className="self-start" loading={resume.isPending} onClick={() => resume.mutate()} data-testid="sla-resume">
            {t('slaResume')}
          </Button>
        </>
      ) : (
        <>
          <Field label={t('slaPauseReason')} hint={t('slaPauseHint')} error={fieldError}>
            {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} data-testid="sla-reason" />}
          </Field>
          <Button
            variant="secondary"
            className="self-start"
            loading={pause.isPending}
            onClick={() => {
              if (reason.trim().length < 10) return setFieldError(t('reasonMin'));
              setFieldError(undefined);
              pause.mutate();
            }}
            data-testid="sla-pause"
          >
            {t('slaPause')}
          </Button>
        </>
      )}
    </section>
  );
}

// ── Acesso restrito (ADMIN) ──────────────────────────────────────────────────────
export function RestrictionSection({ tenant, c, onDone }: { tenant: string; c: CaseDetail; onDone: () => Promise<unknown> }) {
  const t = useTranslations('case');
  const toggle = useMutation({
    mutationFn: () => staffApi(tenant).post(`complaints/${c.id}/restriction`, { isRestricted: !c.isRestricted }),
    onSuccess: async () => {
      toast.success(t('restrictionDone'));
      await onDone();
    },
    onError: (e) => toast.error(apiMessage(e) ?? t('actionError')),
  });
  return (
    <section aria-labelledby="act-restrict" className="flex flex-col gap-3 border-t border-line pt-6">
      <h3 id="act-restrict" className="font-semibold">
        {t('restrictionSection')}
      </h3>
      <p className="text-fg-2">{c.isRestricted ? t('restrictionOn') : t('restrictionOff')}</p>
      <Button variant="secondary" className="self-start" loading={toggle.isPending} onClick={() => toggle.mutate()} data-testid="restriction-toggle">
        {c.isRestricted ? t('restrictionDisable') : t('restrictionEnable')}
      </Button>
    </section>
  );
}

// ── Impedimento (qualquer perfil interno) ────────────────────────────────────────
export function RecuseSection({ tenant, id }: { tenant: string; id: string }) {
  const t = useTranslations('case');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const recuse = useMutation({
    mutationFn: () => staffApi(tenant).post(`complaints/${id}/recuse`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success(t('recuseDone'));
      router.replace(`/${tenant}/painel`);
    },
    onError: (e) => setError(e instanceof ApiError && e.status === 403 ? t('forbidden') : (apiMessage(e) ?? t('actionError'))),
  });
  const close = () => {
    setOpen(false);
    setReason('');
    setFieldError(undefined);
    setError(null);
  };
  return (
    <section aria-labelledby="act-recuse" className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id="act-recuse" className="font-semibold">
        {t('recuseSection')}
      </h3>
      <p className="text-body-sm text-fg-2">{t('recuseHint')}</p>
      <Button variant="secondary" className="self-start" onClick={() => setOpen(true)} data-testid="recuse-open">
        {t('recuseButton')}
      </Button>
      <ConfirmDialog
        open={open}
        title={t('recuseTitle')}
        confirmLabel={t('recuseButton')}
        danger
        busy={recuse.isPending}
        onClose={close}
        onConfirm={() => {
          if (reason.trim().length < 10) return setFieldError(t('reasonMin'));
          setFieldError(undefined);
          setError(null);
          recuse.mutate();
        }}
      >
        <p>{t('recuseBody')}</p>
        <Field label={t('recuseReason')} hint={t('reasonHint')} error={fieldError}>
          {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="recuse-reason" />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </ConfirmDialog>
    </section>
  );
}
