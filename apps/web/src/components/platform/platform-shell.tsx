'use client';

import { Alert, Button, cn, Skeleton } from '@ouvion/ui';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronsLeft, ChevronsRight, CreditCard, LayoutDashboard, LogOut, ScrollText, Settings, UsersRound, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { platformApi, type PlatformMe, type PlatformRole } from '@/lib/platform-client';

const MeCtx = createContext<PlatformMe | null>(null);

/** Operador logado. Só existe dentro do painel, depois que `auth/me` confirmou a sessão. */
export function usePlatformMe(): PlatformMe {
  const me = useContext(MeCtx);
  if (!me) throw new Error('usePlatformMe fora do PlatformShell');
  return me;
}

const COLLAPSE_KEY = 'ouvion.platform.sidebar.collapsed';

interface NavItem {
  href: string;
  key: 'dashboard' | 'tenants' | 'subscriptions' | 'users' | 'audit' | 'settings';
  icon: LucideIcon;
  roles: PlatformRole[];
}

/** Os 6 itens do painel; cada perfil só vê o que o §2 do documento permite (FINANCIAL não vê Empresas). */
const NAV: NavItem[] = [
  { href: '/admin/dashboard', key: 'dashboard', icon: LayoutDashboard, roles: ['SUPER_ADMIN', 'SUPPORT', 'FINANCIAL'] },
  { href: '/admin/empresas', key: 'tenants', icon: Building2, roles: ['SUPER_ADMIN', 'SUPPORT'] },
  { href: '/admin/assinaturas', key: 'subscriptions', icon: CreditCard, roles: ['SUPER_ADMIN', 'FINANCIAL'] },
  { href: '/admin/usuarios-internos', key: 'users', icon: UsersRound, roles: ['SUPER_ADMIN'] },
  { href: '/admin/auditoria', key: 'audit', icon: ScrollText, roles: ['SUPER_ADMIN'] },
  { href: '/admin/configuracoes', key: 'settings', icon: Settings, roles: ['SUPER_ADMIN'] },
];

export function PlatformShell({ children }: { children: ReactNode }) {
  const t = useTranslations('platform.shell');
  const tr = useTranslations('platform.roles');
  const tc = useTranslations('common');
  const tp = useTranslations('platform');
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* sem armazenamento: segue expandido */
    }
  }, []);

  const me = useQuery({ queryKey: ['platform-me'], queryFn: () => platformApi.get<PlatformMe>('auth/me'), staleTime: 60_000, gcTime: 60_000 });

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      /* preferência não persiste */
    }
  }

  async function logout() {
    try {
      await platformApi.post('auth/logout');
    } finally {
      router.replace('/loginadm');
    }
  }

  const items = me.data ? NAV.filter((n) => n.roles.includes(me.data.role)) : [];

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-3 focus:shadow-modal">
        {tc('skipToContent')}
      </a>

      <aside className={cn('no-print border-b border-line bg-surface lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r', collapsed ? 'lg:w-16' : 'lg:w-64')}>
        <div className="flex h-full flex-col gap-2 pt-safe">
          <div className="flex min-h-[64px] items-center justify-between gap-3 px-4">
            <Link href="/admin/dashboard" className={cn('flex min-h-touch min-w-0 items-center no-underline hover:no-underline', collapsed && 'lg:hidden')}>
              <span className="truncate text-h3 text-fg">{tp('brand')}</span>
            </Link>
            <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={toggle} aria-label={collapsed ? t('expand') : t('collapse')} aria-expanded={!collapsed}>
              {collapsed ? <ChevronsRight className="h-5 w-5" aria-hidden="true" /> : <ChevronsLeft className="h-5 w-5" aria-hidden="true" />}
            </Button>
          </div>

          <nav aria-label={t('nav')} className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {items.map((n) => {
              const active = pathname.startsWith(n.href);
              const label = t(n.key);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? label : undefined}
                  className={cn(
                    'flex min-h-touch items-center gap-3 whitespace-nowrap rounded-md px-3 text-body font-medium no-underline hover:no-underline',
                    active ? 'bg-sunken text-fg shadow-[inset_3px_0_0_0_var(--brand)]' : 'text-fg-2 hover:bg-sunken hover:text-fg',
                    collapsed && 'lg:justify-center lg:px-0',
                  )}
                >
                  <n.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className={cn(collapsed && 'lg:sr-only')}>{label}</span>
                </Link>
              );
            })}
          </nav>

          <div className={cn('flex items-center justify-between gap-2 border-t border-line px-4 py-3 pb-safe', collapsed && 'lg:flex-col lg:px-2')}>
            <div className={cn('min-w-0 text-body-sm', collapsed && 'lg:hidden')}>
              {me.data ? (
                <>
                  <p className="truncate font-medium text-fg" data-testid="operator-name">
                    {me.data.fullName}
                  </p>
                  <p className="truncate text-fg-2" data-testid="operator-role">
                    {tr(me.data.role)}
                  </p>
                </>
              ) : (
                <Skeleton className="h-8 w-28" />
              )}
            </div>
            <Button variant="ghost" onClick={logout} aria-label={t('logout')} title={t('logout')} data-testid="padm-logout" className={cn(collapsed && 'lg:px-0')}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className={cn(collapsed && 'lg:sr-only')}>{t('logout')}</span>
            </Button>
          </div>
        </div>
      </aside>

      <main id="conteudo" className="min-w-0 flex-1 px-safe py-6 sm:py-8">
        <div className="mx-auto w-full max-w-6xl">
          {me.isPending ? (
            <div className="flex flex-col gap-4" aria-busy="true">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : me.isError ? (
            <Alert tone="danger">{t('loadError')}</Alert>
          ) : (
            <MeCtx.Provider value={me.data}>{children}</MeCtx.Provider>
          )}
        </div>
      </main>
    </div>
  );
}
