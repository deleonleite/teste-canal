import { revalidateTag } from 'next/cache';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accessCookie, clearSession, refreshCookie, saveSession, type Tokens } from '@/lib/session';
import { API_URL, brandingTag, serviceHeaders, TENANT_SLUG } from '@/lib/server-api';

/**
 * BFF da equipe (comitê). Os tokens da API NUNCA chegam ao JavaScript do navegador: ficam em cookies httpOnly
 * (SameSite=Strict) e este proxy os converte em `Authorization: Bearer`. Access expirado → renova com o refresh
 * (rotativo) e repete a chamada uma vez.
 *
 * CSRF: além do SameSite=Strict, toda chamada que muda estado exige o cabeçalho `x-ouvion-csrf` (um formulário
 * de outro site não consegue enviá-lo) e `Origin` igual ao host.
 */

const ALLOWED = [
  /^auth\/(login|change-password|me|sessions|logout|logout-all|mfa\/(verify|enroll|activate|disable))(\/[0-9a-f-]{36})?$/,
  /^onboarding\/(activation|activate|dpo|escalation-recipient)$/,
  /^complaints(\/[0-9a-f-]{36}(\/(status|assign|comments|addenda|sla\/(pause|resume)|related-suggestions|links|messages|attachments|recuse|restriction|reveal-identity)|\/attachments\/[0-9a-f-]{36}(\/(download|verify))?)?)?$/,
  /^users(\/manage)?$/,
  /^users\/[0-9a-f-]{36}\/(block|unblock|mfa\/reset)$/,
  /^notifications(\/(unread-count|read-all|preferences|[0-9a-f-]{36}\/read))?$/,
  /^conflicts(\/[0-9a-f-]{36}\/decide)?$/,
  /^audit(\/(seals|verify))?$/,
  /^settings(\/[A-Za-z_]+)?$/,
  /^branding$/,
];

const PASS_REQUEST = ['content-type', 'accept'];
const PASS_RESPONSE = ['content-type', 'content-disposition'];

const noStore = { 'cache-control': 'no-store' };
const json = (body: unknown, status: number) => Response.json(body, { status, headers: noStore });

async function callApi(joined: string, search: string, req: NextRequest, tenant: string, body: ArrayBuffer | undefined, token?: string) {
  const headers = new Headers();
  for (const [k, v] of req.headers) if (PASS_REQUEST.includes(k)) headers.set(k, v);
  for (const [k, v] of Object.entries(serviceHeaders(tenant))) headers.set(k, v);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip');
  if (ip) headers.set('x-real-client-ip', ip);
  const ua = req.headers.get('user-agent');
  if (ua) headers.set('user-agent', ua);
  // Pré-sessão (cadastro do 2º fator): o token escopado vem do corpo da tela, em cabeçalho próprio.
  const scoped = req.headers.get('x-ouvion-scoped');
  if (token) headers.set('authorization', `Bearer ${token}`);
  else if (scoped) headers.set('authorization', `Bearer ${scoped}`);
  return fetch(`${API_URL}/${joined}${search}`, {
    method: req.method,
    headers,
    body,
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
}

/** Renova a sessão com o refresh token do cookie. `null` = sessão não renovável (faz logout). */
async function refresh(tenant: string, req: NextRequest, refreshToken: string): Promise<Tokens | null> {
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { ...serviceHeaders(tenant), 'content-type': 'application/json', 'x-real-client-ip': req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as Tokens;
}

async function handle(req: NextRequest, ctx: { params: Promise<{ tenant: string; path: string[] }> }): Promise<Response> {
  const { tenant, path } = await ctx.params;
  const joined = path.join('/');
  if (!TENANT_SLUG.test(tenant) || path.some((p) => p === '..' || p === '.' || p === '') || !ALLOWED.some((r) => r.test(joined))) {
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
  let at = jar.get(accessCookie(tenant))?.value;
  const rt = jar.get(refreshCookie(tenant))?.value;
  const isLogin = joined === 'auth/login' || joined === 'auth/mfa/verify' || joined === 'auth/change-password';

  // Sem access mas com refresh (cookie de access expirou): renova antes de chamar.
  let renewed: Tokens | null = null;
  if (!at && rt && !isLogin) {
    renewed = await refresh(tenant, req, rt);
    if (!renewed) {
      await clearSession(jar, tenant);
      return json({ message: 'Sessão expirada' }, 401);
    }
    at = renewed.accessToken;
  }

  let upstream: Response;
  try {
    upstream = await callApi(joined, req.nextUrl.search, req, tenant, body, at);
    if (upstream.status === 401 && rt && !renewed && !isLogin && at) {
      renewed = await refresh(tenant, req, rt);
      if (!renewed) {
        await clearSession(jar, tenant);
        return json({ message: 'Sessão expirada' }, 401);
      }
      upstream = await callApi(joined, req.nextUrl.search, req, tenant, body, renewed.accessToken);
    }
  } catch {
    return json({ message: 'Serviço indisponível' }, 502);
  }
  if (renewed) await saveSession(jar, tenant, renewed);

  // Login / MFA: a API devolve os tokens no corpo; aqui viram cookies e SAEM da resposta.
  const text = await upstream.text();
  const isSessionEndpoint = isLogin || joined === 'auth/mfa/activate';
  if (upstream.ok && isSessionEndpoint) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const tokens = (parsed.accessToken ? parsed : (parsed.session as Record<string, unknown> | undefined)) as Tokens | undefined;
    if (tokens?.accessToken) {
      await saveSession(jar, tenant, tokens);
      const rest = parsed.accessToken ? { authenticated: true } : { ...parsed, session: { authenticated: true } };
      return json(rest, upstream.status);
    }
  }
  // Marca/configurações públicas mudaram (ou a empresa foi ativada/DPO informado): descarta o cache do canal público.
  if (upstream.ok && mutating && (joined === 'branding' || joined.startsWith('settings/') || joined === 'onboarding/dpo' || joined === 'onboarding/activate')) revalidateTag(brandingTag(tenant));
  if (joined === 'auth/logout' || joined === 'auth/logout-all') await clearSession(jar, tenant);

  const out = new Headers(noStore);
  for (const k of PASS_RESPONSE) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(text, { status: upstream.status, headers: out });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
