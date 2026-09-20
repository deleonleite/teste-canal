import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  SUPER_ADMIN_DATABASE_URL: z.string().url().optional(),
  /** 32 bytes em base64: chave-mestra da qual derivam as chaves de dados por tenant. */
  FIELD_ENCRYPTION_KEY: z.string().optional(),
  PUBLIC_WEB_URL: z.string().url().optional(),
});
export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Variáveis de ambiente inválidas: ${JSON.stringify(result.error.flatten().fieldErrors)}`);
  }
  return result.data;
}
