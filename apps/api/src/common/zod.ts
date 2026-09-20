import { BadRequestException } from '@nestjs/common';
import type { z, ZodTypeAny } from 'zod';

/** Validação estrita de entrada: campos não declarados são rejeitados pelos schemas `.strict()`. */
export function parseBody<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Dados inválidos',
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}
