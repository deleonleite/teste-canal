import { Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { AuditAction } from '@ouvion/contracts';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { parseBody } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { AuditIntegrityService } from './integrity.service';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  action: z.enum(AuditAction).optional(),
  resource: z.string().max(60).optional(),
  userId: z.string().uuid().optional(),
});

@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrity: AuditIntegrityService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  /** Selos da trilha (raiz Merkle, encadeamento e âncora externa) para conferência independente. */
  @Get('seals')
  @Roles('ADMIN', 'AUDITOR')
  async seals() {
    const rows = await this.prisma.run((tx) => tx.auditSeal.findMany({ orderBy: { toSeq: 'desc' }, take: 100 }));
    return rows.map((s) => ({
      id: s.id,
      fromSeq: s.fromSeq.toString(),
      toSeq: s.toSeq.toString(),
      gaps: s.gaps.map(String),
      rowCount: s.rowCount,
      merkleRoot: s.merkleRoot,
      prevSealHash: s.prevSealHash,
      sealHash: s.sealHash,
      sealedAt: s.sealedAt,
      anchorType: s.anchorType,
      anchorRef: s.anchorRef,
      anchoredAt: s.anchoredAt,
    }));
  }

  /** Verificação sob demanda: recalcula hashes, raízes, cadeia e confere as âncoras. */
  @Post('verify')
  @HttpCode(200)
  @Roles('ADMIN', 'AUDITOR')
  verify() {
    return this.integrity.verifyAndAlert(this.cls.get('tenantId')!);
  }

  /** Consulta/exportação de auditoria do tenant. `seq` de eventos anônimos nunca é exposto. */
  @Get()
  @Roles('ADMIN', 'AUDITOR')
  async list(@Query() raw: unknown) {
    const q = parseBody(querySchema, raw);
    const where = { action: q.action, resource: q.resource, userId: q.userId };
    const [rows, total] = await this.prisma.run((tx) =>
      Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { seq: 'desc' },
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
        tx.auditLog.count({ where }),
      ]),
    );
    return {
      data: rows.map(({ seq, anonymousOrigin, ...r }) => ({
        ...r,
        seq: anonymousOrigin ? null : seq.toString(),
        anonymousOrigin,
      })),
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  }
}
