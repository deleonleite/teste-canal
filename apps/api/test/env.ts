/** URLs do banco de teste (Postgres do docker-compose). Sobrescreva com TEST_DB_HOST se necessário. */
const host = process.env.TEST_DB_HOST ?? 'localhost:5432';
const db = 'ouvion_test';

export const OWNER_URL = `postgresql://postgres:postgres@${host}/${db}`;
export const RUNTIME_URL = `postgresql://app_runtime:app_runtime@${host}/${db}`;
export const PLATFORM_URL = `postgresql://platform_admin:platform_admin@${host}/${db}`;
export const ADMIN_URL = `postgresql://postgres:postgres@${host}/postgres`;

process.env.DATABASE_URL = RUNTIME_URL;
process.env.DIRECT_DATABASE_URL = OWNER_URL;
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.PLATFORM_DATABASE_URL = PLATFORM_URL;
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.MFA_ENFORCEMENT = 'off';
