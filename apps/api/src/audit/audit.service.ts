import { Injectable } from '@nestjs/common';
import type { AuditAction } from '@ouvion/contracts';
import { ClsService } from 'nestjs-cls';

import type { Tx } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';

export interface AuditEvent {
  action: AuditAction;
  resource: string;
  resourceId?: string;
  /** Nunca colocar texto livre com PII aqui (conteúdo sensível vai para AuditPayload, fase 7). */
  details?: Record<string, unknown>;
  userId?: string;
  ip?: string;
  userAgent?: string;
  /** Evento originado por denunciante anônimo: sem usuário, IP ou UA; horário ao minuto. */
  anonymousOrigin?: boolean;
}

@Injectable()
export class AuditService {
  constructor(private readonly cls: ClsService<TenantClsStore>) {}

  /** Grava na MESMA transação da ação de negócio (rollback consistente). seq/rowHash: trigger. */
  async record(tx: Tx, e: AuditEvent): Promise<void> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new Error('Contexto de tenant ausente');
    const anon = e.anonymousOrigin === true;
    await tx.auditLog.create({
      data: {
        tenantId,
        action: e.action,
        resource: e.resource,
        resourceId: e.resourceId,
        details: e.details as never,
        userId: anon ? null : e.userId,
        ipAddress: anon ? null : e.ip,
        userAgent: anon ? null : e.userAgent,
        anonymousOrigin: anon,
      },
    });
  }
}
