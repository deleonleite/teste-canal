import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import type { TenantClsStore } from '../tenancy/tenant-context';

const SESSION_MINUTES = 30;

/**
 * Token temporário de sessão do protocolo (doc §5.2.1): escopo de UMA denúncia, curta duração,
 * sem estado no servidor e sem cookie. Autoriza mensagens e anexos sem novo login.
 */
@Injectable()
export class ProtocolSessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  sign(complaintId: string): Promise<string> {
    const tenantId = this.cls.get('tenantId')!;
    return this.jwt.signAsync(
      { sub: complaintId, tenantId, scope: 'protocol' },
      { expiresIn: `${SESSION_MINUTES}m` },
    );
  }

  async verify(token: string | undefined): Promise<string> {
    if (!token) throw new UnauthorizedException();
    try {
      const c = await this.jwt.verifyAsync<{ sub: string; tenantId: string; scope?: string }>(token);
      if (c.scope !== 'protocol' || c.tenantId !== this.cls.get('tenantId')) throw new Error();
      return c.sub;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

@Injectable()
export class ProtocolGuard implements CanActivate {
  constructor(
    private readonly sessions: ProtocolSessionService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const complaintId = await this.sessions.verify(req.header('authorization')?.replace(/^Bearer /i, ''));
    this.cls.set('protocolComplaintId', complaintId);
    return true;
  }
}
