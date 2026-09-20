import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { maxPriority, SUGGESTED_PRIORITY, type CreateComplaintInput, type UserRole } from '@ouvion/contracts';
import * as argon2 from 'argon2';

import { CaseAccessService, SAFE_OMIT } from '../access/case-access.service';
import { systemMessage } from '../channel/messages.service';
import { RateLimiter, tooMany } from '../common/rate-limiter';
import { AuditService } from '../audit/audit.service';
import { truncateToMinute } from '../common/client-info';
import { ConflictService } from '../conflicts/conflict.service';
import { FieldCipher } from '../crypto/field-cipher';
import { NotificationsService } from '../notifications/notifications.service';
import { loadSlaSettings, slaDates, slaIndicators, slaWhere } from '../workflow/sla';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  addendumIntegrityHash,
  generateAccessKey,
  generateProtocol,
  normalizeAccessKey,
  reportIntegrityHash,
} from './integrity';

export interface Actor {
  userId: string;
  role: UserRole;
  ip?: string;
  userAgent?: string;
}

const GENERIC_LOOKUP_ERROR = 'Protocolo ou chave inválidos';
const CLOSED = ['RESOLVED', 'DISMISSED'];
const RECEIPT_MESSAGE =
  'Recebemos sua denúncia. Você pode acompanhar o andamento e enviar informações complementares por este canal.';
const ASSIGNED_MESSAGE = 'Sua denúncia foi encaminhada para investigação.';
const LOOKUP_WINDOW_MS = 15 * 60_000;
const LOOKUP_MAX_FAILURES = 5;

@Injectable()
export class ComplaintsService implements OnModuleInit {
  /** Hash descartável: garante o mesmo custo de verificação quando o protocolo não existe. */
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CaseAccessService,
    private readonly conflicts: ConflictService,
    private readonly cipher: FieldCipher,
    private readonly limiter: RateLimiter,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash(generateAccessKey(), { type: argon2.argon2id });
  }

  /**
   * Criação pública. Anônima: sem createdBy, sem IP/UA (nem em auditoria), horários ao minuto
   * (garantido também por trigger). A chave de acesso é devolvida UMA vez e só o hash é guardado.
   * Identificada: nome/e-mail/telefone do denunciante ficam cifrados (AES-GCM, chave por tenant).
   */
  async create(input: CreateComplaintInput, actor: Actor | null) {
    if (!input.isAnonymous && !actor) {
      throw new UnauthorizedException('Identifique-se para registrar uma denúncia não anônima');
    }
    if (input.isAnonymous) await this.assertAnonymousAllowed();

    const accessKey = generateAccessKey();
    const accessKeyHash = await argon2.hash(normalizeAccessKey(accessKey), { type: argon2.argon2id });
    const witnesses = input.witnesses ?? [];
    const reportedType = input.type;

    for (let attempt = 0; attempt < 5; attempt++) {
      const protocol = generateProtocol();
      try {
        const complaint = await this.prisma.run(async (tx) => {
          const tenantId = (await tx.$queryRaw<{ t: string }[]>`SELECT app_current_tenant()::text AS t`)[0]!.t;
          const enc = async (v?: string) => (v && !input.isAnonymous ? this.cipher.encrypt(tenantId, v) : null);
          const [reporterNameEnc, reporterEmailEnc, reporterPhoneEnc] = await Promise.all([
            enc(input.reporterName),
            enc(input.reporterEmail),
            enc(input.reporterPhone),
          ]);
          // Prazos de SLA e prioridade sugerida por tipo (o triador ajusta depois, com motivo).
          // Em caso anônimo tudo parte do instante truncado ao minuto: prazo não pode revelar o segundo exato.
          const settings = await loadSlaSettings(tx);
          const base = input.isAnonymous ? truncateToMinute(new Date()) : new Date();
          const priority = maxPriority(input.priority ?? SUGGESTED_PRIORITY[input.type], SUGGESTED_PRIORITY[input.type]);
          const created = await tx.complaint.create({
            data: {
              tenantId,
              protocol,
              accessKeyHash,
              isAnonymous: input.isAnonymous,
              type: input.type,
              reportedType,
              priority,
              acknowledgedAt: settings.autoAck ? base : null,
              ...slaDates(base, priority, settings),
              title: input.title,
              description: input.description,
              involvedPeople: input.involvedPeople,
              witnesses,
              incidentDate: input.incidentDate ? new Date(`${input.incidentDate}T00:00:00Z`) : null,
              location: input.location ?? null,
              department: input.department ?? null,
              isRestricted: await this.isRestrictedType(tx, input.type),
              reporterNameEnc,
              reporterEmailEnc,
              reporterPhoneEnc,
              createdBy: input.isAnonymous ? null : actor!.userId,
              integrityHash: reportIntegrityHash({
                title: input.title,
                description: input.description,
                reportedType,
                involvedPeople: input.involvedPeople,
                witnesses,
                incidentDate: input.incidentDate ?? null,
                location: input.location ?? null,
              }),
            },
            omit: SAFE_OMIT,
          });
          await tx.complaintStatusHistory.create({
            data: {
              tenantId,
              complaintId: created.id,
              previousStatus: null,
              newStatus: 'PENDING',
              changedBy: null,
              reason: 'Denúncia criada',
              createdAt: input.isAnonymous ? truncateToMinute(new Date()) : new Date(),
            },
          });
          if (settings.autoAck) await systemMessage(tx, created, RECEIPT_MESSAGE);
          await this.audit.record(tx, {
            action: 'CREATE',
            resource: 'complaint',
            resourceId: created.id,
            details: { source: 'WEB', anonymous: input.isAnonymous },
            anonymousOrigin: input.isAnonymous,
            userId: input.isAnonymous ? undefined : actor?.userId,
            ip: input.isAnonymous ? undefined : actor?.ip,
            userAgent: input.isAnonymous ? undefined : actor?.userAgent,
          });
          return created;
        });
        await this.conflicts.afterCreate(complaint.id);
        await this.notifications.onComplaintCreated(complaint.id);
        return {
          complaintId: complaint.id,
          protocol: complaint.protocol,
          accessKey,
          status: complaint.status,
          createdAt: complaint.createdAt,
        };
      } catch (e) {
        const collision = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!collision) throw e;
      }
    }
    throw new ConflictException('Não foi possível gerar um protocolo único. Tente novamente.');
  }

  private tenantKey(): string {
    return this.prisma.currentTenantId();
  }

  private async assertAnonymousAllowed(): Promise<void> {
    const setting = await this.prisma.run((tx) =>
      tx.systemSetting.findFirst({ where: { key: 'allowAnonymousComplaints' } }),
    );
    if (setting?.value === 'false') {
      throw new BadRequestException('Este canal exige identificação do denunciante');
    }
  }

  /** Tipos restritos por regra do tenant (`restrictedTypes`, ex.: "HARASSMENT,CORRUPTION"). */
  private async isRestrictedType(tx: Tx, type: string): Promise<boolean> {
    const s = await tx.systemSetting.findFirst({ where: { key: 'restrictedTypes' } });
    return (s?.value ?? '').split(',').map((t) => t.trim().toUpperCase()).includes(type);
  }

  /** Consulta pública por protocolo + chave. Mesma resposta para protocolo inexistente e chave errada. */
  async lookup(protocol: string, accessKey: string) {
    // Após 5 falhas o protocolo fica bloqueado por 15 min (contagem por protocolo, sem gravar IP).
    const lockKey = `lookup-fail:${this.tenantKey()}:${protocol}`;
    if (this.limiter.isBlocked(lockKey)) throw tooMany();
    const found = await this.prisma.run((tx) => tx.complaint.findUnique({ where: { protocol } }));
    const ok = await argon2.verify(
      found?.accessKeyHash ?? this.dummyHash,
      normalizeAccessKey(accessKey),
    );
    if (!found || !found.accessKeyHash || !ok) {
      if (this.limiter.hit(lockKey, LOOKUP_WINDOW_MS) >= LOOKUP_MAX_FAILURES) this.limiter.block(lockKey, LOOKUP_WINDOW_MS);
      throw new NotFoundException(GENERIC_LOOKUP_ERROR);
    }
    this.limiter.reset(lockKey);

    return this.publicView(found);
  }

  /** Resumo do caso para o denunciante com sessão de protocolo (sem pedir a chave de novo). */
  async summary(complaintId: string) {
    const found = await this.prisma.run((tx) => tx.complaint.findUnique({ where: { id: complaintId } }));
    if (!found) throw new NotFoundException(GENERIC_LOOKUP_ERROR);
    return this.publicView(found);
  }

  private async publicView(found: {
    id: string; protocol: string; status: string; type: string; priority: string; title: string; createdAt: Date; updatedAt: Date;
    isAnonymous: boolean; acknowledgedAt: Date | null; ackDueAt: Date | null; feedbackSentAt: Date | null; feedbackDueAt: Date | null; followUpUntil: Date | null;
  }) {
    await this.prisma.run((tx) =>
      this.audit.record(tx, {
        action: 'READ',
        resource: 'complaint',
        resourceId: found.id,
        details: { via: 'protocol' },
        anonymousOrigin: found.isAnonymous,
      }),
    );
    // Marcos macro para a linha do tempo pública: dia e hora aproximada (minuto), sem autor nem motivo interno.
    const history = await this.prisma.run((tx) =>
      tx.complaintStatusHistory.findMany({ where: { complaintId: found.id }, orderBy: { createdAt: 'asc' }, select: { newStatus: true, createdAt: true } }),
    );
    const closed = ['RESOLVED', 'DISMISSED'].includes(found.status);
    // Dados mínimos: nunca informações sensíveis.
    return {
      timeline: history.map((h) => ({ status: h.newStatus, at: truncateToMinute(h.createdAt) })),
      // Prazos ainda em aberto (o denunciante acompanha o retorno esperado).
      ackDueAt: found.acknowledgedAt ? null : found.ackDueAt,
      feedbackDueAt: found.feedbackSentAt ? null : found.feedbackDueAt,
      canReportRetaliation: closed && !!found.followUpUntil && found.followUpUntil > new Date(),
      id: found.id,
      protocol: found.protocol,
      status: found.status,
      type: found.type,
      priority: found.priority,
      title: found.title,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
      isAnonymous: found.isAnonymous,
    };
  }

  async list(actor: Actor, q: { page: number; limit: number; status?: string; type?: string; priority?: string; sla?: 'on_time' | 'at_risk' | 'breached' }) {
    const where: Prisma.ComplaintWhereInput = {
      AND: [
        this.access.listWhere(actor),
        { status: q.status as never, type: q.type as never, priority: q.priority as never },
        ...(q.sla ? [slaWhere(q.sla)] : []),
      ],
    };
    const [data, total] = await this.prisma.run((tx) =>
      Promise.all([
        tx.complaint.findMany({
          where,
          omit: SAFE_OMIT,
          orderBy: { createdAt: 'desc' },
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
        tx.complaint.count({ where }),
      ]),
    );
    return {
      data: data.map((c) => ({ ...c, sla: slaIndicators(c) })),
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  }

  /**
   * Detalhe autenticado; toda leitura gera auditoria READ — reforçada (`suspectPending`) quando o
   * leitor está sob suspeita de conflito pendente.
   */
  async detail(actor: Actor, id: string) {
    let suspect = false;
    const result = await this.prisma.run(async (tx) => {
      const { complaint, suspectPending } = await this.access.requireRead(tx, actor, id);
      const [history, addenda] = await Promise.all([
        tx.complaintStatusHistory.findMany({ where: { complaintId: id }, orderBy: { createdAt: 'desc' } }),
        tx.complaintAddendum.findMany({ where: { complaintId: id }, orderBy: { createdAt: 'asc' } }),
      ]);
      await this.audit.record(tx, {
        action: 'READ',
        resource: 'complaint',
        resourceId: id,
        details: suspectPending ? { suspectPending: true } : undefined,
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      suspect = suspectPending;
      return { ...complaint, history, addenda, sla: slaIndicators(complaint) };
    });
    // Leitura por suspeito pendente: alerta imediato aos revisores (doc §5.2.9).
    if (suspect) await this.notifications.onConflictSuspected(id, 'suspect_read');
    return result;
  }

  /** ADMIN atribui investigador; o histórico registra o status anterior REAL. */
  async assign(actor: Actor, id: string, investigatorId: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireDecide(tx, actor, id);
      return this.assignCore(tx, id, investigatorId, actor.userId, {
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }).then(async (r) => {
      await this.notifications.onAssigned(id, investigatorId);
      return r;
    });
  }

  /** Núcleo da atribuição (usado também pelo destinatário alternativo, que não tem conta). */
  async assignCore(
    tx: Tx,
    id: string,
    investigatorId: string,
    changedBy: string | null,
    who: { userId?: string; ip?: string; userAgent?: string; external?: string },
  ) {
    const c = await tx.complaint.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Denúncia não encontrada');
    if (CLOSED.includes(c.status)) throw new BadRequestException('Reabra o caso antes de atribuir um investigador');
    // Elegível = INVESTIGATOR ativo, não suspenso, sem impedimento e sem suspeita no caso.
    const eligible = await this.conflicts.eligibleInvestigators(tx, id);
    if (!eligible.some((e) => e.id === investigatorId)) {
      throw new BadRequestException('Investigador inválido, inativo, suspenso, impedido ou citado no caso');
    }
    const updated = await tx.complaint.update({
      where: { id },
      data: { investigatorId, status: 'IN_PROGRESS', acknowledgedAt: c.acknowledgedAt ?? new Date() },
      omit: SAFE_OMIT,
    });
    await tx.complaintStatusHistory.create({
      data: {
        tenantId: c.tenantId,
        complaintId: id,
        previousStatus: c.status,
        newStatus: 'IN_PROGRESS',
        changedBy,
        reason: 'Atribuída a investigador',
      },
    });
    await systemMessage(tx, c, ASSIGNED_MESSAGE);
    await this.audit.record(tx, {
      action: who.external ? 'EXTERNAL_ACCESS' : 'UPDATE',
      resource: 'complaint',
      resourceId: id,
      details: { assignedTo: investigatorId, previousStatus: c.status, ...(who.external ? { accessId: who.external } : {}) },
      userId: who.userId,
      ip: who.ip,
      userAgent: who.userAgent,
    });
    return updated;
  }

  /** Complemento ao relato (somente inserção, com hash). */
  async addAddendum(actor: Actor, id: string, content: string) {
    return this.prisma.run(async (tx) => {
      const { complaint } = await this.access.requireDecide(tx, actor, id);
      const created = await tx.complaintAddendum.create({
        data: {
          tenantId: complaint.tenantId,
          complaintId: id,
          authorType: 'COMMITTEE',
          authorId: actor.userId,
          content,
          integrityHash: addendumIntegrityHash(id, content),
        },
      });
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'complaint_addendum',
        resourceId: created.id,
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return created;
    });
  }

  async addComment(actor: Actor, id: string, content: string, visibility: 'INTERNAL' | 'REPORTER') {
    const created = await this.prisma.run(async (tx) => {
      const { complaint } = await this.access.requireDecide(tx, actor, id);
      const created = await tx.complaintComment.create({
        data: { tenantId: complaint.tenantId, complaintId: id, authorId: actor.userId, content, visibility },
      });
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'complaint_comment',
        resourceId: created.id,
        details: { visibility },
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return created;
    });
    await this.notifications.onComment(id, actor.userId, visibility);
    return created;
  }

  /** Equipe vê tudo; REPORTER só comentários de visibilidade REPORTER nas próprias denúncias. */
  async listComments(actor: Actor, id: string) {
    return this.prisma.run(async (tx) => {
      await this.access.requireRead(tx, actor, id);
      return tx.complaintComment.findMany({
        where: { complaintId: id, ...(actor.role === 'REPORTER' ? { visibility: 'REPORTER' } : {}) },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  /**
   * Revelação de identidade (quebra de vidro): ADMIN elegível ou investigador atribuído, com
   * justificativa. Gera IdentityReveal + auditoria REVEAL_IDENTITY (sem PII nos detalhes).
   */
  async revealIdentity(actor: Actor, id: string, justification: string) {
    const revealed = await this.prisma.run(async (tx) => {
      const { complaint } = await this.access.requireDecide(tx, actor, id);
      const isAssignedInvestigator = actor.role === 'INVESTIGATOR' && complaint.investigatorId === actor.userId;
      if (actor.role !== 'ADMIN' && !isAssignedInvestigator) throw new ForbiddenException();
      if (complaint.isAnonymous) throw new BadRequestException('Denúncia anônima não possui identidade a revelar');

      const raw = await tx.complaint.findUniqueOrThrow({
        where: { id },
        select: { reporterNameEnc: true, reporterEmailEnc: true, reporterPhoneEnc: true },
      });
      const dec = async (v: string | null) => (v ? this.cipher.decrypt(complaint.tenantId, v) : null);
      await tx.identityReveal.create({
        data: { tenantId: complaint.tenantId, complaintId: id, userId: actor.userId, justification },
      });
      await this.audit.record(tx, {
        action: 'REVEAL_IDENTITY',
        resource: 'complaint',
        resourceId: id,
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return {
        name: await dec(raw.reporterNameEnc),
        email: await dec(raw.reporterEmailEnc),
        phone: await dec(raw.reporterPhoneEnc),
      };
    });
    await this.notifications.onIdentityRevealed(id, actor.userId);
    return revealed;
  }
}
