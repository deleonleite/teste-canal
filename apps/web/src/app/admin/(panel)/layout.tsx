import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { PlatformShell } from '@/components/platform/platform-shell';
import { PlatformTheme } from '@/components/platform/platform-theme';
import { PLATFORM_ACCESS_COOKIE, PLATFORM_REFRESH_COOKIE } from '@/lib/session';

/** Porteiro do painel da plataforma: sem cookie de sessão nem entra. A validade real é conferida pela API. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!jar.get(PLATFORM_ACCESS_COOKIE) && !jar.get(PLATFORM_REFRESH_COOKIE)) redirect('/loginadm');
  return (
    <>
      <PlatformTheme />
      <PlatformShell>{children}</PlatformShell>
    </>
  );
}
