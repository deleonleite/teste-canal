/**
 * Normalização de colagem em campos de código (PROMPTFRONT §11.3): protocolo e chave aceitam espaços,
 * hífens e quebras de linha extras (copiados de papel ou de outro app) e são ajustados antes de validar.
 */

const ALNUM = /[^A-Za-z0-9]/g;

/** DEN-2026-A1B2C3, em maiúsculas. Aceita "den 2026 a1b2c3", "DEN2026A1B2C3", quebras de linha… */
export function normalizeProtocol(input: string): string {
  const raw = input.toUpperCase().replace(ALNUM, '');
  const m = /^DEN(\d{4})([A-Z0-9]{0,6})$/.exec(raw);
  if (!m) return input.toUpperCase().replace(/\s+/g, '');
  return m[2] ? `DEN-${m[1]}-${m[2]}` : `DEN-${m[1]}-`;
}

export function isProtocolComplete(input: string): boolean {
  return /^DEN-\d{4}-[A-Z0-9]{6}$/.test(normalizeProtocol(input));
}

/** XXXX-XXXX-XXXX-XXXX-XXXX (blocos de 4, maiúsculas). A chave tem 20 caracteres; aceita mais para não cortar colagem errada. */
export function normalizeAccessKey(input: string): string {
  const raw = input.toUpperCase().replace(ALNUM, '').slice(0, 32);
  return raw.match(/.{1,4}/g)?.join('-') ?? '';
}

export function isAccessKeyComplete(input: string): boolean {
  return input.toUpperCase().replace(ALNUM, '').length >= 16;
}

/** Uma entrada por linha; texto único vira lista (a API faz o mesmo, o formulário só espelha para o resumo). */
export function splitLines(input: string): string[] {
  return input.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
