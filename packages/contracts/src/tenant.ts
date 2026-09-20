import { z } from 'zod';

export const tenantSlugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug deve conter apenas letras minúsculas, números e hífens');

export const provisionTenantSchema = z.object({
  slug: tenantSlugSchema,
  companyName: z.string().min(2).max(120),
  adminEmail: z.string().email(),
  adminFullName: z.string().min(2).max(120),
  adminPasswordHash: z.string().min(20),
});
export type ProvisionTenantInput = z.infer<typeof provisionTenantSchema>;
