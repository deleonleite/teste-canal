import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  accessGrantSchema,
  externalTriggerSchema,
  recuseSchema,
  restrictionSchema,
  revealIdentitySchema,
} from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { ConflictService } from '../conflicts/conflict.service';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { CaseManagementService } from './case-management.service';
import { type Actor, ComplaintsService } from './complaints.service';

const uuid = z.string().uuid();

@Controller('complaints/:id')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CaseManagementController {
  constructor(
    private readonly mgmt: CaseManagementService,
    private readonly complaints: ComplaintsService,
    private readonly conflicts: ConflictService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private actor(req: Request): Actor {
    return { userId: this.cls.get('userId')!, role: this.cls.get('role')!, ...clientInfo(req) };
  }

  @Post('recuse')
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR')
  recuse(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseBody(recuseSchema, body);
    return this.conflicts.recuse(this.actor(req), parseBody(uuid, id), reason);
  }

  @Post('reveal-identity')
  @Roles('ADMIN', 'INVESTIGATOR')
  reveal(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { justification } = parseBody(revealIdentitySchema, body);
    return this.complaints.revealIdentity(this.actor(req), parseBody(uuid, id), justification);
  }

  @Post('restriction')
  @Roles('ADMIN')
  restriction(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { isRestricted } = parseBody(restrictionSchema, body);
    return this.mgmt.setRestriction(this.actor(req), parseBody(uuid, id), isRestricted);
  }

  @Post('access-grants')
  @Roles('ADMIN')
  grant(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.mgmt.grantAccess(this.actor(req), parseBody(uuid, id), parseBody(accessGrantSchema, body));
  }

  @Post('access-grants/:grantId/revoke')
  @Roles('ADMIN')
  revokeGrant(@Req() req: Request, @Param('id') id: string, @Param('grantId') grantId: string) {
    return this.mgmt.revokeGrant(this.actor(req), parseBody(uuid, id), parseBody(uuid, grantId));
  }

  @Post('external-access')
  @Roles('ADMIN')
  triggerExternal(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseBody(externalTriggerSchema, body);
    return this.mgmt.triggerExternal(this.actor(req), parseBody(uuid, id), reason);
  }

  @Post('external-access/:accessId/revoke')
  @Roles('ADMIN')
  revokeExternal(@Req() req: Request, @Param('id') id: string, @Param('accessId') accessId: string) {
    return this.mgmt.revokeExternal(this.actor(req), parseBody(uuid, id), parseBody(uuid, accessId));
  }
}
