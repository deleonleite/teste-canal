import { defineConfig, devices } from '@playwright/test';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:3100';
export const BFF_SECRET = 'e2e-bff-secret-e2e-bff-secret-e2e-bff-secret';
const DB = 'postgresql://app_runtime:app_runtime@localhost:5432/ouvion';
const OWNER_DB = 'postgresql://postgres:postgres@localhost:5432/ouvion';

/**
 * E2E contra a API real (Postgres/Redis do docker-compose) e o Next em modo produção. O tenant "demo" é
 * criado pelo seed (idempotente). Rate limits por IP ficam desligados só aqui (a suíte dispara tudo do mesmo IP).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: WEB, locale: 'pt-BR', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `${API}/health`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        PORT: '3001',
        DATABASE_URL: DB,
        DIRECT_DATABASE_URL: OWNER_DB,
        JWT_ACCESS_SECRET: 'e2e-jwt-secret-e2e-jwt-secret-e2e-jwt-secret',
        BFF_SHARED_SECRET: BFF_SECRET,
        RATE_LIMIT_DISABLED: 'true',
        MFA_ENFORCEMENT: 'off',
      },
    },
    {
      command: 'npx next start -p 3100',
      url: `${WEB}/demo`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { API_URL: API, BFF_SHARED_SECRET: BFF_SECRET, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
