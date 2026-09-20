import { Injectable } from '@nestjs/common';
import type { PlatformAuditAction, Prisma, Severity } from '@prisma/client';

import { PlatformPrismaService } from './platform-prisma.service';

export interface PlatformAuditInput {
  action: PlatformAuditAction;
  resource: string;
  severity?: Severity;
  actorId?: string | null;
  resourceId?: string | null;
  tenantId?: string | null;
  /** Nunca colocar aqui senha, token, código MFA, segredo nem conteúdo de denúncia. */
  details?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}

/** Trilha da plataforma (append-only, garantido por trigger no banco). */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly prisma: PlatformPrismaService) {}

  async record(e: PlatformAuditInput): Promise<void> {
    await this.prisma.db.platformAuditLog.create({
      data: {
        action: e.action,
        resource: e.resource,
        severity: e.severity ?? 'LOW',
        actorId: e.actorId ?? null,
        resourceId: e.resourceId ?? null,
        tenantId: e.tenantId ?? null,
        details: e.details,
        ipAddress: e.ip ?? null,
        userAgent: e.userAgent ?? null,
      },
    });
  }
}
