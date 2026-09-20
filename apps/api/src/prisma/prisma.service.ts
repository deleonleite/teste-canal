import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';

import type { TenantClsStore } from '../tenancy/tenant-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Client base (papel app_runtime, sujeito a RLS) + execução escopada por tenant. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly base = new PrismaClient();

  constructor(private readonly cls: ClsService<TenantClsStore>) {}

  /** Executa `fn` numa transação em que app.tenant_id já está definido (RLS ativa). */
  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) throw new Error('tenantId inválido');
    return this.base.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  /** Igual a withTenant, usando o tenant resolvido para o request corrente. */
  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('Contexto de tenant ausente');
    return this.withTenant(tenantId, fn);
  }

  currentTenantId(): string {
    const id = this.cls.get('tenantId');
    if (!id) throw new Error('Contexto de tenant ausente');
    return id;
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }
}
