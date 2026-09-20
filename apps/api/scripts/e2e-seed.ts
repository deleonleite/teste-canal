import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { LocalKek } from '../src/crypto/field-cipher';
import { provisionTenant } from '../src/tenancy/provision-tenant';

/** Segredo TOTP FIXO só de dev/e2e (nunca em produção): permite gerar o código nos testes. */
export const DEV_PLATFORM_TOTP_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const DEV_PLATFORM_USERS: Array<{ email: string; fullName: string; role: 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCIAL' }> = [
  { email: 'superadmin@ouvion.com', fullName: 'Super Admin Demo', role: 'SUPER_ADMIN' },
  { email: 'suporte@ouvion.com', fullName: 'Suporte Demo', role: 'SUPPORT' },
  { email: 'financeiro@ouvion.com', fullName: 'Financeiro Demo', role: 'FINANCIAL' },
  // Contas dedicadas aos testes e2e (cada uma com o seu próprio contador de código TOTP).
  { email: 'e2e-ops@ouvion.com', fullName: 'E2E Operador', role: 'SUPER_ADMIN' },
  { email: 'e2e-login@ouvion.com', fullName: 'E2E Login', role: 'SUPER_ADMIN' },
  { email: 'e2e-logout@ouvion.com', fullName: 'E2E Logout', role: 'SUPER_ADMIN' },
];

/** Operadores de demonstração da plataforma: MFA já ativo com o segredo fixo acima. Só dev/staging. */
async function seedPlatform(owner: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('seed de plataforma não roda em produção');
  const kek = new LocalKek();
  const passwordHash = await argon2.hash('Demo123!@', { type: argon2.argon2id });
  for (const u of DEV_PLATFORM_USERS) {
    const data = {
      fullName: u.fullName, role: u.role, passwordHash, isActive: true, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null,
      mfaEnabled: true, mfaLastStep: 0, mfaRecoveryCodes: [] as string[],
    };
    const row = await owner.platformUser.upsert({ where: { email: u.email }, create: { email: u.email, ...data, mfaSecretEnc: null }, update: data });
    await owner.platformUser.update({ where: { id: row.id }, data: { mfaSecretEnc: kek.wrap(Buffer.from(DEV_PLATFORM_TOTP_SECRET, 'utf8'), `platform-mfa:${row.id}`) } });
    await owner.platformRefreshToken.deleteMany({ where: { userId: row.id } });
  }
}


/**
 * Tenant de demonstração/e2e (idempotente): provisiona se não existir e normaliza marca e configurações
 * públicas. Só para dev/CI — nunca rodar contra produção.
 */
async function main(): Promise<void> {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) throw new Error('DIRECT_DATABASE_URL é obrigatório');
  const slug = process.env.E2E_TENANT ?? 'demo';
  const owner = new PrismaClient({ datasourceUrl: url });

  let tenant = await owner.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    const r = await provisionTenant(owner, {
      slug,
      companyName: 'Empresa Demo',
      adminEmail: `admin@${slug}.com`,
      adminFullName: 'Admin Demo',
      adminPasswordHash: await argon2.hash('Senha-Forte-123!', { type: argon2.argon2id }),
    });
    tenant = await owner.tenant.findUniqueOrThrow({ where: { id: r.tenantId } });
  }
  await owner.tenant.update({ where: { id: tenant.id }, data: { dpoName: 'Maria Encarregada', dpoEmail: `dpo@${slug}.com`, status: 'ACTIVE' } });
  await owner.tenantBranding.update({ where: { tenantId: tenant.id }, data: { companyName: 'Empresa Demo', primaryColor: '#0a5c36', secondaryColor: '#f59e0b' } });

  // Admin sem 2º fator ativo: o e2e loga só com senha (a API do e2e roda com MFA_ENFORCEMENT=off).
  await owner.user.updateMany({ where: { tenantId: tenant.id, email: `admin@${slug}.com` }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryCodes: [], mfaLastStep: 0 } });

  // Investigador elegível para os testes de atribuição do painel.
  const investigatorEmail = `investigador@${slug}.com`;
  await owner.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: investigatorEmail } },
    create: {
      tenantId: tenant.id,
      email: investigatorEmail,
      fullName: 'Ivo Investigador',
      role: 'INVESTIGATOR',
      passwordHash: await argon2.hash('Senha-Forte-123!', { type: argon2.argon2id }),
    },
    update: { isActive: true, isBlocked: false },
  });

  const settings: Record<string, string> = {
    docCodigoEtica: 'https://exemplo.com/codigo-de-etica.pdf',
    docPoliticaAssedio: 'https://exemplo.com/politica-de-assedio.pdf',
    companyEmail: `etica@${slug}.com`,
    companyPhone: '0800 000 0000',
  };
  for (const [key, value] of Object.entries(settings)) {
    await owner.systemSetting.upsert({
      where: { tenantId_key: { tenantId: tenant.id, key } },
      create: { tenantId: tenant.id, key, value, isPublic: true },
      update: { value, isPublic: true },
    });
  }
  await owner.systemSetting.deleteMany({ where: { tenantId: tenant.id, key: { in: ['allowAnonymousComplaints', 'maintenanceMode'] } } });
  await seedPlatform(owner);
  console.warn(`Tenant "${slug}" pronto.`);
  await owner.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
