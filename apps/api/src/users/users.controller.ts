import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { blockUserSchema, UserRole } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { MfaService } from '../auth/mfa.service';
import { RefreshTokensService } from '../auth/refresh-tokens.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';

const idSchema = z.string().uuid();
const listQuery = z.object({ role: z.enum(UserRole).optional() });

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly mfa: MfaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  /** Lista sem passwordHash e sem motivo de suspensão (este só o ADMIN vê no detalhe interno). */
  @Get()
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR')
  list(@Query() raw: unknown) {
    const { role } = parseBody(listQuery, raw);
    return this.prisma.run((tx) =>
      tx.user.findMany({
        where: { role, isActive: true, isBlocked: false },
        select: { id: true, email: true, fullName: true, role: true },
        orderBy: { fullName: 'asc' },
      }),
    );
  }

  /**
   * Gestão de equipe (ADMIN): todos os usuários internos, inclusive suspensos, com o estado de cada um.
   * Nunca devolve hash de senha, segredo de MFA nem o motivo da suspensão. REPORTER/PUBLIC não são equipe.
   */
  @Get('manage')
  @Roles('ADMIN')
  manage() {
    return this.prisma.run((tx) =>
      tx.user.findMany({
        where: { role: { in: ['ADMIN', 'INVESTIGATOR', 'AUDITOR'] }, isActive: true },
        select: { id: true, email: true, fullName: true, role: true, isBlocked: true, mfaEnabled: true, lastLoginAt: true },
        orderBy: { fullName: 'asc' },
      }),
    );
  }

  /**
   * Suspensão MANUAL (medida cautelar decidida fora do canal). O sistema nunca suspende sozinho.
   * O motivo é interno e nunca é exibido ao suspenso; não vai para a auditoria (pode conter PII).
   */
  @Post(':id/block')
  @Roles('ADMIN')
  async block(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const id = parseBody(idSchema, rawId);
    const { reason } = parseBody(blockUserSchema, body);
    const actorId = this.cls.get('userId')!;
    return this.prisma.run(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new NotFoundException('Usuário não encontrado');
      if (user.role === 'ADMIN' && !user.isBlocked) {
        const otherAdmins = await tx.user.count({
          where: { role: 'ADMIN', isActive: true, isBlocked: false, id: { not: id } },
        });
        if (otherAdmins === 0) throw new ConflictException('Não é possível suspender o último ADMIN');
      }
      await tx.user.update({
        where: { id },
        data: { isBlocked: true, blockedAt: new Date(), blockedBy: actorId, blockedReason: reason },
      });
      // Suspensão derruba todas as sessões do usuário imediatamente.
      await this.refreshTokens.revokeAll(tx, id);
      await this.audit.record(tx, {
        action: 'BLOCK',
        resource: 'user',
        resourceId: id,
        userId: actorId,
        ...clientInfo(req),
      });
      return { id, isBlocked: true };
    });
  }

  /** ADMIN reseta o MFA de um usuário (auditado); as sessões dele caem e ele recadastra no próximo login. */
  @Post(':id/mfa/reset')
  @Roles('ADMIN')
  resetMfa(@Req() req: Request, @Param('id') rawId: string) {
    return this.mfa.reset(this.cls.get('userId')!, parseBody(idSchema, rawId), clientInfo(req));
  }

  @Post(':id/unblock')
  @Roles('ADMIN')
  async unblock(@Req() req: Request, @Param('id') rawId: string) {
    const id = parseBody(idSchema, rawId);
    const actorId = this.cls.get('userId')!;
    return this.prisma.run(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new NotFoundException('Usuário não encontrado');
      await tx.user.update({
        where: { id },
        data: { isBlocked: false, blockedAt: null, blockedBy: null, blockedReason: null },
      });
      await this.audit.record(tx, {
        action: 'UNBLOCK',
        resource: 'user',
        resourceId: id,
        userId: actorId,
        ...clientInfo(req),
      });
      return { id, isBlocked: false };
    });
  }
}
