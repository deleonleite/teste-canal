import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { UserRole } from '@ouvion/contracts';

import { CaseAccessService } from '../access/case-access.service';
import { AuditService } from '../audit/audit.service';
import { truncateToMinute } from '../common/client-info';
import { ExternalAccessService } from '../external/external-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';

export type Decider =
  | { type: 'user'; userId: string; role: UserRole; ip?: string; userAgent?: string }
  | { type: 'external'; accessId: string; ip?: string; userAgent?: string };

const OPEN = ['RESOLVED', 'DISMISSED'];

export const normalizeText = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Conflito de interesses (doc §5.2.9). Regras-chave:
 *  - a suspeita NUNCA bloqueia nem altera a conta; só restringe o acesso ao caso;
 *  - impedimento efetivo = autodeclarado ou suspeita CONFIRMADA por ADMIN não suspeito;
 *  - anti-paralisia: sem ADMIN elegível, o caso vai ao destinatário alternativo.
 */
@Injectable()
export class ConflictService {
  private readonly log = new Logger(ConflictService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CaseAccessService,
    private readonly external: ExternalAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Pós-criação: falha aqui NUNCA desfaz a denúncia (é registrada e reprocessável). */
  async afterCreate(complaintId: string): Promise<void> {
    try {
      if ((await this.detect(complaintId)) > 0) await this.notifications.onConflictSuspected(complaintId);
      await this.ensureRouting(complaintId);
    } catch (e) {
      this.log.warn(`Falha na verificação de conflito de interesses (${(e as Error).name})`);
    }
  }

  async detect(complaintId: string): Promise<number> {
    return this.prisma.run(async (tx) => {
      const c = await tx.complaint.findUniqueOrThrow({
        where: { id: complaintId },
        select: { id: true, tenantId: true, isAnonymous: true, involvedPeople: true, witnesses: true },
      });
      const names = [...c.involvedPeople, ...c.witnesses].map(normalizeText);
      const users = await tx.user.findMany({
        where: { role: { in: ['ADMIN', 'INVESTIGATOR', 'AUDITOR'] }, isActive: true },
        select: { id: true, email: true, fullName: true },
      });
      const flags: Array<{ userId: string; matchType: 'EMAIL' | 'NAME' }> = [];
      for (const u of users) {
        const email = normalizeText(u.email);
        if (names.some((n) => n.includes(email))) flags.push({ userId: u.id, matchType: 'EMAIL' });
        else if (names.includes(normalizeText(u.fullName))) flags.push({ userId: u.id, matchType: 'NAME' });
      }
      if (flags.length === 0) return 0;
      const now = new Date();
      await tx.conflictFlag.createMany({
        data: flags.map((f) => ({
          tenantId: c.tenantId,
          complaintId,
          ...f,
          createdAt: c.isAnonymous ? truncateToMinute(now) : now,
        })),
        skipDuplicates: true,
      });
      await this.audit.record(tx, {
        action: 'CREATE',
        resource: 'conflict_flag',
        resourceId: complaintId,
        details: { suspects: flags.length },
        anonymousOrigin: c.isAnonymous,
      });
      return flags.length;
    });
  }

  /** Anti-paralisia: sem ADMIN elegível, aciona o destinatário alternativo. */
  async ensureRouting(complaintId: string): Promise<void> {
    const eligible = await this.prisma.run((tx) => this.access.eligibleAdminCount(tx, complaintId));
    if (eligible > 0) return;
    await this.external.trigger(
      complaintId,
      'SYSTEM',
      'Todos os ADMINs elegíveis estão impedidos ou sob suspeita de conflito de interesses',
    );
  }

  list(status?: 'PENDING' | 'CONFIRMED' | 'DISMISSED', complaintId?: string) {
    return this.prisma.run((tx) =>
      tx.conflictFlag.findMany({
        where: { status, complaintId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Decisão do revisor (ADMIN não suspeito) ou do destinatário alternativo (escopo do seu caso). */
  async decide(
    decider: Decider,
    flagId: string,
    decision: 'CONFIRMED' | 'DISMISSED',
    note: string,
    scopeComplaintId?: string,
  ) {
    let reassignedNotice: string | null | undefined;
    const complaintId = await this.prisma.run(async (tx) => {
      const flag = await tx.conflictFlag.findUnique({ where: { id: flagId } });
      if (!flag || (scopeComplaintId && flag.complaintId !== scopeComplaintId)) {
        throw new NotFoundException('Suspeita não encontrada');
      }
      if (flag.status !== 'PENDING') throw new ConflictException('Suspeita já decidida');

      if (decider.type === 'user') {
        if (flag.userId === decider.userId) throw new ForbiddenException('Você não pode decidir a própria suspeita');
        await this.access.requireDecide(tx, decider, flag.complaintId);
      }
      const decidedBy = decider.type === 'user' ? decider.userId : `EXTERNAL:${decider.accessId}`;
      await tx.conflictFlag.update({
        where: { id: flagId },
        data: { status: decision, decidedBy, decidedAt: new Date(), decisionNote: note },
      });

      let reassignedTo: string | null | undefined;
      if (decision === 'CONFIRMED') {
        await tx.complaintRecusal.create({
          data: {
            tenantId: flag.tenantId,
            complaintId: flag.complaintId,
            userId: flag.userId,
            reason: 'Conflito de interesses confirmado',
            declaredBy: decider.type === 'user' ? decider.userId : null,
            origin: 'AUTOMATIC',
          },
        });
        const c = await tx.complaint.findUniqueOrThrow({ where: { id: flag.complaintId } });
        if (c.investigatorId === flag.userId) reassignedTo = await this.reassign(tx, c.id, flag.userId);
      }
      await this.audit.record(tx, {
        action: decision === 'CONFIRMED' ? 'RECUSE' : 'UPDATE',
        resource: 'conflict_flag',
        resourceId: flagId,
        details: {
          decision,
          suspectUserId: flag.userId,
          decidedBy: decider.type === 'user' ? 'ADMIN' : 'EXTERNAL',
          ...(reassignedTo !== undefined ? { reassignedTo } : {}),
        },
        userId: decider.type === 'user' ? decider.userId : undefined,
        ip: decider.ip,
        userAgent: decider.userAgent,
      });
      reassignedNotice = reassignedTo;
      return flag.complaintId;
    });
    if (reassignedNotice !== undefined) await this.notifications.onRecusalReassigned(complaintId, reassignedNotice);
    if (decision === 'CONFIRMED') await this.ensureRouting(complaintId);
    return { id: flagId, status: decision };
  }

  /** Autodeclaração de impedimento (INVESTIGATOR/AUDITOR/ADMIN). */
  async recuse(actor: { userId: string; role: UserRole; ip?: string; userAgent?: string }, complaintId: string, reason: string) {
    let reassignedNotice: string | null | undefined;
    await this.prisma.run(async (tx) => {
      const { complaint } = await this.access.requireRead(tx, actor, complaintId);
      if (await tx.complaintRecusal.count({ where: { complaintId, userId: actor.userId } })) {
        throw new ConflictException('Impedimento já declarado');
      }
      await tx.complaintRecusal.create({
        data: { tenantId: complaint.tenantId, complaintId, userId: actor.userId, reason, declaredBy: actor.userId, origin: 'SELF' },
      });
      let reassignedTo: string | null | undefined;
      if (complaint.investigatorId === actor.userId) reassignedTo = await this.reassign(tx, complaintId, actor.userId);
      await this.audit.record(tx, {
        action: 'RECUSE',
        resource: 'complaint',
        resourceId: complaintId,
        details: { origin: 'SELF', ...(reassignedTo !== undefined ? { reassignedTo } : {}) },
        userId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      reassignedNotice = reassignedTo;
    });
    if (reassignedNotice !== undefined) await this.notifications.onRecusalReassigned(complaintId, reassignedNotice);
    await this.ensureRouting(complaintId);
    return { complaintId, recused: true };
  }

  /** Investigadores elegíveis para o caso, do menos ao mais carregado. */
  async eligibleInvestigators(tx: Tx, complaintId: string, extraExcluded: string[] = []) {
    const blocked = [...(await this.access.blockedUserIds(tx, complaintId)), ...extraExcluded];
    const candidates = await tx.user.findMany({
      where: { role: 'INVESTIGATOR', isActive: true, isBlocked: false, id: { notIn: blocked } },
      select: { id: true, fullName: true },
    });
    if (candidates.length === 0) return [];
    const loads = await tx.complaint.groupBy({
      by: ['investigatorId'],
      where: { investigatorId: { in: candidates.map((c) => c.id) }, status: { notIn: OPEN as never[] } },
      _count: { _all: true },
    });
    const load = new Map(loads.map((l) => [l.investigatorId, l._count._all]));
    return candidates.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
  }

  /** Redistribui o caso; sem elegível, fica sem investigador e volta a PENDING. */
  async reassign(tx: Tx, complaintId: string, leavingUserId: string): Promise<string | null> {
    const [next] = await this.eligibleInvestigators(tx, complaintId, [leavingUserId]);
    const c = await tx.complaint.findUniqueOrThrow({ where: { id: complaintId } });
    if (next) {
      await tx.complaint.update({ where: { id: complaintId }, data: { investigatorId: next.id } });
    } else {
      await tx.complaint.update({
        where: { id: complaintId },
        data: { investigatorId: null, status: c.status === 'IN_PROGRESS' ? 'PENDING' : c.status },
      });
      if (c.status === 'IN_PROGRESS') {
        await tx.complaintStatusHistory.create({
          data: {
            tenantId: c.tenantId,
            complaintId,
            previousStatus: c.status,
            newStatus: 'PENDING',
            reason: 'Aguardando novo investigador (impedimento)',
          },
        });
      }
    }
    return next?.id ?? null;
  }
}
