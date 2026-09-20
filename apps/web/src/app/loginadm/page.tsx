import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PlatformLogin } from '@/components/platform/platform-login';
import { PlatformTheme } from '@/components/platform/platform-theme';

export const metadata: Metadata = { title: 'Acesso da equipe OuviON' };

export default async function LoginAdmPage({ searchParams }: { searchParams: Promise<{ expirada?: string }> }) {
  const [sp, t] = await Promise.all([searchParams, getTranslations('platform')]);
  return (
    <div className="flex min-h-dvh flex-col">
      <PlatformTheme />
      <header className="border-b border-line bg-surface pt-safe">
        <div className="mx-auto flex min-h-[64px] max-w-5xl items-center px-safe">
          <span className="text-h3 text-fg">{t('brand')}</span>
        </div>
      </header>
      <main id="conteudo" className="mx-auto w-full max-w-md flex-1 px-safe py-12">
        <PlatformLogin expired={sp.expirada === '1'} />
      </main>
    </div>
  );
}
