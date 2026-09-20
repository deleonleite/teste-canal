'use client';

import { create } from 'zustand';

import type { LookupResponse } from './api-client';
import { EMPTY_FORM, type ComplaintFormValues } from './validation';

/**
 * Estado do canal público. PRIVACIDADE (PROMPTFRONT §12.2): tudo fica só na memória da aba — nada em
 * cookie, localStorage ou cache — e some ao fechar a aba. A única exceção é o rascunho, e só com o
 * opt-in explícito do usuário (`persistDraft`), por no máximo 24 h.
 */

interface DraftState {
  values: ComplaintFormValues;
  files: File[]; // arquivos nunca são persistidos
  step: number;
  persist: boolean;
  setValues: (v: Partial<ComplaintFormValues>) => void;
  setFiles: (f: File[]) => void;
  setStep: (s: number) => void;
  setPersist: (p: boolean) => void;
  reset: () => void;
  hydrate: (v: ComplaintFormValues) => void;
}

export const useDraft = create<DraftState>((set) => ({
  values: EMPTY_FORM,
  files: [],
  step: 0,
  persist: false,
  setValues: (v) => set((s) => ({ values: { ...s.values, ...v } })),
  setFiles: (files) => set({ files }),
  setStep: (step) => set({ step }),
  setPersist: (persist) => set({ persist }),
  reset: () => set({ values: EMPTY_FORM, files: [], step: 0, persist: false }),
  hydrate: (values) => set({ values, step: 1 }),
}));

/** Recibo logo após o envio: a chave de acesso só existe aqui, é exibida uma vez e apagada ao continuar. */
interface ReceiptState {
  protocol: string | null;
  accessKey: string | null;
  sessionToken: string | null;
  uploadFailures: number;
  setReceipt: (r: { protocol: string; accessKey: string; sessionToken: string; uploadFailures: number }) => void;
  wipeKey: () => void;
  clear: () => void;
}

export const useReceipt = create<ReceiptState>((set) => ({
  protocol: null,
  accessKey: null,
  sessionToken: null,
  uploadFailures: 0,
  setReceipt: (r) => set(r),
  wipeKey: () => set({ accessKey: null }),
  clear: () => set({ protocol: null, accessKey: null, sessionToken: null, uploadFailures: 0 }),
}));

/** Sessão de acompanhamento (protocolo + token de 30 min). Recarregar a página exige a chave de novo, por design. */
interface TrackingState {
  data: LookupResponse | null;
  sessionToken: string | null;
  set: (data: LookupResponse) => void;
  setToken: (t: string) => void;
  clear: () => void;
}

export const useTracking = create<TrackingState>((set) => ({
  data: null,
  sessionToken: null,
  set: (data) => set({ data, sessionToken: data.sessionToken }),
  setToken: (sessionToken) => set({ sessionToken }),
  clear: () => set({ data: null, sessionToken: null }),
}));

// ── Rascunho persistido (opt-in, 24 h) ──────────────────────────────────────────────
const DRAFT_TTL_MS = 24 * 3600_000;
const draftKey = (tenant: string) => `ouvion:draft:${tenant}`;

export function loadPersistedDraft(tenant: string, now = Date.now()): ComplaintFormValues | null {
  try {
    const raw = window.localStorage.getItem(draftKey(tenant));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { expiresAt: number; values: ComplaintFormValues };
    if (parsed.expiresAt < now) {
      window.localStorage.removeItem(draftKey(tenant));
      return null;
    }
    // O aviso de identificação por conteúdo nunca é restaurado: precisa ser lido de novo na revisão.
    return { ...EMPTY_FORM, ...parsed.values, contentWarningAcknowledged: false };
  } catch {
    return null;
  }
}

export function persistDraft(tenant: string, values: ComplaintFormValues, now = Date.now()): void {
  try {
    window.localStorage.setItem(draftKey(tenant), JSON.stringify({ expiresAt: now + DRAFT_TTL_MS, values: { ...values, contentWarningAcknowledged: false } }));
  } catch {
    /* armazenamento indisponível (modo privado, cota): o rascunho segue só em memória */
  }
}

export function clearPersistedDraft(tenant: string): void {
  try {
    window.localStorage.removeItem(draftKey(tenant));
  } catch {
    /* nada a apagar */
  }
}
