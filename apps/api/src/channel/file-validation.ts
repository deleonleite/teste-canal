import { BadRequestException } from '@nestjs/common';

interface FileKind {
  mimes: string[];
  detect: (b: Buffer) => boolean;
  detected: string;
}

const startsWith = (b: Buffer, sig: number[]): boolean => sig.every((v, i) => b[i] === v);

const JPEG: FileKind = { mimes: ['image/jpeg'], detected: 'image/jpeg', detect: (b) => startsWith(b, [0xff, 0xd8, 0xff]) };
const PNG: FileKind = {
  mimes: ['image/png'],
  detected: 'image/png',
  detect: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
const GIF: FileKind = {
  mimes: ['image/gif'],
  detected: 'image/gif',
  detect: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a',
};
const PDF: FileKind = { mimes: ['application/pdf'], detected: 'application/pdf', detect: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' };
const ZIP: FileKind = {
  mimes: ['application/zip', 'application/x-zip-compressed'],
  detected: 'application/zip',
  detect: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
};
const DOCX: FileKind = {
  mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  detected: 'application/zip', // DOCX é um ZIP
  detect: ZIP.detect,
};
const DOC: FileKind = {
  mimes: ['application/msword'],
  detected: 'application/x-ole-storage',
  detect: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
};

/** Extensões permitidas (doc §5.4). Validação por assinatura (magic bytes), não só por extensão/MIME. */
const BY_EXTENSION: Record<string, FileKind> = {
  jpg: JPEG, jpeg: JPEG, png: PNG, gif: GIF, pdf: PDF, doc: DOC, docx: DOCX, zip: ZIP,
};

export interface ValidatedFile {
  extension: string;
  detectedMime: string;
}

export function validateFile(originalName: string, declaredMime: string, body: Buffer): ValidatedFile {
  const extension = originalName.split('.').pop()?.toLowerCase() ?? '';
  const kind = BY_EXTENSION[extension];
  if (!kind) throw new BadRequestException('Tipo de arquivo não permitido');
  if (body.length === 0) throw new BadRequestException('Arquivo vazio');
  if (!kind.mimes.includes(declaredMime.toLowerCase())) {
    throw new BadRequestException('O tipo informado não corresponde à extensão do arquivo');
  }
  if (!kind.detect(body)) throw new BadRequestException('O conteúdo do arquivo não corresponde ao tipo declarado');
  return { extension, detectedMime: kind.detected };
}

/** Nome seguro para exibição: sem caminho, sem caracteres de controle. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'arquivo';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'arquivo';
}
