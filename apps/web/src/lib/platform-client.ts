import { ApiError } from './api-client';

/**
 * Cliente do navegador para o painel da plataforma (`/api/platform/...`). A sessão vive em cookies httpOnly
 * do servidor; aqui só há o cabeçalho anti-CSRF. Sessão vencida (401) leva ao `/loginadm`.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/platform/${path}`, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'x-ouvion-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
  const pre = path.startsWith('auth/login') || path.startsWith('auth/mfa') || path.startsWith('auth/change-password');
  if (res.status === 401 && !pre && typeof window !== 'undefined') window.location.assign('/loginadm?expirada=1');
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export const platformApi = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
};

export type PlatformRole = 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCIAL';

export interface PlatformMe {
  userId: string;
  email: string;
  fullName: string;
  role: PlatformRole;
  mfaEnabled: boolean;
}

export type PlatformLoginResult =
  | { authenticated: true }
  | { passwordChangeRequired: true; token: string }
  | { mfaRequired: true; mfaToken: string }
  | { mfaEnrollmentRequired: true; enrollToken: string };

export interface TenantRow {
  id: string;
  slug: string;
  companyName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL' | 'CANCELLED';
  maxUsers: number;
  maxComplaintsPerMonth: number;
  subscriptionExpiresAt: string | null;
  createdAt: string;
  dpo: { name: string | null; email: string | null } | null;
  onboarding: { escalationVerified: boolean; escalationTotpEnrolled: boolean };
  counts: { users: number; complaints: number; complaintsThisMonth: number };
}

export interface InternalUser {
  id: string;
  email: string;
  fullName: string;
  role: PlatformRole;
  isActive: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PlatformAuditRow {
  id: string;
  action: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  resource: string;
  resourceId: string | null;
  tenantId: string | null;
  actorId: string | null;
  actorName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: string;
}

export interface PlatformAuditPage {
  data: PlatformAuditRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
