import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { provisionTenant } from '../src/tenancy/provision-tenant';

/** Uso: SLUG=acme COMPANY="Acme" ADMIN_EMAIL=a@b.com ADMIN_NAME="Fulano" ADMIN_PASSWORD=... pnpm tenant:provision */
async function main(): Promise<void> {
  const { SLUG, COMPANY, ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD, DIRECT_DATABASE_URL } =
    process.env;
  if (!SLUG || !COMPANY || !ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD || !DIRECT_DATABASE_URL) {
    throw new Error(
      'Defina SLUG, COMPANY, ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD e DIRECT_DATABASE_URL',
    );
  }
  const owner = new PrismaClient({ datasourceUrl: DIRECT_DATABASE_URL });
  const result = await provisionTenant(owner, {
    slug: SLUG,
    companyName: COMPANY,
    adminEmail: ADMIN_EMAIL,
    adminFullName: ADMIN_NAME,
    adminPasswordHash: await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id }),
  });
  console.warn('Tenant provisionado:', result);
  await owner.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
