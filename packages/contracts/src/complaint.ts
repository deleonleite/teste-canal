import { z } from 'zod';

import { CommentVisibility, ComplaintPriority, ComplaintType } from './enums';

const nameList = z.array(z.string().trim().min(1).max(200)).max(50);

export const createComplaintSchema = z
  .object({
    isAnonymous: z.boolean(),
    type: z.enum(ComplaintType),
    title: z.string().trim().min(10).max(200),
    description: z.string().trim().min(50).max(20000),
    priority: z.enum(ComplaintPriority).optional(),
    department: z.string().trim().max(120).optional(),
    location: z.string().trim().max(200).optional(),
    incidentDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD)')
      .refine((d) => d <= new Date().toISOString().slice(0, 10), 'A data não pode ser futura')
      .optional(),
    /** Citados/acusados. Aceita texto único (normalizado em lista). */
    involvedPeople: z
      .union([nameList, z.string().trim().min(1)])
      .transform((v) => (typeof v === 'string' ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : v))
      .refine((v) => v.length >= 1, 'Informe ao menos um citado'),
    witnesses: z
      .union([nameList, z.string()])
      .transform((v) => (typeof v === 'string' ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : v))
      .optional(),
    /** Denunciante anônimo deve reconhecer o aviso de identificação por conteúdo. */
    contentWarningAcknowledged: z.boolean().optional(),
    /** Contato do denunciante identificado (guardado cifrado; anônima nunca informa). */
    reporterName: z.string().trim().min(2).max(120).optional(),
    reporterEmail: z.string().email().max(200).optional(),
    reporterPhone: z
      .string()
      .regex(/^\+?[\d\s()-]{10,20}$/, 'Telefone inválido')
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.isAnonymous && (v.reporterName || v.reporterEmail || v.reporterPhone)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reporterName'],
        message: 'Denúncia anônima não pode conter dados de identificação do denunciante',
      });
    }
    if (v.isAnonymous && v.contentWarningAcknowledged !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentWarningAcknowledged'],
        message: 'Reconheça o aviso sobre identificação pelo conteúdo do relato',
      });
    }
  });
export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;

/** Só campos de classificação/gestão; qualquer campo do relato original é rejeitado (strict). */
export const classifyComplaintSchema = z
  .object({
    type: z.enum(ComplaintType).optional(),
    priority: z.enum(ComplaintPriority).optional(),
    department: z.string().trim().max(120).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    /** Obrigatório ao alterar a prioridade (ajuste do triador é registrado com motivo). */
    reason: z.string().trim().min(10).max(500).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'reason'), 'Nenhum campo informado')
  .refine((v) => v.priority === undefined || !!v.reason, 'Informe o motivo do ajuste de prioridade');

export const lookupComplaintSchema = z
  .object({ protocol: z.string().trim().min(1).max(40), accessKey: z.string().trim().min(1).max(64) })
  .strict();

export const assignInvestigatorSchema = z.object({ investigatorId: z.string().uuid() }).strict();

export const createCommentSchema = z
  .object({
    content: z.string().trim().min(1).max(5000),
    visibility: z.enum(CommentVisibility).default('INTERNAL'),
  })
  .strict();

export const createAddendumSchema = z
  .object({ content: z.string().trim().min(10).max(10000) })
  .strict();

export const blockUserSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();

export const registerSchema = z
  .object({
    email: z.string().email().max(200),
    fullName: z.string().trim().min(2).max(120),
    password: z.string().max(100),
  })
  .strict();

const isoFuture = z
  .string()
  .datetime()
  .refine((d) => new Date(d).getTime() > Date.now(), 'A validade deve estar no futuro')
  .refine((d) => new Date(d).getTime() < Date.now() + 90 * 86400_000, 'Validade máxima de 90 dias');

export const recuseSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const decideConflictSchema = z
  .object({ decision: z.enum(['CONFIRMED', 'DISMISSED']), note: z.string().trim().min(10).max(500) })
  .strict();
export const restrictionSchema = z.object({ isRestricted: z.boolean() }).strict();
export const accessGrantSchema = z
  .object({ userId: z.string().uuid(), reason: z.string().trim().min(10).max(500), expiresAt: isoFuture })
  .strict();
export const externalTriggerSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const revealIdentitySchema = z
  .object({ justification: z.string().trim().min(20).max(1000) })
  .strict();

export const escalationRecipientSchema = z.object({ email: z.string().email().max(200) }).strict();
export const escalationConfirmSchema = z.object({ token: z.string().min(20).max(200) }).strict();
export const escalationEnrollSchema = z
  .object({ token: z.string().min(20).max(200), code: z.string().regex(/^\d{6}$/) })
  .strict();
export const externalVerifySchema = z
  .object({ token: z.string().min(20).max(200), code: z.string().regex(/^\d{6}$/) })
  .strict();

export const messageSchema = z.object({ content: z.string().trim().min(1).max(5000) }).strict();
