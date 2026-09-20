'use client';

import { Alert, Button, Card, Field, Skeleton, Textarea } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { platformApi, type TenantRow } from '@/lib/platform-client';
import { ConfirmDialog } from '@/components/staff/dialog';
import { usePlatformMe } from './platform-shell';
import { RoleGate } from './shared';
import { TenantStatusBadge } from './tenants-view';

export function TenantDetailView({ id }: { id: string }) {
  return (
    <RoleGate roles={['SUPER_ADMIN', 'SUPPORT']}>
      <Detail id={id} />
    </RoleGate>
  );
}

function Detail({ id }: { id: string }) {
  const t = useTranslations('platform.tenants');
  const locale = useLocale();
  const me = usePlatformMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [resendOpen, setResendOpen] = useState(false);
  const [resent, setResent] = useState<{ devInviteUrl?: string } | null>(null);

  const q = useQuery({ queryKey: ['platform-tenant', id], queryFn: () => platformApi.get<TenantRow>(`tenants/${id}`) });
  const suspended = q.data?.status === 'SUSPENDED';

  const close = () => {
    setOpen(false);
    setReason('');
    setFieldError(undefined);
    setError(null);
  };
  const change = useMutation({
    mutationFn: () => platformApi.post(`tenants/${id}/${suspended ? 'reactivate' : 'suspend'}`, { reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(t(suspended ? 'reactivated' : 'suspended'));
      close();
      await Promise.all([qc.invalidateQueries({ queryKey: ['platform-tenant', id] }), qc.invalidateQueries({ queryKey: ['platform-tenants'] })]);
    },
    onError: (e) => setError(e instanceof ApiError && e.status === 409 ? t('conflict') : t('actionError')),
  });

  const resend = useMutation({
    mutationFn: () => platformApi.post<{ devInviteUrl?: string }>(`tenants/${id}/resend-invite`),
    onSuccess: async (r) => {
      toast.success(t('resent'));
      setResent(r);
      setResendOpen(false);
      await qc.invalidateQueries({ queryKey: ['platform-tenant', id] });
    },
    onError: (e) => {
      setResendOpen(false);
      toast.error(e instanceof ApiError && e.status === 409 ? t('resendConflict') : t('actionError'));
    },
  });

  const back = (
    <Link href="/admin/empresas" className="inline-flex min-h-touch items-center gap-2 self-start text-body text-fg-2 no-underline hover:text-fg hover:no-underline">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {t('back')}
    </Link>
  );

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError || !q.data) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Alert tone="danger">{q.error instanceof ApiError && q.error.status === 404 ? t('notFound') : t('loadError')}</Alert>
      </div>
    );
  }

  const x = q.data;
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(iso));
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-1 border-b border-line py-3 sm:flex-row sm:gap-6">
      <dt className="w-56 shrink-0 text-body-sm font-medium text-fg-2">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
  const done = (ok: boolean) => (ok ? t('done') : t('pending'));

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1">{x.companyName}</h1>
          <TenantStatusBadge status={x.status} />
        </div>
        <p className="font-mono text-body-sm text-fg-2">{x.slug}</p>
      </header>

      <Alert tone="info">
        <span className="inline-flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('guarantee')}
        </span>
      </Alert>

      <Card className="p-4 sm:p-6">
        <dl>
          <Row label={t('usersLabel')}>
            {x.counts.users} <span className="text-fg-2">{t('limitUsers', { max: x.maxUsers })}</span>
          </Row>
          <Row label={t('complaintsTotal')}>{x.counts.complaints}</Row>
          <Row label={t('complaintsMonth')}>
            {x.counts.complaintsThisMonth} <span className="text-fg-2">{t('limitComplaints', { max: x.maxComplaintsPerMonth })}</span>
          </Row>
          <Row label={t('expires')}>{x.subscriptionExpiresAt ? date(x.subscriptionExpiresAt) : <span className="text-fg-2">{t('noExpiry')}</span>}</Row>
          <Row label={t('dpo')}>{x.dpo ? [x.dpo.name, x.dpo.email].filter(Boolean).join(' · ') : <span className="text-fg-2">{t('noDpo')}</span>}</Row>
          {x.invite && (
            <Row label={t('inviteRow')}>
              <span data-testid="invite-state">{t(`inviteState.${x.invite.state}`, { email: x.invite.email, date: date(x.invite.expiresAt) })}</span>
            </Row>
          )}
          <Row label={t('onbEscalation')}>{done(x.onboarding.escalationVerified)}</Row>
          <Row label={t('onbTotp')}>{done(x.onboarding.escalationTotpEnrolled)}</Row>
          <Row label={t('colCreated')}>{date(x.createdAt)}</Row>
        </dl>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        {me.role === 'SUPER_ADMIN' && (
          <Button variant={suspended ? 'secondary' : 'danger'} onClick={() => setOpen(true)} data-testid="tenant-toggle">
            {suspended ? t('reactivate') : t('suspend')}
          </Button>
        )}
        {me.role === 'SUPER_ADMIN' && x.invite && x.invite.state !== 'accepted' && (
          <Button variant="secondary" onClick={() => setResendOpen(true)} data-testid="resend-invite">
            {t('resend')}
          </Button>
        )}
        <Button variant="secondary" disabled aria-describedby="rs-hint">
          {t('requestSupport')}
        </Button>
        <span id="rs-hint" className="text-body-sm text-fg-2">
          {t('requestSupportHint')}
        </span>
      </div>

      {resent?.devInviteUrl && (
        <Alert tone="info" title={t('devLinkTitle')}>
          <p>{t('devLinkBody')}</p>
          <a href={resent.devInviteUrl} className="break-all" data-testid="dev-invite-link">
            {resent.devInviteUrl}
          </a>
        </Alert>
      )}

      <ConfirmDialog open={resendOpen} title={t('resendTitle')} confirmLabel={t('resend')} busy={resend.isPending} onClose={() => setResendOpen(false)} onConfirm={() => resend.mutate()}>
        <p>{t('resendBody')}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={open}
        title={t(suspended ? 'reactivateTitle' : 'suspendTitle', { name: x.companyName })}
        confirmLabel={suspended ? t('reactivate') : t('suspend')}
        danger={!suspended}
        busy={change.isPending}
        onClose={close}
        onConfirm={() => {
          if (reason.trim().length < 10) return setFieldError(t('reasonMin'));
          setFieldError(undefined);
          setError(null);
          change.mutate();
        }}
      >
        <p>{t(suspended ? 'reactivateBody' : 'suspendBody')}</p>
        <Field label={t('reason')} hint={t('reasonHint')} error={fieldError}>
          {(a) => <Textarea {...a} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="tenant-reason" />}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </ConfirmDialog>
    </div>
  );
}
