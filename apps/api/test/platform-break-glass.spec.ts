import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PlatformRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { closeAll, createComplaint, createTenant, owner, platform } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
const REASON = 'Cliente relatou que o relato não abre no painel e pediu ajuda (chamado aberto).';
let app: INestApplication;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const as = (token: string) => ({ authorization: `Bearer ${token}` });

/** Operador pelo fluxo real (senha → cadastro do 2º fator). `next()` devolve um código de um passo AINDA NÃO USADO. */
async function makeOperator(role: PlatformRole) {
  const email = `op-${role.toLowerCase()}-${uniq()}@ouvion.com`;
  const u = await owner.platformUser.create({ data: { email, fullName: `Operador ${role} ${uniq()}`, role, passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } });
  const login = await http().post('/platform/auth/login').send({ email, password: PASSWORD }).expect(200);
  const enrollToken = login.body.enrollToken as string;
  const enroll = await http().post('/platform/auth/mfa/enroll').send({ enrollToken }).expect(200);
  const secret = new URL(enroll.body.otpauthUri).searchParams.get('secret')!;
  const act = await http().post('/platform/auth/mfa/activate').send({ enrollToken, code: authenticator.generate(secret) }).expect(200);
  // O código do login já gastou o passo atual: o seguinte (dentro da janela de ±1) ainda vale.
  const next = () => authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret);
  return { id: u.id, fullName: u.fullName, token: act.body.session.accessToken as string, next };
}

async function scenario() {
  const t = await createTenant(PASSWORD);
  const complaintId = await createComplaint(t.tenantId, 'Título sigiloso do relato 4242');
  const complaint = await owner.complaint.findUniqueOrThrow({ where: { id: complaintId } });
  const support = await makeOperator('SUPPORT');
  const approver = await makeOperator('SUPER_ADMIN');
  const body = { tenantId: t.tenantId, scope: 'COMPLAINT', protocol: complaint.protocol, reason: REASON, ticketRef: 'CHAM-1234' };
  return { t, complaintId, protocol: complaint.protocol, support, approver, body };
}

/** Pedido já aprovado (janela de 30 min) para os testes de uso. */
async function approved() {
  const s = await scenario();
  const created = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
  await http().post(`/platform/break-glass/${created.body.id}/approve`).set(as(s.approver.token)).send({ minutes: 30, code: s.approver.next() }).expect(200);
  return { ...s, id: created.body.id as string };
}

describe('solicitação', () => {
  it('SUPPORT e SUPER_ADMIN pedem; FINANCIAL não; item inexistente e motivo curto são recusados; trilha nos dois lados', async () => {
    const s = await scenario();
    const financial = await makeOperator('FINANCIAL');
    await http().post('/platform/break-glass').set(as(financial.token)).send(s.body).expect(403);
    await http().post('/platform/break-glass').set(as(s.support.token)).send({ ...s.body, protocol: 'DEN-0000-NAOEXISTE' }).expect(404);
    await http().post('/platform/break-glass').set(as(s.support.token)).send({ ...s.body, reason: 'curto' }).expect(400);
    await http().post('/platform/break-glass').set(as(s.support.token)).send({ ...s.body, scope: 'ATTACHMENT' }).expect(400); // sem nome do arquivo

    // O protocolo de OUTRA empresa não resolve nesta.
    const other = await createTenant(PASSWORD);
    const otherComplaint = await owner.complaint.findUniqueOrThrow({ where: { id: await createComplaint(other.tenantId) } });
    await http().post('/platform/break-glass').set(as(s.support.token)).send({ ...s.body, protocol: otherComplaint.protocol }).expect(404);

    const ok = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
    expect(ok.body.status).toBe('PENDING');
    const pl = await owner.platformAuditLog.findFirstOrThrow({ where: { action: 'BREAK_GLASS_REQUESTED', resourceId: ok.body.id } });
    expect(pl).toMatchObject({ severity: 'HIGH', actorId: s.support.id, tenantId: s.t.tenantId });
    const tl = await owner.auditLog.findFirstOrThrow({ where: { tenantId: s.t.tenantId, action: 'BREAK_GLASS_PLATFORM', resourceId: ok.body.id } });
    expect(tl.details).toMatchObject({ phase: 'requested', scope: 'COMPLAINT', target: s.protocol });
    expect(JSON.stringify(tl.details)).not.toContain('sigiloso'); // a trilha do cliente nunca leva conteúdo
  });

  it('SUPPORT vê só os próprios pedidos; SUPER_ADMIN vê todos', async () => {
    const s = await scenario();
    const other = await makeOperator('SUPPORT');
    const mine = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
    const theirs = await http().post('/platform/break-glass').set(as(other.token)).send(s.body).expect(201);
    const listMine = (await http().get('/platform/break-glass').set(as(s.support.token)).expect(200)).body as Array<{ id: string }>;
    expect(listMine.map((r) => r.id)).toContain(mine.body.id);
    expect(listMine.map((r) => r.id)).not.toContain(theirs.body.id);
    await http().get(`/platform/break-glass/${theirs.body.id}`).set(as(s.support.token)).expect(404);
    const all = (await http().get('/platform/break-glass').set(as(s.approver.token)).expect(200)).body as Array<{ id: string }>;
    expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([mine.body.id, theirs.body.id]));
  });
});

describe('aprovação', () => {
  it('sem aprovação não há leitura; quem pediu não aprova; exige 2º SUPER_ADMIN com código NOVO; janela de no máximo 1 h', async () => {
    const s = await scenario();
    const created = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
    const id = created.body.id as string;

    await http().post(`/platform/break-glass/${id}/read`).set(as(s.support.token)).expect(409); // ainda pendente
    await http().post(`/platform/break-glass/${id}/approve`).set(as(s.support.token)).send({ minutes: 30, code: s.support.next() }).expect(403); // SUPPORT não aprova

    // SUPER_ADMIN que pediu não aprova o próprio pedido.
    const selfReq = await http().post('/platform/break-glass').set(as(s.approver.token)).send(s.body).expect(201);
    await http().post(`/platform/break-glass/${selfReq.body.id}/approve`).set(as(s.approver.token)).send({ minutes: 30, code: s.approver.next() }).expect(403);

    await http().post(`/platform/break-glass/${id}/approve`).set(as(s.approver.token)).send({ minutes: 61, code: s.approver.next() }).expect(400); // > 1 h
    await http().post(`/platform/break-glass/${id}/approve`).set(as(s.approver.token)).send({ minutes: 30, code: '000000' }).expect(401); // código errado
    const code = s.approver.next();
    const ok = await http().post(`/platform/break-glass/${id}/approve`).set(as(s.approver.token)).send({ minutes: 30, code }).expect(200);
    const msLeft = new Date(ok.body.expiresAt).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(29 * 60_000);
    expect(msLeft).toBeLessThanOrEqual(30 * 60_000);
    // O mesmo código não vale outra vez (e o pedido já foi decidido).
    await http().post(`/platform/break-glass/${id}/approve`).set(as(s.approver.token)).send({ minutes: 30, code }).expect(401);
    const dec = await owner.breakGlassRequest.findUniqueOrThrow({ where: { id } });
    expect(dec).toMatchObject({ status: 'APPROVED', approvedBy: s.approver.id });
  });

  it('avisa os ADMIN da empresa NA HORA (in-app crítico + e-mail) com motivo e quem acessou, e audita nos dois lados', async () => {
    const s = await scenario();
    const created = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
    await http().post(`/platform/break-glass/${created.body.id}/approve`).set(as(s.approver.token)).send({ minutes: 20, code: s.approver.next() }).expect(200);

    const notes = await owner.notification.findMany({ where: { tenantId: s.t.tenantId, type: 'BREAK_GLASS_ACCESS' } });
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]).toMatchObject({ inApp: true, emailPending: true });
    expect(notes[0]!.message).toContain(REASON);
    expect(notes[0]!.message).toContain(s.support.fullName);
    expect(notes[0]!.message).toContain(s.approver.fullName);
    expect(notes[0]!.message).toContain(s.protocol);
    expect(notes[0]!.message).not.toContain('sigiloso');

    const admins = await owner.user.count({ where: { tenantId: s.t.tenantId, role: 'ADMIN', isActive: true } });
    expect(notes).toHaveLength(admins);

    const pl = await owner.platformAuditLog.findFirstOrThrow({ where: { action: 'BREAK_GLASS_APPROVED', resourceId: created.body.id } });
    expect(pl).toMatchObject({ severity: 'CRITICAL', actorId: s.approver.id });
    const tl = await owner.auditLog.findFirstOrThrow({ where: { tenantId: s.t.tenantId, action: 'BREAK_GLASS_PLATFORM', resourceId: created.body.id, details: { path: ['phase'], equals: 'approved' } } });
    expect(tl.details).toMatchObject({ requestedBy: s.support.fullName, approvedBy: s.approver.fullName, reason: REASON });
  });

  it('o ADMIN da empresa enxerga o registro na PRÓPRIA auditoria (transparência)', async () => {
    const s = await approved();
    const login = await http().post('/auth/login').set('x-tenant-slug', s.t.slug).send({ email: s.t.adminEmail, password: PASSWORD }).expect(201);
    const res = await http().get('/audit?action=BREAK_GLASS_PLATFORM').set({ 'x-tenant-slug': s.t.slug, ...as(login.body.accessToken) }).expect(200);
    const phases = (res.body.data as Array<{ details: { phase: string } }>).map((r) => r.details.phase);
    expect(phases).toEqual(expect.arrayContaining(['requested', 'approved']));
  });

  it('recusa exige motivo; pedido recusado não abre nada', async () => {
    const s = await scenario();
    const created = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
    const id = created.body.id as string;
    await http().post(`/platform/break-glass/${id}/deny`).set(as(s.approver.token)).send({ reason: 'curto' }).expect(400);
    await http().post(`/platform/break-glass/${id}/deny`).set(as(s.support.token)).send({ reason: 'Suporte tentando recusar.' }).expect(403);
    await http().post(`/platform/break-glass/${id}/deny`).set(as(s.approver.token)).send({ reason: 'Chamado sem justificativa suficiente.' }).expect(200);
    await http().post(`/platform/break-glass/${id}/read`).set(as(s.support.token)).expect(409);
    await http().post(`/platform/break-glass/${id}/approve`).set(as(s.approver.token)).send({ minutes: 30, code: s.approver.next() }).expect(409);
    expect((await owner.platformAuditLog.findFirstOrThrow({ where: { action: 'BREAK_GLASS_DENIED', resourceId: id } })).severity).toBe('MEDIUM');
  });
});

describe('uso do acesso', () => {
  it('só quem pediu lê; o conteúdo vem SEM identidade do denunciante; cada abertura é auditada (plataforma CRITICAL + empresa)', async () => {
    const s = await approved();
    await http().post(`/platform/break-glass/${s.id}/read`).set(as(s.approver.token)).expect(403); // o aprovador não usa o acesso

    const res = await http().post(`/platform/break-glass/${s.id}/read`).set(as(s.support.token)).expect(200);
    expect(res.body).toMatchObject({ kind: 'COMPLAINT', protocol: s.protocol, title: 'Título sigiloso do relato 4242' });
    const dump = JSON.stringify(res.body);
    expect(dump).not.toMatch(/reporter|accessKey|passwordHash|message|comment/i); // nada de identidade, chave, mensagens, comentários

    await http().post(`/platform/break-glass/${s.id}/read`).set(as(s.support.token)).expect(200); // 2ª abertura = 2º registro
    const uses = await owner.breakGlassUse.count({ where: { requestId: s.id } });
    expect(uses).toBe(2);
    const pl = await owner.platformAuditLog.findMany({ where: { action: 'BREAK_GLASS_USED', resourceId: s.id } });
    expect(pl).toHaveLength(2);
    expect(pl[0]).toMatchObject({ severity: 'CRITICAL', actorId: s.support.id, tenantId: s.t.tenantId });
    const tl = await owner.auditLog.findMany({ where: { tenantId: s.t.tenantId, action: 'BREAK_GLASS_PLATFORM', resourceId: s.id, details: { path: ['phase'], equals: 'used' } } });
    expect(tl).toHaveLength(2);
    expect(tl[0]!.details).toMatchObject({ usedBy: s.support.fullName, target: s.protocol });
  });

  it('a janela TERMINA sozinha e não há prorrogação: novo acesso exige novo pedido', async () => {
    const s = await approved();
    await http().post(`/platform/break-glass/${s.id}/read`).set(as(s.support.token)).expect(200);
    await owner.breakGlassRequest.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); // simula o fim da janela

    const late = await http().post(`/platform/break-glass/${s.id}/read`).set(as(s.support.token)).expect(409);
    expect(late.body.message).toContain('janela');
    const view = await http().get(`/platform/break-glass/${s.id}`).set(as(s.support.token)).expect(200);
    expect(view.body.state).toBe('EXPIRED');
    // Não dá para "prorrogar": aprovar de novo o mesmo pedido é recusado (outro aprovador, pois cada código vale um passo só).
    const second = await makeOperator('SUPER_ADMIN');
    await http().post(`/platform/break-glass/${s.id}/approve`).set(as(second.token)).send({ minutes: 60, code: second.next() }).expect(409);
    // Um pedido novo cria novo registro.
    const again = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
    expect(again.body.id).not.toBe(s.id);
  });

  it('SUPER_ADMIN pode revogar antes do fim; depois disso a leitura falha e a empresa é avisada na trilha', async () => {
    const s = await approved();
    await http().post(`/platform/break-glass/${s.id}/revoke`).set(as(s.support.token)).send({ reason: 'Suporte não revoga.' }).expect(403);
    await http().post(`/platform/break-glass/${s.id}/revoke`).set(as(s.approver.token)).send({ reason: 'Problema resolvido, acesso não é mais necessário.' }).expect(200);
    await http().post(`/platform/break-glass/${s.id}/read`).set(as(s.support.token)).expect(409);
    const tl = await owner.auditLog.findFirst({ where: { tenantId: s.t.tenantId, action: 'BREAK_GLASS_PLATFORM', resourceId: s.id, details: { path: ['phase'], equals: 'revoked' } } });
    expect(tl).not.toBeNull();
  });

  it('anexo: escopo de UM arquivo, link temporário sem expor a chave do objeto; arquivo não verificado não abre', async () => {
    const s = await scenario();
    const mk = (filename: string, scanStatus: 'CLEAN' | 'PENDING') =>
      owner.attachment.create({
        data: { tenantId: s.t.tenantId, complaintId: s.complaintId, filename, mimeType: 'application/pdf', detectedMime: 'application/pdf', size: 1234, s3Key: `k/${uniq()}`, s3Bucket: 'memory', sha256Hash: 'a'.repeat(64), scanStatus },
      });
    await mk('prova.pdf', 'CLEAN');
    await mk('pendente.pdf', 'PENDING');
    const ask = (filename: string) => http().post('/platform/break-glass').set(as(s.support.token)).send({ ...s.body, scope: 'ATTACHMENT', filename });
    await ask('nao-existe.pdf').expect(404);

    const clean = await ask('prova.pdf').expect(201);
    await http().post(`/platform/break-glass/${clean.body.id}/approve`).set(as(s.approver.token)).send({ minutes: 15, code: s.approver.next() }).expect(200);
    const res = await http().post(`/platform/break-glass/${clean.body.id}/read`).set(as(s.support.token)).expect(200);
    expect(res.body).toMatchObject({ kind: 'ATTACHMENT', filename: 'prova.pdf', expiresInSeconds: 300 });
    expect(res.body.url).toContain('expires=300');
    expect(JSON.stringify(res.body)).not.toMatch(/s3Key|s3Bucket/);

    const pending = await ask('pendente.pdf').expect(201);
    const second = await makeOperator('SUPER_ADMIN');
    await http().post(`/platform/break-glass/${pending.body.id}/approve`).set(as(second.token)).send({ minutes: 15, code: second.next() }).expect(200);
    await http().post(`/platform/break-glass/${pending.body.id}/read`).set(as(s.support.token)).expect(409);
  });
});

describe('garantias no BANCO (mesmo com SQL direto)', () => {
  it('o papel da plataforma não aprova nem lê por fora das funções, e as funções conferem aprovador e dono', async () => {
    const s = await scenario();
    const created = await http().post('/platform/break-glass').set(as(s.support.token)).send(s.body).expect(201);
    const id = created.body.id as string;

    // Sem GRANT de escrita: não dá para se auto-aprovar por UPDATE.
    await expect(platform.$executeRawUnsafe(`UPDATE break_glass_requests SET status = 'APPROVED', expires_at = now() + interval '1 day' WHERE id = '${id}'`)).rejects.toThrow(/permission denied/);
    await expect(platform.$executeRawUnsafe(`INSERT INTO break_glass_uses (request_id, used_by) VALUES ('${id}', '${s.support.id}')`)).rejects.toThrow(/permission denied/);
    await expect(platform.$queryRawUnsafe('SELECT count(*) FROM complaints')).rejects.toThrow(/permission denied/);

    // Chamando a função direto: o próprio solicitante não aprova, nem com janela absurda, nem lê pedido pendente.
    await expect(platform.$queryRawUnsafe(`SELECT * FROM platform_bg_approve('${id}', '${s.support.id}', 30)`)).rejects.toThrow(/diferente de quem pediu/);
    await expect(platform.$queryRawUnsafe(`SELECT * FROM platform_bg_approve('${id}', '${s.approver.id}', 600)`)).rejects.toThrow(/5 a 60/);
    await expect(platform.$queryRawUnsafe(`SELECT platform_bg_read('${id}', '${s.support.id}')`)).rejects.toThrow(/não está ativo/);
    // Um SUPPORT nunca aprova (a função exige SUPER_ADMIN ativo).
    const other = await makeOperator('SUPPORT');
    await expect(platform.$queryRawUnsafe(`SELECT * FROM platform_bg_approve('${id}', '${other.id}', 30)`)).rejects.toThrow(/aprovador inválido/);
    // Sem uso, sem registro de uso.
    expect(await owner.breakGlassUse.count({ where: { requestId: id } })).toBe(0);
  });
});
