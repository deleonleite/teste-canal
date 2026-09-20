import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { TopBar } from '@/components/top-bar';
import { getBranding } from '@/lib/server-api';

export default async function ChannelLayout({ children, params }: { children: ReactNode; params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const [branding, t] = await Promise.all([getBranding(tenant), getTranslations('common')]);
  if (!branding) notFound();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-3 focus:shadow-modal">
        {t('skipToContent')}
      </a>
      <TopBar tenant={tenant} branding={branding} />
      <main id="conteudo" className="mx-auto w-full max-w-5xl flex-1 px-safe py-8 sm:py-12">
        {children}
      </main>
    </div>
  );
}
