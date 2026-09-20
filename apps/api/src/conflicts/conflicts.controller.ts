import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { decideConflictSchema } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { ConflictService } from './conflict.service';

const listQuery = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'DISMISSED']).optional(),
  complaintId: z.string().uuid().optional(),
});

/** Revisão de suspeitas de conflito: somente ADMIN (e o decisor não pode ser o suspeito). */
@Controller('conflicts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ConflictsController {
  constructor(
    private readonly conflicts: ConflictService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  @Get()
  list(@Query() raw: unknown) {
    const q = parseBody(listQuery, raw);
    return this.conflicts.list(q.status, q.complaintId);
  }

  @Post(':flagId/decide')
  decide(@Req() req: Request, @Param('flagId') flagId: string, @Body() body: unknown) {
    const { decision, note } = parseBody(decideConflictSchema, body);
    return this.conflicts.decide(
      { type: 'user', userId: this.cls.get('userId')!, role: this.cls.get('role')!, ...clientInfo(req) },
      parseBody(z.string().uuid(), flagId),
      decision,
      note,
    );
  }
}
