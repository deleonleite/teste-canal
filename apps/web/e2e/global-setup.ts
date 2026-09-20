import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { request } from '@playwright/test';
import { authenticator } from 'otplib';

/** Segredo TOTP FIXO do seed de dev/e2e (ver apps/api/scripts/e2e-seed.ts). */
export const PLATFORM_TOTP_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
export const PLATFORM_PASSWORD = 'Demo123!@';
export const AUTH_DIR = join(__dirname, '.auth');
export const platformState = (name: string) => join(AUTH_DIR, `${name}.json`);

/** Entra na plataforma pelo BFF (senha + código TOTP) e guarda os cookies para os testes reutilizarem. */
async function platformLogin(baseURL: string, email: string, name: string): Promise<void> {
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { 'x-ouvion-csrf': '1' } });
  const login = await ctx.post('/api/platform/auth/login', { data: { email, password: PLATFORM_PASSWORD } });
  if (!login.ok()) throw new Error(`login da plataforma falhou para ${email}: ${login.status()}`);
  const { mfaToken } = (await login.json()) as { mfaToken: string };
  const verify = await ctx.post('/api/platform/auth/mfa/verify', { data: { mfaToken, code: authenticator.generate(PLATFORM_TOTP_SECRET) } });
  if (!verify.ok()) throw new Error(`2º fator falhou para ${email}: ${verify.status()}`);
  await ctx.storageState({ path: platformState(name) });
  await ctx.dispose();
}

/** Garante o tenant "demo" (idempotente) e os operadores da plataforma, e abre as sessões usadas pelos testes. */
export default async function globalSetup(): Promise<void> {
  execSync('pnpm e2e:seed', {
    cwd: join(__dirname, '..', '..', 'api'),
    stdio: 'pipe',
    env: { ...process.env, DIRECT_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/ouvion', DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/ouvion' },
  });
  mkdirSync(AUTH_DIR, { recursive: true });
  const base = 'http://localhost:3100';
  await platformLogin(base, 'superadmin@ouvion.com', 'superadmin');
  await platformLogin(base, 'suporte@ouvion.com', 'suporte');
  await platformLogin(base, 'financeiro@ouvion.com', 'financeiro');
  await platformLogin(base, 'e2e-approver-a@ouvion.com', 'approver-a');
  await platformLogin(base, 'e2e-approver-b@ouvion.com', 'approver-b');
  await platformLogin(base, 'e2e-approver-c@ouvion.com', 'approver-c');
}
