import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformRole } from '@prisma/client';
import type { Request } from 'express';

import { PlatformAuthService } from './platform-auth.service';

export const PLATFORM_ROLES = 'platform_roles';
/** Perfis internos autorizados na rota. Sem o decorator, qualquer operador autenticado entra. */
export const PlatformRoles = (...roles: PlatformRole[]) => SetMetadata(PLATFORM_ROLES, roles);

export interface PlatformRequest extends Request {
  operator: { userId: string; role: PlatformRole; sessionId: string };
}

/** Sessão da plataforma: só Bearer (o BFF guarda o token em cookie httpOnly e o converte). */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PlatformRequest>();
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    req.operator = await this.auth.resolve(header.slice(7));
    const roles = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(PLATFORM_ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.includes(req.operator.role)) throw new ForbiddenException();
    return true;
  }
}
