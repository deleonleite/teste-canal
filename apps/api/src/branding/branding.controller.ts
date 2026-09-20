import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { updateBrandingSchema } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';

/**
 * Marca e dados públicos do tenant para o canal (landing, formulário, acompanhamento) e para o tema.
 * Só o que já é público por natureza: nenhuma chave de configuração privada.
 * `customCss` NÃO é devolvido aqui: CSS arbitrário de tenant exige sanitização antes de ir ao navegador.
 */
@Controller('public/branding')
export class BrandingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get() {
    const tenantId = this.prisma.currentTenantId();
    return this.prisma.run(async (tx) => {
      const [tenant, branding, settings] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, dpoName: true, dpoEmail: true } }),
        tx.tenantBranding.findUnique({ where: { tenantId } }),
        tx.systemSetting.findMany({ where: { isPublic: true }, select: { key: true, value: true } }),
      ]);
      const pub = Object.fromEntries(settings.map((s) => [s.key, s.value]));
      return {
        slug: tenant.slug,
        companyName: branding?.companyName ?? pub.companyName ?? tenant.slug,
        primaryColor: branding?.primaryColor ?? '#3b82f6',
        secondaryColor: branding?.secondaryColor ?? '#f59e0b',
        logoUrl: branding?.logoUrl ?? null,
        faviconUrl: branding?.faviconUrl ?? null,
        loginBackgroundUrl: branding?.loginBackgroundUrl ?? null,
        dpo: tenant.dpoName || tenant.dpoEmail ? { name: tenant.dpoName, email: tenant.dpoEmail } : null,
        allowAnonymousComplaints: pub.allowAnonymousComplaints !== 'false',
        maintenanceMode: pub.maintenanceMode === 'true',
        contact: { phone: pub.companyPhone ?? null, email: pub.companyEmail ?? null },
        documents: {
          codigoEtica: pub.docCodigoEtica ?? null,
          politicaFornecedores: pub.docPoliticaFornecedores ?? null,
          politicaAnticorrupcao: pub.docPoliticaAnticorrupcao ?? null,
          politicaLicitacoes: pub.docPoliticaLicitacoes ?? null,
          politicaPldFtp: pub.docPoliticaPldFtp ?? null,
          politicaAssedio: pub.docPoliticaAssedio ?? null,
        },
        privacyPolicy: pub.privacyPolicy ?? null,
        termsOfService: pub.termsOfService ?? null,
      };
    });
  }
}

/** Marca editável pelo ADMIN (nome, cores, logo, favicon). O que muda aqui aparece no canal público. */
@Controller('branding')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ManageBrandingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private select = { companyName: true, primaryColor: true, secondaryColor: true, logoUrl: true, faviconUrl: true } as const;

  @Get()
  get() {
    const tenantId = this.prisma.currentTenantId();
    return this.prisma.run((tx) => tx.tenantBranding.findUniqueOrThrow({ where: { tenantId }, select: this.select }));
  }

  @Put()
  update(@Req() req: Request, @Body() body: unknown) {
    const data = parseBody(updateBrandingSchema, body);
    const tenantId = this.prisma.currentTenantId();
    return this.prisma.run(async (tx) => {
      const row = await tx.tenantBranding.update({ where: { tenantId }, data, select: this.select });
      await this.audit.record(tx, {
        action: 'UPDATE',
        resource: 'tenant_branding',
        resourceId: tenantId,
        details: { fields: Object.keys(data) },
        userId: this.cls.get('userId')!,
        ...clientInfo(req),
      });
      return row;
    });
  }
}
