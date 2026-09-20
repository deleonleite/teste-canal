import { Injectable } from '@nestjs/common';
import type { UserRole } from '@ouvion/contracts';

/** Perfis internos com MFA obrigatório (doc §5.1). */
export const MFA_REQUIRED_ROLES: readonly UserRole[] = ['ADMIN', 'INVESTIGATOR', 'AUDITOR', 'SUPER_ADMIN'];

@Injectable()
export class SecurityConfig {
  /**
   * Em produção a obrigatoriedade de MFA é SEMPRE ligada. Só ambientes de desenvolvimento/staging
   * podem desligá-la (MFA_ENFORCEMENT=off), como previsto na arquitetura (§11).
   */
  enforceMfa = process.env.NODE_ENV === 'production' || process.env.MFA_ENFORCEMENT !== 'off';

  requiresMfa(role: UserRole): boolean {
    return this.enforceMfa && MFA_REQUIRED_ROLES.includes(role);
  }
}
