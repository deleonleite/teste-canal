import { Injectable, Logger } from '@nestjs/common';
import { CRITICAL_NOTIFICATIONS, type NotificationType, routingRulesSchema } from '@ouvion/contracts';

import { CaseAccessService } from '../access/case-access.service';
import { truncateToMinute } from '../common/client-info';
import { Mailer } from '../mail/mailer';
import { PrismaService, type Tx } from '../prisma/prisma.service';

const TYPE_LABEL: Record<string, string> = {
  HARASSMENT: 'Assédio', DISCRIMINATION: 'Discriminação', FRAUD: 'Fraude', CORRUPTION: 'Corrupção',
  SAFETY: 'Segurança do trabalho', ETHICS: 'Ética', OTHER: 'Outro',
};
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente', IN_PROGRESS: 'Em investigação', UNDER_REVIEW: 'Em análise', ESCALATED: 'Escalada',
  RESOLVED: 'Resolvida', DISMISSED: 'Arquivada',
};
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;

interface CaseRef {
  id: string;
  protocol: string;
  type: string;
  isAnonymous: boolean;
  isRestricted: boolean;
  investigatorId: string | null;
  createdBy: string | null;
  department: string | null;
}

interface Notify {
  type: NotificationType;
  title: string;
  message: string;
  userIds: string[];
  complaint: Pick<CaseRef, 'id' | 'isAnonymous'>;
  data?: Record<string, unknown>;
}

// Atraso do e-mail de evento anônimo: 2 a 4 min, truncado ao minuto. Sem isso o horário de envio no provedor
// seria quase o do próprio evento (o sweep roda a cada minuto e o horário da notificação é só ao minuto).
const ANON_EMAIL_MIN_DELAY_MS = 120_000;
const ANON_EMAIL_JITTER_MS = 120_000;

/**
 * Notificações in-app + e-mail (doc §5.8). Regras:
 *  - respeita UserPreferences; SLA vencido, suspeita de conflito e redistribuição IGNORAM silenciamento;
 *  - e-mail e tela NÃO revelam detalhes da denúncia: só protocolo, tipo e link autenticado;
 *  - falha aqui NUNCA derruba a operação de negócio (é registrada e o e-mail é reprocessado);
 *  - e-mail sobre denúncia anônima só sai pelo sweep, para o provedor não registrar o instante do evento.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CaseAccessService,
    private readonly mailer: Mailer,
  ) {}

  // ── Núcleo ────────────────────────────────────────────────────────────────────
  /** Cria as notificações e tenta o e-mail imediato (só para casos não anônimos). Nunca lança. */
  async notify(n: Notify): Promise<void> {
    try {
      const ids = await this.persist(n);
      if (!n.complaint.isAnonymous) await this.flush(ids);
    } catch (e) {
      this.log.warn(`Falha ao notificar (${(e as Error).name}); segue sem notificação`);
    }
  }

  private async persist(n: Notify): Promise<string[]> {
    const tenantId = this.prisma.currentTenantId();
    const unique = [...new Set(n.userIds)];
    if (unique.length === 0) return [];
    return this.prisma.withTenant(tenantId, async (tx) => {
      const users = await tx.user.findMany({
        where: { id: { in: unique }, isActive: true, isBlocked: false },
        select: { id: true },
      });
      const prefs = new Map((await tx.userPreferences.findMany({ where: { userId: { in: users.map((u) => u.id) } } })).map((p) => [p.userId, p]));
      const critical = CRITICAL_NOTIFICATIONS.includes(n.type);
      const created: string[] = [];
      for (const u of users) {
        const p = prefs.get(u.id);
        const inApp = critical || (p?.inAppNotifications !== false && !p?.inAppMutedTypes.includes(n.type));
        const email = critical || (p?.emailNotifications !== false && !p?.emailMutedTypes.includes(n.type));
        if (!inApp && !email) continue;
        const row = await tx.notification.create({
          data: {
            tenantId,
            userId: u.id,
            type: n.type,
            title: n.title,
            message: n.message,
            data: (n.data ?? undefined) as never,
            relatedId: n.complaint.id,
            relatedType: 'complaint',
            inApp,
            isRead: !inApp,
            emailPending: email,
            emailSendAfter: email && n.complaint.isAnonymous
              ? truncateToMinute(new Date(Date.now() + ANON_EMAIL_MIN_DELAY_MS + Math.random() * ANON_EMAIL_JITTER_MS))
              : null,
          },
        });
        if (email) created.push(row.id);
      }
      return created;
    });
  }

  /** Envia os e-mails pendentes indicados (ou todos os elegíveis). Falha de e-mail não é erro de negócio. */
  async flush(ids?: string[]): Promise<number> {
    if (ids && ids.length === 0) return 0;
    const tenantId = this.prisma.currentTenantId();
    const base = process.env.PUBLIC_WEB_URL ?? 'https://app.ouvion.local';
    const tenant = await this.prisma.base.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.notification.findMany({
        where: ids
          ? { id: { in: ids } }
          : { emailPending: true, OR: [{ emailSendAfter: null }, { emailSendAfter: { lte: new Date() } }] },
        take: 200,
      });
      const users = new Map((await tx.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]));
      let sent = 0;
      for (const r of rows) {
        const to = users.get(r.userId);
        try {
          if (!to) throw new Error('destinatário sem e-mail');
          const link = r.relatedId ? `\n${base}/${tenant.slug}/complaints/${r.relatedId}` : '';
          await this.mailer.send({ to, subject: r.title, text: `${r.message}${link}` });
          await tx.notification.update({ where: { id: r.id }, data: { emailPending: false, emailSent: true, emailSentAt: new Date(), emailError: null } });
          sent++;
        } catch (e) {
          await tx.notification.update({ where: { id: r.id }, data: { emailError: (e as Error).message.slice(0, 200) } });
        }
      }
      return sent;
    });
  }

  // ── Destinatários ─────────────────────────────────────────────────────────────
  private async case(tx: Tx, id: string): Promise<CaseRef> {
    return tx.complaint.findUniqueOrThrow({
      where: { id },
      select: { id: true, protocol: true, type: true, isAnonymous: true, isRestricted: true, investigatorId: true, createdBy: true, department: true },
    });
  }

  /** Equipe elegível para o caso: sem impedidos/suspeitos e, se restrito, só ADMIN/atribuído/concessão. */
  private async eligibleStaff(tx: Tx, c: CaseRef, roles: Array<'ADMIN' | 'INVESTIGATOR' | 'AUDITOR'>): Promise<string[]> {
    const blocked = await this.access.blockedUserIds(tx, c.id);
    const grants = c.isRestricted
      ? (await tx.complaintAccessGrant.findMany({ where: { complaintId: c.id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { userId: true } })).map((g) => g.userId)
      : [];
    const users = await tx.user.findMany({
      where: { role: { in: roles }, isActive: true, isBlocked: false, id: { notIn: blocked } },
      select: { id: true, role: true },
    });
    return users
      .filter((u) => !c.isRestricted || u.role === 'ADMIN' || u.id === c.investigatorId || grants.includes(u.id))
      .map((u) => u.id);
  }

  private async withCase<T>(complaintId: string, fn: (tx: Tx, c: CaseRef) => Promise<T>): Promise<T> {
    return this.prisma.run(async (tx) => fn(tx, await this.case(tx, complaintId)));
  }

  private msg(c: CaseRef, text: string): string {
    return `${text} Protocolo ${c.protocol} (${TYPE_LABEL[c.type] ?? c.type}).`;
  }

  // ── Eventos ───────────────────────────────────────────────────────────────────
  /** Regras de roteamento do tenant (`routingRules`): destinatários extras por tipo/departamento. */
  private async routedUsers(tx: Tx, c: CaseRef): Promise<string[]> {
    const s = await tx.systemSetting.findFirst({ where: { key: 'routingRules' } });
    if (!s) return [];
    try {
      const rules = routingRulesSchema.parse(JSON.parse(s.value));
      return rules
        .filter((r) => (!r.match.type || r.match.type === c.type) && (!r.match.department || r.match.department === c.department))
        .flatMap((r) => r.notifyUserIds);
    } catch {
      return [];
    }
  }

  async onComplaintCreated(complaintId: string): Promise<void> {
    try {
      const { c, ids } = await this.withCase(complaintId, async (tx, c) => {
        const staff = await this.eligibleStaff(tx, c, ['ADMIN', 'INVESTIGATOR']);
        const extra = (await this.routedUsers(tx, c)).filter((id) => staff.includes(id) || !c.isRestricted);
        const blocked = await this.access.blockedUserIds(tx, c.id);
        return { c, ids: [...staff, ...extra.filter((id) => !blocked.includes(id))] };
      });
      await this.notify({ type: 'COMPLAINT_CREATED', title: 'Nova denúncia aguardando triagem', message: this.msg(c, 'Denúncia aguardando triagem.'), userIds: ids, complaint: c });
    } catch (e) {
      this.log.warn(`Falha ao notificar criação (${(e as Error).name})`);
    }
  }

  async onAssigned(complaintId: string, investigatorId: string): Promise<void> {
    const c = await this.withCase(complaintId, async (_tx, c) => c).catch(() => null);
    if (c) await this.notify({ type: 'COMPLAINT_ASSIGNED', title: 'Denúncia atribuída a você', message: this.msg(c, 'Você foi designado(a) investigador(a).'), userIds: [investigatorId], complaint: c });
  }

  async onStatusChanged(complaintId: string, to: string, actorId: string | null): Promise<void> {
    const c = await this.withCase(complaintId, async (_tx, c) => c).catch(() => null);
    if (!c) return;
    const ids = [c.investigatorId, c.createdBy].filter((x): x is string => !!x && x !== actorId);
    await this.notify({ type: 'COMPLAINT_STATUS_CHANGED', title: 'Status da denúncia atualizado', message: this.msg(c, `Novo status: ${statusLabel(to)}.`), userIds: ids, complaint: c, data: { status: to } });
  }

  async onComment(complaintId: string, authorId: string, visibility: 'INTERNAL' | 'REPORTER'): Promise<void> {
    const c = await this.withCase(complaintId, async (_tx, c) => c).catch(() => null);
    if (!c) return;
    const ids = [c.investigatorId, visibility === 'REPORTER' ? c.createdBy : null].filter((x): x is string => !!x && x !== authorId);
    await this.notify({ type: 'COMPLAINT_COMMENT', title: 'Novo comentário na denúncia', message: this.msg(c, 'Há um novo comentário.'), userIds: ids, complaint: c });
  }

  /** Mensagem do denunciante: vai ao investigador atribuído; sem atribuição, aos ADMINs elegíveis. */
  async onReporterMessage(complaintId: string): Promise<void> {
    try {
      const { c, ids } = await this.withCase(complaintId, async (tx, c) => ({
        c,
        ids: c.investigatorId ? [c.investigatorId] : await this.eligibleStaff(tx, c, ['ADMIN']),
      }));
      await this.notify({ type: 'REPORTER_MESSAGE', title: 'Nova mensagem do denunciante', message: this.msg(c, 'O denunciante enviou uma mensagem.'), userIds: ids, complaint: c });
    } catch (e) {
      this.log.warn(`Falha ao notificar mensagem (${(e as Error).name})`);
    }
  }

  async onAttachment(complaintId: string, uploaderId: string | null): Promise<void> {
    const c = await this.withCase(complaintId, async (_tx, c) => c).catch(() => null);
    if (!c) return;
    const ids = [c.investigatorId].filter((x): x is string => !!x && x !== uploaderId);
    await this.notify({ type: 'ATTACHMENT_UPLOADED', title: 'Novo anexo na denúncia', message: this.msg(c, 'Um anexo foi enviado.'), userIds: ids, complaint: c });
  }

  /** ADMINs revisores (elegíveis, ou seja, não suspeitos) são avisados da suspeita. */
  async onConflictSuspected(complaintId: string, kind: 'detected' | 'suspect_read' = 'detected'): Promise<void> {
    try {
      const { c, ids } = await this.withCase(complaintId, async (tx, c) => ({ c, ids: await this.eligibleStaff(tx, c, ['ADMIN']) }));
      await this.notify({
        type: 'CONFLICT_SUSPECTED',
        title: kind === 'detected' ? 'Suspeita de conflito de interesses' : 'Leitura por usuário sob suspeita de conflito',
        message: this.msg(c, kind === 'detected' ? 'Revise a suspeita em até 24 h.' : 'Um usuário sob suspeita pendente acessou o caso.'),
        userIds: ids,
        complaint: c,
        data: { kind },
      });
    } catch (e) {
      this.log.warn(`Falha ao notificar suspeita (${(e as Error).name})`);
    }
  }

  async onRecusalReassigned(complaintId: string, newInvestigatorId: string | null): Promise<void> {
    const r = await this.withCase(complaintId, async (tx, c) => ({ c, admins: await this.eligibleStaff(tx, c, ['ADMIN']) })).catch(() => null);
    if (!r) return;
    await this.notify({
      type: 'RECUSAL_REASSIGNED',
      title: 'Caso redistribuído por impedimento',
      message: this.msg(r.c, newInvestigatorId ? 'O caso foi redistribuído a você.' : 'Caso sem investigador após impedimento; atribua um novo.'),
      userIds: newInvestigatorId ? [newInvestigatorId] : r.admins,
      complaint: r.c,
    });
  }

  async onSla(complaintId: string, level: 'WARNING' | 'BREACHED', kind: 'ACK' | 'FEEDBACK'): Promise<void> {
    const r = await this.withCase(complaintId, async (tx, c) => ({ c, admins: await this.eligibleStaff(tx, c, ['ADMIN']) })).catch(() => null);
    if (!r) return;
    const what = kind === 'ACK' ? 'confirmação de recebimento' : 'retorno ao denunciante';
    await this.notify({
      type: level === 'WARNING' ? 'SLA_WARNING' : 'SLA_BREACHED',
      title: level === 'WARNING' ? 'Prazo próximo do vencimento' : 'Prazo vencido',
      message: this.msg(r.c, level === 'WARNING' ? `O prazo de ${what} vence em breve.` : `O prazo de ${what} venceu.`),
      userIds: [...r.admins, ...(r.c.investigatorId ? [r.c.investigatorId] : [])],
      complaint: r.c,
      data: { kind, level },
    });
  }

  async onExternalAccess(complaintId: string): Promise<void> {
    const r = await this.withCase(complaintId, async (tx, c) => ({ c, ids: await this.eligibleStaff(tx, c, ['ADMIN', 'AUDITOR']) })).catch(() => null);
    if (r) await this.notify({ type: 'SYSTEM_ALERT', title: 'Acesso externo ao caso', message: this.msg(r.c, 'O destinatário alternativo acessou o caso.'), userIds: r.ids, complaint: r.c, data: { kind: 'external_access' } });
  }

  async onIdentityRevealed(complaintId: string, actorId: string): Promise<void> {
    const r = await this.withCase(complaintId, async (tx, c) => ({ c, ids: await this.eligibleStaff(tx, c, ['ADMIN']) })).catch(() => null);
    if (r) await this.notify({ type: 'SYSTEM_ALERT', title: 'Identidade de denunciante revelada', message: this.msg(r.c, 'A identidade do denunciante foi exibida (quebra de vidro).'), userIds: r.ids.filter((id) => id !== actorId), complaint: r.c, data: { kind: 'identity_revealed' } });
  }

  // ── Consulta do próprio usuário ───────────────────────────────────────────────
  list(userId: string, unreadOnly: boolean) {
    return this.prisma.run((tx) =>
      tx.notification.findMany({
        where: { userId, inApp: true, ...(unreadOnly ? { isRead: false } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, type: true, title: true, message: true, data: true, relatedId: true, relatedType: true, isRead: true, readAt: true, createdAt: true },
      }),
    );
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.run((tx) => tx.notification.count({ where: { userId, inApp: true, isRead: false } }));
  }

  async markRead(userId: string, id: string): Promise<{ updated: number }> {
    const r = await this.prisma.run((tx) => tx.notification.updateMany({ where: { id, userId, isRead: false }, data: { isRead: true, readAt: new Date() } }));
    return { updated: r.count };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const r = await this.prisma.run((tx) => tx.notification.updateMany({ where: { userId, inApp: true, isRead: false }, data: { isRead: true, readAt: new Date() } }));
    return { updated: r.count };
  }

  getPreferences(userId: string) {
    return this.prisma.run(async (tx) => {
      const p = await tx.userPreferences.findUnique({ where: { userId } });
      return p ?? { emailNotifications: true, inAppNotifications: true, emailMutedTypes: [], inAppMutedTypes: [], emailDigest: false, emailDigestTime: '09:00' };
    });
  }

  updatePreferences(userId: string, data: Record<string, unknown>) {
    const tenantId = this.prisma.currentTenantId();
    return this.prisma.run((tx) =>
      tx.userPreferences.upsert({ where: { userId }, create: { tenantId, userId, ...data }, update: data }),
    );
  }
}
