'use client';

import { Alert, Button, Field, Input, Mono, Textarea } from '@ouvion/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/staff/dialog';
import { ApiError } from '@/lib/api-client';
import { platformApi, type CreateTenantResult } from '@/lib/platform-client';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** "Empresa Ótima S.A." → "empresa-otima-s-a" (sugestão; a pessoa pode editar). */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Nova Empresa (tarefas.md §4.2.1). O convite por link é a escolha pré-selecionada; a senha temporária exige um
 * clique consciente, um motivo e mostra a senha gerada uma única vez.
 */
export function NewTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('platform.tenants');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [mode, setMode] = useState<'invite' | 'temp_password'>('invite');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateTenantResult | null>(null);

  const reset = () => {
    setName('');
    setSlug('');
    setSlugTouched(false);
    setMode('invite');
    setErrors({});
    setError(null);
    setResult(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: (b: Record<string, unknown>) => platformApi.post<CreateTenantResult>('tenants', b),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['platform-tenants'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) setErrors({ slug: t('slugInUse') });
      else if (e instanceof ApiError && e.status === 400 && mode === 'temp_password') setErrors({ password: t('tempWeak') });
      else setError(t('createError'));
    },
  });

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const body: Record<string, unknown> = {
      companyName: name.trim(),
      slug,
      adminFullName: String(f.get('adminName') ?? '').trim(),
      adminEmail: String(f.get('adminEmail') ?? '').trim(),
      mode,
    };
    const next: Record<string, string> = {};
    if (body.companyName === '' || String(body.companyName).length < 2) next.name = t('required');
    if (!SLUG.test(slug) || slug.length < 3 || slug.length > 40) next.slug = t('slugInvalid');
    if (String(body.adminFullName).length < 2) next.adminName = t('required');
    if (!body.adminEmail) next.adminEmail = t('required');
    if (mode === 'temp_password') {
      const reason = String(f.get('reason') ?? '').trim();
      if (reason.length < 10) next.reason = t('reasonMin');
      body.reason = reason;
      const password = String(f.get('password') ?? '');
      if (password) body.password = password;
    }
    setErrors(next);
    setError(null);
    if (Object.keys(next).length === 0) create.mutate(body);
  }

  const date = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));

  if (result) {
    return (
      <ConfirmDialog
        open={open}
        title={result.mode === 'invite' ? t('invitedTitle') : result.temporaryPassword ? t('tempTitle') : t('tempTypedTitle')}
        confirmLabel={t('openCompany')}
        cancelLabel={t('close')}
        onClose={close}
        onConfirm={() => {
          const id = result.tenantId;
          close();
          router.push(`/admin/empresas/${id}`);
        }}
      >
        {result.mode === 'invite' ? (
          <>
            <p data-testid="invite-result">{t('invitedBody', { email: result.sentTo ?? '', date: result.expiresAt ? date(result.expiresAt) : '' })}</p>
            {result.devInviteUrl && (
              <Alert tone="info" title={t('devLinkTitle')}>
                <p>{t('devLinkBody')}</p>
                <a href={result.devInviteUrl} className="break-all" data-testid="dev-invite-link">
                  {result.devInviteUrl}
                </a>
              </Alert>
            )}
          </>
        ) : result.temporaryPassword ? (
          <>
            <p>{t('tempBody')}</p>
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-sunken p-3">
              <Mono className="break-all text-body" data-testid="temp-password">
                {result.temporaryPassword}
              </Mono>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(result.temporaryPassword ?? '').then(() => toast.success(t('copied')));
                }}
              >
                {t('copy')}
              </Button>
            </div>
          </>
        ) : (
          <p>{t('tempTypedBody')}</p>
        )}
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog open={open} title={t('newTitle')} confirmLabel={t('create')} busy={create.isPending} onClose={close} onConfirm={() => (document.getElementById('nt-form') as HTMLFormElement | null)?.requestSubmit()}>
      <form id="nt-form" onSubmit={onSubmit} noValidate className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
        <Field label={t('companyName')} error={errors.name}>
          {(a) => (
            <Input
              {...a}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              autoComplete="off"
              data-testid="nt-name"
            />
          )}
        </Field>
        <Field label={t('slug')} hint={t('slugHint')} error={errors.slug}>
          {(a) => (
            <Input
              {...a}
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              autoComplete="off"
              spellCheck={false}
              data-testid="nt-slug"
            />
          )}
        </Field>
        <Field label={t('adminName')} error={errors.adminName}>
          {(a) => <Input {...a} name="adminName" autoComplete="off" data-testid="nt-admin-name" />}
        </Field>
        <Field label={t('adminEmail')} error={errors.adminEmail}>
          {(a) => <Input {...a} name="adminEmail" type="email" autoComplete="off" autoCapitalize="none" data-testid="nt-admin-email" />}
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">{t('access')}</legend>
          <label className="flex min-h-touch cursor-pointer items-start gap-3 rounded-md border border-line p-3">
            <input type="radio" name="mode" value="invite" checked={mode === 'invite'} onChange={() => setMode('invite')} className="mt-1 h-4 w-4" data-testid="nt-mode-invite" />
            <span className="flex flex-col gap-1">
              <span className="font-medium">{t('modeInvite')}</span>
              <span className="text-body-sm text-fg-2">{t('modeInviteHint')}</span>
            </span>
          </label>
          <label className="flex min-h-touch cursor-pointer items-start gap-3 rounded-md border border-line p-3">
            <input type="radio" name="mode" value="temp_password" checked={mode === 'temp_password'} onChange={() => setMode('temp_password')} className="mt-1 h-4 w-4" data-testid="nt-mode-temp" />
            <span className="flex flex-col gap-1">
              <span className="font-medium">{t('modeTemp')}</span>
              <span className="text-body-sm text-fg-2">{t('modeTempHint')}</span>
            </span>
          </label>
        </fieldset>

        {mode === 'temp_password' && (
          <>
            <Field label={t('tempReason')} hint={t('tempReasonHint')} error={errors.reason}>
              {(a) => <Textarea {...a} name="reason" rows={2} data-testid="nt-reason" />}
            </Field>
            <Field label={t('tempPassword')} hint={t('tempPasswordHint')} error={errors.password}>
              {(a) => <Input {...a} name="password" type="text" autoComplete="off" spellCheck={false} data-testid="nt-password" />}
            </Field>
          </>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </ConfirmDialog>
  );
}
