import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { FieldCipher } from '../src/crypto/field-cipher';
import { Mailer, OutboxMailer } from '../src/mail/mailer';
import { closeAll, createTenant, owner } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
const RECIPIENT = 'conselho@externo.com';
let app: INestApplication;
let passwordHash: string;
let mailer: OutboxMailer;

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  mailer = app.get(Mailer) as OutboxMailer;
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());

async function makeUser(tenantId: string, role: UserRole, tag: string, fullName = `Usuario ${tag}`) {
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const u = await owner.user.create({ data: { tenantId, email, fullName, passwordHash, role } });
  return { id: u.id, email, fullName };
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

function api(slug: string) {
  const mk = (method: 'get' | 'post' | 'put' | 'patch') => (url: string, token?: string) => {
    const r = http()[method](url).set('x-tenant-slug', slug);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  return { get: mk('get'), post: mk('post'), put: mk('put'), patch: mk('patch') };
}

/** Destinatário alternativo pronto: e-mail confirmado por link e TOTP enrolado (fluxo real). */
async function readyRecipient(a: ReturnType<typeof api>, adminToken: string): Promise<string> {
  const before = mailer.sent.length;
  await a.put('/onboarding/escalation-recipient', adminToken).send({ email: RECIPIENT }).expect(200);
  const mail = mailer.sent.slice(before).find((m) => m.to === RECIPIENT)!;
  const token = /token=([\w-]+)/.exec(mail.text)![1]!;
  const confirm = await a.post('/public/onboarding/escalation/confirm').send({ token }).expect(200);
  const secret = new URL(confirm.body.otpauthUri).searchParams.get('secret')!;
  await a.post('/public/onboarding/escalation/enroll').send({ token, code: authenticator.generate(secret) }).expect(200);
  return secret;
}

async function world(opts: { recipient?: boolean } = {}) {
  const t = await createTenant(PASSWORD);
  const adminB = await makeUser(t.tenantId, 'ADMIN', 'adminb', 'Beatriz Administradora');
  const inv1 = await makeUser(t.tenantId, 'INVESTIGATOR', 'inv1', 'Carlos Investigador');
  const inv2 = await makeUser(t.tenantId, 'INVESTIGATOR', 'inv2', 'Diana Investigadora');
  const aud = await makeUser(t.tenantId, 'AUDITOR', 'aud', 'Eduardo Auditor');
  const rep = await makeUser(t.tenantId, 'REPORTER', 'rep', 'Fabio Denunciante');
  const adminA = { id: t.adminId, email: t.adminEmail, fullName: 'Admin Teste' };
  const a = api(t.slug);
  const tok = {
    adminA: await login(t.slug, adminA.email),
    adminB: await login(t.slug, adminB.email),
    inv1: await login(t.slug, inv1.email),
    inv2: await login(t.slug, inv2.email),
    aud: await login(t.slug, aud.email),
    rep: await login(t.slug, rep.email),
  };
  const secret = opts.recipient === false ? null : await readyRecipient(a, tok.adminA);
  const complaint = async (over: Record<string, unknown> = {}, token?: string) => {
    const r = await a.post('/public/complaints', token).send(report(over)).expect(201);
    return owner.complaint.findUniqueOrThrow({ where: { protocol: r.body.protocol } });
  };
  return { t, a, adminA, adminB, inv1, inv2, aud, rep, tok, secret, complaint };
}

const zeroSeconds = (d: Date) => d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

describe('onboarding do destinatário alternativo', () => {
  it('exige e-mail confirmado por link e TOTP enrolado antes de ficar pronto', async () => {
    const w = await world({ recipient: false });
    expect((await w.a.get('/onboarding/status', w.tok.adminA).expect(200)).body).toEqual({
      ready: false,
      missing: ['escalationRecipient.configured'],
    });
    await w.a.put('/onboarding/escalation-recipient', w.tok.inv1).send({ email: RECIPIENT }).expect(403);

    await w.a.put('/onboarding/escalation-recipient', w.tok.adminA).send({ email: RECIPIENT }).expect(200);
    const mail = mailer.sent.filter((m) => m.to === RECIPIENT).pop()!;
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    expect((await w.a.get('/onboarding/status', w.tok.adminA)).body.missing).toEqual(['escalationRecipient.emailVerified']);

    await w.a.post('/public/onboarding/escalation/confirm').send({ token: 'x'.repeat(30) }).expect(401);
    const confirm = await w.a.post('/public/onboarding/escalation/confirm').send({ token }).expect(200);
    expect((await w.a.get('/onboarding/status', w.tok.adminA)).body.missing).toEqual(['escalationRecipient.secondFactor']);

    const secret = new URL(confirm.body.otpauthUri).searchParams.get('secret')!;
    await w.a.post('/public/onboarding/escalation/enroll').send({ token, code: '000000' }).expect(401);
    await w.a.post('/public/onboarding/escalation/enroll').send({ token, code: authenticator.generate(secret) }).expect(200);
    expect((await w.a.get('/onboarding/status', w.tok.adminA)).body).toEqual({ ready: true, missing: [] });

    // Trocar o destinatário zera a verificação.
    await w.a.put('/onboarding/escalation-recipient', w.tok.adminA).send({ email: 'outro@externo.com' }).expect(200);
    expect((await w.a.get('/onboarding/status', w.tok.adminA)).body.ready).toBe(false);
  });

  it('o segredo TOTP fica cifrado (não aparece em claro no banco)', async () => {
    const w = await world();
    const t = await owner.tenant.findUniqueOrThrow({ where: { id: w.t.tenantId } });
    expect(t.escalationTotpSecretEnc).toMatch(/^v2\./);
    expect(t.escalationTotpSecretEnc).not.toContain(w.secret!);
  });
});

describe('suspeita de conflito de interesses', () => {
  it('detecta citados por nome/e-mail sem alterar contas; horário fino nunca em caso anônimo', async () => {
    const w = await world();
    const c = await w.complaint({ involvedPeople: ['CARLOS  investigador', `contato: ${w.aud.email}`] });
    const flags = await owner.conflictFlag.findMany({ where: { complaintId: c.id }, orderBy: { matchType: 'asc' } });
    expect(flags.map((f) => [f.userId, f.matchType, f.status])).toEqual([
      [w.aud.id, 'EMAIL', 'PENDING'],
      [w.inv1.id, 'NAME', 'PENDING'],
    ]);
    expect(flags.every((f) => zeroSeconds(f.createdAt))).toBe(true);
    // A suspeita nunca toca a conta.
    const u = await owner.user.findUniqueOrThrow({ where: { id: w.inv1.id } });
    expect(u).toMatchObject({ isBlocked: false, isActive: true });
    await w.a.get('/auth/me', w.tok.inv1).expect(200);
  });

  it('suspeito pendente lê (com auditoria reforçada) mas não decide, não é atribuído e não recebe o caso', async () => {
    const w = await world();
    const c = await w.complaint({ involvedPeople: [w.adminB.fullName, w.inv1.fullName] });

    await w.a.get(`/complaints/${c.id}`, w.tok.adminB).expect(200);
    const audit = await owner.auditLog.findFirstOrThrow({
      where: { tenantId: w.t.tenantId, action: 'READ', resourceId: c.id, userId: w.adminB.id },
    });
    expect(audit.details).toEqual({ suspectPending: true });

    await w.a.patch(`/complaints/${c.id}`, w.tok.adminB).send({ priority: 'LOW', reason: 'Ajuste de prioridade após triagem' }).expect(403);
    await w.a.post(`/complaints/${c.id}/assign`, w.tok.adminB).send({ investigatorId: w.inv2.id }).expect(403);
    await w.a.post(`/complaints/${c.id}/restriction`, w.tok.adminB).send({ isRestricted: true }).expect(403);
    await w.a.post(`/complaints/${c.id}/comments`, w.tok.inv1).send({ content: 'x' }).expect(403);

    // Investigador suspeito não pode ser atribuído; o eleito pode.
    await w.a.post(`/complaints/${c.id}/assign`, w.tok.adminA).send({ investigatorId: w.inv1.id }).expect(400);
    await w.a.post(`/complaints/${c.id}/assign`, w.tok.adminA).send({ investigatorId: w.inv2.id }).expect(201);

    // O suspeito não decide a própria suspeita (nem a alheia enquanto está sob suspeita).
    const flags = await owner.conflictFlag.findMany({ where: { complaintId: c.id } });
    const own = flags.find((f) => f.userId === w.adminB.id)!;
    const other = flags.find((f) => f.userId === w.inv1.id)!;
    const body = { decision: 'DISMISSED', note: 'Homônimo, sem relação com o caso' };
    await w.a.post(`/conflicts/${own.id}/decide`, w.tok.adminB).send(body).expect(403);
    await w.a.post(`/conflicts/${other.id}/decide`, w.tok.adminB).send(body).expect(403);
    await w.a.post(`/conflicts/${other.id}/decide`, w.tok.inv1).send(body).expect(403);

    // Descartada: restrições liberadas.
    await w.a.post(`/conflicts/${own.id}/decide`, w.tok.adminA).send(body).expect(201);
    await w.a.patch(`/complaints/${c.id}`, w.tok.adminB).send({ priority: 'LOW', reason: 'Ajuste de prioridade após triagem' }).expect(200);
    await w.a.post(`/conflicts/${own.id}/decide`, w.tok.adminA).send(body).expect(409);
  });

  it('confirmada: perde o acesso, sai da lista e o caso é redistribuído', async () => {
    const w = await world();
    const c = await w.complaint({ involvedPeople: ['Alguém de Fora'] });
    await w.a.post(`/complaints/${c.id}/assign`, w.tok.adminA).send({ investigatorId: w.inv1.id }).expect(201);
    // Suspeita levantada depois da atribuição (ex.: novo dado).
    const flag = await owner.conflictFlag.create({
      data: { tenantId: w.t.tenantId, complaintId: c.id, userId: w.inv1.id, matchType: 'NAME' },
    });
    await w.a
      .post(`/conflicts/${flag.id}/decide`, w.tok.adminA)
      .send({ decision: 'CONFIRMED', note: 'Investigador é o citado, confirmado' })
      .expect(201);

    const after = await owner.complaint.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.investigatorId).toBe(w.inv2.id);
    await w.a.get(`/complaints/${c.id}`, w.tok.inv1).expect(404);
    const list = await w.a.get('/complaints', w.tok.inv1).expect(200);
    expect(list.body.data.map((d: { id: string }) => d.id)).not.toContain(c.id);
    await w.a.get(`/complaints/${c.id}`, w.tok.inv2).expect(200);
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, action: 'RECUSE' } })).toBe(1);
  });

  it('autodeclaração de impedimento: perde o acesso e redistribui; sem elegível volta a PENDING', async () => {
    const w = await world();
    const c = await w.complaint();
    await w.a.post(`/complaints/${c.id}/assign`, w.tok.adminA).send({ investigatorId: w.inv1.id }).expect(201);
    await w.a.post(`/complaints/${c.id}/recuse`, w.tok.inv1).send({ reason: 'Sou amigo próximo do citado' }).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.inv1).expect(404);
    await w.a.post(`/complaints/${c.id}/recuse`, w.tok.inv1).send({ reason: 'Sou amigo próximo do citado' }).expect(404);
    expect((await owner.complaint.findUniqueOrThrow({ where: { id: c.id } })).investigatorId).toBe(w.inv2.id);

    await w.a.post(`/complaints/${c.id}/recuse`, w.tok.inv2).send({ reason: 'Também tenho conflito aqui' }).expect(201);
    const last = await owner.complaint.findUniqueOrThrow({ where: { id: c.id } });
    expect(last).toMatchObject({ investigatorId: null, status: 'PENDING' });
    const hist = await owner.complaintStatusHistory.findFirstOrThrow({
      where: { complaintId: c.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(hist).toMatchObject({ previousStatus: 'IN_PROGRESS', newStatus: 'PENDING' });
  });
});

describe('ANTI-PARALISIA: todos os ADMINs citados', () => {
  it('roteia ao destinatário alternativo, que decide por link único + TOTP, só naquele caso', async () => {
    const w = await world();
    const c = await w.complaint({
      title: 'Titulo confidencial do caso',
      involvedPeople: ['Admin Teste', w.adminB.fullName],
    });
    const other = await w.complaint({ involvedPeople: ['Admin Teste'] }); // outro caso do mesmo tenant

    // 1) Ambos suspeitos e acesso externo acionado pelo sistema (horário ao minuto: caso anônimo).
    const flags = await owner.conflictFlag.findMany({ where: { complaintId: c.id } });
    expect(flags).toHaveLength(2);
    const access = await owner.externalAccess.findFirstOrThrow({ where: { complaintId: c.id } });
    expect(access.triggeredBy).toBe('SYSTEM');
    expect(zeroSeconds(access.createdAt)).toBe(true);

    // 2) E-mail: só protocolo e link, nenhum dado do caso.
    const mail = mailer.sent.filter((m) => m.to === RECIPIENT && m.text.includes(c.protocol)).pop()!;
    expect(mail.text).not.toContain('confidencial');
    expect(mail.text).not.toContain('fraude');
    expect(mail.text).not.toContain('Admin Teste');
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    const totp = () => authenticator.generate(w.secret!);

    // 3) Segundo fator obrigatório; erro genérico; link inexistente também.
    await w.a.post('/external/verify').send({ token, code: '000000' }).expect(401);
    await w.a.post('/external/verify').send({ token: 'z'.repeat(43), code: totp() }).expect(401);
    const session = await w.a.post('/external/verify').send({ token, code: totp() }).expect(201);
    const ext = session.body.accessToken as string;
    // Uso único: o mesmo link não abre outra sessão.
    await w.a.post('/external/verify').send({ token, code: totp() }).expect(401);

    // 4) Escopo de um caso: lê o relato; não usa nenhuma rota da equipe.
    const view = await w.a.get('/external/case', ext).expect(200);
    expect(view.body.id).toBe(c.id);
    expect(view.body).not.toHaveProperty('accessKeyHash');
    await w.a.get('/complaints', ext).expect(401);
    await w.a.get(`/complaints/${c.id}`, ext).expect(401);
    await w.a.get('/users', ext).expect(401);
    await w.a.get('/audit', ext).expect(401);
    await w.a.get('/external/case').expect(401);

    // 5) Decide as suspeitas do SEU caso; não as de outro caso.
    const otherFlag = await owner.conflictFlag.findFirstOrThrow({ where: { complaintId: other.id } });
    const decision = { decision: 'CONFIRMED', note: 'Ambos são citados; impedimento confirmado' };
    await w.a.post(`/external/conflicts/${otherFlag.id}/decide`, ext).send(decision).expect(404);
    for (const f of flags) await w.a.post(`/external/conflicts/${f.id}/decide`, ext).send(decision).expect(201);

    // 6) Os ADMINs perdem o caso; ele some das listas deles.
    await w.a.get(`/complaints/${c.id}`, w.tok.adminA).expect(404);
    await w.a.get(`/complaints/${c.id}`, w.tok.adminB).expect(404);
    const list = await w.a.get('/complaints', w.tok.adminA).expect(200);
    expect(list.body.data.map((d: { id: string }) => d.id)).not.toContain(c.id);

    // 7) Sem novo e-mail (o acesso vigente é reaproveitado) e o destinatário atribui investigador.
    const mailsForCase = mailer.sent.filter((m) => m.text.includes(c.protocol));
    expect(mailsForCase).toHaveLength(1);
    const invs = await w.a.get('/external/investigators', ext).expect(200);
    expect(invs.body.map((i: { id: string }) => i.id).sort()).toEqual([w.inv1.id, w.inv2.id].sort());
    await w.a.post('/external/assign', ext).send({ investigatorId: w.inv1.id }).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.inv1).expect(200);

    // 8) Tudo auditado com IP (o destinatário é identificado) e sem PII.
    const audits = await owner.auditLog.findMany({ where: { tenantId: w.t.tenantId, action: 'EXTERNAL_ACCESS' } });
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.some((a) => a.ipAddress !== null && !a.anonymousOrigin)).toBe(true);
    const used = await owner.externalAccess.findUniqueOrThrow({ where: { id: access.id } });
    expect(used.usedCount).toBe(1);
    expect(used.failedAttempts).toBe(1);
  });

  it('5 códigos errados revogam o link; expirado e revogado por ADMIN também não abrem', async () => {
    const w = await world();
    const c = await w.complaint({ involvedPeople: ['Admin Teste', w.adminB.fullName] });
    const mail = mailer.sent.filter((m) => m.text.includes(c.protocol)).pop()!;
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    for (let i = 0; i < 5; i++) await w.a.post('/external/verify').send({ token, code: '111111' }).expect(401);
    // Depois de revogado, nem o código certo funciona.
    await w.a.post('/external/verify').send({ token, code: authenticator.generate(w.secret!) }).expect(401);
    expect((await owner.externalAccess.findFirstOrThrow({ where: { complaintId: c.id } })).revokedAt).not.toBeNull();

    // Expirado.
    const c2 = await w.complaint({ involvedPeople: ['Admin Teste', w.adminB.fullName] });
    const mail2 = mailer.sent.filter((m) => m.text.includes(c2.protocol)).pop()!;
    const token2 = /token=([\w-]+)/.exec(mail2.text)![1]!;
    await owner.externalAccess.updateMany({ where: { complaintId: c2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await w.a.post('/external/verify').send({ token: token2, code: authenticator.generate(w.secret!) }).expect(401);
  });

  it('ADMIN não suspeito aciona e revoga o acesso externo; sessão aberta cai na hora', async () => {
    const w = await world();
    const c = await w.complaint();
    await w.a.post(`/complaints/${c.id}/external-access`, w.tok.inv1).send({ reason: 'Preciso de parecer externo' }).expect(403);
    await w.a.post(`/complaints/${c.id}/external-access`, w.tok.adminA).send({ reason: 'Preciso de parecer externo' }).expect(201);
    const mail = mailer.sent.filter((m) => m.text.includes(c.protocol)).pop()!;
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    const s = await w.a.post('/external/verify').send({ token, code: authenticator.generate(w.secret!) }).expect(201);
    await w.a.get('/external/case', s.body.accessToken).expect(200);

    const access = await owner.externalAccess.findFirstOrThrow({ where: { complaintId: c.id } });
    expect(access.triggeredBy).toBe(w.adminA.id);
    await w.a.post(`/complaints/${c.id}/external-access/${access.id}/revoke`, w.tok.adminA).expect(201);
    await w.a.get('/external/case', s.body.accessToken).expect(401);
  });

  it('sem destinatário verificado a denúncia é registrada mesmo assim e o problema fica auditado', async () => {
    const w = await world({ recipient: false });
    const c = await w.complaint({ involvedPeople: ['Admin Teste', w.adminB.fullName] });
    expect(await owner.externalAccess.count({ where: { complaintId: c.id } })).toBe(0);
    expect(await owner.conflictFlag.count({ where: { complaintId: c.id, status: 'PENDING' } })).toBe(2);
    const audit = await owner.auditLog.findFirstOrThrow({
      where: { tenantId: w.t.tenantId, action: 'EXTERNAL_ACCESS' },
    });
    expect(JSON.stringify(audit.details)).toContain('unavailable');
  });
});

describe('casos restritos e concessões', () => {
  it('só ADMIN, investigador atribuído e concessão vigente enxergam o caso', async () => {
    const w = await world();
    await w.a.put('/settings/restrictedTypes', w.tok.adminA).send({ value: 'HARASSMENT, CORRUPTION' }).expect(200);
    const c = await w.complaint({ type: 'HARASSMENT' });
    expect(c.isRestricted).toBe(true);
    const open = await w.complaint({ type: 'FRAUD' });
    expect(open.isRestricted).toBe(false);

    for (const t of [w.tok.inv1, w.tok.aud]) {
      await w.a.get(`/complaints/${c.id}`, t).expect(404);
      const list = await w.a.get('/complaints', t).expect(200);
      expect(list.body.data.map((d: { id: string }) => d.id)).toEqual([open.id]);
    }
    await w.a.get(`/complaints/${c.id}`, w.tok.adminB).expect(200);

    await w.a.post(`/complaints/${c.id}/assign`, w.tok.adminA).send({ investigatorId: w.inv1.id }).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.inv1).expect(200);
    await w.a.get(`/complaints/${c.id}`, w.tok.inv2).expect(404);

    // Concessão com validade; REPORTER não pode receber; revogada/expirada => some.
    const future = new Date(Date.now() + 86400_000).toISOString();
    await w.a.post(`/complaints/${c.id}/access-grants`, w.tok.adminA).send({ userId: w.rep.id, reason: 'Acompanhamento do caso', expiresAt: future }).expect(400);
    await w.a.post(`/complaints/${c.id}/access-grants`, w.tok.inv1).send({ userId: w.aud.id, reason: 'Acompanhamento do caso', expiresAt: future }).expect(403);
    const g = await w.a.post(`/complaints/${c.id}/access-grants`, w.tok.adminA).send({ userId: w.aud.id, reason: 'Acompanhamento do caso', expiresAt: future }).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.aud).expect(200);
    await w.a.post(`/complaints/${c.id}/access-grants/${g.body.id}/revoke`, w.tok.adminA).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.aud).expect(404);

    const g2 = await w.a.post(`/complaints/${c.id}/access-grants`, w.tok.adminA).send({ userId: w.inv2.id, reason: 'Apoio técnico ao caso', expiresAt: future }).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.inv2).expect(200);
    await owner.complaintAccessGrant.update({ where: { id: g2.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await w.a.get(`/complaints/${c.id}`, w.tok.inv2).expect(404);
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, action: 'ACCESS_GRANT' } })).toBe(3);
  });

  it('ADMIN marca/libera restrição; demais perfis não', async () => {
    const w = await world();
    const c = await w.complaint();
    await w.a.post(`/complaints/${c.id}/restriction`, w.tok.inv1).send({ isRestricted: true }).expect(403);
    await w.a.post(`/complaints/${c.id}/restriction`, w.tok.adminA).send({ isRestricted: true }).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.aud).expect(404);
    await w.a.post(`/complaints/${c.id}/restriction`, w.tok.adminA).send({ isRestricted: false }).expect(201);
    await w.a.get(`/complaints/${c.id}`, w.tok.aud).expect(200);
  });
});

describe('identidade do denunciante (quebra de vidro)', () => {
  const contact = { reporterName: 'Fabio Denunciante', reporterEmail: 'fabio.real@empresa.com', reporterPhone: '+55 11 99999-0000' };

  it('PII cifrada por tenant, oculta por padrão; revelação só com justificativa e auditada', async () => {
    const w = await world();
    const c = await w.complaint({ isAnonymous: false, contentWarningAcknowledged: undefined, ...contact }, w.tok.rep);

    // Em repouso: só texto cifrado, nada em claro.
    const dump = JSON.stringify(await owner.$queryRaw`SELECT to_jsonb(c)::text FROM complaints c WHERE id = ${c.id}::uuid`);
    expect(dump).not.toContain('fabio.real@empresa.com');
    expect(dump).not.toContain('99999-0000');
    expect(c.reporterEmailEnc).toMatch(/^v2\.1\./);

    // Detalhe e listagem nunca trazem a PII.
    const detail = await w.a.get(`/complaints/${c.id}`, w.tok.adminA).expect(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/fabio\.real|reporter(Name|Email|Phone)/);

    const just = { justification: 'Preciso confirmar detalhes do relato com o denunciante' };
    await w.a.post(`/complaints/${c.id}/reveal-identity`, w.tok.inv1).send(just).expect(403); // não atribuído
    await w.a.post(`/complaints/${c.id}/reveal-identity`, w.tok.aud).send(just).expect(403);
    await w.a.post(`/complaints/${c.id}/reveal-identity`, w.tok.adminA).send({ justification: 'curta' }).expect(400);

    const ok = await w.a.post(`/complaints/${c.id}/reveal-identity`, w.tok.adminA).send(just).expect(201);
    expect(ok.body).toEqual({ name: contact.reporterName, email: contact.reporterEmail, phone: contact.reporterPhone });
    expect(await owner.identityReveal.count({ where: { complaintId: c.id, userId: w.adminA.id } })).toBe(1);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.t.tenantId, action: 'REVEAL_IDENTITY' } });
    expect(JSON.stringify(audit.details ?? {})).not.toContain('fabio');

    // Investigador atribuído também pode.
    await w.a.post(`/complaints/${c.id}/assign`, w.tok.adminA).send({ investigatorId: w.inv1.id }).expect(201);
    await w.a.post(`/complaints/${c.id}/reveal-identity`, w.tok.inv1).send(just).expect(201);
  });

  it('anônima não aceita nem revela identidade; suspeito pendente não revela; cifra é presa ao tenant', async () => {
    const w = await world();
    await w.a.post('/public/complaints').send(report({ reporterEmail: 'x@y.com' })).expect(400);
    const anon = await w.complaint();
    await w.a.post(`/complaints/${anon.id}/reveal-identity`, w.tok.adminA).send({ justification: 'Justificativa com mais de vinte caracteres' }).expect(400);

    const c = await w.complaint({ isAnonymous: false, contentWarningAcknowledged: undefined, involvedPeople: [w.adminB.fullName], ...contact }, w.tok.rep);
    await w.a.post(`/complaints/${c.id}/reveal-identity`, w.tok.adminB).send({ justification: 'Justificativa com mais de vinte caracteres' }).expect(403);

    const cipher = app.get(FieldCipher);
    const other = await createTenant(PASSWORD);
    await expect(cipher.decrypt(other.tenantId, c.reporterEmailEnc!)).rejects.toThrow();
    expect(await cipher.decrypt(w.t.tenantId, c.reporterEmailEnc!)).toBe(contact.reporterEmail);
  });

  it('o ADMIN impedido não revela nem vê o caso', async () => {
    const w = await world();
    const c = await w.complaint({ isAnonymous: false, contentWarningAcknowledged: undefined, ...contact }, w.tok.rep);
    await w.a.post(`/complaints/${c.id}/recuse`, w.tok.adminB).send({ reason: 'Conheço o denunciante pessoalmente' }).expect(201);
    await w.a.post(`/complaints/${c.id}/reveal-identity`, w.tok.adminB).send({ justification: 'Justificativa com mais de vinte caracteres' }).expect(404);
  });
});
