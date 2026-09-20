import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { PanelShell } from '@/components/staff/panel-shell';
import { accessCookie, refreshCookie } from '@/lib/session';

/**
 * Porteiro do painel: sem nenhum cookie de sessão nem entra. A validade real da sessão é confirmada pela API
 * (`auth/me`, que também renova); o servidor de páginas não escreve cookies, por isso a renovação fica no BFF.
 */
export default async function PanelLayout({ children, params }: { children: ReactNode; params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const jar = await cookies();
  if (!jar.get(accessCookie(tenant)) && !jar.get(refreshCookie(tenant))) redirect(`/${tenant}/entrar`);
  return <PanelShell tenant={tenant}>{children}</PanelShell>;
}
