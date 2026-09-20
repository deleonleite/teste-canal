import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  assignInvestigatorSchema,
  classifyComplaintSchema,
  ComplaintPriority,
  ComplaintStatus,
  ComplaintType,
  createAddendumSchema,
  createCommentSchema,
} from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { WorkflowService } from '../workflow/workflow.service';
import { type Actor, ComplaintsService } from './complaints.service';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(ComplaintStatus).optional(),
  type: z.enum(ComplaintType).optional(),
  priority: z.enum(ComplaintPriority).optional(),
  sla: z.enum(['on_time', 'at_risk', 'breached']).optional(),
});
const idSchema = z.string().uuid();

/** Rotas autenticadas da equipe (e REPORTER nas próprias denúncias). */
@Controller('complaints')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ComplaintsController {
  constructor(
    private readonly complaints: ComplaintsService,
    private readonly workflow: WorkflowService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private actor(req: Request): Actor {
    return { userId: this.cls.get('userId')!, role: this.cls.get('role')!, ...clientInfo(req) };
  }

  @Get()
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR', 'REPORTER')
  list(@Req() req: Request, @Query() raw: unknown) {
    return this.complaints.list(this.actor(req), parseBody(listQuery, raw));
  }

  @Get(':id')
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR', 'REPORTER')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.complaints.detail(this.actor(req), parseBody(idSchema, id));
  }

  @Patch(':id')
  @Roles('ADMIN', 'INVESTIGATOR')
  classify(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const changes = parseBody(classifyComplaintSchema, body);
    return this.workflow.classify(this.actor(req), parseBody(idSchema, id), changes);
  }

  @Post(':id/assign')
  @Roles('ADMIN')
  assign(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { investigatorId } = parseBody(assignInvestigatorSchema, body);
    return this.complaints.assign(this.actor(req), parseBody(idSchema, id), investigatorId);
  }

  @Post(':id/addenda')
  @Roles('ADMIN', 'INVESTIGATOR')
  addendum(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { content } = parseBody(createAddendumSchema, body);
    return this.complaints.addAddendum(this.actor(req), parseBody(idSchema, id), content);
  }

  @Post(':id/comments')
  @Roles('ADMIN', 'INVESTIGATOR')
  comment(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { content, visibility } = parseBody(createCommentSchema, body);
    return this.complaints.addComment(this.actor(req), parseBody(idSchema, id), content, visibility);
  }

  @Get(':id/comments')
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR', 'REPORTER')
  comments(@Req() req: Request, @Param('id') id: string) {
    return this.complaints.listComments(this.actor(req), parseBody(idSchema, id));
  }
}
