import { z } from 'zod';

import { ComplaintPriority, ComplaintStatus, ComplaintType } from './enums';

export const ComplaintConclusion = ['SUBSTANTIATED', 'PARTIALLY_SUBSTANTIATED', 'UNSUBSTANTIATED', 'INCONCLUSIVE'] as const;
export type ComplaintConclusion = (typeof ComplaintConclusion)[number];

export const NotificationType = [
  'COMPLAINT_CREATED', 'COMPLAINT_ASSIGNED', 'COMPLAINT_STATUS_CHANGED', 'COMPLAINT_COMMENT',
  'ATTACHMENT_UPLOADED', 'DOSSIER_GENERATED', 'SYSTEM_ALERT', 'DEADLINE_REMINDER', 'REPORTER_MESSAGE',
  'SLA_WARNING', 'SLA_BREACHED', 'CONFLICT_SUSPECTED', 'RECUSAL_REASSIGNED',
] as const;
export type NotificationType = (typeof NotificationType)[number];

/** Notificações críticas ignoram preferências de silenciamento (doc §5.8). */
export const CRITICAL_NOTIFICATIONS: readonly NotificationType[] = ['SLA_BREACHED', 'CONFLICT_SUSPECTED', 'RECUSAL_REASSIGNED'];

export const CLOSED_STATUSES: readonly ComplaintStatus[] = ['RESOLVED', 'DISMISSED'];

/** Máquina de estados (doc §5.2.7). Reabrir RESOLVED/DISMISSED é exclusivo do ADMIN e vai para IN_PROGRESS. */
export const ALLOWED_TRANSITIONS: Record<ComplaintStatus, readonly ComplaintStatus[]> = {
  PENDING: ['IN_PROGRESS', 'DISMISSED'],
  IN_PROGRESS: ['UNDER_REVIEW', 'ESCALATED', 'RESOLVED', 'DISMISSED'],
  UNDER_REVIEW: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'DISMISSED'],
  ESCALATED: ['IN_PROGRESS', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
};

export function isReopen(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return CLOSED_STATUSES.includes(from) && to === 'IN_PROGRESS';
}

/** Prioridade inicial SUGERIDA por tipo (o triador ajusta com motivo registrado). */
export const SUGGESTED_PRIORITY: Record<ComplaintType, ComplaintPriority> = {
  CORRUPTION: 'HIGH',
  HARASSMENT: 'HIGH',
  SAFETY: 'HIGH',
  FRAUD: 'MEDIUM',
  DISCRIMINATION: 'MEDIUM',
  ETHICS: 'MEDIUM',
  OTHER: 'MEDIUM',
};

const PRIORITY_RANK: Record<ComplaintPriority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
export const maxPriority = (a: ComplaintPriority, b: ComplaintPriority): ComplaintPriority =>
  PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;

export const statusChangeSchema = z
  .object({
    status: z.enum(ComplaintStatus),
    reason: z.string().trim().min(10).max(500),
    /** Obrigatório ao encerrar (RESOLVED/DISMISSED). */
    conclusion: z.enum(ComplaintConclusion).optional(),
    correctiveActions: z.string().trim().max(5000).optional(),
    conclusionNotes: z.string().trim().max(5000).optional(),
    /** Obrigatório em ESCALATED: instância superior que recebeu o caso. */
    escalatedTo: z.string().trim().min(3).max(200).optional(),
  })
  .strict();
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

export const slaPauseSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const linkComplaintSchema = z.object({ relatedId: z.string().uuid() }).strict();
export const retaliationSchema = z.object({ content: z.string().trim().min(20).max(5000) }).strict();

export const preferencesSchema = z
  .object({
    emailNotifications: z.boolean().optional(),
    inAppNotifications: z.boolean().optional(),
    emailMutedTypes: z.array(z.enum(NotificationType)).optional(),
    inAppMutedTypes: z.array(z.enum(NotificationType)).optional(),
    emailDigest: z.boolean().optional(),
    emailDigestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  })
  .strict();

// ── Configurações com formato próprio (validadas na escrita) ──────────────────────────────
const days = z.coerce.number().int().min(1).max(3650);
export const slaByPrioritySchema = z.record(
  z.enum(ComplaintPriority),
  z.object({ ack: days.optional(), feedback: days.optional() }).strict(),
);
export const routingRulesSchema = z
  .array(
    z
      .object({
        match: z.object({ type: z.enum(ComplaintType).optional(), department: z.string().max(120).optional() }).strict(),
        notifyUserIds: z.array(z.string().uuid()).min(1).max(20),
      })
      .strict(),
  )
  .max(50);

/** Valida o valor de configurações estruturadas; devolve mensagem de erro ou null. */
export function validateSettingValue(key: string, value: string): string | null {
  const json = (): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  switch (key) {
    case 'sla_ack_days':
    case 'sla_feedback_days':
    case 'retaliationFollowUpDays':
    case 'data_retention_days':
      return days.safeParse(value).success ? null : 'Informe um número inteiro de dias (1–3650)';
    case 'auto_ack_message':
    case 'allowAnonymousComplaints':
    case 'maintenanceMode':
    case 'encrypt_complaint_body':
      return value === 'true' || value === 'false' ? null : 'Use "true" ou "false"';
    case 'docCodigoEtica':
    case 'docPoliticaFornecedores':
    case 'docPoliticaAnticorrupcao':
    case 'docPoliticaLicitacoes':
    case 'docPoliticaPldFtp':
    case 'docPoliticaAssedio':
      // Link do PDF do documento normativo (vazio remove). Só http(s): nada de javascript:/data:.
      return value === '' || /^https?:\/\/[^\s]+$/i.test(value) ? null : 'Informe o endereço (https://...) do documento';
    case 'sla_by_priority':
      return slaByPrioritySchema.safeParse(json()).success ? null : 'JSON inválido: {"CRITICAL":{"ack":2,"feedback":30}}';
    case 'routingRules':
      return routingRulesSchema.safeParse(json()).success ? null : 'JSON inválido: [{"match":{"type":"FRAUD"},"notifyUserIds":["uuid"]}]';
    default:
      return null;
  }
}
