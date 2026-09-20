import { createHash, randomInt } from 'node:crypto';

export interface ReportSnapshot {
  title: string;
  description: string;
  reportedType: string;
  involvedPeople: string[];
  witnesses: string[];
  incidentDate: string | null;
  location: string | null;
}

/** SHA-256 do relato original (ordem fixa de campos => hash reproduzível). */
export function reportIntegrityHash(r: ReportSnapshot): string {
  const canonical = JSON.stringify([
    r.title,
    r.description,
    r.reportedType,
    r.involvedPeople,
    r.witnesses,
    r.incidentDate,
    r.location,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function addendumIntegrityHash(complaintId: string, content: string): string {
  return createHash('sha256').update(JSON.stringify([complaintId, content]), 'utf8').digest('hex');
}

// Sem 0/O/1/I/L para leitura sem ambiguidade.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomChars(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** DEN-{ANO}-{6 alfanuméricos maiúsculos} */
export function generateProtocol(now = new Date()): string {
  return `DEN-${now.getUTCFullYear()}-${randomChars(6)}`;
}

/** 20 caracteres (~100 bits), agrupados 5x4 para leitura: XXXX-XXXX-XXXX-XXXX-XXXX. */
export function generateAccessKey(): string {
  return randomChars(20).match(/.{4}/g)!.join('-');
}

/** Normaliza a chave digitada (caixa e separadores não importam). */
export function normalizeAccessKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
