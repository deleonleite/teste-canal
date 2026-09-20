import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente do painel SUPER_ADMIN: conecta como `platform_admin`, um papel de banco que só enxerga tenants,
 * branding e as tabelas da plataforma — sem nenhum GRANT em complaints, anexos, mensagens ou usuários de tenant
 * (arq. §5.3/§6.3). Por isso NÃO usa o `PrismaService` normal (app_runtime + RLS por tenant).
 */
@Injectable()
export class PlatformPrismaService implements OnModuleDestroy {
  readonly db: PrismaClient;

  constructor() {
    let url = process.env.PLATFORM_DATABASE_URL;
    if (!url) {
      if (process.env.NODE_ENV === 'production') throw new Error('PLATFORM_DATABASE_URL é obrigatória em produção');
      // Só dev/teste: mesma base do DATABASE_URL, com as credenciais do papel platform_admin.
      const base = process.env.DATABASE_URL;
      if (base) {
        const u = new URL(base);
        u.username = 'platform_admin';
        u.password = process.env.PLATFORM_ADMIN_PASSWORD ?? 'platform_admin';
        url = u.toString();
      }
    }
    this.db = new PrismaClient(url ? { datasourceUrl: url } : undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}
