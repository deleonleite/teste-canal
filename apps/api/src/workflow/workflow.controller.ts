import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { linkComplaintSchema, retaliationSchema, slaPauseSchema, statusChangeSchema } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import type { Actor } from '../complaints/complaints.service';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { WorkflowService } from './workflow.service';

const uuid = z.string().uuid();

@Controller('complaints/:id')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkflowController {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private actor(req: Request): Actor {
    return { userId: this.cls.get('userId')!, role: this.cls.get('role')!, ...clientInfo(req) };
  }

  /** Alteração de status pela máquina de estados; encerrar exige conclusão; reabrir é só ADMIN. */
  @Post('status')
  @HttpCode(200)
  @Roles('ADMIN', 'INVESTIGATOR')
  status(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.workflow.changeStatus(this.actor(req), parseBody(uuid, id), parseBody(statusChangeSchema, body));
  }

  /** "Remover" = arquivar (DISMISSED); nunca exclui fisicamente. */
  @Delete()
  @Roles('ADMIN')
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.workflow.archive(this.actor(req), parseBody(uuid, id));
  }

  @Post('sla/pause')
  @HttpCode(200)
  @Roles('ADMIN', 'INVESTIGATOR')
  pause(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.workflow.pauseSla(this.actor(req), parseBody(uuid, id), parseBody(slaPauseSchema, body).reason);
  }

  @Post('sla/resume')
  @HttpCode(200)
  @Roles('ADMIN', 'INVESTIGATOR')
  resume(@Req() req: Request, @Param('id') id: string) {
    return this.workflow.resumeSla(this.actor(req), parseBody(uuid, id));
  }

  @Get('related-suggestions')
  @Roles('ADMIN', 'INVESTIGATOR')
  related(@Req() req: Request, @Param('id') id: string) {
    return this.workflow.suggestRelated(this.actor(req), parseBody(uuid, id));
  }

  @Post('links')
  @Roles('ADMIN', 'INVESTIGATOR')
  link(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.workflow.link(this.actor(req), parseBody(uuid, id), parseBody(linkComplaintSchema, body).relatedId);
  }

  /** REPORTER com conta relata retaliação na própria denúncia (o anônimo usa o canal por protocolo). */
  @Post('retaliation')
  @Roles('REPORTER')
  retaliation(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { content } = parseBody(retaliationSchema, body);
    return this.workflow.reportRetaliation(parseBody(uuid, id), content, { anonymousSession: false, actorId: this.cls.get('userId')! });
  }
}
