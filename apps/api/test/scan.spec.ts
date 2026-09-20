import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import type { UserRole } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { BullJobQueue, InMemoryJobQueue, JobQueue } from '../src/queue/job-queue';
import { AttachmentScanHandler } from '../src/scan/attachment-scan.handler';
import { inspectArchive, stripMetadata } from '../src/scan/metadata-stripper';
import { ClamdScanner, EICAR_TEST_STRING, Scanner } from '../src/scan/scanner';
import { MemoryStorage, Storage } from '../src/storage/storage';
import { AttachmentSweepHandler, JobHandlers } from '../src/worker/handlers';
import { closeAll, createTenant, owner } from './helpers';

const PASSWORD = 'Senha-Forte-123!';

// ── Construtores de arquivos de teste com metadados identificadores ─────────────────────────────
const SECRET = 'Fabio-Silva-Camera-GPS-23.55S';

const jpegWithExif = (): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]), // APP0 JFIF
    Buffer.concat([Buffer.from([0xff, 0xe1]), u16(2 + 6 + SECRET.length), Buffer.from(`Exif\0\0${SECRET}`)]), // APP1 EXIF
    Buffer.concat([Buffer.from([0xff, 0xfe]), u16(2 + 12), Buffer.from('autor: Fabio')]), // COM
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), // SOS
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), // dados (com byte stuffing)
    Buffer.from([0xff, 0xd9]),
  ]);
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([len, Buffer.from(type), data, crc]);
}
const pngWithText = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from(`Author\0${SECRET}`)),
    pngChunk('eXIf', Buffer.from(SECRET)),
    pngChunk('tIME', Buffer.from([7, 232, 5, 5, 10, 11, 12])),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0, 0, 0, 4, 0, 1])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

const gifWithComment = (): Buffer =>
  Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([1, 0, 1, 0, 0x00, 0, 0]), // LSD sem tabela global
    Buffer.from([0x21, 0xfe, SECRET.length, ...Buffer.from(SECRET), 0]), // comentário
    Buffer.from([0x21, 0xff, 11, ...Buffer.from('XMP DataXMP'), 3, 1, 2, 3, 0]), // extensão XMP
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), // descritor de imagem
    Buffer.from([2, 2, 0x44, 0x01, 0]), // LZW
    Buffer.from([0x3b]),
  ]);

async function pdfWithMeta(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setAuthor(SECRET);
  doc.setCreator('Microsoft Word da empresa ACME');
  doc.setProducer(SECRET);
  doc.setTitle('Denúncia de Fabio');
  return Buffer.from(await doc.save());
}

async function docxWithMeta(): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('word/document.xml', `<w:document><w:ins w:author="${SECRET}" w:initials="FS"><w:t>texto</w:t></w:ins></w:document>`);
  z.file('word/comments.xml', `<w:comments><w:comment w:author="${SECRET}"/></w:comments>`);
  z.file('docProps/core.xml', `<cp:coreProperties><dc:creator>${SECRET}</dc:creator></cp:coreProperties>`);
  z.file('docProps/app.xml', `<Properties><Company>${SECRET}</Company></Properties>`);
  z.file('docProps/thumbnail.jpeg', SECRET);
  return z.generateAsync({ type: 'nodebuffer' });
}

const bytesHave = (b: Buffer, s: string): boolean => b.includes(Buffer.from(s));

describe('remoção de metadados (unidade)', () => {
  it('JPEG: tira EXIF/GPS e comentário, mantém o resto', async () => {
    const before = jpegWithExif();
    expect(bytesHave(before, SECRET)).toBe(true);
    const after = await stripMetadata('jpg', before);
    expect(bytesHave(after, SECRET)).toBe(false);
    expect(bytesHave(after, 'Fabio')).toBe(false);
    expect(after.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(after.subarray(-2).toString('hex')).toBe('ffd9');
    expect(bytesHave(after, 'JFIF')).toBe(true); // APP0 preservado
    expect(after.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]))).toBe(true); // dados da imagem intactos
    await expect(stripMetadata('jpg', Buffer.from('nao e jpeg'))).rejects.toThrow();
  });

  it('PNG: tira tEXt/eXIf/tIME e mantém chunks críticos com CRC válido', async () => {
    const after = await stripMetadata('png', pngWithText());
    expect(bytesHave(after, SECRET)).toBe(false);
    for (const t of ['IHDR', 'IDAT', 'IEND']) expect(bytesHave(after, t)).toBe(true);
    for (const t of ['tEXt', 'eXIf', 'tIME']) expect(bytesHave(after, t)).toBe(false);
    // CRCs dos chunks mantidos
    let i = 8;
    while (i < after.length) {
      const len = after.readUInt32BE(i);
      const type = after.subarray(i + 4, i + 8);
      const data = after.subarray(i + 8, i + 8 + len);
      expect(after.readUInt32BE(i + 8 + len)).toBe(crc32(Buffer.concat([type, data])));
      i += 12 + len;
    }
  });

  it('GIF: tira comentário e extensão XMP', async () => {
    const after = await stripMetadata('gif', gifWithComment());
    expect(bytesHave(after, SECRET)).toBe(false);
    expect(bytesHave(after, 'XMP Data')).toBe(false);
    expect(after.subarray(-1)[0]).toBe(0x3b);
  });

  it('PDF: zera autor/criador/produtor/título e o resultado continua um PDF válido', async () => {
    const before = await PDFDocument.load(await pdfWithMeta(), { updateMetadata: false });
    expect(before.getAuthor()).toBe(SECRET);
    expect(before.getCreator()).toContain('ACME');
    const after = await PDFDocument.load(await stripMetadata('pdf', await pdfWithMeta()), { updateMetadata: false });
    expect(after.getPageCount()).toBe(1);
    for (const v of [after.getAuthor(), after.getCreator(), after.getProducer(), after.getTitle(), after.getSubject(), after.getKeywords()]) {
      expect(v).toBeUndefined();
    }
    expect(after.getCreationDate()).toBeUndefined();
  });

  it('DOCX: zera core/app, autores de revisão e comentários, miniatura e datas', async () => {
    const after = await stripMetadata('docx', await docxWithMeta());
    const z = await JSZip.loadAsync(after);
    for (const [name, e] of Object.entries(z.files)) {
      if (e.dir) continue;
      expect(await e.async('string')).not.toContain(SECRET);
      expect(e.date.getUTCFullYear()).toBe(1980);
      expect(name).not.toContain('thumbnail');
    }
    expect(z.file('word/document.xml')).not.toBeNull();
  });

  it('ZIP comum: normaliza as datas das entradas', async () => {
    const z = new JSZip();
    z.file('a.txt', 'oi', { date: new Date() });
    const after = await JSZip.loadAsync(await stripMetadata('zip', await z.generateAsync({ type: 'nodebuffer' })));
    expect(after.file('a.txt')!.date.getUTCFullYear()).toBe(1980);
  });

  it('formato sem suporte à limpeza (.doc) falha explicitamente', async () => {
    await expect(stripMetadata('doc', Buffer.from('x'))).rejects.toThrow(/Sem suporte/);
  });
});

describe('inspeção de compactados', () => {
  it('barra zip-bomb, aninhados e entradas demais; aceita zip normal', async () => {
    const ok = new JSZip();
    ok.file('a.txt', 'conteudo normal');
    await expect(inspectArchive(await ok.generateAsync({ type: 'nodebuffer' }))).resolves.toBeUndefined();

    const bomb = new JSZip();
    bomb.file('zeros.bin', Buffer.alloc(20 * 1024 * 1024)); // ~20 MB que comprimem para poucos KB
    await expect(inspectArchive(await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))).rejects.toThrow(/zip-bomb/);

    const nested = new JSZip();
    nested.file('interno.zip', 'PK');
    await expect(inspectArchive(await nested.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/aninhados/);

    const many = new JSZip();
    for (let i = 0; i < 1001; i++) many.file(`f${i}.txt`, 'x');
    await expect(inspectArchive(await many.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/entradas demais/);

    await expect(inspectArchive(Buffer.from('nem e zip'))).rejects.toThrow(/inválido/);
  });
});

// ── Fluxo completo: upload -> sweep -> varredura -> limpeza -> custódia ─────────────────────────────
let app: INestApplication;
let passwordHash: string;
let storage: MemoryStorage;
let queue: InMemoryJobQueue;
let handlers: JobHandlers;
let scanHandler: AttachmentScanHandler;

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  storage = app.get(Storage) as MemoryStorage;
  queue = app.get(JobQueue) as InMemoryJobQueue;
  handlers = app.get(JobHandlers);
  scanHandler = app.get(AttachmentScanHandler);
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());

async function world() {
  const t = await createTenant(PASSWORD);
  const mk = async (role: UserRole, tag: string) => {
    const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@x.com`;
    await owner.user.create({ data: { tenantId: t.tenantId, email, fullName: tag, passwordHash, role } });
    return email;
  };
  const login = async (email: string) =>
    (await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email, password: PASSWORD }).expect(201)).body.accessToken as string;
  const invEmail = await mk('INVESTIGATOR', 'inv');
  const tok = { admin: await login(t.adminEmail), inv: await login(invEmail) };
  const call = (m: 'get' | 'post', url: string, token?: string) => {
    const r = http()[m](url).set('x-tenant-slug', t.slug);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  const complaint = async () => {
    const r = await call('post', '/public/complaints').send({
      isAnonymous: true, contentWarningAcknowledged: true, type: 'FRAUD', title: 'Suspeita de fraude em notas fiscais',
      description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas.', involvedPeople: ['Alguém'],
    }).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: r.body.protocol } });
    return { row, session: r.body.sessionToken as string };
  };
  const anonUpload = (session: string, buf: Buffer, name: string, mime: string) =>
    call('post', '/public/channel/attachments', session).attach('file', buf, { filename: name, contentType: mime });
  return { t, tok, call, complaint, anonUpload };
}

/** Executa os jobs de varredura pendentes na fila em memória (o que o worker faria). */
async function runScanJobs(attachmentId: string): Promise<void> {
  for (const j of queue.jobs.filter((x) => x.name === 'attachment-scan' && x.data.attachmentId === attachmentId)) {
    await handlers.handle(j.name, j.data);
  }
}
const sweepAge = (id: string) => owner.attachment.update({ where: { id }, data: { uploadedAt: new Date(Date.now() - 120_000) } });

describe('varredura + limpeza (denúncia anônima)', () => {
  it('upload anônimo NÃO é enfileirado no ato; o sweep o pega; sai limpo e com custódia registrada', async () => {
    const w = await world();
    const c = await w.complaint();
    const original = pngWithText();
    const up = await w.anonUpload(c.session, original, 'foto-fabio.png', 'image/png').expect(201);
    const id = up.body.id as string;

    expect(queue.jobs.some((j) => j.data.attachmentId === id)).toBe(false); // nada na fila com o instante do upload
    expect((await owner.attachment.findUniqueOrThrow({ where: { id } })).scanStatus).toBe('PENDING');

    await sweepAge(id);
    expect(await app.get(AttachmentSweepHandler).handle()).toBeGreaterThanOrEqual(1);
    await app.get(AttachmentSweepHandler).handle(); // idempotente: não duplica
    expect(queue.jobs.filter((j) => j.data.attachmentId === id)).toHaveLength(1);
    await runScanJobs(id);

    const row = await owner.attachment.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ scanStatus: 'CLEAN', metadataStripped: true });
    expect(row.originalSha256Hash).toBe(createHash('sha256').update(original).digest('hex'));
    const stored = storage.objects.get(row.s3Key)!.body;
    expect(row.sha256Hash).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(row.sha256Hash).not.toBe(row.originalSha256Hash);
    expect(row.size).toBe(stored.length);
    expect(bytesHave(stored, SECRET)).toBe(false);

    // Auditoria da varredura: anônima (sem usuário/IP), com os dois hashes da custódia.
    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.t.tenantId, resource: 'attachment_scan' } });
    expect(audit).toMatchObject({ anonymousOrigin: true, userId: null, ipAddress: null });
    expect(audit.timestamp.getUTCSeconds()).toBe(0);
    expect(audit.details).toMatchObject({ status: 'CLEAN', metadataStripped: true, originalSha256: row.originalSha256Hash });

    // Já limpo: verificação de integridade bate e o download é liberado.
    const base = `/complaints/${c.row.id}/attachments/${id}`;
    expect((await w.call('post', `${base}/verify`, w.tok.admin).expect(201)).body.ok).toBe(true);
    await w.call('get', `${base}/download`, w.tok.admin).expect(200);

    // Reprocessar é inofensivo (idempotente) e não duplica auditoria.
    await scanHandler.handle({ tenantId: w.t.tenantId, attachmentId: id });
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, resource: 'attachment_scan' } })).toBe(1);
  });

  it('cada formato suportado sai sem o identificador (JPEG, GIF, PDF, DOCX)', async () => {
    const w = await world();
    const c = await w.complaint();
    const cases: Array<[Buffer, string, string]> = [
      [jpegWithExif(), 'a.jpg', 'image/jpeg'],
      [gifWithComment(), 'a.gif', 'image/gif'],
      [await pdfWithMeta(), 'a.pdf', 'application/pdf'],
      [await docxWithMeta(), 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ];
    for (const [buf, name, mime] of cases) {
      const up = await w.anonUpload(c.session, buf, name, mime).expect(201);
      await runScanJobsViaHandler(w.t.tenantId, up.body.id);
      const row = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
      expect(row.scanStatus).toBe('CLEAN');
      const stored = storage.objects.get(row.s3Key)!.body;
      expect(bytesHave(stored, SECRET)).toBe(false);
      if (name === 'a.pdf') {
        const reopened = await PDFDocument.load(stored, { updateMetadata: false });
        expect(reopened.getAuthor()).toBeUndefined();
      }
    }
  });

  it('arquivo ilegível na limpeza vira ERROR (bloqueado) em vez de vazar metadados', async () => {
    const w = await world();
    const c = await w.complaint();
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x74, 0x45, 0x58, 0x74])]);
    const up = await w.anonUpload(c.session, broken, 'quebrado.png', 'image/png').expect(201);
    await runScanJobsViaHandler(w.t.tenantId, up.body.id);
    const row = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row.scanStatus).toBe('ERROR');
    expect(row.scanDetail).toMatch(/metadata_strip_failed/);
    await w.call('get', `/complaints/${c.row.id}/attachments/${up.body.id}/download`, w.tok.admin).expect(400);
  });

  it('.doc é recusado em denúncia anônima (não dá para limpar), mas aceito pela equipe', async () => {
    const w = await world();
    const c = await w.complaint();
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const res = await w.anonUpload(c.session, ole, 'x.doc', 'application/msword').expect(400);
    expect(res.body.message).toMatch(/remover metadados/);
    await w.call('post', `/complaints/${c.row.id}/assign`, w.tok.admin).send({ investigatorId: (await owner.user.findFirstOrThrow({ where: { tenantId: w.t.tenantId, role: 'INVESTIGATOR' } })).id }).expect(201);
    await w.call('post', `/complaints/${c.row.id}/attachments`, w.tok.inv).attach('file', ole, { filename: 'x.doc', contentType: 'application/msword' }).expect(201);
  });

  it('zip-bomb e compactado aninhado são recusados já no upload', async () => {
    const w = await world();
    const c = await w.complaint();
    const bomb = new JSZip();
    bomb.file('zeros.bin', Buffer.alloc(20 * 1024 * 1024));
    const bombBuf = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect((await w.anonUpload(c.session, bombBuf, 'b.zip', 'application/zip').expect(400)).body.message).toMatch(/zip-bomb/);
    const nested = new JSZip();
    nested.file('dentro.zip', 'PK');
    const nestedBuf = await nested.generateAsync({ type: 'nodebuffer' });
    await w.anonUpload(c.session, nestedBuf, 'n.zip', 'application/zip').expect(400);
  });
});

async function runScanJobsViaHandler(tenantId: string, attachmentId: string): Promise<void> {
  await scanHandler.handle({ tenantId, attachmentId });
}

describe('antivírus e custódia', () => {
  it('EICAR: fica INFECTED, é bloqueado e o estado é final até para o dono do schema', async () => {
    const w = await world();
    const c = await w.complaint();
    const virus = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(EICAR_TEST_STRING)]);
    const up = await w.anonUpload(c.session, virus, 'x.pdf', 'application/pdf').expect(201);
    await runScanJobsViaHandler(w.t.tenantId, up.body.id);

    const row = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row).toMatchObject({ scanStatus: 'INFECTED', metadataStripped: false });
    expect(row.scanDetail).toMatch(/eicar/i); // stub: Eicar-Test-Signature; clamd real: Win.Test.EICAR_HDB-1
    await w.call('get', `/complaints/${c.row.id}/attachments/${up.body.id}/download`, w.tok.admin).expect(400);
    await expect(owner.attachment.update({ where: { id: row.id }, data: { scanStatus: 'CLEAN' } })).rejects.toThrow(/final/);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.t.tenantId, resource: 'attachment_scan' } });
    expect(JSON.stringify(audit.details)).toContain('INFECTED');
  });

  it('trigger de custódia: hash só troca uma vez, preservando o original', async () => {
    const w = await world();
    const c = await w.complaint();
    const up = await w.anonUpload(c.session, pngWithText(), 'a.png', 'image/png').expect(201);
    await runScanJobsViaHandler(w.t.tenantId, up.body.id);
    const id = up.body.id as string;
    await expect(owner.attachment.update({ where: { id }, data: { sha256Hash: 'f'.repeat(64) } })).rejects.toThrow(/Hash do anexo/);
    await expect(owner.attachment.update({ where: { id }, data: { originalSha256Hash: 'e'.repeat(64) } })).rejects.toThrow();
    await expect(owner.attachment.update({ where: { id }, data: { size: 1 } })).rejects.toThrow();
    // E a aplicação nem consegue tocar nas colunas de conteúdo/identidade.
    const { runtime } = await import('./helpers');
    await expect(
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${w.t.tenantId}, true)`;
        return tx.$executeRawUnsafe(`UPDATE attachments SET s3_key = 'outro' WHERE id = '${id}'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('falha do antivírus NÃO vira "limpo": o job falha, o arquivo segue PENDING e depois vira ERROR', async () => {
    const w = await world();
    const c = await w.complaint();
    const up = await w.anonUpload(c.session, pngWithText(), 'a.png', 'image/png').expect(201);
    const real = app.get(Scanner);
    const original = real.scan.bind(real);
    real.scan = async () => {
      throw new Error('clamd indisponível');
    };
    try {
      await expect(scanHandler.handle({ tenantId: w.t.tenantId, attachmentId: up.body.id })).rejects.toThrow(/clamd/);
      expect((await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } })).scanStatus).toBe('PENDING');
    } finally {
      real.scan = original;
    }
    await scanHandler.markError(w.t.tenantId, up.body.id, 'scan_failed: clamd indisponível');
    const row = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row).toMatchObject({ scanStatus: 'ERROR' });
    await w.call('get', `/complaints/${c.row.id}/attachments/${up.body.id}/download`, w.tok.admin).expect(400);
  });

  it('upload da equipe é enfileirado na hora e, limpo, mantém o arquivo e o hash', async () => {
    const w = await world();
    const c = await w.complaint();
    const invId = (await owner.user.findFirstOrThrow({ where: { tenantId: w.t.tenantId, role: 'INVESTIGATOR' } })).id;
    await w.call('post', `/complaints/${c.row.id}/assign`, w.tok.admin).send({ investigatorId: invId }).expect(201);
    const original = pngWithText();
    const up = await w.call('post', `/complaints/${c.row.id}/attachments`, w.tok.inv).attach('file', original, { filename: 'parecer.png', contentType: 'image/png' }).expect(201);
    expect(queue.jobs.filter((j) => j.data.attachmentId === up.body.id)).toHaveLength(1);
    await runScanJobs(up.body.id);
    const row = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row).toMatchObject({ scanStatus: 'CLEAN', metadataStripped: false, originalSha256Hash: null });
    expect(row.sha256Hash).toBe(createHash('sha256').update(original).digest('hex'));
    expect(row.filename).toBe('parecer.png');
  });
});

// ── Integrações reais: ClamAV e Redis/BullMQ (ignoradas se o serviço não estiver no ar) ────────────
describe('ClamAV real (clamd)', () => {
  it('detecta EICAR e libera arquivo limpo', async () => {
    const scanner = new ClamdScanner(process.env.CLAMAV_HOST ?? 'localhost', 3310, 10_000);
    let clean;
    try {
      clean = await scanner.scan(Buffer.from('conteudo inofensivo'));
    } catch {
      return console.warn('clamd indisponível: teste ignorado');
    }
    expect(clean).toEqual({ status: 'CLEAN' });
    const bad = await scanner.scan(Buffer.from(EICAR_TEST_STRING));
    expect(bad.status).toBe('INFECTED');
    expect((bad as { signature: string }).signature).toMatch(/EICAR/i);
    // Arquivo maior que um bloco de 64 KB também trafega inteiro.
    expect(await scanner.scan(Buffer.alloc(300 * 1024, 65))).toEqual({ status: 'CLEAN' });
  });
});

describe('Redis + BullMQ reais', () => {
  const REDIS = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
  let available = false;

  beforeAll(async () => {
    const probe = new IORedis(REDIS, { maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: () => null });
    try {
      await probe.connect();
      await probe.ping();
      available = true;
    } catch {
      available = false;
    } finally {
      probe.disconnect();
    }
  });

  it('anônimo não gera job; o da equipe sim; o worker processa e a fila não guarda histórico', async () => {
    if (!available) return console.warn('Redis indisponível: teste ignorado');
    const bull = new BullJobQueue(REDIS);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(JobQueue).useValue(bull).compile();
    const a2 = mod.createNestApplication();
    await a2.init();
    const connection = new IORedis(REDIS, { maxRetriesPerRequest: null });
    let workerConn: IORedis | undefined;
    const scanQ = new Queue('attachment-scan', { connection });
    await scanQ.obliterate({ force: true });

    const h2 = a2.get(JobHandlers);
    const req = () => request(a2.getHttpServer());
    const t = await createTenant(PASSWORD);
    const invEmail = `inv-${Math.random().toString(36).slice(2, 8)}@x.com`;
    const inv = await owner.user.create({ data: { tenantId: t.tenantId, email: invEmail, fullName: 'inv', passwordHash, role: 'INVESTIGATOR' } });
    const adminTok = (await req().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD })).body.accessToken;
    const invTok = (await req().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: invEmail, password: PASSWORD })).body.accessToken;
    const created = await req().post('/public/complaints').set('x-tenant-slug', t.slug).send({
      isAnonymous: true, contentWarningAcknowledged: true, type: 'FRAUD', title: 'Suspeita de fraude em notas fiscais',
      description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas.', involvedPeople: ['Alguém'],
    }).expect(201);
    const complaint = await owner.complaint.findUniqueOrThrow({ where: { protocol: created.body.protocol } });

    try {
      // 1) anônimo: nenhum job no Redis
      await req().post('/public/channel/attachments').set('x-tenant-slug', t.slug).set('authorization', `Bearer ${created.body.sessionToken}`)
        .attach('file', pngWithText(), { filename: 'a.png', contentType: 'image/png' }).expect(201);
      expect(await scanQ.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')).toMatchObject({ waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 });

      // 2) equipe: job entra na fila
      await req().post(`/complaints/${complaint.id}/assign`).set('x-tenant-slug', t.slug).set('authorization', `Bearer ${adminTok}`).send({ investigatorId: inv.id }).expect(201);
      const up = await req().post(`/complaints/${complaint.id}/attachments`).set('x-tenant-slug', t.slug).set('authorization', `Bearer ${invTok}`)
        .attach('file', pngWithText(), { filename: 'p.png', contentType: 'image/png' }).expect(201);
      expect((await scanQ.getJobCounts('waiting')).waiting).toBe(1);

      // 3) worker real processa; job concluído some
      workerConn = new IORedis(REDIS, { maxRetriesPerRequest: null });
      const worker = new Worker('attachment-scan', (job) => h2.handle('attachment-scan', job.data), { connection: workerConn });
      await new Promise<void>((resolve, reject) => {
        worker.on('completed', () => resolve());
        worker.on('failed', (_j, e) => reject(e));
        setTimeout(() => reject(new Error('worker não processou em 15 s')), 15_000);
      });
      await worker.close();
      expect((await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } })).scanStatus).toBe('CLEAN');
      expect(await scanQ.getJobCounts('waiting', 'active', 'completed', 'failed')).toMatchObject({ waiting: 0, active: 0, completed: 0, failed: 0 });

      // 4) o sweep enfileira o anexo anônimo (que ficou PENDING) — só então ele entra na fila
      const anonAtt = await owner.attachment.findFirstOrThrow({ where: { complaintId: complaint.id, uploadedBy: null } });
      await owner.attachment.update({ where: { id: anonAtt.id }, data: { uploadedAt: new Date(Date.now() - 120_000) } });
      expect(await a2.get(AttachmentSweepHandler).handle()).toBeGreaterThanOrEqual(1);
      expect((await scanQ.getJobCounts('waiting')).waiting).toBeGreaterThanOrEqual(1);
    } finally {
      await scanQ.obliterate({ force: true });
      await scanQ.close();
      connection.disconnect();
      workerConn?.disconnect();
      await bull.close();
      await a2.close();
    }
  }, 60_000);
});
