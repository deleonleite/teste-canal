import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Storage } from '../storage/storage';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { stripMetadata } from './metadata-stripper';
import { Scanner } from './scanner';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Executa `fn` com o tenant no contexto (o worker não tem request/middleware). */
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService<TenantClsStore>) {}

  run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      return fn();
    });
  }
}

/**
 * Varredura assíncrona do anexo: antivírus e, em denúncia anônima (origem do denunciante), remoção
 * de metadados. Estados finais e cadeia de custódia são garantidos por trigger no banco.
 */
@Injectable()
export class AttachmentScanHandler {
  private readonly log = new Logger(AttachmentScanHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: Storage,
    private readonly scanner: Scanner,
    private readonly tenants: TenantContext,
  ) {}

  /** Falha de infraestrutura (clamd fora, storage) LANÇA: o job é retentado, nunca vira "limpo". */
  handle(data: { tenantId: string; attachmentId: string }): Promise<void> {
    return this.tenants.run(data.tenantId, async () => {
      const a = await this.prisma.withTenant(data.tenantId, (tx) =>
        tx.attachment.findUnique({
          where: { id: data.attachmentId },
          include: { complaint: { select: { isAnonymous: true } } },
        }),
      );
      if (!a || a.deletedAt || a.scanStatus !== 'PENDING') return; // idempotente
      const anonymousOrigin = a.complaint.isAnonymous && a.uploadedBy === null;

      const body = await this.storage.get(a.s3Key);
      const verdict = await this.scanner.scan(body);
      if (verdict.status === 'INFECTED') {
        await this.finish(data.tenantId, a.id, anonymousOrigin, { scanStatus: 'INFECTED', scanDetail: verdict.signature });
        this.log.warn(`Anexo ${a.id} infectado (${verdict.signature}) — bloqueado`);
        return;
      }
      if (!anonymousOrigin) {
        await this.finish(data.tenantId, a.id, anonymousOrigin, { scanStatus: 'CLEAN' });
        return;
      }

      // Anônimo: limpa os metadados; o hash original é preservado antes da troca (custódia).
      let clean: Buffer;
      try {
        clean = await stripMetadata(a.filename.split('.').pop()!.toLowerCase(), body);
      } catch (e) {
        await this.finish(data.tenantId, a.id, anonymousOrigin, {
          scanStatus: 'ERROR',
          scanDetail: `metadata_strip_failed: ${(e as Error).message}`.slice(0, 200),
        });
        return;
      }
      await this.storage.put(a.s3Key, clean, a.detectedMime);
      await this.finish(data.tenantId, a.id, anonymousOrigin, {
        scanStatus: 'CLEAN',
        metadataStripped: true,
        originalSha256Hash: a.sha256Hash,
        sha256Hash: sha256(clean),
        size: clean.length,
      });
    });
  }

  /** Esgotadas as retentativas, o arquivo fica em ERROR (bloqueado) e o problema é auditado. */
  markError(tenantId: string, attachmentId: string, reason: string): Promise<void> {
    return this.tenants.run(tenantId, async () => {
      const a = await this.prisma.withTenant(tenantId, (tx) =>
        tx.attachment.findUnique({
          where: { id: attachmentId },
          include: { complaint: { select: { isAnonymous: true } } },
        }),
      );
      if (!a || a.scanStatus !== 'PENDING') return;
      await this.finish(tenantId, a.id, a.complaint.isAnonymous && a.uploadedBy === null, {
        scanStatus: 'ERROR',
        scanDetail: reason.slice(0, 200),
      });
    });
  }

  private async finish(
    tenantId: string,
    id: string,
    anonymousOrigin: boolean,
    data: {
      scanStatus: 'CLEAN' | 'INFECTED' | 'ERROR';
      scanDetail?: string;
      metadataStripped?: boolean;
      originalSha256Hash?: string;
      sha256Hash?: string;
      size?: number;
    },
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.attachment.update({ where: { id }, data: { ...data, scannedAt: new Date() } });
      await this.audit.record(tx, {
        action: 'UPDATE',
        resource: 'attachment_scan',
        resourceId: id,
        details: {
          status: data.scanStatus,
          metadataStripped: data.metadataStripped ?? false,
          ...(data.scanStatus !== 'CLEAN' ? { detail: data.scanDetail } : {}),
          ...(data.originalSha256Hash ? { originalSha256: data.originalSha256Hash, cleanSha256: data.sha256Hash } : {}),
        },
        anonymousOrigin,
      });
    });
  }
}
