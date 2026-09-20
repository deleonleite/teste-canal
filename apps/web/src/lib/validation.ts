import { createComplaintSchema } from '@ouvion/contracts';

import { splitLines } from './normalize';

/**
 * Validação do formulário: as REGRAS vêm do mesmo schema Zod que a API usa (`createComplaintSchema`);
 * os TEXTOS vêm do dicionário i18n (PROMPTFRONT §11.4), nunca de mensagens da biblioteca.
 */

export interface ComplaintFormValues {
  type: string;
  title: string;
  description: string;
  incidentDate: string;
  location: string;
  department: string;
  involvedPeople: string;
  witnesses: string;
  contentWarningAcknowledged: boolean;
}

export type FieldKey = keyof ComplaintFormValues;
export type FieldErrors = Partial<Record<FieldKey, string>>;
export type Translate = (key: string) => string;

export const EMPTY_FORM: ComplaintFormValues = {
  type: '',
  title: '',
  description: '',
  incidentDate: '',
  location: '',
  department: '',
  involvedPeople: '',
  witnesses: '',
  contentWarningAcknowledged: false,
};

/** Campos de cada etapa (0 Anonimato, 1 Fato, 2 Envolvidos, 3 Anexos, 4 Revisão). */
export const STEP_FIELDS: FieldKey[][] = [
  [],
  ['type', 'title', 'description', 'incidentDate', 'location', 'department'],
  ['involvedPeople', 'witnesses'],
  [],
  ['contentWarningAcknowledged'],
];

/** Só campos de formato fechado validam ao sair do campo; os de contagem, ao avançar (§11.1). */
export const BLUR_FIELDS: FieldKey[] = ['incidentDate'];

const opt = (v: string): string | undefined => (v.trim() ? v.trim() : undefined);

export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Corpo do POST /public/complaints. Vazios são omitidos (a API distingue "ausente" de "vazio"). */
export function buildPayload(v: ComplaintFormValues) {
  return {
    isAnonymous: true as const,
    contentWarningAcknowledged: v.contentWarningAcknowledged,
    type: v.type,
    title: v.title.trim(),
    description: v.description.trim(),
    incidentDate: opt(v.incidentDate),
    location: opt(v.location),
    department: opt(v.department),
    involvedPeople: splitLines(v.involvedPeople),
    witnesses: splitLines(v.witnesses),
  };
}

const KNOWN: FieldKey[] = ['type', 'title', 'description', 'involvedPeople', 'contentWarningAcknowledged'];

export function validateComplaint(v: ComplaintFormValues, t: Translate, now = new Date()): FieldErrors {
  const errors: FieldErrors = {};

  // Data: validada aqui (futura x formato) para diferenciar as duas mensagens.
  if (v.incidentDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.incidentDate) || Number.isNaN(Date.parse(v.incidentDate))) errors.incidentDate = t('incidentDateFormat');
    else if (v.incidentDate > todayIso(now)) errors.incidentDate = t('incidentDateFuture');
  }

  // Regra do relato anônimo (a API a aplica em superRefine, que o Zod só executa quando o resto está válido).
  if (!v.contentWarningAcknowledged) errors.contentWarningAcknowledged = t('ack');

  const payload = buildPayload({ ...v, incidentDate: '' }); // a data já foi tratada acima
  const parsed = createComplaintSchema.safeParse(payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as FieldKey | undefined;
      if (!field || !KNOWN.includes(field) || errors[field]) continue;
      if (field === 'description') errors.description = issue.code === 'too_big' ? t('descriptionMax') : t('description');
      else if (field === 'title') errors.title = t('title');
      else if (field === 'type') errors.type = t('type');
      else if (field === 'involvedPeople') errors.involvedPeople = t('involved');
      else if (field === 'contentWarningAcknowledged') errors.contentWarningAcknowledged = t('ack');
    }
  }
  return errors;
}

export function validateMessage(text: string, t: Translate): string | undefined {
  const s = text.trim();
  if (s.length < 1) return t('message');
  if (s.length > 5000) return t('messageMax');
  return undefined;
}

export const validateAddendum = (text: string, t: Translate): string | undefined => (text.trim().length < 10 ? t('addendum') : undefined);
export const validateRetaliation = (text: string, t: Translate): string | undefined => (text.trim().length < 20 ? t('retaliation') : undefined);

/** Arquivos aceitos (PROMPTFRONT §11.2): a checagem definitiva, por magic bytes, é do servidor. */
export const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'doc', 'docx', 'zip'];
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20;

/** Relato anônimo exige remover metadados; .doc (formato OLE) não é limpável e a API o recusa. */
export function checkFile(file: { name: string; size: number }, opts: { anonymous?: boolean } = {}): 'ok' | 'too_big' | 'bad_type' | 'doc_anonymous' {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) return 'bad_type';
  if (opts.anonymous && ext === 'doc') return 'doc_anonymous';
  if (file.size > MAX_FILE_BYTES) return 'too_big';
  return 'ok';
}
