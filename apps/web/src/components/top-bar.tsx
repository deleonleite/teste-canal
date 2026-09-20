import { Button } from '@ouvion/ui';
import { Search } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import type { Branding } from '@/lib/branding-type';

/** Barra superior minimalista do canal público: logo do tenant + "Consultar protocolo" (sem sidebar, §6). */
export async function TopBar({ tenant, branding }: { tenant: string; branding: Branding }) {
  const t = await getTranslations('nav');
  return (
    <header className="border-b border-line bg-surface pt-safe no-print">
      <div className="mx-auto flex min-h-[64px] max-w-5xl items-center justify-between gap-4 px-safe">
        <Link href={`/${tenant}`} className="flex min-h-touch items-center gap-3 no-underline hover:no-underline" aria-label={`${branding.companyName} — ${t('channel')}`}>
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo do tenant, URL externa arbitrária
            <img src={branding.logoUrl} alt="" className="h-9 w-auto max-w-[160px] object-contain" />
          ) : null}
          <span className="text-h3 text-fg">{branding.companyName}</span>
        </Link>
        <Button asChild variant="secondary">
          <Link href={`/${tenant}/acompanhar`} className="no-underline hover:no-underline">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span>{t('trackProtocol')}</span>
          </Link>
        </Button>
      </div>
    </header>
  );
}
