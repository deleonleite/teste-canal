import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { reportIntegrityHash } from '../src/complaints/integrity';
import { MemoryStorage, Storage } from '../src/storage/storage';
import { closeAll, createTenant, owner } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
let app: INestApplication;
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());

async function makeUser(tenantId: string, role: UserRole, tag: string) {
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const u = await owner.user.create({
    data: { tenantId, email, fullName: `Usuário ${tag}`, passwordHash, role },
  });
  return { id: u.id, email };
}

async function login(slug: string, email: string): Promise<string> {
  const r = await http().post('/auth/login').set('x-tenant-slug', slug).send({ email, password: PASSWORD });
  expect(r.status).toBe(201);
  return r.body.accessToken as string;
}

const validReport = (over: Record<string, unknown> = {}) => ({
  isAnonymous: true,
  contentWarningAcknowledged: true,
  type: 'FRAUD',
  title: 'Suspeita de fraude em notas fiscais',
  description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas.',
  involvedPeople: ['João da Silva'],
  ...over,
});

async function setup() {
  const t = await createTenant(PASSWORD);
  const investigator = await makeUser(t.tenantId, 'INVESTIGATOR', 'inv');
  const auditor = await makeUser(t.tenantId, 'AUDITOR', 'aud');
  const reporter = await makeUser(t.tenantId, 'REPORTER', 'rep');
  const tokens = {
    admin: await login(t.slug, t.adminEmail),
    inv: await login(t.slug, investigator.email),
    aud: await login(t.slug, auditor.email),
    rep: await login(t.slug, reporter.email),
  };
  const as = (slug = t.slug) => ({
    post: (url: string, token?: string) => {
      const r = http().post(url).set('x-tenant-slug', slug);
      return token ? r.set('authorization', `Bearer ${token}`) : r;
    },
    get: (url: string, token?: string) => {
      const r = http().get(url).set('x-tenant-slug', slug);
      return token ? r.set('authorization', `Bearer ${token}`) : r;
    },
    patch: (url: string, token?: string) => {
      const r = http().patch(url).set('x-tenant-slug', slug);
      return token ? r.set('authorization', `Bearer ${token}`) : r;
    },
    put: (url: string, token?: string) => {
      const r = http().put(url).set('x-tenant-slug', slug);
      return token ? r.set('authorization', `Bearer ${token}`) : r;
    },
  });
  return { t, investigator, auditor, reporter, tokens, api: as() };
}

const zeroSeconds = (d: Date) => d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

describe('criação e consulta pública', () => {
  it('anônima exige o aviso de identificação por conteúdo e não vincula usuário', async () => {
    const s = await setup();
    await s.api.post('/public/complaints').send(validReport({ contentWarningAcknowledged: false })).expect(400);

    // Mesmo com token válido no header, a anônima nunca grava createdBy.
    const res = await s.api.post('/public/complaints', s.tokens.rep).send(validReport()).expect(201);
    expect(res.body.protocol).toMatch(/^DEN-\d{4}-[A-Z0-9]{6}$/);
    expect(res.body.accessKey).toMatch(/^([A-Z0-9]{4}-){4}[A-Z0-9]{4}$/);

    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: res.body.protocol } });
    expect(row.createdBy).toBeNull();
    expect(row.status).toBe('PENDING');
    expect(row.accessKeyHash).toMatch(/^\$argon2id\$/);
    expect(row.accessKeyHash).not.toContain(res.body.accessKey);
    expect(row.reportedType).toBe('FRAUD');
    expect(row.integrityHash).toBe(
      reportIntegrityHash({
        title: row.title,
        description: row.description,
        reportedType: 'FRAUD',
        involvedPeople: row.involvedPeople,
        witnesses: [],
        incidentDate: null,
        location: null,
      }),
    );
  });

  it('valida entrada estrita: campo desconhecido, data futura, sem citado', async () => {
    const s = await setup();
    await s.api.post('/public/complaints').send(validReport({ createdBy: 'x' })).expect(400);
    await s.api.post('/public/complaints').send(validReport({ incidentDate: '2999-01-01' })).expect(400);
    await s.api.post('/public/complaints').send(validReport({ involvedPeople: [] })).expect(400);
    // Texto único é normalizado em lista.
    const ok = await s.api
      .post('/public/complaints')
      .send(validReport({ involvedPeople: 'Ana\nBeto', witnesses: 'Carla' }))
      .expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: ok.body.protocol } });
    expect(row.involvedPeople).toEqual(['Ana', 'Beto']);
    expect(row.witnesses).toEqual(['Carla']);
  });

  it('identificada exige login; anônima não', async () => {
    const s = await setup();
    await s.api.post('/public/complaints').send(validReport({ isAnonymous: false })).expect(401);
    const ok = await s.api
      .post('/public/complaints', s.tokens.rep)
      .send(validReport({ isAnonymous: false }))
      .expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: ok.body.protocol } });
    expect(row.createdBy).toBe(s.reporter.id);
  });

  it('consulta por protocolo+chave devolve só dados mínimos; erro é genérico e idêntico', async () => {
    const s = await setup();
    const c = await s.api.post('/public/complaints').send(validReport()).expect(201);

    const ok = await s.api
      .post('/public/complaints/lookup')
      .send({ protocol: c.body.protocol, accessKey: c.body.accessKey.toLowerCase().replace(/-/g, '') })
      .expect(200);
    expect(Object.keys(ok.body).sort()).toEqual(
      ['ackDueAt', 'canReportRetaliation', 'createdAt', 'feedbackDueAt', 'id', 'isAnonymous', 'priority', 'protocol', 'sessionToken', 'status', 'timeline', 'title', 'type', 'updatedAt'].sort(),
    );

    const wrongKey = await s.api
      .post('/public/complaints/lookup')
      .send({ protocol: c.body.protocol, accessKey: 'AAAA-AAAA-AAAA-AAAA-AAAA' })
      .expect(404);
    const noProtocol = await s.api
      .post('/public/complaints/lookup')
      .send({ protocol: 'DEN-2026-NADA00', accessKey: c.body.accessKey })
      .expect(404);
    expect(wrongKey.body).toEqual(noProtocol.body);
    expect(wrongKey.body.message).toBe('Protocolo ou chave inválidos');

    // Protocolo de um tenant não é consultável a partir de outro.
    const other = await createTenant(PASSWORD);
    await http()
      .post('/public/complaints/lookup')
      .set('x-tenant-slug', other.slug)
      .send({ protocol: c.body.protocol, accessKey: c.body.accessKey })
      .expect(404);
  });
});

describe('relato original imutável', () => {
  it('API e banco recusam alterar o relato; classificação e complementos são permitidos', async () => {
    const s = await setup();
    const c = await s.api.post('/public/complaints').send(validReport()).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: c.body.protocol } });

    for (const field of ['title', 'description', 'involvedPeople', 'reportedType', 'integrityHash']) {
      await s.api.patch(`/complaints/${row.id}`, s.tokens.admin).send({ [field]: 'x' }).expect(400);
    }
    // Trigger do banco: nem o dono do schema consegue reescrever o relato.
    await expect(
      owner.complaint.update({ where: { id: row.id }, data: { title: 'adulterado pelo dono' } }),
    ).rejects.toThrow(/imutável/);

    const patched = await s.api
      .patch(`/complaints/${row.id}`, s.tokens.inv)
      .send({ type: 'CORRUPTION', priority: 'HIGH', tags: ['nf'], reason: 'Indícios de pagamento indevido' })
      .expect(200);
    expect(patched.body.type).toBe('CORRUPTION');
    expect(patched.body.reportedType).toBe('FRAUD');

    const add = await s.api
      .post(`/complaints/${row.id}/addenda`, s.tokens.inv)
      .send({ content: 'Complemento apurado durante a triagem.' })
      .expect(201);
    expect(add.body.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    const after = await owner.complaint.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.title).toBe(row.title);
    expect(after.integrityHash).toBe(row.integrityHash);

    const audit = await owner.auditLog.findFirstOrThrow({
      where: { tenantId: s.t.tenantId, action: 'UPDATE', resourceId: row.id },
    });
    expect(JSON.stringify(audit.details)).toContain('CORRUPTION');
  });

  it('complementos e histórico são somente-inserção para a aplicação', async () => {
    const s = await setup();
    const c = await s.api.post('/public/complaints').send(validReport()).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: c.body.protocol } });
    const { runtime } = await import('./helpers');
    await expect(
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${s.t.tenantId}, true)`;
        return tx.complaintStatusHistory.deleteMany({ where: { complaintId: row.id } });
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('RBAC e atribuição', () => {
  it('perfis fora da matriz recebem 401/403', async () => {
    const s = await setup();
    const c = await s.api.post('/public/complaints').send(validReport()).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: c.body.protocol } });

    await s.api.get('/complaints').expect(401);
    await s.api.patch(`/complaints/${row.id}`, s.tokens.aud).send({ priority: 'LOW', reason: 'Ajuste de prioridade após triagem' }).expect(403);
    await s.api.post(`/complaints/${row.id}/comments`, s.tokens.aud).send({ content: 'x' }).expect(403);
    await s.api.post(`/complaints/${row.id}/assign`, s.tokens.inv).send({ investigatorId: s.investigator.id }).expect(403);
    await s.api.get('/audit', s.tokens.inv).expect(403);
    await s.api.get(`/complaints/${row.id}`, s.tokens.aud).expect(200);
  });

  it('REPORTER só vê as próprias denúncias (403 em alheia); anônima não aparece', async () => {
    const s = await setup();
    const mine = await s.api.post('/public/complaints', s.tokens.rep).send(validReport({ isAnonymous: false })).expect(201);
    const anon = await s.api.post('/public/complaints').send(validReport()).expect(201);
    const mineRow = await owner.complaint.findUniqueOrThrow({ where: { protocol: mine.body.protocol } });
    const anonRow = await owner.complaint.findUniqueOrThrow({ where: { protocol: anon.body.protocol } });

    const list = await s.api.get('/complaints', s.tokens.rep).expect(200);
    expect(list.body.data.map((d: { id: string }) => d.id)).toEqual([mineRow.id]);
    await s.api.get(`/complaints/${anonRow.id}`, s.tokens.rep).expect(403);
    await s.api.get(`/complaints/${mineRow.id}`, s.tokens.rep).expect(200);
    const staffList = await s.api.get('/complaints', s.tokens.admin).expect(200);
    expect(staffList.body.data.every((d: Record<string, unknown>) => !('accessKeyHash' in d))).toBe(true);
  });

  it('atribuição registra o status anterior REAL e recusa investigador inválido', async () => {
    const s = await setup();
    const c = await s.api.post('/public/complaints').send(validReport()).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: c.body.protocol } });
    await owner.complaint.update({ where: { id: row.id }, data: { status: 'UNDER_REVIEW' } });

    await s.api.post(`/complaints/${row.id}/assign`, s.tokens.admin).send({ investigatorId: s.auditor.id }).expect(400);
    await s.api.post(`/complaints/${row.id}/assign`, s.tokens.admin).send({ investigatorId: s.investigator.id }).expect(201);

    const hist = await owner.complaintStatusHistory.findMany({
      where: { complaintId: row.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(hist[0]).toMatchObject({ previousStatus: 'UNDER_REVIEW', newStatus: 'IN_PROGRESS' });
  });
});

describe('comentários com visibilidade', () => {
  it('REPORTER só lê os de visibilidade REPORTER, e só na própria denúncia', async () => {
    const s = await setup();
    const c = await s.api.post('/public/complaints', s.tokens.rep).send(validReport({ isAnonymous: false })).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: c.body.protocol } });
    await s.api.post(`/complaints/${row.id}/comments`, s.tokens.inv).send({ content: 'nota interna' }).expect(201);
    await s.api
      .post(`/complaints/${row.id}/comments`, s.tokens.inv)
      .send({ content: 'pergunta ao denunciante', visibility: 'REPORTER' })
      .expect(201);

    const rep = await s.api.get(`/complaints/${row.id}/comments`, s.tokens.rep).expect(200);
    expect(rep.body.map((x: { content: string }) => x.content)).toEqual(['pergunta ao denunciante']);
    const aud = await s.api.get(`/complaints/${row.id}/comments`, s.tokens.aud).expect(200);
    expect(aud.body).toHaveLength(2);

    const other = await makeUser(s.t.tenantId, 'REPORTER', 'rep2');
    const otherToken = await login(s.t.slug, other.email);
    await s.api.get(`/complaints/${row.id}/comments`, otherToken).expect(403);
  });
});

describe('suspensão manual de acesso', () => {
  it('bloqueia na hora, mensagem genérica, motivo fora da auditoria, último ADMIN protegido', async () => {
    const s = await setup();
    const reason = 'Afastamento cautelar decidido pelo RH em reunião';
    await s.api.post(`/users/${s.investigator.id}/block`, s.tokens.admin).send({ reason }).expect(201);

    // O token ainda válido (15 min) deixa de valer imediatamente.
    await s.api.get('/auth/me', s.tokens.inv).expect(401);
    const denied = await http()
      .post('/auth/login')
      .set('x-tenant-slug', s.t.slug)
      .send({ email: s.investigator.email, password: PASSWORD })
      .expect(403);
    expect(denied.body.message).toBe('Acesso suspenso. Contate o RH/administrador');
    expect(JSON.stringify(denied.body)).not.toContain('RH em reunião');

    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: s.t.tenantId, action: 'BLOCK' } });
    expect(JSON.stringify(audit, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('reunião');

    await s.api.post(`/users/${s.t.adminId}/block`, s.tokens.admin).send({ reason }).expect(409);
    await s.api.post(`/users/${s.investigator.id}/block`, s.tokens.inv).send({ reason }).expect(401);

    await s.api.post(`/users/${s.investigator.id}/unblock`, s.tokens.admin).expect(201);
    await login(s.t.slug, s.investigator.email);
    const u = await owner.user.findUniqueOrThrow({ where: { id: s.investigator.id } });
    expect(u.blockedReason).toBeNull();
  });
});

describe('configurações', () => {
  it('leitura pública só de chaves públicas; escrita só ADMIN; chave desconhecida recusada', async () => {
    const s = await setup();
    await s.api.put('/settings/companyEmail', s.tokens.admin).send({ value: 'contato@x.com' }).expect(200);
    await s.api.put('/settings/data_retention_days', s.tokens.admin).send({ value: '2555' }).expect(200);
    await s.api.put('/settings/inventada', s.tokens.admin).send({ value: '1' }).expect(400);
    await s.api.put('/settings/companyEmail', s.tokens.inv).send({ value: 'x@x.com' }).expect(403);

    const pub = await s.api.get('/public/settings').expect(200);
    expect(pub.body).toEqual({ companyEmail: 'contato@x.com' });
  });

  it('allowAnonymousComplaints=false exige identificação; maintenanceMode nunca bloqueia', async () => {
    const s = await setup();
    await s.api.put('/settings/maintenanceMode', s.tokens.admin).send({ value: 'true' }).expect(200);
    await s.api.post('/public/complaints').send(validReport()).expect(201);

    await s.api.put('/settings/allowAnonymousComplaints', s.tokens.admin).send({ value: 'false' }).expect(200);
    await s.api.post('/public/complaints').send(validReport()).expect(400);
    await s.api.post('/public/complaints', s.tokens.rep).send(validReport({ isAnonymous: false })).expect(201);
  });
});

describe('cadastro e política de senha', () => {
  it('rejeita senha fraca/comum, cria REPORTER, recusa e-mail duplicado', async () => {
    const s = await setup();
    const body = (password: string) => ({ email: 'novo@x.com', fullName: 'Novo Usuário', password });
    await s.api.post('/auth/register').send(body('curta')).expect(400);
    await s.api.post('/auth/register').send(body('senhasemsimbolo1A')).expect(400);
    await s.api.post('/auth/register').send(body('Password1')).expect(400);
    const ok = await s.api.post('/auth/register').send(body('Uma-Senha-Boa-42')).expect(201);
    expect(ok.body.accessToken).toBeTruthy();
    const u = await owner.user.findFirstOrThrow({ where: { tenantId: s.t.tenantId, email: 'novo@x.com' } });
    expect(u.role).toBe('REPORTER');
    await s.api.post('/auth/register').send(body('Uma-Senha-Boa-42')).expect(409);
  });
});

describe('auditoria: seq de eventos anônimos nunca é exposto', () => {
  it('mascara seq e horário fino nas consultas do tenant', async () => {
    const s = await setup();
    await s.api.post('/public/complaints').send(validReport()).expect(201);
    const res = await s.api.get('/audit?limit=100', s.tokens.aud).expect(200);
    const anon = res.body.data.filter((r: { anonymousOrigin: boolean }) => r.anonymousOrigin);
    const staff = res.body.data.filter((r: { anonymousOrigin: boolean }) => !r.anonymousOrigin);
    expect(anon.length).toBeGreaterThan(0);
    expect(anon.every((r: { seq: unknown }) => r.seq === null)).toBe(true);
    expect(anon.every((r: { ipAddress: unknown; userAgent: unknown; userId: unknown }) => r.ipAddress === null && r.userAgent === null && r.userId === null)).toBe(true);
    expect(staff.every((r: { seq: unknown }) => typeof r.seq === 'string')).toBe(true);
  });
});

describe('SUÍTE DE ACEITAÇÃO DO ANONIMATO (v1 — bloqueia release)', () => {
  const UA = 'AnonProbe/9.9 (marcador-unico-xyz-123)';
  const IPS = ['127.0.0.1', '::ffff:127.0.0.1', '"::1"'];
  const FILE_NAME = 'selfie-joao-silva-crachá.png';

  it('fluxo anônimo completo não deixa IP, UA, chave, vínculo nem horário fino em lugar algum', async () => {
    const t = await createTenant(PASSWORD); // tenant isolado: nenhum evento de equipe (que grava IP)
    const logs: string[] = [];
    const wOut = process.stdout.write.bind(process.stdout);
    const wErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => (logs.push(String(c)), true)) as never;
    process.stderr.write = ((c: string | Uint8Array) => (logs.push(String(c)), true)) as never;

    let protocol = '';
    let accessKey = '';
    const headers: Array<Record<string, unknown>> = [];
    try {
      const create = await http()
        .post('/public/complaints')
        .set('x-tenant-slug', t.slug)
        .set('user-agent', UA)
        .set('x-forwarded-for', '203.0.113.77')
        .send(validReport({ description: 'Relato anônimo para a suíte de aceitação do anonimato. '.repeat(2) }));
      expect(create.status).toBe(201);
      headers.push(create.headers);
      protocol = create.body.protocol;
      accessKey = create.body.accessKey;

      for (let i = 0; i < 2; i++) {
        const look = await http()
          .post('/public/complaints/lookup')
          .set('x-tenant-slug', t.slug)
          .set('user-agent', UA)
          .set('x-forwarded-for', '203.0.113.77')
          .send({ protocol, accessKey });
        expect(look.status).toBe(200);
        headers.push(look.headers);
      }
      await http()
        .post('/public/complaints/lookup')
        .set('x-tenant-slug', t.slug)
        .set('user-agent', UA)
        .send({ protocol, accessKey: 'ERRO-ERRO-ERRO-ERRO-ERRO' })
        .expect(404);

      // Canal seguro: mensagem, complemento, anexo (nome identificador) e leitura da conversa.
      const session = create.body.sessionToken as string;
      const channel = (method: 'get' | 'post', url: string) =>
        http()[method](url).set('x-tenant-slug', t.slug).set('user-agent', UA).set('x-forwarded-for', '203.0.113.77').set('authorization', `Bearer ${session}`);
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]);
      const m = await channel('post', '/public/channel/messages').send({ content: 'Mensagem do denunciante anônimo.' });
      const ad = await channel('post', '/public/channel/addenda').send({ content: 'Complemento do denunciante anônimo ao relato.' });
      const at = await channel('post', '/public/channel/attachments').attach('file', png, { filename: FILE_NAME, contentType: 'image/png' });
      expect([m.status, ad.status, at.status]).toEqual([201, 201, 201]);
      // Resposta do comitê (inserida direto: login de equipe gravaria IP no tenant e sujaria a varredura).
      const c0 = await owner.complaint.findUniqueOrThrow({ where: { protocol } });
      await owner.complaintMessage.create({ data: { tenantId: t.tenantId, complaintId: c0.id, direction: 'TO_REPORTER', authorId: t.adminId, content: 'Resposta do comitê.' } });
      const read = await channel('get', '/public/channel/messages');
      expect(read.status).toBe(200);
      headers.push(m.headers, ad.headers, at.headers, read.headers);
    } finally {
      process.stdout.write = wOut as never;
      process.stderr.write = wErr as never;
    }

    // 1) Nenhum cookie persistente.
    expect(headers.every((h) => h['set-cookie'] === undefined)).toBe(true);

    // 2) Varredura de TODAS as tabelas com dados do tenant.
    const tables = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`;
    expect(tables.length).toBeGreaterThanOrEqual(8);
    const dump: string[] = [];
    for (const { table_name } of tables) {
      const rows = await owner.$queryRawUnsafe<{ j: string }[]>(
        `SELECT to_jsonb(x)::text AS j FROM "${table_name}" x WHERE tenant_id = '${t.tenantId}'`,
      );
      dump.push(...rows.map((r) => r.j));
    }
    const everything = dump.join('\n');
    const plainKey = accessKey;
    const forbidden = [UA, 'marcador-unico', '203.0.113.77', ...IPS, plainKey, plainKey.replace(/-/g, ''), FILE_NAME, 'selfie', 'crach'];
    for (const needle of forbidden) expect(everything).not.toContain(needle);

    // 3) Logs da aplicação.
    const logText = logs.join('');
    for (const needle of forbidden) expect(logText).not.toContain(needle);

    // 4) Sem vínculo por createdBy; sem horário fino; sem IP/UA/usuário na auditoria anônima.
    const complaint = await owner.complaint.findUniqueOrThrow({ where: { protocol } });
    expect(complaint.createdBy).toBeNull();
    expect(zeroSeconds(complaint.createdAt) && zeroSeconds(complaint.updatedAt)).toBe(true);
    const history = await owner.complaintStatusHistory.findMany({ where: { complaintId: complaint.id } });
    expect(history.every((h) => zeroSeconds(h.createdAt))).toBe(true);

    // Mensagens e anexos do fluxo anônimo: horários ao minuto, sem autor do lado do denunciante.
    const msgs = await owner.complaintMessage.findMany({ where: { complaintId: complaint.id } });
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs.every((x) => zeroSeconds(x.createdAt) && (!x.readAt || zeroSeconds(x.readAt)))).toBe(true);
    const files = await owner.attachment.findMany({ where: { complaintId: complaint.id } });
    expect(files).toHaveLength(1);
    expect(zeroSeconds(files[0]!.uploadedAt)).toBe(true);
    expect(files[0]!.uploadedBy).toBeNull();
    // Storage: chave e tipo, nada do remetente.
    const storageDump = JSON.stringify([...(app.get(Storage) as MemoryStorage).objects.entries()].map(([k, v]) => [k, v.contentType]));
    for (const needle of forbidden) expect(storageDump).not.toContain(needle);

    const audits = await owner.auditLog.findMany({ where: { tenantId: t.tenantId } });
    const anon = audits.filter((a) => a.anonymousOrigin);
    expect(anon.length).toBeGreaterThanOrEqual(7); // criação, 2 consultas, mensagem, complemento, anexo, leitura do chat
    for (const a of anon) {
      expect(a.ipAddress).toBeNull();
      expect(a.userAgent).toBeNull();
      expect(a.userId).toBeNull();
      expect(zeroSeconds(a.timestamp)).toBe(true);
    }
    expect(audits.filter((a) => !a.anonymousOrigin)).toHaveLength(0);
  });

  it('o banco anula IP/UA e trunca o horário mesmo se a aplicação tentar gravá-los', async () => {
    const t = await createTenant(PASSWORD);
    const { runtime } = await import('./helpers');
    const row = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.tenantId}, true)`;
      return tx.auditLog.create({
        data: {
          tenantId: t.tenantId,
          action: 'CREATE',
          resource: 'complaint',
          anonymousOrigin: true,
          ipAddress: '10.0.0.9',
          userAgent: 'curl/8',
          userId: t.adminId,
          timestamp: new Date('2026-05-05T10:11:12.345Z'),
        },
      });
    });
    expect(row.ipAddress).toBeNull();
    expect(row.userAgent).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.timestamp.toISOString()).toBe('2026-05-05T10:11:00.000Z');
  });
});
