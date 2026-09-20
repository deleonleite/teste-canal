import { ApiError } from './api-client';

/**
 * Cliente do navegador para a área da equipe (`/api/staff/{tenant}/...`). A sessão vive em cookies httpOnly
 * gerenciados pelo servidor; aqui só há o cabeçalho anti-CSRF. Sessão vencida (401) leva ao login.
 */

async function request<T>(tenant: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/staff/${encodeURIComponent(tenant)}/${path}`, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      // FormData: o navegador define o content-type com o boundary; JSON: definimos aqui.
      headers: { 'x-ouvion-csrf': '1', ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, e);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (res.status === 401 && !path.startsWith('auth/login') && !path.startsWith('auth/mfa') && typeof window !== 'undefined') {
    window.location.assign(`/${tenant}/entrar?expirada=1`);
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export function staffApi(tenant: string) {
  return {
    get: <T>(path: string) => request<T>(tenant, 'GET', path),
    post: <T>(path: string, body: unknown = {}, headers?: Record<string, string>) => request<T>(tenant, 'POST', path, body, headers),
    patch: <T>(path: string, body: unknown) => request<T>(tenant, 'PATCH', path, body),
    put: <T>(path: string, body: unknown) => request<T>(tenant, 'PUT', path, body),
    del: <T>(path: string) => request<T>(tenant, 'DELETE', path),
    upload: <T>(path: string, file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return request<T>(tenant, 'POST', path, form);
    },
  };
}

/** Mensagem da API (NestJS) para mostrar ao usuário, quando houver. */
export function apiMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const m = (e.body as { message?: unknown } | null)?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m) && typeof m[0] === 'string') return m[0];
  return null;
}

// ── Tipos ────────────────────────────────────────────────────────────────────────
export type Role = 'ADMIN' | 'INVESTIGATOR' | 'AUDITOR' | 'REPORTER';

export interface Me {
  userId: string;
  tenantId: string;
  role: Role;
  mfaEnabled: boolean;
}

export type LoginResult =
  | { authenticated: true }
  | { mfaRequired: true; mfaToken: string }
  | { mfaEnrollmentRequired: true; enrollToken: string }
  | { passwordChangeRequired: true; token: string };

export interface SlaIndicator {
  state: string;
  dueAt: string | null;
}

export interface CaseRow {
  id: string;
  protocol: string;
  type: string;
  priority: string;
  status: string;
  title: string;
  isAnonymous: boolean;
  isRestricted: boolean;
  investigatorId: string | null;
  department: string | null;
  createdAt: string;
  sla: { ack: SlaIndicator; feedback: SlaIndicator };
}

export interface CaseList {
  data: CaseRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface CaseDetail extends CaseRow {
  description: string;
  involvedPeople: string[];
  witnesses: string[];
  incidentDate: string | null;
  location: string | null;
  tags: string[];
  conclusion: string | null;
  correctiveActions: string | null;
  conclusionNotes: string | null;
  slaPausedAt: string | null;
  slaPauseReason: string | null;
  history: Array<{ id: string; previousStatus: string | null; newStatus: string; reason: string | null; createdAt: string }>;
  addenda: Array<{ id: string; content: string; createdAt: string }>;
}

export interface Comment {
  id: string;
  content: string;
  visibility: string;
  createdAt: string;
  authorId?: string | null;
}

export interface StaffMessage {
  id: string;
  direction: 'FROM_REPORTER' | 'TO_REPORTER';
  content: string;
  createdAt: string;
}

export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

export interface ManagedUser extends UserRow {
  isBlocked: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

export interface SessionRow {
  id: string;
  createdAt: string;
  current: boolean;
}

export interface NotificationPrefs {
  emailNotifications: boolean;
  inAppNotifications: boolean;
  emailDigest: boolean;
  emailDigestTime: string;
}

export interface RevealedIdentity {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface ConflictFlag {
  id: string;
  complaintId: string;
  userId: string;
  matchType: 'EMAIL' | 'NAME';
  status: 'PENDING' | 'CONFIRMED' | 'DISMISSED';
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  timestamp: string;
  anonymousOrigin: boolean;
}

export interface AuditPage {
  data: AuditRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface AuditSeal {
  id: string;
  fromSeq: string;
  toSeq: string;
  rowCount: number;
  sealedAt: string;
}

export interface VerificationReport {
  ok: boolean;
  sealsChecked: number;
  rowsChecked: number;
  problems: Array<{ type: string; detail: string }>;
}

export interface BrandingForm {
  companyName: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  faviconUrl: string | null;
}

export interface AttachmentRow {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256Hash: string;
  uploadedAt: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR';
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  relatedId: string | null;
  relatedType: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface RelatedSuggestion {
  id: string;
  protocol: string;
  title: string;
  type: string;
  status: string;
  sharedPeople: number;
  sameLocation: boolean;
}

export interface ActivationStatus {
  tenantStatus: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  ready: boolean;
  missing: string[];
  escalationRecipientEmail: string | null;
  dpo: { name: string; email: string } | null;
}
