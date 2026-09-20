import { execSync } from 'node:child_process';
import { join } from 'node:path';

/** Garante o tenant "demo" (idempotente) no banco de desenvolvimento. */
export default async function globalSetup(): Promise<void> {
  execSync('pnpm e2e:seed', {
    cwd: join(__dirname, '..', '..', 'api'),
    stdio: 'pipe',
    env: { ...process.env, DIRECT_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/ouvion', DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/ouvion' },
  });
}
