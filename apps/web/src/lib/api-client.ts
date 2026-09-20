/**
 * Cliente do navegador para o BFF (`/api/bff/{tenant}/...`). O navegador NUNCA chama a API direto: o BFF
 * repassa, com o segredo de serviço, e o token de sessão do protocolo vai no cabeçalho Authorization.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export type ErrorKind = 'not_found' | 'too_many' | 'unauthorized' | 'bad_request' | 'network' | 'generic';

export function classifyError(e: unknown): ErrorKind {
  if (!(e instanceof ApiError)) return 'network';
  if (e.status === 404) return 'not_found';
  if (e.status === 429) return 'too_many';
  if (e.status === 401) return 'unauthorized';
  if (e.status === 400) return 'bad_request';
  return 'generic';
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store', credentials: 'omit' });
  } catch (e) {
    throw new ApiError(0, e);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const auth = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

export function api(tenant: string) {
  const base = `/api/bff/${encodeURIComponent(tenant)}`;
  return {
    get: <T>(path: string, token?: string) => request<T>(`${base}/${path}`, { method: 'GET', headers: auth(token) }),
    post: <T>(path: string, body: unknown, token?: string) =>
      request<T>(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(token) }, body: JSON.stringify(body) }),
    upload: <T>(path: string, file: File, token?: string) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return request<T>(`${base}/${path}`, { method: 'POST', headers: auth(token), body: form });
    },
  };
}

// ── Tipos das respostas do canal público ─────────────────────────────────────────
export interface CreateResponse {
  protocol: string;
  accessKey: string;
  sessionToken: string;
  status: string;
  createdAt: string;
}

export interface TimelineEntry {
  status: string;
  at: string;
}

export interface LookupResponse {
  id: string;
  protocol: string;
  status: string;
  type: string;
  priority: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  isAnonymous: boolean;
  timeline: TimelineEntry[];
  ackDueAt: string | null;
  feedbackDueAt: string | null;
  canReportRetaliation: boolean;
  sessionToken: string;
}

export interface ChannelMessage {
  id: string;
  direction: 'FROM_REPORTER' | 'TO_REPORTER';
  content: string;
  createdAt: string;
  readAt: string | null;
}

export interface RetaliationResponse {
  protocol: string;
  accessKey: string;
  sessionToken: string;
}
