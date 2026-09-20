import type { PrismaClient } from '@prisma/client';
import { provisionTenantSchema, type ProvisionTenantInput } from '@ouvion/contracts';

export function auditSequenceName(tenantId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('tenantId inválido');
  return `audit_seq_${tenantId.replace(/-/g, '')}`;
}

/**
 * Fluxo único de provisionamento (doc de negócio §3): tenant + branding + SEQUENCE de auditoria
 * + primeiro ADMIN, atomicamente. As políticas RLS são estáticas (migration) e valem para todo
 * tenant. Deve rodar com o papel dono do schema (DIRECT_DATABASE_URL), nunca como app_runtime.
 * A chave KMS por tenant entra na fase 4.
 */
export async function provisionTenant(
  owner: PrismaClient,
  input: ProvisionTenantInput,
): Promise<{ tenantId: string; adminId: string }> {
  const data = provisionTenantSchema.parse(input);
  return owner.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        slug: data.slug,
        branding: { create: { companyName: data.companyName } },
      },
    });
    await tx.$executeRawUnsafe(`CREATE SEQUENCE ${auditSequenceName(tenant.id)}`);
    const admin = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: data.adminEmail.toLowerCase(),
        fullName: data.adminFullName,
        passwordHash: data.adminPasswordHash,
        role: 'ADMIN',
      },
    });
    return { tenantId: tenant.id, adminId: admin.id };
  });
}
