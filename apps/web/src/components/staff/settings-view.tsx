'use client';

import { brandTokens } from '@ouvion/ui';
import { Alert, Button, Card, Checkbox, Field, Input, Skeleton } from '@ouvion/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { apiMessage, staffApi, type BrandingForm } from '@/lib/staff-client';
import { useMe } from './panel-shell';

const HEX = /^#[0-9a-fA-F]{6}$/;
const HTTP = /^https?:\/\/[^\s]+$/i;
const DOCS = ['docCodigoEtica', 'docPoliticaAssedio', 'docPoliticaAnticorrupcao', 'docPoliticaFornecedores', 'docPoliticaLicitacoes', 'docPoliticaPldFtp'] as const;

export function SettingsView({ tenant }: { tenant: string }) {
  const t = useTranslations('settings');
  const me = useMe();
  if (me.role !== 'ADMIN') return <Alert tone="info">{t('adminOnly')}</Alert>;
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-h1">{t('title')}</h1>
      <BrandCard tenant={tenant} />
      <ChannelCard tenant={tenant} />
    </div>
  );
}

// ── Marca, com prévia e aviso de contraste ───────────────────────────────────────
function BrandCard({ tenant }: { tenant: string }) {
  const t = useTranslations('settings');
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const q = useQuery({ queryKey: ['branding', tenant], queryFn: () => api.get<BrandingForm>('branding') });
  const [f, setF] = useState<BrandingForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (v: BrandingForm) => api.put('branding', { companyName: v.companyName.trim(), primaryColor: v.primaryColor, secondaryColor: v.secondaryColor, logoUrl: v.logoUrl?.trim() || null, faviconUrl: v.faviconUrl?.trim() || null }),
    onSuccess: async () => {
      toast.success(t('brandSaved'));
      await qc.invalidateQueries({ queryKey: ['branding', tenant] });
    },
    onError: (e) => setError(apiMessage(e) ?? t('saveError')),
  });

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError || !f) return <Alert tone="danger">{t('loadError')}</Alert>;

  function submit() {
    if (!f) return;
    const next: Record<string, string> = {};
    if (f.companyName.trim().length < 2) next.companyName = t('nameMin');
    if (!HEX.test(f.primaryColor)) next.primaryColor = t('colorFormat');
    if (!HEX.test(f.secondaryColor)) next.secondaryColor = t('colorFormat');
    if (f.logoUrl?.trim() && !HTTP.test(f.logoUrl.trim())) next.logoUrl = t('urlInvalid');
    if (f.faviconUrl?.trim() && !HTTP.test(f.faviconUrl.trim())) next.faviconUrl = t('urlInvalid');
    setErrors(next);
    setError(null);
    if (Object.keys(next).length === 0) save.mutate(f);
  }

  const validPrimary = HEX.test(f.primaryColor) ? f.primaryColor : '#0a5c36';
  const light = brandTokens(validPrimary, 'light');
  const dark = brandTokens(validPrimary, 'dark');
  const adjusted = light.brandText.toLowerCase() !== validPrimary.toLowerCase() || light.lowContrast;

  return (
    <Card className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <h2 className="text-h3">{t('brand')}</h2>
        <p className="max-w-prose text-body-sm text-fg-2">{t('brandHint')}</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('companyName')} error={errors.companyName} className="sm:col-span-2">
          {(a) => <Input {...a} value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} autoComplete="off" data-testid="brand-name" />}
        </Field>
        <ColorField label={t('primaryColor')} value={f.primaryColor} error={errors.primaryColor} onChange={(v) => setF({ ...f, primaryColor: v })} testId="brand-primary" />
        <ColorField label={t('secondaryColor')} value={f.secondaryColor} error={errors.secondaryColor} onChange={(v) => setF({ ...f, secondaryColor: v })} testId="brand-secondary" />
        <Field label={t('logoUrl')} hint={t('logoHint')} error={errors.logoUrl}>
          {(a) => <Input {...a} value={f.logoUrl ?? ''} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} inputMode="url" autoComplete="off" spellCheck={false} data-testid="brand-logo" />}
        </Field>
        <Field label={t('faviconUrl')} error={errors.faviconUrl}>
          {(a) => <Input {...a} value={f.faviconUrl ?? ''} onChange={(e) => setF({ ...f, faviconUrl: e.target.value })} inputMode="url" autoComplete="off" spellCheck={false} />}
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-semibold">{t('preview')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {([['light', light, '#ffffff', '#14181f'], ['dark', dark, '#161a21', '#e8eaee']] as const).map(([name, tk, bg, fg]) => (
            <div key={name} className="flex flex-col gap-3 rounded-md border border-line p-4" style={{ background: bg, color: fg }} data-testid={`preview-${name}`}>
              <span className="text-h3">{f.companyName || '—'}</span>
              <span className="flex flex-wrap items-center gap-4">
                <span className="inline-flex min-h-touch items-center rounded-md px-4 font-medium" style={{ background: tk.brand, color: tk.onBrand }}>
                  {t('previewButton')}
                </span>
                <span className="font-medium underline" style={{ color: tk.brandText }}>
                  {t('previewLink')}
                </span>
              </span>
            </div>
          ))}
        </div>
        {adjusted ? (
          <div data-testid="contrast-warning">
            <Alert tone="warning">
              <p>{t('contrastAdjusted', { light: light.brandText, dark: dark.brandText })}</p>
            </Alert>
          </div>
        ) : (
          <Alert tone="success">
            <p>{t('contrastOk')}</p>
          </Alert>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      <Button className="self-start" loading={save.isPending} onClick={submit} data-testid="brand-save">
        {t('saveBrand')}
      </Button>
    </Card>
  );
}

function ColorField({ label, value, error, onChange, testId }: { label: string; value: string; error: string | undefined; onChange: (v: string) => void; testId: string }) {
  return (
    <Field label={label} error={error}>
      {(a) => (
        <div className="flex items-center gap-3">
          <input
            type="color"
            aria-label={`${label} (seletor)`}
            value={HEX.test(value) ? value : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className="h-11 w-14 shrink-0 cursor-pointer rounded-sm border border-line-strong bg-surface p-1"
          />
          <Input {...a} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} maxLength={7} data-testid={testId} />
        </div>
      )}
    </Field>
  );
}

// ── Canal público: anonimato, manutenção, contato e documentos ───────────────────
function ChannelCard({ tenant }: { tenant: string }) {
  const t = useTranslations('settings');
  const qc = useQueryClient();
  const api = staffApi(tenant);
  const q = useQuery({ queryKey: ['settings', tenant], queryFn: () => api.get<Record<string, string>>('settings') });
  const [v, setV] = useState<Record<string, string> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setV(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: async (next: Record<string, string>) => {
      // Só grava o que mudou; uma chave por chamada (a API valida cada uma).
      for (const [key, value] of Object.entries(next)) if ((q.data?.[key] ?? '') !== value) await api.put(`settings/${key}`, { value });
    },
    onSuccess: async () => {
      toast.success(t('channelSaved'));
      await qc.invalidateQueries({ queryKey: ['settings', tenant] });
    },
    onError: (e) => setError(apiMessage(e) ?? t('saveError')),
  });

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError || !v) return <Alert tone="danger">{t('loadError')}</Alert>;

  const set = (k: string, val: string) => setV({ ...v, [k]: val });
  const bool = (k: string, def: boolean) => (v[k] === undefined ? def : v[k] === 'true');

  function submit() {
    const next: Record<string, string> = {};
    for (const k of DOCS) if (v![k] && !HTTP.test(v![k]!)) next[k] = t('urlInvalid');
    setErrors(next);
    setError(null);
    if (Object.keys(next).length > 0) return;
    const out: Record<string, string> = {};
    for (const k of ['allowAnonymousComplaints', 'maintenanceMode', 'companyEmail', 'companyPhone', ...DOCS]) if (v![k] !== undefined) out[k] = v![k]!;
    save.mutate(out);
  }

  return (
    <Card className="flex flex-col gap-6 p-4 sm:p-6">
      <h2 className="text-h3">{t('channel')}</h2>
      <Checkbox checked={bool('allowAnonymousComplaints', true)} onCheckedChange={(c) => set('allowAnonymousComplaints', String(c === true))} label={t('allowAnonymous')} description={t('allowAnonymousHint')} />
      <Checkbox checked={bool('maintenanceMode', false)} onCheckedChange={(c) => set('maintenanceMode', String(c === true))} label={t('maintenance')} description={t('maintenanceHint')} />

      <div className="flex flex-col gap-4">
        <h3 className="font-semibold">{t('contact')}</h3>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('companyEmail')}>{(a) => <Input {...a} type="email" value={v.companyEmail ?? ''} onChange={(e) => set('companyEmail', e.target.value)} autoComplete="off" />}</Field>
          <Field label={t('companyPhone')}>{(a) => <Input {...a} type="tel" value={v.companyPhone ?? ''} onChange={(e) => set('companyPhone', e.target.value)} autoComplete="off" />}</Field>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="font-semibold">{t('documents')}</h3>
        <p className="text-body-sm text-fg-2">{t('docHint')}</p>
        <div className="grid gap-5 sm:grid-cols-2">
          {DOCS.map((k) => (
            <Field key={k} label={t(k)} error={errors[k]}>
              {(a) => <Input {...a} value={v[k] ?? ''} onChange={(e) => set(k, e.target.value)} inputMode="url" autoComplete="off" spellCheck={false} data-testid={`setting-${k}`} />}
            </Field>
          ))}
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      <Button className="self-start" loading={save.isPending} onClick={submit} data-testid="channel-save">
        {t('saveChannel')}
      </Button>
    </Card>
  );
}
