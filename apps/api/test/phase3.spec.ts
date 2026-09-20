import { createHash } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { RateLimiter } from '../src/common/rate-limiter';
import { MemoryStorage, S3Storage, Storage } from '../src/storage/storage';
import { closeAll, createTenant, owner } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
let app: INestApplication;
let passwordHash: string;
let storage: MemoryStorage;
let limiter: RateLimiter;

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  storage = app.get(Storage) as MemoryStorage;
  limiter = app.get(RateLimiter);
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());

async function makeUser(tenantId: string, role: UserRole, tag: string) {
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const u = await owner.user.create({ data: { tenantId, email, fullName: `Pessoa ${tag}`, passwordHash, role } });
  return { id: u.id, email };
}
async function login(slug: string, email: string): Promise<string> {
  const r = await http().post('/auth/login').set('x-tenant-slug', slug).send({ email, password: PASSWORD });
  expect(r.status).toBe(201);
  return r.body.accessToken as string;
}

const report = (over: Record<string, unknown> = {}) => ({
  isAnonymous: true,
  contentWarningAcknowledged: true,
  type: 'FRAUD',
  title: 'Suspeita de fraude em notas fiscais',
  description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas.',
  involvedPeople: ['Pessoa Externa Qualquer'],
  ...over,
});

const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function world() {
  const t = await createTenant(PASSWORD);
  const inv = await makeUser(t.tenantId, 'INVESTIGATOR', 'inv');
  const inv2 = await makeUser(t.tenantId, 'INVESTIGATOR', 'inv2');
  const aud = await makeUser(t.tenantId, 'AUDITOR', 'aud');
  const rep = await makeUser(t.tenantId, 'REPORTER', 'rep');
  const tok = {
    admin: await login(t.slug, t.adminEmail),
    inv: await login(t.slug, inv.email),
    inv2: await login(t.slug, inv2.email),
    aud: await login(t.slug, aud.email),
    rep: await login(t.slug, rep.email),
  };
  const req = (method: 'get' | 'post' | 'put' | 'delete') => (url: string, token?: string) => {
    const r = http()[method](url).set('x-tenant-slug', t.slug);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  const a = { get: req('get'), post: req('post'), put: req('put'), del: req('delete') };
  const anon = async (over: Record<string, unknown> = {}, token?: string) => {
    const r = await a.post('/public/complaints', token).send(report(over)).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: r.body.protocol } });
    return { row, key: r.body.accessKey as string, session: r.body.sessionToken as string, protocol: r.body.protocol as string };
  };
  return { t, inv, inv2, aud, rep, tok, a, anon };
}

const zeroSeconds = (d: Date) => d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

describe('sessão do protocolo', () => {
  it('criação e consulta devolvem token curto de escopo único; outros tokens não servem', async () => {
    const w = await world();
    const c = await w.anon();
    expect(c.session).toBeTruthy();
    await w.a.get('/public/channel/messages', c.session).expect(200);

    const look = await w.a.post('/public/complaints/lookup').send({ protocol: c.protocol, accessKey: c.key }).expect(200);
    await w.a.get('/public/channel/messages', look.body.sessionToken).expect(200);

    await w.a.get('/public/channel/messages').expect(401);
    await w.a.get('/public/channel/messages', w.tok.admin).expect(401); // token de equipe não abre o canal
    await w.a.get('/complaints', c.session).expect(401); // token de protocolo não abre a área da equipe
    await w.a.get('/auth/me', c.session).expect(401);

    const jwt = app.get(JwtService);
    const expired = await jwt.signAsync({ sub: c.row.id, tenantId: w.t.tenantId, scope: 'protocol' }, { expiresIn: '-10s' });
    await w.a.get('/public/channel/messages', expired).expect(401);

    const other = await world();
    await http().get('/public/channel/messages').set('x-tenant-slug', other.t.slug).set('authorization', `Bearer ${c.session}`).expect(401);
  });
});

describe('chat seguro com o denunciante', () => {
  it('conversa bidirecional anônima: recibo automático, resposta do comitê, leitura e mensagem de atribuição', async () => {
    const w = await world();
    const c = await w.anon();

    // Recibo automático já na criação.
    const first = await w.a.get('/public/channel/messages', c.session).expect(200);
    expect(first.body).toHaveLength(1);
    expect(first.body[0]).toMatchObject({ direction: 'TO_REPORTER' });

    await w.a.post('/public/channel/messages', c.session).send({ content: 'Tenho mais informações sobre o caso.' }).expect(201);
    await w.a.post('/public/channel/messages', c.session).send({ content: '' }).expect(400);
    await w.a.post('/public/channel/messages', c.session).send({ content: 'x'.repeat(5001) }).expect(400);
    await w.a.post('/public/channel/messages', c.session).send({ content: 'ok', authorId: 'x' }).expect(400);

    // Comitê: atribui (gera mensagem automática) e responde.
    await w.a.post(`/complaints/${c.row.id}/assign`, w.tok.admin).send({ investigatorId: w.inv.id }).expect(201);
    await w.a.post(`/complaints/${c.row.id}/messages`, w.tok.inv).send({ content: 'Pode informar as datas exatas?' }).expect(201);
    await w.a.post(`/complaints/${c.row.id}/messages`, w.tok.aud).send({ content: 'x' }).expect(403); // AUDITOR só lê
  });

  it('o denunciante lê tudo em ordem, o que marca as mensagens do comitê como lidas (horário ao minuto)', async () => {
    const w = await world();
    const c = await w.anon();
    await w.a.post(`/complaints/${c.row.id}/assign`, w.tok.admin).send({ investigatorId: w.inv.id }).expect(201);
    await w.a.post(`/complaints/${c.row.id}/messages`, w.tok.inv).send({ content: 'Pode informar as datas exatas?' }).expect(201);
    await w.a.post('/public/channel/messages', c.session).send({ content: 'Foram em março.' }).expect(201);

    const read = await w.a.get('/public/channel/messages', c.session).expect(200);
    expect(read.body.map((m: { direction: string }) => m.direction)).toEqual([
      'TO_REPORTER', // recibo
      'TO_REPORTER', // encaminhada à investigação
      'TO_REPORTER', // pergunta do comitê
      'FROM_REPORTER',
    ]);
    const rows = await owner.complaintMessage.findMany({ where: { complaintId: c.row.id } });
    expect(rows.every((m) => zeroSeconds(m.createdAt))).toBe(true);
    expect(rows.filter((m) => m.direction === 'TO_REPORTER').every((m) => m.readAt && zeroSeconds(m.readAt))).toBe(true);
    // Sem autor nas mensagens do denunciante e nas automáticas.
    expect(rows.filter((m) => m.authorId === null)).toHaveLength(3);

    // A equipe também vê a conversa; AUDITOR só lê.
    const staff = await w.a.get(`/complaints/${c.row.id}/messages`, w.tok.inv).expect(200);
    expect(staff.body).toHaveLength(4);
    await w.a.get(`/complaints/${c.row.id}/messages`, w.tok.aud).expect(200);
    await w.a.get(`/complaints/${c.row.id}/messages`, w.tok.rep).expect(403); // REPORTER não dono
    await w.a.get(`/complaints/${c.row.id}/messages`).expect(401);
  });

  it('auditoria das mensagens anônimas: sem usuário/IP/UA, horário ao minuto, sem conteúdo', async () => {
    const w = await world();
    const c = await w.anon();
    await w.a.post('/public/channel/messages', c.session).set('user-agent', 'ProbeUA/1').send({ content: 'segredo do caso' }).expect(201);
    const audits = await owner.auditLog.findMany({ where: { tenantId: w.t.tenantId, resource: 'complaint_message' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ anonymousOrigin: true, userId: null, ipAddress: null, userAgent: null });
    expect(zeroSeconds(audits[0]!.timestamp)).toBe(true);
    expect(JSON.stringify(audits[0]!.details)).not.toContain('segredo');
  });

  it('complemento do denunciante entra como addendum e o relato original não muda', async () => {
    const w = await world();
    const c = await w.anon();
    const add = await w.a.post('/public/channel/addenda', c.session).send({ content: 'Complemento: o valor foi de R$ 10 mil.' }).expect(201);
    expect(add.body.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    const after = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(after.integrityHash).toBe(c.row.integrityHash);
    const detail = await w.a.get(`/complaints/${c.row.id}`, w.tok.admin).expect(200);
    expect(detail.body.addenda).toHaveLength(1);
    expect(detail.body.addenda[0]).toMatchObject({ authorType: 'REPORTER', authorId: null });
  });

  it('REPORTER com conta conversa só na própria denúncia', async () => {
    const w = await world();
    const mine = await w.anon({ isAnonymous: false, contentWarningAcknowledged: undefined }, w.tok.rep);
    const other = await w.anon();
    await w.a.post(`/complaints/${mine.row.id}/messages`, w.tok.rep).send({ content: 'Mais um detalhe importante.' }).expect(201);
    await w.a.post(`/complaints/${other.row.id}/messages`, w.tok.rep).send({ content: 'intruso' }).expect(403);
    const m = await owner.complaintMessage.findFirstOrThrow({ where: { complaintId: mine.row.id, direction: 'FROM_REPORTER' } });
    expect(m.authorId).toBe(w.rep.id);
  });

  it('limite por sessão: 31ª mensagem em 15 min recebe 429', async () => {
    const w = await world();
    const c = await w.anon();
    for (let i = 0; i < 30; i++) await w.a.post('/public/channel/messages', c.session).send({ content: `m${i}` }).expect(201);
    await w.a.post('/public/channel/messages', c.session).send({ content: 'demais' }).expect(429);
  });
});

describe('proteção da consulta por protocolo', () => {
  it('5 falhas bloqueiam o protocolo por 15 min (até com a chave certa); depois libera; outro tenant não é afetado', async () => {
    const w = await world();
    const c = await w.anon();
    const other = await world();
    const lookup = (key: string, slug = w.t.slug) =>
      http().post('/public/complaints/lookup').set('x-tenant-slug', slug).send({ protocol: c.protocol, accessKey: key });

    for (let i = 0; i < 5; i++) await lookup('AAAA-AAAA-AAAA-AAAA-AAAA').expect(404);
    await lookup(c.key).expect(429);
    await lookup('AAAA-AAAA-AAAA-AAAA-AAAA').expect(429);
    await lookup(c.key, other.t.slug).expect(404); // outro tenant: mesmo protocolo não existe lá

    const realNow = limiter.now;
    limiter.now = () => realNow() + 16 * 60_000;
    try {
      await lookup(c.key).expect(200);
    } finally {
      limiter.now = realNow;
    }
  });

  it('limite por origem: 11ª denúncia em 1 h recebe 429 (IP só como chave opaca em memória)', async () => {
    const w = await world();
    limiter.ipLimitsEnabled = true;
    try {
      for (let i = 0; i < 10; i++) await w.a.post('/public/complaints').send(report()).expect(201);
      await w.a.post('/public/complaints').send(report()).expect(429);
    } finally {
      limiter.ipLimitsEnabled = false;
    }
  });
});

describe('anexos', () => {
  it('upload anônimo: valida por assinatura, descarta o nome original, guarda hash e horário ao minuto', async () => {
    const w = await world();
    const c = await w.anon();
    const png = PNG();
    const res = await w.a
      .post('/public/channel/attachments', c.session)
      .attach('file', png, { filename: 'selfie-do-joao-silva.png', contentType: 'image/png' })
      .expect(201);
    expect(res.body).toMatchObject({ filename: 'anexo-1.png', size: png.length, scanStatus: 'PENDING' });

    const row = await owner.attachment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ uploadedBy: null, filename: 'anexo-1.png', detectedMime: 'image/png', metadataStripped: false });
    expect(row.sha256Hash).toBe(createHash('sha256').update(png).digest('hex'));
    expect(zeroSeconds(row.uploadedAt)).toBe(true);
    expect(row.s3Key).toMatch(/^complaints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    expect(storage.objects.get(row.s3Key)?.body.equals(png)).toBe(true);
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('joao');

    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.t.tenantId, resource: 'attachment' } });
    expect(audit).toMatchObject({ anonymousOrigin: true, userId: null, ipAddress: null });
    expect(JSON.stringify(audit.details)).not.toContain('joao');

    // Segundo arquivo: numeração sequencial genérica.
    const second = await w.a.post('/public/channel/attachments', c.session).attach('file', PDF(), { filename: 'contrato.pdf', contentType: 'application/pdf' }).expect(201);
    expect(second.body.filename).toBe('anexo-2.pdf');
  });

  it('rejeita tipo não permitido, conteúdo divergente, MIME divergente, vazio, grande demais e excesso de arquivos', async () => {
    const w = await world();
    const c = await w.anon();
    const up = (buf: Buffer, filename: string, contentType: string) =>
      w.a.post('/public/channel/attachments', c.session).attach('file', buf, { filename, contentType });

    await up(Buffer.from('MZ....'), 'virus.exe', 'application/octet-stream').expect(400);
    await up(PDF(), 'falso.png', 'image/png').expect(400); // extensão png, conteúdo pdf
    await up(PNG(), 'foto.png', 'application/pdf').expect(400); // MIME declarado diverge
    await up(Buffer.alloc(0), 'vazio.png', 'image/png').expect(400);
    await w.a.post('/public/channel/attachments', c.session).expect(400); // sem arquivo

    await w.a.put('/settings/max_file_size_mb', w.tok.admin).send({ value: '1' }).expect(200);
    await up(Buffer.concat([PNG(), Buffer.alloc(2 * 1024 * 1024)]), 'grande.png', 'image/png').expect(400);
    await w.a.put('/settings/max_file_size_mb', w.tok.admin).send({ value: '25' }).expect(200);

    // Limite de 20 arquivos por denúncia (fixado no banco para não estourar o limite por sessão).
    const many = await w.anon();
    for (let i = 0; i < 20; i++) {
      await owner.attachment.create({
        data: {
          tenantId: w.t.tenantId, complaintId: many.row.id, filename: `a${i}.png`, mimeType: 'image/png',
          detectedMime: 'image/png', size: 1, s3Key: `k/${i}`, s3Bucket: 'memory', sha256Hash: 'x'.repeat(64),
        },
      });
    }
    await w.a.post('/public/channel/attachments', many.session).attach('file', PNG(), { filename: 'mais.png', contentType: 'image/png' }).expect(400);
  });

  it('upload da equipe mantém o nome; equipe restrita e REPORTER só no que pode', async () => {
    const w = await world();
    const c = await w.anon();
    await w.a.post(`/complaints/${c.row.id}/assign`, w.tok.admin).send({ investigatorId: w.inv.id }).expect(201);
    const res = await w.a
      .post(`/complaints/${c.row.id}/attachments`, w.tok.inv)
      .attach('file', PDF(), { filename: 'parecer-juridico.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(res.body.filename).toBe('parecer-juridico.pdf');
    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.t.tenantId, resource: 'attachment', userId: w.inv.id } });
    expect(audit.ipAddress).not.toBeNull(); // equipe é identificada

    await w.a.post(`/complaints/${c.row.id}/attachments`, w.tok.aud).attach('file', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(403);
    await w.a.post(`/complaints/${c.row.id}/attachments`, w.tok.rep).attach('file', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(403);
    const list = await w.a.get(`/complaints/${c.row.id}/attachments`, w.tok.aud).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty('s3Key');
  });

  it('download só por URL pré-assinada, só de arquivo CLEAN, com auditoria', async () => {
    const w = await world();
    const c = await w.anon();
    const up = await w.a.post('/public/channel/attachments', c.session).attach('file', PNG(), { filename: 'a.png', contentType: 'image/png' }).expect(201);
    const url = `/complaints/${c.row.id}/attachments/${up.body.id}/download`;

    await w.a.get(url, w.tok.admin).expect(400); // PENDING: ainda sem varredura
    await owner.attachment.update({ where: { id: up.body.id }, data: { scanStatus: 'INFECTED' } });
    await w.a.get(url, w.tok.admin).expect(400);
    // O estado de varredura é final: nem o dono do schema volta INFECTED para CLEAN.
    await expect(owner.attachment.update({ where: { id: up.body.id }, data: { scanStatus: 'CLEAN' } })).rejects.toThrow(/final/);

    const up2 = await w.a.post('/public/channel/attachments', c.session).attach('file', PNG(), { filename: 'b.png', contentType: 'image/png' }).expect(201);
    const url2 = `/complaints/${c.row.id}/attachments/${up2.body.id}/download`;
    await owner.attachment.update({ where: { id: up2.body.id }, data: { scanStatus: 'CLEAN' } });

    const ok = await w.a.get(url2, w.tok.aud).expect(200);
    expect(ok.body.url).toContain('expires=3600');
    expect(ok.body.expiresInSeconds).toBe(3600);
    await w.a.get(url2).expect(401);
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, resource: 'attachment', action: 'READ' } })).toBe(1);
  });

  it('verificação de integridade detecta adulteração; só ADMIN/AUDITOR', async () => {
    const w = await world();
    const c = await w.anon();
    const up = await w.a.post('/public/channel/attachments', c.session).attach('file', PNG(), { filename: 'a.png', contentType: 'image/png' }).expect(201);
    const url = `/complaints/${c.row.id}/attachments/${up.body.id}/verify`;
    await w.a.post(url, w.tok.inv).expect(403);
    expect((await w.a.post(url, w.tok.aud).expect(201)).body.ok).toBe(true);

    const row = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    await storage.put(row.s3Key, Buffer.from('conteúdo adulterado'), 'image/png');
    const bad = await w.a.post(url, w.tok.admin).expect(201);
    expect(bad.body.ok).toBe(false);
    const audits = await owner.auditLog.findMany({ where: { tenantId: w.t.tenantId, resource: 'attachment_integrity' }, orderBy: { seq: 'asc' } });
    expect(audits.map((a) => (a.details as { ok: boolean }).ok)).toEqual([true, false]);
  });

  it('exclusão lógica: ADMIN ou quem enviou; remove o objeto e some de listas e downloads', async () => {
    const w = await world();
    const c = await w.anon();
    await w.a.post(`/complaints/${c.row.id}/assign`, w.tok.admin).send({ investigatorId: w.inv.id }).expect(201);
    const up = await w.a.post(`/complaints/${c.row.id}/attachments`, w.tok.inv).attach('file', PDF(), { filename: 'p.pdf', contentType: 'application/pdf' }).expect(201);
    const row = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    const url = `/complaints/${c.row.id}/attachments/${up.body.id}`;

    await w.a.del(url, w.tok.aud).expect(403);
    await w.a.del(url, w.tok.inv2).expect(403); // outro investigador, não é quem enviou
    await w.a.del(url, w.tok.rep).expect(403);

    await w.a.del(url, w.tok.inv).expect(200); // quem enviou
    const gone = await owner.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.deletedBy).toBe(w.inv.id);
    expect(storage.objects.has(row.s3Key)).toBe(false);
    expect((await w.a.get(`/complaints/${c.row.id}/attachments`, w.tok.admin)).body).toHaveLength(0);
    await w.a.get(`${url}/download`, w.tok.admin).expect(404);
    await w.a.del(url, w.tok.admin).expect(404); // já removido

    // ADMIN remove arquivo de terceiros.
    const up2 = await w.a.post(`/complaints/${c.row.id}/attachments`, w.tok.inv).attach('file', PDF(), { filename: 'q.pdf', contentType: 'application/pdf' }).expect(201);
    await w.a.del(`/complaints/${c.row.id}/attachments/${up2.body.id}`, w.tok.admin).expect(200);
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, action: 'DELETE', resource: 'attachment' } })).toBe(2);
  });
});

describe('adaptador S3 (MinIO)', () => {
  const cfg = { endpoint: 'http://localhost:9000', region: 'us-east-1', accessKeyId: 'minio', secretAccessKey: 'minio12345', forcePathStyle: true };
  const bucket = `ouvion-test-${Date.now()}`;
  let available = false;

  beforeAll(async () => {
    try {
      const res = await fetch('http://localhost:9000/minio/health/live');
      if (!res.ok) return;
      await new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }).send(new CreateBucketCommand({ Bucket: bucket }));
      available = true;
    } catch {
      available = false;
    }
  });

  it('put/get/presign/delete funcionam contra um S3 real (ignora se o MinIO não estiver no ar)', async () => {
    if (!available) return console.warn('MinIO indisponível: teste do adaptador S3 ignorado');
    const s3 = new S3Storage(bucket, cfg);
    const body = PNG();
    await s3.put('complaints/x/y', body, 'image/png');
    expect((await s3.get('complaints/x/y')).equals(body)).toBe(true);
    const url = await s3.presignGet('complaints/x/y', 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    // Sem assinatura o objeto não é público.
    expect((await fetch(`${cfg.endpoint}/${bucket}/complaints/x/y`)).status).toBeGreaterThanOrEqual(400);
    await s3.delete('complaints/x/y');
    await expect(s3.get('complaints/x/y')).rejects.toThrow();
  });
});

describe('ordem da conversa vem da sequência, não do horário', () => {
  it('mensagens do mesmo minuto mantêm a ordem de envio e `seq` nunca vaza', async () => {
    const w = await world();
    const c = await w.anon();
    await w.a.post(`/complaints/${c.row.id}/assign`, w.tok.admin).send({ investigatorId: w.inv.id }).expect(201);
    const sent: string[] = [];
    for (let i = 0; i < 6; i++) {
      const fromReporter = i % 2 === 0;
      const text = `mensagem-${i}`;
      sent.push(text);
      if (fromReporter) await w.a.post('/public/channel/messages', c.session).send({ content: text }).expect(201);
      else await w.a.post(`/complaints/${c.row.id}/messages`, w.tok.inv).send({ content: text }).expect(201);
    }
    // Todas caem no mesmo minuto truncado (ou em poucos): o horário não ordena.
    const rows = await owner.complaintMessage.findMany({ where: { complaintId: c.row.id } });
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBeLessThan(rows.length);

    const reporterView = await w.a.get('/public/channel/messages', c.session).expect(200);
    const texts = reporterView.body.map((m: { content: string }) => m.content).filter((t: string) => t.startsWith('mensagem-'));
    expect(texts).toEqual(sent);
    const staffView = await w.a.get(`/complaints/${c.row.id}/messages`, w.tok.inv).expect(200);
    expect(staffView.body.map((m: { content: string }) => m.content).filter((t: string) => t.startsWith('mensagem-'))).toEqual(sent);
    expect(JSON.stringify(reporterView.body)).not.toContain('seq');
    expect(JSON.stringify(staffView.body)).not.toContain('"seq"');
  });
});
