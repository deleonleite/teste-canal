import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { provisionTenant } from '../src/tenancy/provision-tenant';
import { OWNER_URL, PLATFORM_URL, RUNTIME_URL } from './env';

export const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
export const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
export const platform = new PrismaClient({ datasourceUrl: PLATFORM_URL });

export async function createTenant(
  password = 'Senha-Forte-123!',
): Promise<{ tenantId: string; adminId: string; slug: string; adminEmail: string }> {
  const slug = `t${randomUUID().slice(0, 8)}`;
  const adminEmail = `admin@${slug}.com`;
  const r = await provisionTenant(owner, {
    slug,
    companyName: `Empresa ${slug}`,
    adminEmail,
    adminFullName: 'Admin Teste',
    adminPasswordHash: await argon2.hash(password, { type: argon2.argon2id }),
  });
  return { ...r, slug, adminEmail };
}

export async function createComplaint(tenantId: string, title = 'Denúncia de teste 1234'): Promise<string> {
  const c = await owner.complaint.create({
    data: {
      tenantId,
      protocol: `DEN-2026-${randomUUID().slice(0, 6).toUpperCase()}`,
      isAnonymous: true,
      type: 'ETHICS',
      reportedType: 'ETHICS',
      involvedPeople: ['Fulano'],
      integrityHash: 'x'.repeat(64),
      title,
      description: 'Descrição longa o suficiente para o teste de isolamento entre tenants.',
    },
  });
  return c.id;
}

/** Executa como app_runtime dentro de uma transação com app.tenant_id definido (ou sem contexto). */
export async function asTenant<T>(
  tenantId: string | null,
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return runtime.$transaction(async (tx) => {
    if (tenantId) await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

export async function closeAll(): Promise<void> {
  await Promise.all([owner.$disconnect(), runtime.$disconnect(), platform.$disconnect()]);
}
