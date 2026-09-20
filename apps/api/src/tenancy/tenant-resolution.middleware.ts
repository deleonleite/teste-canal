import { Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from './tenant-context';

const SLUG_HEADER = 'x-tenant-slug';

/**
 * Resolve o tenant por slug (header injetado pelo BFF) ou domínio próprio (Host) e grava no CLS.
 * Tenants/branding são legíveis pelo app_runtime antes de existir contexto (política RLS de leitura).
 */
@Injectable()
export class TenantResolutionMiddleware implements NestMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const slug = req.header(SLUG_HEADER)?.toLowerCase();
    const host = req.hostname?.toLowerCase();

    const tenant = slug
      ? await this.prisma.base.tenant.findUnique({ where: { slug } })
      : host
        ? await this.prisma.base.tenant.findFirst({ where: { branding: { customDomain: host } } })
        : null;

    if (!tenant) throw new NotFoundException('Empresa não encontrada');
    // O contexto CLS é aberto aqui (não por ClsModule.middleware) para garantir a ordem:
    // tudo que roda depois de next() — guards, handlers, Prisma — enxerga o tenant.
    this.cls.run(() => {
      this.cls.set('tenantId', tenant.id);
      this.cls.set('tenantStatus', tenant.status);
      next();
    });
  }
}
