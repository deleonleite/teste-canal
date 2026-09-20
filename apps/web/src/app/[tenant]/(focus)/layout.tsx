import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { getBranding } from '@/lib/server-api';

/**
 * Formulário de nova denúncia: página inteira, sem sidebar e sem navegação — só o formulário, o
 * progresso por etapa e a barra fixa no rodapé (PROMPTFRONT §5.4).
 */
export default async function FocusLayout({ children, params }: { children: ReactNode; params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const [branding, t] = await Promise.all([getBranding(tenant), getTranslations('common')]);
  if (!branding) notFound();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-3 focus:shadow-modal">
        {t('skipToContent')}
      </a>
      <header className="border-b border-line bg-surface pt-safe">
        <div className="mx-auto flex min-h-[56px] max-w-2xl items-center gap-3 px-safe">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo do tenant, URL externa arbitrária
            <img src={branding.logoUrl} alt="" className="h-8 w-auto max-w-[140px] object-contain" />
          ) : null}
          <span className="text-h3 text-fg">{branding.companyName}</span>
        </div>
      </header>
      <main id="conteudo" className="flex-1 px-safe py-8">
        {children}
      </main>
    </div>
  );
}
