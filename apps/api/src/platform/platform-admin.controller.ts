import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { passwordSchema } from '@ouvion/contracts';
import { PlatformAuditAction, PlatformRole, Severity } from '@prisma/client';
import * as argon2 from 'argon2';
import { z } from 'zod';

import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformPrismaService } from './platform-prisma.service';
import { PlatformGuard, PlatformRoles, type PlatformRequest } from './platform.guard';

const uuid = z.string().uuid();

const createUserSchema = z
  .object({ fullName: z.string().trim().min(2).max(120), email: z.string().email().max(200), role: z.nativeEnum(PlatformRole), password: z.string().min(1).max(100) })
  .strict();
const updateUserSchema = z
  .object({ role: z.nativeEnum(PlatformRole).optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nenhum campo informado');
const tempPasswordSchema = z.object({ password: z.string().min(1).max(100) }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const tenantsQuery = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED']).optional(), q: z.string().trim().max(100).optional() });
const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  action: z.nativeEnum(PlatformAuditAction).optional(),
  severity: z.nativeEnum(Severity).optional(),
});

interface StatRow {
  tenant_id: string;
  user_count: number;
  complaint_count: number;
  complaints_this_month: number;
}

/** Empresas, usuários internos e auditoria da plataforma. Nenhuma rota aqui toca conteúdo de denúncia. */
@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformAdminController {
  constructor(
    private readonly prisma: PlatformPrismaService,
    private readonly audit: PlatformAuditService,
    private readonly auth: PlatformAuthService,
  ) {}

  // ── Empresas ───────────────────────────────────────────────────────────────────────────────
  private async tenantRows(where: object = {}) {
    const [tenants, stats] = await Promise.all([
      this.prisma.db.tenant.findMany({
        where,
        select: {
          id: true,
          slug: true,
          status: true,
          maxUsers: true,
          maxComplaintsPerMonth: true,
          subscriptionExpiresAt: true,
          createdAt: true,
          dpoName: true,
          dpoEmail: true,
          escalationVerifiedAt: true,
          escalationTotpEnrolledAt: true,
          branding: { select: { companyName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.db.$queryRaw<StatRow[]>`SELECT * FROM platform_tenant_stats()`,
    ]);
    const byId = new Map(stats.map((s) => [s.tenant_id, s]));
    return tenants.map((t) => {
      const s = byId.get(t.id);
      return {
        id: t.id,
        slug: t.slug,
        companyName: t.branding?.companyName ?? t.slug,
        status: t.status,
        maxUsers: t.maxUsers,
        maxComplaintsPerMonth: t.maxComplaintsPerMonth,
        subscriptionExpiresAt: t.subscriptionExpiresAt,
        createdAt: t.createdAt,
        dpo: t.dpoName || t.dpoEmail ? { name: t.dpoName, email: t.dpoEmail } : null,
        onboarding: { escalationVerified: t.escalationVerifiedAt !== null, escalationTotpEnrolled: t.escalationTotpEnrolledAt !== null },
        // Só números: nunca conteúdo.
        counts: { users: s?.user_count ?? 0, complaints: s?.complaint_count ?? 0, complaintsThisMonth: s?.complaints_this_month ?? 0 },
      };
    });
  }

  @Get('tenants')
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  async tenants(@Query() raw: unknown) {
    const { status, q } = parseBody(tenantsQuery, raw);
    const rows = await this.tenantRows(status ? { status } : {});
    const needle = q?.toLowerCase();
    return needle ? rows.filter((t) => t.slug.includes(needle) || t.companyName.toLowerCase().includes(needle)) : rows;
  }

  @Get('tenants/:id')
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  async tenant(@Param('id') id: string) {
    const [row] = await this.tenantRows({ id: parseBody(uuid, id) });
    if (!row) throw new NotFoundException('Empresa não encontrada');
    return row;
  }

  /** Suspensão COMERCIAL (TenantStatus): o canal público continua recebendo denúncias; a equipe da empresa perde o login. */
  @Post('tenants/:id/suspend')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN')
  suspend(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseBody(reasonSchema, body);
    return this.setStatus(req, parseBody(uuid, id), 'SUSPENDED', 'TENANT_SUSPENDED', reason);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN')
  reactivate(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parseBody(reasonSchema, body);
    return this.setStatus(req, parseBody(uuid, id), 'ACTIVE', 'TENANT_REACTIVATED', reason);
  }

  private async setStatus(req: PlatformRequest, id: string, status: 'SUSPENDED' | 'ACTIVE', action: 'TENANT_SUSPENDED' | 'TENANT_REACTIVATED', reason: string) {
    const t = await this.prisma.db.tenant.findUnique({ where: { id }, select: { status: true } });
    if (!t) throw new NotFoundException('Empresa não encontrada');
    if (t.status === status) throw new ConflictException(status === 'SUSPENDED' ? 'A empresa já está suspensa' : 'A empresa já está ativa');
    if (status === 'ACTIVE' && t.status !== 'SUSPENDED') throw new ConflictException('Só é possível reativar uma empresa suspensa');
    await this.prisma.db.tenant.update({ where: { id }, data: { status } });
    await this.audit.record({
      action,
      severity: 'HIGH',
      resource: 'tenant',
      resourceId: id,
      tenantId: id,
      actorId: req.operator.userId,
      details: { from: t.status, to: status, reason },
      ...clientInfo(req),
    });
    return { id, status };
  }

  // ── Usuários internos ──────────────────────────────────────────────────────────────────────
  @Get('users')
  @PlatformRoles('SUPER_ADMIN')
  users() {
    return this.prisma.db.platformUser.findMany({
      select: { id: true, email: true, fullName: true, role: true, isActive: true, mfaEnabled: true, mustChangePassword: true, lastLoginAt: true, createdAt: true },
      orderBy: { fullName: 'asc' },
    });
  }

  private checkPassword(password: string): void {
    const p = passwordSchema.safeParse(password);
    if (!p.success) throw new BadRequestException(p.error.issues[0]?.message ?? 'Senha fraca');
  }

  /** Cria operador com senha TEMPORÁRIA: a troca e o cadastro do 2º fator são obrigatórios no primeiro acesso. */
  @Post('users')
  @PlatformRoles('SUPER_ADMIN')
  async createUser(@Req() req: PlatformRequest, @Body() body: unknown) {
    const b = parseBody(createUserSchema, body);
    this.checkPassword(b.password);
    const email = b.email.toLowerCase();
    if (await this.prisma.db.platformUser.findUnique({ where: { email } })) throw new ConflictException('E-mail já está em uso');
    const u = await this.prisma.db.platformUser.create({
      data: { email, fullName: b.fullName, role: b.role, passwordHash: await argon2.hash(b.password, { type: argon2.argon2id }), mustChangePassword: true },
      select: { id: true, email: true, fullName: true, role: true },
    });
    await this.audit.record({ action: 'INTERNAL_USER_CREATED', severity: 'MEDIUM', resource: 'platform_user', resourceId: u.id, actorId: req.operator.userId, details: { role: u.role }, ...clientInfo(req) });
    return u;
  }

  /** Impede tirar o último SUPER_ADMIN ativo (mudança de perfil ou desativação). */
  private async assertNotLastSuperAdmin(id: string): Promise<void> {
    const others = await this.prisma.db.platformUser.count({ where: { role: 'SUPER_ADMIN', isActive: true, id: { not: id } } });
    if (others === 0) throw new ConflictException('Não é possível remover o último SUPER_ADMIN ativo');
  }

  @Patch('users/:id')
  @PlatformRoles('SUPER_ADMIN')
  async updateUser(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const uid = parseBody(uuid, id);
    const b = parseBody(updateUserSchema, body);
    const u = await this.prisma.db.platformUser.findUnique({ where: { id: uid } });
    if (!u) throw new NotFoundException('Usuário não encontrado');
    if (uid === req.operator.userId && (b.isActive === false || (b.role && b.role !== u.role))) {
      throw new ConflictException('Você não pode alterar o seu próprio perfil nem desativar a si mesmo');
    }
    if (u.role === 'SUPER_ADMIN' && u.isActive && (b.isActive === false || (b.role && b.role !== 'SUPER_ADMIN'))) await this.assertNotLastSuperAdmin(uid);
    const updated = await this.prisma.db.platformUser.update({ where: { id: uid }, data: b, select: { id: true, role: true, isActive: true } });
    if (b.isActive === false || (b.role && b.role !== u.role)) await this.auth.revokeAll(uid); // perfil/desativação valem na hora
    await this.audit.record({
      action: 'INTERNAL_USER_UPDATED',
      severity: 'MEDIUM',
      resource: 'platform_user',
      resourceId: uid,
      actorId: req.operator.userId,
      details: { fields: Object.keys(b), role: b.role ?? null, isActive: b.isActive ?? null },
      ...clientInfo(req),
    });
    return updated;
  }

  /** Nova senha temporária (definida por outro SUPER_ADMIN): derruba sessões e exige troca + 2º fator no próximo acesso. */
  @Post('users/:id/reset-password')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN')
  async resetPassword(@Req() req: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const uid = parseBody(uuid, id);
    const { password } = parseBody(tempPasswordSchema, body);
    this.checkPassword(password);
    if (uid === req.operator.userId) throw new ConflictException('Use a troca de senha da própria conta');
    if (!(await this.prisma.db.platformUser.findUnique({ where: { id: uid }, select: { id: true } }))) throw new NotFoundException('Usuário não encontrado');
    await this.prisma.db.platformUser.update({
      where: { id: uid },
      data: { passwordHash: await argon2.hash(password, { type: argon2.argon2id }), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await this.auth.revokeAll(uid);
    await this.audit.record({ action: 'INTERNAL_USER_PASSWORD_RESET', severity: 'HIGH', resource: 'platform_user', resourceId: uid, actorId: req.operator.userId, ...clientInfo(req) });
    return { id: uid, mustChangePassword: true };
  }

  // ── Auditoria da plataforma ────────────────────────────────────────────────────────────────
  @Get('audit')
  @PlatformRoles('SUPER_ADMIN')
  async auditLog(@Query() raw: unknown) {
    const q = parseBody(auditQuery, raw);
    const where = { action: q.action, severity: q.severity };
    const [rows, total] = await Promise.all([
      this.prisma.db.platformAuditLog.findMany({ where, orderBy: { timestamp: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.db.platformAuditLog.count({ where }),
    ]);
    const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const actors = await this.prisma.db.platformUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
    const names = new Map(actors.map((a) => [a.id, a.fullName]));
    return {
      data: rows.map((r) => ({ ...r, actorName: r.actorId ? (names.get(r.actorId) ?? null) : null })),
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  }
}
