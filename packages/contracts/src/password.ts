import { z } from 'zod';

/** Senhas comuns/vazadas mais frequentes (lista mínima; a verificação completa usa base externa). */
const COMMON_PASSWORDS = new Set(
  [
    '12345678', '123456789', '1234567890', 'password', 'password1', 'senha123', 'senha1234',
    'qwerty123', 'qwertyuiop', 'abc12345', 'iloveyou', 'admin123', 'admin1234', 'mudar123',
    'brasil123', 'corinthians', 'flamengo123', '11111111', '00000000', 'letmein123',
  ].map((p) => p.toLowerCase()),
);

/** Política única de senha em todo o sistema (doc de negócio §5.1). */
export const passwordSchema = z
  .string()
  .min(8, 'A senha deve ter no mínimo 8 caracteres')
  .max(100, 'A senha deve ter no máximo 100 caracteres')
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p), 'Use letras maiúsculas e minúsculas')
  .refine((p) => /\d/.test(p), 'Inclua ao menos um número')
  .refine((p) => /[^A-Za-z0-9]/.test(p), 'Inclua ao menos um símbolo')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'Senha muito comum');
