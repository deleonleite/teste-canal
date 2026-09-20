import type { NextRequest } from 'next/server';

import { API_URL, serviceHeaders, TENANT_SLUG } from '@/lib/server-api';

/**
 * BFF: o navegador só fala com este proxy; ele repassa à API NestJS com o segredo de serviço.
 *
 * Anonimato: em rotas `public/*` o BFF NÃO repassa o user-agent (a API nunca o usa ali) e o IP segue só
 * como chave de limite de tentativas (a API o transforma em HMAC opaco, em memória, e nunca o grava).
 * Nada é logado aqui. Cookies não passam em nenhum sentido nestas rotas.
 */

// Só o canal público nesta entrega. Login/área do comitê entram com o front-2.
const ALLOWED = [/^public\//];

const PASS_REQUEST = ['content-type', 'authorization', 'accept', 'x-token-delivery'];
const PASS_RESPONSE = ['content-type', 'content-disposition'];
const HOP = new Set(['host', 'connection', 'content-length']);

async function handle(req: NextRequest, ctx: { params: Promise<{ tenant: string; path: string[] }> }): Promise<Response> {
  const { tenant, path } = await ctx.params;
  const joined = path.join('/');
  if (!TENANT_SLUG.test(tenant) || path.some((p) => p === '..' || p === '.' || p === '') || !ALLOWED.some((r) => r.test(joined))) {
    return Response.json({ message: 'Não encontrado' }, { status: 404 });
  }

  const headers = new Headers();
  for (const [k, v] of req.headers) if (PASS_REQUEST.includes(k) && !HOP.has(k)) headers.set(k, v);
  for (const [k, v] of Object.entries(serviceHeaders(tenant))) headers.set(k, v);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip');
  if (ip) headers.set('x-real-client-ip', ip);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/${joined}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
      // `duplex` é necessário para repassar o corpo (upload) em streaming; ainda não consta nos tipos do DOM.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch {
    return Response.json({ message: 'Serviço indisponível' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }

  const out = new Headers({ 'cache-control': 'no-store' });
  for (const k of PASS_RESPONSE) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
