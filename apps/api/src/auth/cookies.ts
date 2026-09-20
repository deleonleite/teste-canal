import { timingSafeEqual } from 'node:crypto';

import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';

export const ACCESS_COOKIE = 'ouv_at';
export const REFRESH_COOKIE = 'ouv_rt';
export const CSRF_COOKIE = 'ouv_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isSecure = (req: Request): boolean =>
  process.env.NODE_ENV === 'production' || req.header('x-forwarded-proto') === 'https';

/** Cookies httpOnly + SameSite=Lax (+ Secure em HTTPS). O CSRF vai em cookie legível (double-submit). */
export function setSessionCookies(
  req: Request,
  res: Response,
  tokens: { accessToken: string; refreshToken: string; csrfToken: string },
): void {
  const base = { httpOnly: true, sameSite: 'lax' as const, secure: isSecure(req) };
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base, path: '/', maxAge: 15 * 60_000 });
  // O refresh só trafega nas rotas de sessão.
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...base, path: '/auth', maxAge: 7 * 86_400_000 });
  res.cookie(CSRF_COOKIE, tokens.csrfToken, { ...base, httpOnly: false, path: '/', maxAge: 7 * 86_400_000 });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** Autenticação por Bearer (servidor-a-servidor/BFF) ou por cookie (navegador, com CSRF). */
export function extractToken(req: Request): { token: string; fromCookie: boolean } | null {
  const bearer = req.header('authorization')?.replace(/^Bearer /i, '');
  if (bearer) return { token: bearer, fromCookie: false };
  const cookie = parseCookies(req.header('cookie'))[ACCESS_COOKIE];
  return cookie ? { token: cookie, fromCookie: true } : null;
}

/** Double-submit: mutações autenticadas por cookie exigem o header igual ao cookie de CSRF. */
export function enforceCsrf(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const cookie = parseCookies(req.header('cookie'))[CSRF_COOKIE];
  const header = req.header(CSRF_HEADER);
  const ok =
    !!cookie && !!header && cookie.length === header.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
  if (!ok) throw new ForbiddenException('Falha na verificação CSRF');
}
