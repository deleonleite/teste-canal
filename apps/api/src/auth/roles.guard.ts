import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@ouvion/contracts';
import { ClsService } from 'nestjs-cls';

import type { TenantClsStore } from '../tenancy/tenant-context';
import { ROLES_KEY } from './roles.decorator';

/** Checagem grossa de perfil. Deve rodar depois do JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!allowed) return true;
    const role = this.cls.get('role');
    if (!role || !allowed.includes(role)) throw new ForbiddenException();
    return true;
  }
}
