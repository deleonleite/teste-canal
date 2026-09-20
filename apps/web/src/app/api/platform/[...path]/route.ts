import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { API_URL } from '@/lib/server-api';
import { clearPlatformSession, PLATFORM_ACCESS_COOKIE, PLATFORM_REFRESH_COOKIE, savePlatformSession, type Tokens } from '@/lib/session';

/**
 * BFF do painel da plataforma (`/loginadm`, `/admin/*`). Mesma ideia do BFF da equipe (tokens só em cookie
 * httpOnly SameSite=Strict, CSRF por cabeçalho + Origin), mas em espaço de cookies próprio e com lista de rotas
 * própria: aqui NÃO existe nenhuma rota de conteúdo de denúncia.
 */

const UUID = '[0-9a-f-]{36}';
const ALLOWED = [
  /^auth\/(login|change-password|logout|me|mfa\/(verify|enroll|activate))$/,
  new RegExp(`^tenants(\\/${UUID}(\\/(suspend|reactivate|resend-invite))?)?$`),
  new RegExp(`^users(\\/${UUID}(\\/reset-password)?)?$`),
  /^audit$/,
];

const PASS_REQUEST = ['content-type', 'accept'];
const PASS_RESPONSE = ['content-type'];
const noStore = { 'cache-control': 'no-store' };
const json = (body: unknown, status: number) => Response.json(body, { status, headers: noStore });

function serviceHeaders(): Record<string, string> {
  return process.env.BFF_SHARED_SECRET ? { 'x-bff-secret': process.env.BFF_SHARED_SECRET } : {};
}

async function callApi(joined: string, search: string, req: NextRequest, body: ArrayBuffer | undefined, token?: string) {
  const headers = new Headers();
  for (const [k, v] of req.headers) if (PASS_REQUEST.includes(k)) headers.set(k, v);
  for (const [k, v] of Object.entries(serviceHeaders())) headers.set(k, v);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip');
  if (ip) headers.set('x-real-client-ip', ip);
  const ua = req.headers.get('user-agent');
  if (ua) headers.set('x-client-user-agent', ua);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(`${API_URL}/platform/${joined}${search}`, { method: req.method, headers, body, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(60_000) });
}

async function refresh(req: NextRequest, refreshToken: string): Promise<Tokens | null> {
  const res = await fetch(`${API_URL}/platform/auth/refresh`, {
    method: 'POST',
    headers: { ...serviceHeaders(), 'content-type': 'application/json', 'x-real-client-ip': req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as Tokens;
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const joined = path.join('/');
  if (path.some((p) => p === '..' || p === '.' || p === '') || !ALLOWED.some((r) => r.test(joined))) {
    return json({ message: 'Não encontrado' }, 404);
  }

  const mutating = !['GET', 'HEAD'].includes(req.method);
  if (mutating) {
    const origin = req.headers.get('origin');
    if (!req.headers.get('x-ouvion-csrf') || (origin && new URL(origin).host !== req.headers.get('host'))) {
      return json({ message: 'Requisição recusada' }, 403);
    }
  }

  const jar = await cookies();
  const body = mutating ? await req.arrayBuffer() : undefined;
  let at = jar.get(PLATFORM_ACCESS_COOKIE)?.value;
  const rt = jar.get(PLATFORM_REFRESH_COOKIE)?.value;
  const preSession = ['auth/login', 'auth/change-password', 'auth/mfa/verify', 'auth/mfa/enroll', 'auth/mfa/activate'].includes(joined);

  let renewed: Tokens | null = null;
  if (!at && rt && !preSession) {
    renewed = await refresh(req, rt);
    if (!renewed) {
      await clearPlatformSession(jar);
      return json({ message: 'Sessão expirada' }, 401);
    }
    at = renewed.accessToken;
  }

  let upstream: Response;
  try {
    upstream = await callApi(joined, req.nextUrl.search, req, body, preSession ? undefined : at);
    if (upstream.status === 401 && rt && !renewed && !preSession && at) {
      renewed = await refresh(req, rt);
      if (!renewed) {
        await clearPlatformSession(jar);
        return json({ message: 'Sessão expirada' }, 401);
      }
      upstream = await callApi(joined, req.nextUrl.search, req, body, renewed.accessToken);
    }
  } catch {
    return json({ message: 'Serviço indisponível' }, 502);
  }
  if (renewed) await savePlatformSession(jar, renewed);

  const text = await upstream.text();
  // Login / MFA: os tokens viram cookies e SAEM da resposta.
  if (upstream.ok && ['auth/login', 'auth/change-password', 'auth/mfa/verify', 'auth/mfa/activate'].includes(joined)) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const tokens = (parsed.accessToken ? parsed : (parsed.session as Record<string, unknown> | undefined)) as Tokens | undefined;
    if (tokens?.accessToken) {
      await savePlatformSession(jar, tokens);
      return json(parsed.accessToken ? { authenticated: true } : { ...parsed, session: { authenticated: true } }, upstream.status);
    }
  }
  if (joined === 'auth/logout') await clearPlatformSession(jar);

  const out = new Headers(noStore);
  for (const k of PASS_RESPONSE) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(text, { status: upstream.status, headers: out });
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
