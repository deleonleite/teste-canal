import { timingSafeEqual } from 'node:crypto';

import type { Request } from 'express';

/**
 * O BFF (Next.js na Vercel) é quem fala com a API; sem ajuste, todo cliente pareceria vir do mesmo IP.
 * Quando a chamada traz o segredo compartilhado do BFF, o IP e o user-agent originais vêm nos cabeçalhos
 * `x-real-client-ip` / `x-client-user-agent`. Sem o segredo válido esses cabeçalhos são IGNORADOS
 * (qualquer cliente poderia forjá-los para burlar o limite de tentativas).
 */
function fromTrustedBff(req: Request): boolean {
  const secret = process.env.BFF_SHARED_SECRET;
  const got = req.header('x-bff-secret');
  return !!secret && !!got && got.length === secret.length && timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

export function originIp(req: Request): string | undefined {
  return fromTrustedBff(req) ? req.header('x-real-client-ip') ?? req.ip : req.ip;
}

/**
 * IP/user-agent SÓ para rotas autenticadas da equipe. Rotas do canal anônimo nunca chamam isto
 * (e o banco anula ambos em eventos com `anonymousOrigin`).
 */
export function clientInfo(req: Request): { ip?: string; userAgent?: string } {
  return {
    ip: originIp(req),
    userAgent: fromTrustedBff(req) ? req.header('x-client-user-agent') ?? req.header('user-agent') : req.header('user-agent'),
  };
}

export function truncateToMinute(d: Date): Date {
  const t = new Date(d);
  t.setSeconds(0, 0);
  return t;
}
