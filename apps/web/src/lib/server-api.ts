import 'server-only';

import type { Branding } from './branding-type';

export type { Branding };

export const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/** Segredo compartilhado com a API: prova que a chamada veio deste BFF (e não de um cliente qualquer). */
export function serviceHeaders(tenant: string): Record<string, string> {
  const h: Record<string, string> = { 'x-tenant-slug': tenant };
  if (process.env.BFF_SHARED_SECRET) h['x-bff-secret'] = process.env.BFF_SHARED_SECRET;
  return h;
}

/** Tag do cache da marca: o painel a invalida ao salvar, para a mudança aparecer já no canal público. */
export const brandingTag = (tenant: string) => `branding:${tenant}`;

export const TENANT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Marca e dados públicos do tenant. `null` = empresa não encontrada. Cache curto: a marca muda pouco. */
export async function getBranding(tenant: string): Promise<Branding | null> {
  if (!TENANT_SLUG.test(tenant)) return null;
  try {
    const res = await fetch(`${API_URL}/public/branding`, { headers: serviceHeaders(tenant), next: { revalidate: 60, tags: [brandingTag(tenant)] } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`branding ${res.status}`);
    return (await res.json()) as Branding;
  } catch (e) {
    if ((e as Error).message.startsWith('branding')) throw e;
    throw new Error('API indisponível');
  }
}
