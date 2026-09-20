import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import type { TenantClsStore } from '../tenancy/tenant-context';
import { enforceCsrf, extractToken } from './cookies';
import { SessionService } from './session.service';

/** Exige sessão válida (Bearer ou cookie httpOnly + CSRF), de usuário ativo e não suspenso. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const found = extractToken(req);
    if (!found) throw new UnauthorizedException();
    if (found.fromCookie) enforceCsrf(req);
    const session = await this.sessions.resolve(found.token);
    this.cls.set('userId', session.userId);
    this.cls.set('role', session.role);
    this.cls.set('sessionId', session.sessionId);
    return true;
  }
}
