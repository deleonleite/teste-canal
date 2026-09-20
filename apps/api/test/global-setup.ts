import { execSync } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

import { ADMIN_URL, OWNER_URL } from './env';

/** Recria o banco ouvion_test, aplica as migrations e define as senhas dos papéis. */
export default async function globalSetup(): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });
  await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS ouvion_test WITH (FORCE)');
  await admin.$executeRawUnsafe('CREATE DATABASE ouvion_test');
  await admin.$disconnect();

  const env = {
    ...process.env,
    DATABASE_URL: OWNER_URL,
    DIRECT_DATABASE_URL: OWNER_URL,
    APP_RUNTIME_PASSWORD: 'app_runtime',
    PLATFORM_ADMIN_PASSWORD: 'platform_admin',
  };
  execSync('npx prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('npx ts-node scripts/db-setup.ts', { env, stdio: 'pipe' });
}
