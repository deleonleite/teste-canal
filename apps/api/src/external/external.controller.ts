import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { assignInvestigatorSchema, decideConflictSchema, externalVerifySchema } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { SAFE_OMIT } from '../access/case-access.service';
import { AuditService } from '../audit/audit.service';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { ComplaintsService } from '../complaints/complaints.service';
import { ConflictService } from '../conflicts/conflict.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { ExternalAccessService } from './external-access.service';

@Injectable()
export class ExternalGuard implements CanActivate {
  constructor(
    private readonly external: ExternalAccessService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const s = await this.external.resolve(req.header('authorization'));
    this.cls.set('externalAccessId', s.accessId);
    this.cls.set('externalComplaintId', s.complaintId);
    return true;
  }
}

/**
 * Área do destinatário alternativo. TUDO aqui é escopado ao único caso do acesso: não há rota que
 * aceite outro complaintId, e não existem listagens de casos, usuários, configurações ou estatísticas.
 */
@Controller('external')
export class ExternalController {
  constructor(
    private readonly external: ExternalAccessService,
    private readonly conflicts: ConflictService,
    private readonly complaints: ComplaintsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly notifications: NotificationsService,
  ) {}

  private scope() {
    return { accessId: this.cls.get('externalAccessId')!, complaintId: this.cls.get('externalComplaintId')! };
  }

  /** Link de uso único + TOTP => sessão de 60 min. */
  @Post('verify')
  verify(@Req() req: Request, @Body() body: unknown) {
    const { token, code } = parseBody(externalVerifySchema, body);
    return this.external.verify(token, code, clientInfo(req));
  }

  @Get('case')
  @UseGuards(ExternalGuard)
  async caseDetail(@Req() req: Request) {
    const { accessId, complaintId } = this.scope();
    return this.prisma.run(async (tx) => {
      const c = await tx.complaint.findUniqueOrThrow({ where: { id: complaintId }, omit: SAFE_OMIT });
      const [history, addenda] = await Promise.all([
        tx.complaintStatusHistory.findMany({ where: { complaintId }, orderBy: { createdAt: 'desc' } }),
        tx.complaintAddendum.findMany({ where: { complaintId }, orderBy: { createdAt: 'asc' } }),
      ]);
      await this.audit.record(tx, {
        action: 'EXTERNAL_ACCESS',
        resource: 'complaint',
        resourceId: complaintId,
        details: { event: 'read', accessId },
        ...clientInfo(req),
      });
      return { ...c, history, addenda };
    });
  }

  @Get('conflicts')
  @UseGuards(ExternalGuard)
  listConflicts() {
    return this.conflicts.list(undefined, this.scope().complaintId);
  }

  @Post('conflicts/:flagId/decide')
  @UseGuards(ExternalGuard)
  decide(@Req() req: Request, @Param('flagId') flagId: string, @Body() body: unknown) {
    const { decision, note } = parseBody(decideConflictSchema, body);
    const { accessId, complaintId } = this.scope();
    return this.conflicts.decide(
      { type: 'external', accessId, ...clientInfo(req) },
      parseBody(z.string().uuid(), flagId),
      decision,
      note,
      complaintId,
    );
  }

  @Get('investigators')
  @UseGuards(ExternalGuard)
  investigators() {
    return this.prisma.run((tx) => this.conflicts.eligibleInvestigators(tx, this.scope().complaintId));
  }

  @Post('assign')
  @UseGuards(ExternalGuard)
  assign(@Req() req: Request, @Body() body: unknown) {
    const { investigatorId } = parseBody(assignInvestigatorSchema, body);
    const { accessId, complaintId } = this.scope();
    return this.prisma
      .run((tx) => this.complaints.assignCore(tx, complaintId, investigatorId, null, { external: accessId, ...clientInfo(req) }))
      .then(async (r) => {
        await this.notifications.onAssigned(complaintId, investigatorId);
        return r;
      });
  }
}
