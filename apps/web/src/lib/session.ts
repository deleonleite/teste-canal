import 'server-only';

import type { cookies } from 'next/headers';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

type Jar = Awaited<ReturnType<typeof cookies>>;

/** Um par de cookies por empresa: duas empresas no mesmo navegador não misturam sessões. */
export const accessCookie = (tenant: string) => `ouvion_at_${tenant}`;
export const refreshCookie = (tenant: string) => `ouvion_rt_${tenant}`;

const base = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
  path: '/',
};

export async function saveSession(jar: Jar, tenant: string, t: Tokens): Promise<void> {
  jar.set(accessCookie(tenant), t.accessToken, { ...base, maxAge: Math.max(30, t.expiresIn - 10) });
  // O refresh vive mais que o access; a API o invalida (rotação + expiração própria).
  jar.set(refreshCookie(tenant), t.refreshToken, { ...base, maxAge: 60 * 60 * 24 * 7 });
}

export async function clearSession(jar: Jar, tenant: string): Promise<void> {
  jar.delete(accessCookie(tenant));
  jar.delete(refreshCookie(tenant));
}

/** Perfil da sessão atual (renovando se preciso), para as páginas de servidor. `null` = não autenticado. */
export interface Me {
  userId: string;
  tenantId: string;
  role: 'ADMIN' | 'INVESTIGATOR' | 'AUDITOR' | 'REPORTER';
  mfaEnabled: boolean;
}

// ── Painel da plataforma (SUPER_ADMIN): espaço de cookies próprio, sem relação com o das empresas ──────────
export const PLATFORM_ACCESS_COOKIE = 'ouvion_pat';
export const PLATFORM_REFRESH_COOKIE = 'ouvion_prt';

export async function savePlatformSession(jar: Jar, t: Tokens): Promise<void> {
  jar.set(PLATFORM_ACCESS_COOKIE, t.accessToken, { ...base, maxAge: Math.max(30, t.expiresIn - 10) });
  jar.set(PLATFORM_REFRESH_COOKIE, t.refreshToken, { ...base, maxAge: 60 * 60 * 24 * 7 });
}

export async function clearPlatformSession(jar: Jar): Promise<void> {
  jar.delete(PLATFORM_ACCESS_COOKIE);
  jar.delete(PLATFORM_REFRESH_COOKIE);
}
