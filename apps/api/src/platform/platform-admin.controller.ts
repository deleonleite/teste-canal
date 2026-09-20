import { randomBytes } from 'node:crypto';

import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { passwordSchema, tenantSlugSchema } from '@ouvion/contracts';
import { PlatformAuditAction, PlatformRole, Severity } from '@prisma/client';
import * as argon2 from 'argon2';
import { z } from 'zod';

import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { sha256 } from '../external/external-access.service';
import { Mailer, OutboxMailer } from '../mail/mailer';
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

const INVITE_VALIDITY_MS = 72 * 3600_000;
const createTenantSchema = z
  .object({
    companyName: z.string().trim().min(2).max(120),
    slug: tenantSlugSchema,
    adminEmail: z.string().email().max(200),
    adminFullName: z.string().trim().min(2).max(120),
    /** 'invite' (padrão, recomendado): link de uso único; 'temp_password' é exceção auditada. */
    mode: z.enum(['invite', 'temp_password']).default('invite'),
    /** Só em temp_password. Vazio = o sistema gera uma senha forte e a mostra UMA vez. */
    password: z.string().min(1).max(100).optional(),
    /** Obrigatório em temp_password: por que a exceção. */
    reason: z.string().trim().min(10).max(500).optional(),
  })
  .strict()
  .refine((v) => v.mode !== 'temp_password' || !!v.reason, { message: 'Informe o motivo da exceção', path: ['reason'] });

/** Senha forte gerada pelo sistema (atende à política única). */
function generatePassword(): string {
  const pick = (chars: string, n: number) => Array.from(randomBytes(n), (b) => chars[b % chars.length]).join('');
  const raw = pick('abcdefghijkmnpqrstuvwxyz', 6) + pick('ABCDEFGHJKMNPQRSTUVWXYZ', 4) + pick('23456789', 3) + pick('!@#$%&*?', 2);
  return Array.from(raw).sort(() => randomBytes(1)[0]! - 128).join('');
}

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
    private readonly mailer: Mailer,
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
    const invites = await this.prisma.db.tenantInvite.findMany({
      where: { tenantId: { in: tenants.map((t) => t.id) } },
      orderBy: { createdAt: 'desc' },
      select: { tenantId: true, email: true, expiresAt: true, usedAt: true, revokedAt: true },
    });
    const lastInvite = new Map<string, (typeof invites)[number]>();
    for (const i of invites) if (!lastInvite.has(i.tenantId)) lastInvite.set(i.tenantId, i);
    return tenants.map((t) => {
      const inv = lastInvite.get(t.id);
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
        invite: inv ? { email: inv.email, state: inv.usedAt ? 'accepted' : inv.revokedAt ? 'revoked' : inv.expiresAt <= new Date() ? 'expired' : 'pending', expiresAt: inv.expiresAt } : null,
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

  private async sendInvite(tenantId: string, slug: string, companyName: string, email: string, operatorId: string, client: { ip?: string; userAgent?: string }) {
    // Reenvio: os convites anteriores deixam de valer (o token antigo nunca é reaproveitado).
    await this.prisma.db.tenantInvite.updateMany({ where: { tenantId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_VALIDITY_MS);
    await this.prisma.db.tenantInvite.create({ data: { tenantId, email: email.toLowerCase(), tokenHash: sha256(token), expiresAt, createdBy: operatorId } });
    const base = process.env.PUBLIC_WEB_URL ?? 'https://app.ouvion.local';
    const link = `${base}/${slug}/convite?token=${token}`;
    await this.mailer.send({
      to: email.toLowerCase(),
      subject: `Convite para administrar o canal de denúncias de ${companyName} — OuviON`,
      text: `Você foi convidado(a) para administrar o canal de denúncias de ${companyName}. Defina sua senha e ative o segundo fator neste link (uso único, vale por 72 horas): ${link}`,
    });
    await this.audit.record({ action: 'TENANT_INVITE_SENT', severity: 'MEDIUM', resource: 'tenant', resourceId: tenantId, tenantId, actorId: operatorId, details: { to: email.toLowerCase(), expiresAt: expiresAt.toISOString() }, ...client });
    // Só dev/teste (e-mail em memória): devolve o link a quem está testando. Em produção nunca sai daqui.
    const dev = this.mailer instanceof OutboxMailer && process.env.NODE_ENV !== 'production';
    return { sentTo: email.toLowerCase(), expiresAt, ...(dev ? { devInviteUrl: link } : {}) };
  }

  /**
   * Nova empresa. Padrão: CONVITE por link — a plataforma nunca chega a conhecer a senha do ADMIN. Exceção
   * auditada: senha temporária (exibida uma única vez, troca obrigatória no primeiro acesso).
   */
  @Post('tenants')
  @PlatformRoles('SUPER_ADMIN')
  async createTenant(@Req() req: PlatformRequest, @Body() body: unknown) {
    const b = parseBody(createTenantSchema, body);
    const client = clientInfo(req);
    const temp = b.mode === 'temp_password';
    let plain: string | undefined;
    if (temp) {
      plain = b.password ?? generatePassword();
      this.checkPassword(plain);
    }
    // Convite: hash de uma senha aleatória que ninguém conhece (a pessoa define a dela pelo link).
    const passwordHash = await argon2.hash(plain ?? randomBytes(32).toString('hex'), { type: argon2.argon2id });
    let created: { tenant_id: string; admin_id: string };
    try {
      const rows = await this.prisma.db.$queryRaw<Array<{ tenant_id: string; admin_id: string }>>`
        SELECT * FROM platform_provision_tenant(${b.slug}, ${b.companyName}, ${b.adminEmail}, ${b.adminFullName}, ${passwordHash}, ${temp})`;
      created = rows[0]!;
    } catch (e) {
      if (/duplicate key|23505|unique/i.test(String((e as Error).message))) throw new ConflictException('Este identificador de empresa já está em uso');
      throw e;
    }
    await this.audit.record({ action: 'TENANT_CREATED', severity: 'MEDIUM', resource: 'tenant', resourceId: created.tenant_id, tenantId: created.tenant_id, actorId: req.operator.userId, details: { slug: b.slug, mode: b.mode }, ...client });

    if (temp) {
      await this.audit.record({
        action: 'TENANT_ADMIN_TEMP_PASSWORD_ISSUED', severity: 'HIGH', resource: 'tenant', resourceId: created.tenant_id, tenantId: created.tenant_id,
        actorId: req.operator.userId, details: { reason: b.reason!, generated: !b.password }, ...client,
      });
      // A senha digitada pelo operador não volta; a GERADA é mostrada uma única vez e não fica em lugar nenhum legível.
      return { tenantId: created.tenant_id, slug: b.slug, mode: 'temp_password' as const, ...(b.password ? {} : { temporaryPassword: plain }) };
    }
    const invite = await this.sendInvite(created.tenant_id, b.slug, b.companyName, b.adminEmail, req.operator.userId, client);
    return { tenantId: created.tenant_id, slug: b.slug, mode: 'invite' as const, ...invite };
  }

  /** Convite vencido/perdido: novo token para o mesmo e-mail, invalidando o anterior. Só enquanto em teste e não aceito. */
  @Post('tenants/:id/resend-invite')
  @HttpCode(200)
  @PlatformRoles('SUPER_ADMIN')
  async resendInvite(@Req() req: PlatformRequest, @Param('id') id: string) {
    const tenantId = parseBody(uuid, id);
    const t = await this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, status: true, branding: { select: { companyName: true } } } });
    if (!t) throw new NotFoundException('Empresa não encontrada');
    const last = await this.prisma.db.tenantInvite.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
    if (!last) throw new ConflictException('Esta empresa não foi criada por convite');
    if (last.usedAt) throw new ConflictException('O convite já foi aceito');
    return this.sendInvite(tenantId, t.slug, t.branding?.companyName ?? t.slug, last.email, req.operator.userId, clientInfo(req));
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
