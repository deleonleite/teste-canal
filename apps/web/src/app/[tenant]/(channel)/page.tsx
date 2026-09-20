import { Alert, Button, Card } from '@ouvion/ui';
import { EyeOff, FileText, HandHeart, Lock, Mail, Phone, ShieldCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProtocolLookup } from '@/components/protocol-lookup';
import { getBranding } from '@/lib/server-api';

const DOC_KEYS = ['codigoEtica', 'politicaFornecedores', 'politicaAnticorrupcao', 'politicaLicitacoes', 'politicaPldFtp', 'politicaAssedio'] as const;
const GUARANTEE_ICONS = [EyeOff, Lock, HandHeart];

export default async function Landing({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const [branding, t] = await Promise.all([getBranding(tenant), getTranslations('landing')]);
  if (!branding) notFound();

  const docs = DOC_KEYS.filter((k) => branding.documents[k]);
  const guarantees = t.raw('guarantees') as Array<{ title: string; body: string }>;

  return (
    <div className="flex flex-col gap-12">
      {branding.maintenanceMode && <Alert tone="info">{t('maintenance')}</Alert>}

      <section className="flex flex-col gap-4">
        <p className="text-body-sm font-medium uppercase tracking-wider text-brand-text">{t('eyebrow')}</p>
        <h1 className="max-w-3xl text-display text-fg">{t('title')}</h1>
        <p className="max-w-prose text-body text-fg-2">{t('subtitle', { company: branding.companyName })}</p>
      </section>

      <section className="grid gap-6 md:grid-cols-2" aria-label={t('startTitle')}>
        <Card className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-6 w-6 text-brand-text" aria-hidden="true" />
            <h2>{t('startTitle')}</h2>
          </div>
          <p className="text-fg-2">{t('startBody')}</p>
          <Button asChild size="lg" className="mt-auto self-start">
            <Link href={`/${tenant}/nova-denuncia`} className="no-underline hover:no-underline text-on-brand">
              {t('startCta')}
            </Link>
          </Button>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2>{t('trackTitle')}</h2>
          <p className="text-fg-2">{t('trackBody')}</p>
          <div className="mt-auto">
            <ProtocolLookup tenant={tenant} />
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-6">
        <h2>{t('guaranteesTitle')}</h2>
        <ul className="grid gap-6 md:grid-cols-3">
          {guarantees.map((g, i) => {
            const Icon = GUARANTEE_ICONS[i] ?? ShieldCheck;
            return (
              <li key={g.title} className="flex flex-col gap-2">
                <Icon className="h-6 w-6 text-brand-text" aria-hidden="true" />
                <h3>{g.title}</h3>
                <p className="text-fg-2">{g.body}</p>
              </li>
            );
          })}
        </ul>
      </section>

      {docs.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2>{t('docsTitle')}</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {docs.map((k) => (
              <li key={k}>
                <a
                  href={branding.documents[k]!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-touch items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-fg no-underline hover:bg-sunken hover:no-underline"
                >
                  <FileText className="h-5 w-5 shrink-0 text-brand-text" aria-hidden="true" />
                  {t(`docs.${k}`)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="flex flex-col gap-6 border-t border-line pt-8 text-body-sm text-fg-2">
        <div className="grid gap-6 sm:grid-cols-2">
          {(branding.contact.phone || branding.contact.email) && (
            <div className="flex flex-col gap-2">
              <h3 className="text-fg">{t('contactTitle')}</h3>
              {branding.contact.phone && (
                <p className="flex items-center gap-2">
                  <Phone className="h-4 w-4" aria-hidden="true" />
                  {branding.contact.phone}
                </p>
              )}
              {branding.contact.email && (
                <p className="flex items-center gap-2">
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  <a href={`mailto:${branding.contact.email}`}>{branding.contact.email}</a>
                </p>
              )}
            </div>
          )}
          {branding.dpo && (
            <div className="flex flex-col gap-2">
              <h3 className="text-fg">{t('dpoTitle')}</h3>
              <p>{t('dpoBody', { name: branding.dpo.name ?? '—', email: branding.dpo.email ?? '—' })}</p>
            </div>
          )}
        </div>
        {(branding.privacyPolicy || branding.termsOfService) && (
          <p className="flex flex-wrap gap-x-6 gap-y-2">
            {branding.privacyPolicy && <a href={branding.privacyPolicy}>{t('privacy')}</a>}
            {branding.termsOfService && <a href={branding.termsOfService}>{t('terms')}</a>}
          </p>
        )}
      </footer>
    </div>
  );
}
