import { brandCss } from '@ouvion/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { BrandingProvider } from '@/components/branding-context';
import { getBranding } from '@/lib/server-api';

type Params = Promise<{ tenant: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { tenant } = await params;
  const b = await getBranding(tenant).catch(() => null);
  return {
    title: b ? { default: `${b.companyName} · Canal de denúncias`, template: `%s · ${b.companyName}` } : 'Canal de denúncias',
    icons: b?.faviconUrl ? { icon: b.faviconUrl } : undefined,
  };
}

/**
 * Camada de marca (nível 1): só a cor de AÇÃO/DESTAQUE muda por tenant. As variáveis --brand* já vêm com
 * contraste garantido para os dois temas; cores de status/prioridade/SLA (nível 0) não são tocadas.
 * O CSS é calculado no servidor: não há flash de tema errado.
 */
export default async function TenantLayout({ children, params }: { children: ReactNode; params: Params }) {
  const { tenant } = await params;
  const branding = await getBranding(tenant);
  if (!branding) notFound();
  return (
    <BrandingProvider branding={branding}>
      <style dangerouslySetInnerHTML={{ __html: brandCss(branding.primaryColor, branding.secondaryColor) }} />
      {children}
    </BrandingProvider>
  );
}
