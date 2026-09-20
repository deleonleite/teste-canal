import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CaseAccessService } from '../access/case-access.service';
import { AuditService } from '../audit/audit.service';
import { RateLimiter, tooMany } from '../common/rate-limiter';
import type { Actor } from '../complaints/complaints.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JobQueue } from '../queue/job-queue';
import { inspectArchive, STRIPPABLE_EXTENSIONS } from '../scan/metadata-stripper';
import { Storage } from '../storage/storage';
import { sanitizeFilename, validateFile } from './file-validation';

const DEFAULT_MAX_MB = 25;
const MAX_FILES_PER_COMPLAINT = 20;
const UPLOADS_PER_WINDOW = 10;
const WINDOW_MS = 15 * 60_000;
const DOWNLOAD_URL_SECONDS = 3600; // URL pré-assinada temporária (1 h)

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/**
 * Anexos (doc §5.4). Antivírus, remoção de metadados e detecção de zip-bomb entram na Fase 4:
 * até lá todo arquivo nasce `scanStatus = PENDING` e NÃO pode ser baixado.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CaseAccessService,
    private readonly storage: Storage,
    private readonly limiter: RateLimiter,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationsService,
  ) {}

  private readonly log = new Logger(AttachmentsService.name);

  private async maxBytes(tx: Tx): Promise<number> {
    const s = await tx.systemSetting.findFirst({ where: { key: 'max_file_size_mb' } });
    const mb = Number(s?.value);
    return (Number.isFinite(mb) && mb > 0 ? Math.min(mb, 100) : DEFAULT_MAX_MB) * 1024 * 1024;
  }

  /**
   * Núcleo do upload. `uploaderId = null` => denunciante sem conta (sessão de protocolo): em caso
   * anônimo o nome original é descartado e nada identifica o remetente.
   */
  private async store(complaintId: string, file: UploadedFile, uploaderId: string | null, ctx: { ip?: string; userAgent?: string }) {
    const validated = validateFile(file.originalname, file.mimetype, file.buffer);
    // Zip-bomb e compactados aninhados são barrados já no upload (lê só o diretório central).
    if (validated.extension === 'zip' || validated.extension === 'docx') {
      await inspectArchive(file.buffer).catch((e: Error) => {
        throw new BadRequestException(e.message);
      });
    }
    const key = `complaints/${complaintId}/${randomUUID()}`;
    const sha256Hash = createHash('sha256').update(file.buffer).digest('hex');

    // 1) valida contra o banco; 2) grava o objeto; 3) grava a linha (desfaz o objeto se falhar).
    const plan = await this.prisma.run(async (tx) => {
      const c = await tx.complaint.findUnique({ where: { id: complaintId }, select: { id: true, tenantId: true, isAnonymous: true } });
      if (!c) throw new NotFoundException('Denúncia não encontrada');
      // Denúncia anônima exige remoção de metadados; .doc (formato OLE) não é limpável.
      if (c.isAnonymous && uploaderId === null && !STRIPPABLE_EXTENSIONS.has(validated.extension)) {
        throw new BadRequestException('Este formato não permite remover metadados. Envie em PDF ou DOCX.');
      }
      if (file.size > (await this.maxBytes(tx))) throw new BadRequestException('Arquivo maior que o limite permitido');
      const count = await tx.attachment.count({ where: { complaintId, deletedAt: null } });
      if (count >= MAX_FILES_PER_COMPLAINT) throw new BadRequestException('Limite de arquivos da denúncia atingido');
      return { c, count };
    });

    await this.storage.put(key, file.buffer, validated.detectedMime);
    try {
      return await this.prisma.run(async (tx) => {
        const anonymousOrigin = plan.c.isAnonymous && uploaderId === null;
        const a = await tx.attachment.create({
          data: {
            tenantId: plan.c.tenantId,
            complaintId,
            filename: anonymousOrigin ? `anexo-${plan.count + 1}.${validated.extension}` : sanitizeFilename(file.originalname),
            mimeType: file.mimetype.toLowerCase(),
            detectedMime: validated.detectedMime,
            size: file.size,
            s3Key: key,
            s3Bucket: this.storage.bucket,
            sha256Hash,
            uploadedBy: uploaderId,
          },
        });
        await this.audit.record(tx, {
          action: 'CREATE',
          resource: 'attachment',
          resourceId: a.id,
          details: { size: file.size, mime: validated.detectedMime },
          anonymousOrigin,
          userId: uploaderId ?? undefined,
          ...(anonymousOrigin ? {} : ctx),
        });
        return {
          anonymousOrigin,
          tenantId: plan.c.tenantId,
          id: a.id,
          filename: a.filename,
          size: a.size,
          scanStatus: a.scanStatus,
          sha256Hash: a.sha256Hash,
        };
      }).then(async ({ anonymousOrigin, tenantId, ...res }) => {
        // Anexo anônimo NÃO é enfileirado no ato: o sweep periódico o pega, para que a fila não guarde o
        // instante exato do evento anônimo. Os demais vão direto (falha aqui é coberta pelo sweep).
        if (!anonymousOrigin) {
          await this.queue
            .enqueue('attachment-scan', { tenantId, attachmentId: res.id }, { jobId: `scan-${res.id}` })
            .catch((e: Error) => this.log.warn(`Falha ao enfileirar varredura (${e.name})`));
        }
        await this.notifications.onAttachment(complaintId, uploaderId);
        return res;
      });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
  }

  uploadAsReporterSession(complaintId: string, file: UploadedFile) {
    if (this.limiter.hit(`upload:${complaintId}`, WINDOW_MS) > UPLOADS_PER_WINDOW) throw tooMany();
    return this.store(complaintId, file, null, {});
  }

  async upload(actor: Actor, complaintId: string, file: UploadedFile) {
    await this.prisma.run((tx) =>
      actor.role === 'REPORTER'
        ? this.access.requireRead(tx, actor, complaintId)
        : this.access.requireDecide(tx, actor, complaintId),
    );
    return this.store(complaintId, file, actor.userId, { ip: actor.ip, userAgent: actor.userAgent });
  }

  async list(actor: Actor, complaintId: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireRead(tx, actor, complaintId);
      return tx.attachment.findMany({
        where: { complaintId, deletedAt: null },
        orderBy: { seq: 'asc' },
        select: { id: true, filename: true, mimeType: true, size: true, sha256Hash: true, uploadedAt: true, scanStatus: true },
      });
    });
  }

  /** Download só por URL pré-assinada temporária, com auditoria, e só de arquivo já varrido (CLEAN). */
  async downloadUrl(actor: Actor, complaintId: string, attachmentId: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireRead(tx, actor, complaintId);
      const a = await tx.attachment.findFirst({ where: { id: attachmentId, complaintId, deletedAt: null } });
      if (!a) throw new NotFoundException('Anexo não encontrado');
      if (a.scanStatus !== 'CLEAN') {
        throw new BadRequestException('Arquivo aguardando varredura de segurança ou bloqueado');
      }
      const url = await this.storage.presignGet(a.s3Key, DOWNLOAD_URL_SECONDS);
      await this.audit.record(tx, {
        action: 'READ',
        resource: 'attachment',
        resourceId: a.id,
        details: { expiresInSeconds: DOWNLOAD_URL_SECONDS },
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return { url, expiresInSeconds: DOWNLOAD_URL_SECONDS };
    });
  }

  /** Exclusão lógica: ADMIN ou quem enviou. O objeto sai do storage; a linha permanece (custódia). */
  async remove(actor: Actor, complaintId: string, attachmentId: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireRead(tx, actor, complaintId);
      const a = await tx.attachment.findFirst({ where: { id: attachmentId, complaintId, deletedAt: null } });
      if (!a) throw new NotFoundException('Anexo não encontrado');
      if (actor.role !== 'ADMIN' && a.uploadedBy !== actor.userId) throw new ForbiddenException();
      await tx.attachment.update({ where: { id: a.id }, data: { deletedAt: new Date(), deletedBy: actor.userId } });
      await this.storage.delete(a.s3Key);
      await this.audit.record(tx, {
        action: 'DELETE',
        resource: 'attachment',
        resourceId: a.id,
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return { id: a.id, deleted: true };
    });
  }

  /** Recalcula o SHA-256 do objeto armazenado e compara com o registrado (ADMIN/AUDITOR). */
  async verifyIntegrity(actor: Actor, complaintId: string, attachmentId: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireRead(tx, actor, complaintId);
      const a = await tx.attachment.findFirst({ where: { id: attachmentId, complaintId, deletedAt: null } });
      if (!a) throw new NotFoundException('Anexo não encontrado');
      const actual = createHash('sha256').update(await this.storage.get(a.s3Key)).digest('hex');
      const ok = actual === a.sha256Hash;
      await this.audit.record(tx, {
        action: 'READ',
        resource: 'attachment_integrity',
        resourceId: a.id,
        details: { ok },
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return { id: a.id, ok, expected: a.sha256Hash, actual };
    });
  }
}
