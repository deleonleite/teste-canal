import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '@ouvion/contracts';
import { ClsService } from 'nestjs-cls';

import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { RefreshTokensService } from './refresh-tokens.service';

interface AccessClaims {
  sub: string;
  tenantId: string;
  sid?: string;
  scope?: string;
}

export interface Session {
  userId: string;
  role: UserRole;
  sessionId: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  /**
   * Valida o token e reconfere no banco a cada request: usuário ativo e não suspenso E sessão
   * (família de refresh) ainda viva. Logout, revogação de sessão e suspensão valem na hora, sem
   * esperar os 15 min do access token. O perfil vem do banco, não do token.
   */
  async resolve(token: string): Promise<Session> {
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token);
    } catch {
      throw new UnauthorizedException();
    }
    const tenantId = this.cls.get('tenantId');
    // Tokens de escopo restrito (externo, protocolo, MFA) nunca valem como sessão de equipe.
    if (claims.scope || !claims.sid || !tenantId || claims.tenantId !== tenantId) throw new UnauthorizedException();
    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: claims.sub } });
      if (!user || !user.isActive || user.isBlocked) return null;
      if (!(await this.refreshTokens.isSessionActive(tx, claims.sid!, user.id))) return null;
      return user;
    });
    if (!result) throw new UnauthorizedException();
    return { userId: result.id, role: result.role, sessionId: claims.sid };
  }

  /** Para rotas públicas com autenticação opcional (ex.: denúncia identificada, via Bearer). */
  async tryResolve(authorization: string | undefined): Promise<Session | null> {
    const token = authorization?.replace(/^Bearer /i, '');
    return token ? this.resolve(token) : null;
  }
}
