import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, InternalServerErrorException, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { Storage } from '../storage/storage';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformPrismaService } from './platform-prisma.service';
import { PlatformGuard, PlatformRoles, type PlatformRequest } from './platform.guard';

const uuid = z.string().uuid();
const DOWNLOAD_SECONDS = 300;

const requestSchema = z
  .object({
    tenantId: z.string().uuid(),
    scope: z.enum(['COMPLAINT', 'ATTACHMENT']),
    /** Protocolo que o cliente informa: o painel nunca lista denúncias. */
    protocol: z.string().trim().min(3).max(60),
    /** Só para anexo: nome exato do arquivo dentro da denúncia. */
    filename: z.string().trim().min(1).max(255).optional(),
    reason: z.string().trim().min(20).max(1000),
    ticketRef: z.string().trim().min(3).max(80),
  })
  .strict()
  .refine((v) => v.scope !== 'ATTACHMENT' || !!v.filename, { message: 'Informe o nome do arquivo', path: ['filename'] });
const approveSchema = z.object({ minutes: z.number().int().min(5).max(60), code: z.string().regex(/^\d{6}$/, 'Código inválido') }).strict();
const noteSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();

/** Converte o erro que uma função do banco levanta (SQLSTATE) na resposta HTTP certa. */
function mapDbError(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = e.meta as { code?: string; message?: string } | undefined;
    const msg = (meta?.message ?? '').replace(/^ERROR:\s*/, '').split('\n')[0] || 'Não foi possível concluir';
    switch (meta?.code) {
      case 'P0002':
        throw new NotFoundException(msg);
      case '42501':
        throw new ForbiddenException(msg);
      case '55000':
        throw new ConflictException(msg);
      case '22023':
        throw new BadRequestException(msg);
    }
  }
  throw e instanceof Error ? e : new InternalServerErrorException();
}

type RequestRow = Prisma.BreakGlassRequestGetPayload<object>;
const stateOf = (r: RequestRow, now = new Date()): 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'DENIED' | 'REVOKED' =>
  r.status === 'APPROVED' ? (r.expiresAt && r.expiresAt > now ? 'ACTIVE' : 'EXPIRED') : r.status;

/**
 * Quebra de vidro (tarefas.md §5): o ÚNICO caminho legítimo para alguém da OuviON ver conteúdo de uma empresa.
 * Pedido com motivo e chamado → aprovação por OUTRO SUPER_ADMIN com código do 2º fator recente → janela de no
 * máximo 1 hora, de UM item → aviso imediato ao ADMIN da empresa → trilha nos dois lados. As regras de janela,
 * aprovador e escopo são conferidas DENTRO do banco (funções platform_bg_*), não só aqui.
 */
@Controller('platform/break-glass')
@UseGuards(PlatformGuard)
export class PlatformBreakGlassController {
  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly audit: PlatformAuditService,
    private readonly auth: PlatformAuthService,
    private readonly storage: Storage,
  ) {}

  @Post()
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  async request(@Req() req: PlatformRequest, @Body() body: unknown) {
    const b = parseBody(requestSchema, body);
    let id: string;
    try {
      const rows = await this.prisma.db.$queryRaw<Array<{ id: string }>>`
        SELECT platform_bg_create(${b.tenantId}::uuid, ${b.scope}::"BreakGlassScope", ${b.protocol}, ${b.filename ?? null}, ${req.operator.userId}::uuid, ${b.reason}, ${b.ticketRef}) AS id`;
      id = rows[0]!.id;
    } catch (e) {
      mapDbError(e);
    }
    await this.audit.record({
      action: 'BREAK_GLASS_REQUESTED', severity: 'HIGH', resource: 'break_glass', resourceId: id, tenantId: b.tenantId, actorId: req.operator.userId,
      details: { scope: b.scope, target: b.filename ? `${b.protocol} / ${b.filename}` : b.protocol, ticket: b.ticketRef, reason: b.reason }, ...clientInfo(req),
    });
    return { id, status: 'PENDING' as const };
  }

  private async view(rows: RequestRow[]) {
    const tenants = await this.prisma.db.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, slug: true, branding: { select: { companyName: true } } } });
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy]).filter((x): x is string => !!x))];
    const users = await this.prisma.db.platformUser.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    const counts = await this.prisma.db.breakGlassUse.groupBy({ by: ['requestId'], where: { requestId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const t = new Map(tenants.map((x) => [x.id, x]));
    const u = new Map(users.map((x) => [x.id, x.fullName]));
    const c = new Map(counts.map((x) => [x.requestId, x._count._all]));
    return rows.map((r) => ({
      id: r.id, tenantId: r.tenantId, tenantName: t.get(r.tenantId)?.branding?.companyName ?? t.get(r.tenantId)?.slug ?? '—', tenantSlug: t.get(r.tenantId)?.slug ?? null,
      scope: r.scope, target: r.resourceLabel, reason: r.reason, ticketRef: r.ticketRef, state: stateOf(r),
      requestedBy: r.requestedBy, requestedByName: u.get(r.requestedBy) ?? null, approvedByName: r.approvedBy ? (u.get(r.approvedBy) ?? null) : null,
      createdAt: r.createdAt, approvedAt: r.approvedAt, expiresAt: r.expiresAt, decisionNote: r.decisionNote, uses: c.get(r.id) ?? 0,
    }));
  }

  /** SUPER_ADMIN vê todos (para decidir); SUPPORT só os próprios. */
  @Get()
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  async list(@Req() req: PlatformRequest) {
    const rows = await this.prisma.db.breakGlassRequest.findMany({
      where: req.operator.role === 'SUPER_ADMIN' ? {} : { requestedBy: req.operator.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.view(rows);
  }

  private async mine(req: PlatformRequest, id: string): Promise<RequestRow> {
    const row = await this.prisma.db.breakGlassRequest.findUnique({ where: { id } });
    if (!row || (req.operator.role !== 'SUPER_ADMIN' && row.requestedBy !== req.operator.userId)) throw new NotFoundException('Pedido não encontrado');
    return row;
  }

  @Get(':id')
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  async one(@Req() req: PlatformRequest, @Param('id') id: string) {
    return (await this.view([await this.mine(req, parseBody(uuid, id))]))[0];
  }

  /** Aprovação: outro SUPER_ADMIN, com código do 2º fator DIGITADO AGORA (MFA recente) e janela de 5 a 60 minutos. */
  @Post(':id/approve')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN')
  async approve(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const rid = parseBody(uuid, id);
    const { minutes, code } = parseBody(approveSchema, body);
    const row = await this.prisma.db.breakGlassRequest.findUnique({ where: { id: rid } });
    if (!row) throw new NotFoundException('Pedido não encontrado');
    if (row.requestedBy === req.operator.userId) throw new ForbiddenException('O aprovador deve ser diferente de quem pediu');
    await this.auth.assertFreshMfa(req.operator.userId, code); // só depois de conferir o código o banco decide
    let out: Array<{ tenant_id: string; expires_at: Date; target: string }>;
    try {
      out = await this.prisma.db.$queryRaw`SELECT * FROM platform_bg_approve(${rid}::uuid, ${req.operator.userId}::uuid, ${minutes}::integer)`;
    } catch (e) {
      mapDbError(e);
    }
    await this.audit.record({
      action: 'BREAK_GLASS_APPROVED', severity: 'CRITICAL', resource: 'break_glass', resourceId: rid, tenantId: row.tenantId, actorId: req.operator.userId,
      details: { target: out[0]!.target, minutes, requestedBy: row.requestedBy, expiresAt: out[0]!.expires_at.toISOString() }, ...clientInfo(req),
    });
    return { id: rid, state: 'ACTIVE' as const, expiresAt: out[0]!.expires_at };
  }

  @Post(':id/deny')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN')
  async deny(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const rid = parseBody(uuid, id);
    const { reason } = parseBody(noteSchema, body);
    const row = await this.prisma.db.breakGlassRequest.findUnique({ where: { id: rid } });
    if (!row) throw new NotFoundException('Pedido não encontrado');
    try {
      await this.prisma.db.$executeRaw`SELECT platform_bg_deny(${rid}::uuid, ${req.operator.userId}::uuid, ${reason})`;
    } catch (e) {
      mapDbError(e);
    }
    await this.audit.record({ action: 'BREAK_GLASS_DENIED', severity: 'MEDIUM', resource: 'break_glass', resourceId: rid, tenantId: row.tenantId, actorId: req.operator.userId, details: { target: row.resourceLabel, reason }, ...clientInfo(req) });
    return { id: rid, state: 'DENIED' as const };
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN')
  async revoke(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const rid = parseBody(uuid, id);
    const { reason } = parseBody(noteSchema, body);
    const row = await this.prisma.db.breakGlassRequest.findUnique({ where: { id: rid } });
    if (!row) throw new NotFoundException('Pedido não encontrado');
    try {
      await this.prisma.db.$executeRaw`SELECT platform_bg_revoke(${rid}::uuid, ${req.operator.userId}::uuid, ${reason})`;
    } catch (e) {
      mapDbError(e);
    }
    await this.audit.record({ action: 'BREAK_GLASS_REVOKED', severity: 'HIGH', resource: 'break_glass', resourceId: rid, tenantId: row.tenantId, actorId: req.operator.userId, details: { target: row.resourceLabel, reason }, ...clientInfo(req) });
    return { id: rid, state: 'REVOKED' as const };
  }

  /** Cada abertura é um USO: a função do banco confere janela/aprovação/dono e grava a trilha dos dois lados na mesma transação. */
  @Post(':id/read')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  async read(@Req() req: PlatformRequest, @Param('id') id: string) {
    const rid = parseBody(uuid, id);
    let content: Record<string, unknown>;
    try {
      const rows = await this.prisma.db.$queryRaw<Array<{ c: Record<string, unknown> }>>`SELECT platform_bg_read(${rid}::uuid, ${req.operator.userId}::uuid) AS c`;
      content = rows[0]!.c;
    } catch (e) {
      mapDbError(e);
    }
    if (content.kind === 'ATTACHMENT') {
      // O objeto nunca passa por aqui: link temporário e curto para aquele arquivo.
      const url = await this.storage.presignGet(String(content.s3Key), DOWNLOAD_SECONDS);
      return { kind: 'ATTACHMENT', filename: content.filename, mimeType: content.mimeType, size: content.size, url, expiresInSeconds: DOWNLOAD_SECONDS };
    }
    return content;
  }
}
