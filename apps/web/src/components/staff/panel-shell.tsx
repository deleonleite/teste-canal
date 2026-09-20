'use client';

import { Alert, Button, cn, Skeleton } from '@ouvion/ui';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronsLeft, ListChecks, ChevronsRight, FolderOpen, Handshake, LogOut, ScrollText, Settings, UserCog, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { useBranding } from '@/components/branding-context';
import { staffApi, type ActivationStatus, type Me } from '@/lib/staff-client';

const MeCtx = createContext<Me | null>(null);

/** Perfil da sessão. Só existe dentro do painel, depois que `auth/me` confirmou a sessão. */
export function useMe(): Me {
  const me = useContext(MeCtx);
  if (!me) throw new Error('useMe fora do PanelShell');
  return me;
}

const COLLAPSE_KEY = 'ouvion.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function PanelShell({ tenant, children }: { tenant: string; children: ReactNode }) {
  const t = useTranslations('shell');
  const tr = useTranslations('roles');
  const tc = useTranslations('common');
  const tn = useTranslations('notifs');
  const tw = useTranslations('onboard.activation');
  const branding = useBranding();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);

  const me = useQuery({ queryKey: ['me', tenant], queryFn: () => staffApi(tenant).get<Me>('auth/me'), staleTime: 60_000, gcTime: 60_000 });

  const unread = useQuery({ queryKey: ['unread', tenant], queryFn: () => staffApi(tenant).get<{ count: number }>('notifications/unread-count'), refetchInterval: 60_000, enabled: me.isSuccess });
  const unreadCount = unread.data?.count ?? 0;

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      /* preferência não persiste; segue funcionando */
    }
  }

  async function logout() {
    try {
      await staffApi(tenant).post('auth/logout');
    } finally {
      router.replace(`/${tenant}/entrar`);
    }
  }

  const role = me.data?.role;
  // Empresa ainda em período de teste: o ADMIN vê o caminho de ativação em toda tela do painel.
  const activation = useQuery({ queryKey: ['activation', tenant], queryFn: () => staffApi(tenant).get<ActivationStatus>('onboarding/activation'), enabled: role === 'ADMIN', staleTime: 30_000 });
  const inTrial = activation.data?.tenantStatus === 'TRIAL';
  const nav: Array<{ href: string; label: string; icon: typeof Bell; badge?: number }> = [
    { href: `/${tenant}/painel`, label: t('cases'), icon: FolderOpen },
    ...(inTrial ? [{ href: `/${tenant}/painel/ativacao`, label: t('activation'), icon: ListChecks }] : []),
    ...(role === 'ADMIN' ? [{ href: `/${tenant}/painel/usuarios`, label: t('users'), icon: Users }] : []),
    ...(role === 'ADMIN' ? [{ href: `/${tenant}/painel/conflitos`, label: t('conflicts'), icon: Handshake }] : []),
    ...(role === 'ADMIN' || role === 'AUDITOR' ? [{ href: `/${tenant}/painel/auditoria`, label: t('audit'), icon: ScrollText }] : []),
    ...(role === 'ADMIN' ? [{ href: `/${tenant}/painel/configuracoes`, label: t('settings'), icon: Settings }] : []),
    { href: `/${tenant}/painel/notificacoes`, label: t('notifications'), icon: Bell, badge: unreadCount },
    { href: `/${tenant}/painel/conta`, label: t('account'), icon: UserCog },
  ];

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-3 focus:shadow-modal">
        {tc('skipToContent')}
      </a>

      <aside className={cn('no-print border-b border-line bg-surface lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r', collapsed ? 'lg:w-16' : 'lg:w-64')}>
        <div className="flex h-full flex-col gap-2 pt-safe">
          <div className="flex min-h-[64px] items-center justify-between gap-3 px-4">
            <Link href={`/${tenant}/painel`} className={cn('flex min-h-touch min-w-0 items-center gap-3 no-underline hover:no-underline', collapsed && 'lg:hidden')}>
              {branding.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- logo do tenant, URL externa arbitrária
                <img src={branding.logoUrl} alt="" className="h-8 w-auto max-w-[120px] object-contain" />
              ) : null}
              <span className="truncate text-h3 text-fg">{branding.companyName}</span>
            </Link>
            <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={toggle} aria-label={collapsed ? t('expand') : t('collapse')} aria-expanded={!collapsed}>
              {collapsed ? <ChevronsRight className="h-5 w-5" aria-hidden="true" /> : <ChevronsLeft className="h-5 w-5" aria-hidden="true" />}
            </Button>
          </div>

          <nav aria-label={t('nav')} className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {nav.map((n) => {
              // "Casos" cobre a lista e o detalhe, mas não as outras áreas do painel.
              const active = n.href === `/${tenant}/painel` ? pathname === n.href || pathname.startsWith(`/${tenant}/painel/casos`) : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? n.label : undefined}
                  className={cn(
                    'flex min-h-touch items-center gap-3 rounded-md px-3 text-body font-medium no-underline hover:no-underline',
                    active ? 'bg-sunken text-fg shadow-[inset_3px_0_0_0_var(--brand)]' : 'text-fg-2 hover:bg-sunken hover:text-fg',
                    collapsed && 'lg:justify-center lg:px-0',
                  )}
                >
                  <n.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className={cn(collapsed && 'lg:sr-only')}>{n.label}</span>
                  {(n.badge ?? 0) > 0 && (
                    <span className="ml-auto rounded-full bg-brand px-2 text-body-sm font-semibold text-on-brand" data-testid="unread-badge">
                      <span className="sr-only">{tn('bell', { count: n.badge ?? 0 })}</span>
                      <span aria-hidden="true">{(n.badge ?? 0) > 99 ? '99+' : n.badge}</span>
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className={cn('flex items-center justify-between gap-2 border-t border-line px-4 py-3 pb-safe', collapsed && 'lg:flex-col lg:px-2')}>
            <div className={cn('min-w-0 text-body-sm text-fg-2', collapsed && 'lg:hidden')}>
              {me.data ? <span data-testid="me-role">{tr(me.data.role)}</span> : <Skeleton className="h-4 w-24" />}
            </div>
            <Button variant="ghost" onClick={logout} aria-label={t('logout')} title={t('logout')} data-testid="logout" className={cn(collapsed && 'lg:px-0')}>
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
            <MeCtx.Provider value={me.data}>
              {inTrial && !pathname.endsWith('/ativacao') && (
                <div className="mb-6" data-testid="trial-banner">
                  <Alert tone="info">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {tw('banner')}
                      <Link href={`/${tenant}/painel/ativacao`} className="font-medium">
                        {tw('bannerLink')}
                      </Link>
                    </span>
                  </Alert>
                </div>
              )}
              {children}
            </MeCtx.Provider>
          )}
        </div>
      </main>
    </div>
  );
}
