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
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Cria um operador e o leva pelo fluxo REAL: senha → cadastro do 2º fator → sessão. */
async function makeOperator(role: PlatformRole) {
  const email = `op-${role.toLowerCase()}-${uniq()}@ouvion.com`;
  const u = await owner.platformUser.create({ data: { email, fullName: `Operador ${role}`, role, passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } });
  const login = await http().post('/platform/auth/login').send({ email, password: PASSWORD }).expect(200);
  expect(login.body.mfaEnrollmentRequired).toBe(true);
  const enrollToken = login.body.enrollToken as string;
  const enroll = await http().post('/platform/auth/mfa/enroll').send({ enrollToken }).expect(200);
  const secret = new URL(enroll.body.otpauthUri).searchParams.get('secret')!;
  const code = authenticator.generate(secret);
  const act = await http().post('/platform/auth/mfa/activate').send({ enrollToken, code }).expect(200);
  return { id: u.id, email, secret, code, recoveryCodes: act.body.recoveryCodes as string[], token: act.body.session.accessToken as string, refresh: act.body.session.refreshToken as string };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe('login da plataforma', () => {
  it('rejeita com a MESMA mensagem para e-mail desconhecido e senha errada, audita e bloqueia após 5 tentativas', async () => {
    const email = `alvo-${uniq()}@ouvion.com`;
    await owner.platformUser.create({ data: { email, fullName: 'Alvo', role: 'SUPPORT', passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } });

    const a = await http().post('/platform/auth/login').send({ email: `nao-existe-${uniq()}@ouvion.com`, password: PASSWORD }).expect(401);
    const b = await http().post('/platform/auth/login').send({ email, password: 'senha-errada' }).expect(401);
    expect(a.body.message).toBe(b.body.message);
    expect(a.body.message).toContain('Acesso restrito à equipe OuviON');

    for (let i = 0; i < 4; i++) await http().post('/platform/auth/login').send({ email, password: 'senha-errada' }).expect(401);
    // Depois de 5 falhas, nem a senha certa entra (bloqueio temporário).
    await http().post('/platform/auth/login').send({ email, password: PASSWORD }).expect(401);
    const failed = await owner.platformAuditLog.count({ where: { action: 'LOGIN_FAILED', details: { path: ['why'], equals: 'senha' } } });
    expect(failed).toBeGreaterThanOrEqual(5);
  });

  it('exige o 2º fator SEMPRE: cadastro no primeiro acesso, depois código; o mesmo código não vale duas vezes', async () => {
    const op = await makeOperator('SUPER_ADMIN');
    const me = await http().get('/platform/auth/me').set(as(op.token)).expect(200);
    expect(me.body).toMatchObject({ email: op.email, role: 'SUPER_ADMIN', mfaEnabled: true });
    expect(op.recoveryCodes).toHaveLength(10);

    // Segundo login: agora pede o código.
    const login = await http().post('/platform/auth/login').send({ email: op.email, password: PASSWORD }).expect(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();
    // Reuso do código usado no cadastro é recusado.
    await http().post('/platform/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: op.code }).expect(401);
    await http().post('/platform/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: '000000' }).expect(401);
    // Código de recuperação abre a sessão uma vez só.
    const ok = await http().post('/platform/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, recoveryCode: op.recoveryCodes[0] }).expect(200);
    expect(ok.body.accessToken).toBeDefined();
    const login2 = await http().post('/platform/auth/login').send({ email: op.email, password: PASSWORD }).expect(200);
    await http().post('/platform/auth/mfa/verify').send({ mfaToken: login2.body.mfaToken, recoveryCode: op.recoveryCodes[0] }).expect(401);
  });

  it('o segredo do 2º fator fica cifrado no banco e o refresh é rotativo (reuso derruba tudo)', async () => {
    const op = await makeOperator('SUPPORT');
    const row = await owner.platformUser.findUniqueOrThrow({ where: { id: op.id } });
    expect(row.mfaSecretEnc).not.toContain(op.secret);
    expect(row.mfaRecoveryCodes.every((h) => h.startsWith('$argon2id$'))).toBe(true);

    const r1 = await http().post('/platform/auth/refresh').send({ refreshToken: op.refresh }).expect(200);
    await http().get('/platform/auth/me').set(as(r1.body.accessToken)).expect(200);
    // O refresh antigo já foi trocado: reusar revoga todas as sessões.
    await http().post('/platform/auth/refresh').send({ refreshToken: op.refresh }).expect(401);
    await http().get('/platform/auth/me').set(as(r1.body.accessToken)).expect(401);
  });

  it('token de tenant não vale na plataforma e token da plataforma não vale em tenant', async () => {
    const t = await createTenant(PASSWORD);
    const tenantLogin = await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD }).expect(201);
    await http().get('/platform/tenants').set(as(tenantLogin.body.accessToken)).expect(401);

    const op = await makeOperator('SUPER_ADMIN');
    await http().get('/users').set({ 'x-tenant-slug': t.slug, ...as(op.token) }).expect(401);
    await http().get('/platform/tenants').expect(401);
  });
});

describe('perfis e conteúdo', () => {
  it('SUPPORT vê empresas mas não suspende nem gere usuários; FINANCIAL não vê empresas; só SUPER_ADMIN vê a auditoria', async () => {
    const support = await makeOperator('SUPPORT');
    const financial = await makeOperator('FINANCIAL');
    const admin = await makeOperator('SUPER_ADMIN');
    const t = await createTenant(PASSWORD);

    await http().get('/platform/tenants').set(as(support.token)).expect(200);
    await http().post(`/platform/tenants/${t.tenantId}/suspend`).set(as(support.token)).send({ reason: 'Tentativa indevida do suporte' }).expect(403);
    await http().get('/platform/users').set(as(support.token)).expect(403);
    await http().get('/platform/audit').set(as(support.token)).expect(403);
    await http().get('/platform/tenants').set(as(financial.token)).expect(403);
    await http().get('/platform/audit').set(as(admin.token)).expect(200);
  });

  it('a lista de empresas traz só NÚMEROS; no banco o papel da plataforma não lê denúncia nem usuário de tenant', async () => {
    const t = await createTenant(PASSWORD);
    await createComplaint(t.tenantId, 'Título sigiloso da denúncia 9876');
    const admin = await makeOperator('SUPER_ADMIN');

    const res = await http().get(`/platform/tenants/${t.tenantId}`).set(as(admin.token)).expect(200);
    expect(res.body.counts).toMatchObject({ complaints: 1, complaintsThisMonth: 1 });
    expect(res.body.counts.users).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toMatch(/sigiloso|title|description/i);

    // Garantia no NÍVEL DO BANCO (arq. §3): sem GRANT, nem com SQL direto.
    for (const table of ['complaints', 'users', 'complaint_messages', 'attachments', 'complaint_comments', 'audit_logs']) {
      await expect(platform.$queryRawUnsafe(`SELECT count(*) FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
    await expect(platform.$queryRawUnsafe('SELECT count(*) FROM platform_tenant_stats()')).resolves.toBeDefined();
  });

  it('a auditoria da plataforma é somente de acréscimo (nem o dono do schema altera ou apaga)', async () => {
    const admin = await makeOperator('SUPER_ADMIN');
    const row = await owner.platformAuditLog.findFirstOrThrow({ where: { actorId: admin.id } });
    await expect(owner.platformAuditLog.update({ where: { id: row.id }, data: { resource: 'adulterado' } })).rejects.toThrow(/somente de acréscimo/);
    await expect(owner.platformAuditLog.delete({ where: { id: row.id } })).rejects.toThrow(/somente de acréscimo/);
  });
});

describe('suspensão comercial da empresa', () => {
  it('exige motivo, audita com severidade alta, bloqueia o login da equipe e MANTÉM o canal público recebendo denúncias', async () => {
    const t = await createTenant(PASSWORD);
    const admin = await makeOperator('SUPER_ADMIN');
    await http().post(`/platform/tenants/${t.tenantId}/suspend`).set(as(admin.token)).send({ reason: 'curto' }).expect(400);
    await http().post(`/platform/tenants/${t.tenantId}/suspend`).set(as(admin.token)).send({ reason: 'Inadimplência há mais de 60 dias.' }).expect(200);
    await http().post(`/platform/tenants/${t.tenantId}/suspend`).set(as(admin.token)).send({ reason: 'Inadimplência há mais de 60 dias.' }).expect(409);

    const log = await owner.platformAuditLog.findFirstOrThrow({ where: { action: 'TENANT_SUSPENDED', tenantId: t.tenantId } });
    expect(log).toMatchObject({ severity: 'HIGH', actorId: admin.id });

    const staff = await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD });
    expect(staff.status).not.toBe(201);
    const complaint = await http().post('/public/complaints').set('x-tenant-slug', t.slug).send({
      isAnonymous: true, contentWarningAcknowledged: true, type: 'FRAUD', title: 'Relato em empresa suspensa',
      description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas fiscais.', involvedPeople: ['Alguém'],
    });
    expect(complaint.status).toBe(201);

    await http().post(`/platform/tenants/${t.tenantId}/reactivate`).set(as(admin.token)).send({ reason: 'Pagamento regularizado hoje.' }).expect(200);
    await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD }).expect(201);
  });
});

describe('usuários internos', () => {
  it('cria com senha temporária: troca obrigatória e 2º fator antes de qualquer sessão; protege o último SUPER_ADMIN e a si mesmo', async () => {
    const admin = await makeOperator('SUPER_ADMIN');
    const email = `novo-${uniq()}@ouvion.com`;
    await http().post('/platform/users').set(as(admin.token)).send({ fullName: 'Novo Suporte', email, role: 'SUPPORT', password: '123' }).expect(400);
    const created = await http().post('/platform/users').set(as(admin.token)).send({ fullName: 'Novo Suporte', email, role: 'SUPPORT', password: 'Temporaria-123!' }).expect(201);
    await http().post('/platform/users').set(as(admin.token)).send({ fullName: 'Novo Suporte', email, role: 'SUPPORT', password: 'Temporaria-123!' }).expect(409);

    const login = await http().post('/platform/auth/login').send({ email, password: 'Temporaria-123!' }).expect(200);
    expect(login.body).toMatchObject({ passwordChangeRequired: true });
    expect(login.body.accessToken).toBeUndefined();
    await http().post('/platform/auth/change-password').send({ token: login.body.token, newPassword: 'Temporaria-123!' }).expect(400);
    const changed = await http().post('/platform/auth/change-password').send({ token: login.body.token, newPassword: 'Definitiva-456!' }).expect(200);
    expect(changed.body.mfaEnrollmentRequired).toBe(true); // ainda sem sessão: falta o 2º fator

    // Próprio perfil e último SUPER_ADMIN são protegidos.
    await http().patch(`/platform/users/${admin.id}`).set(as(admin.token)).send({ isActive: false }).expect(409);
    await http().patch(`/platform/users/${admin.id}`).set(as(admin.token)).send({ role: 'SUPPORT' }).expect(409);

    // Desativar derruba a sessão na hora.
    const victim = await makeOperator('SUPPORT');
    await http().get('/platform/auth/me').set(as(victim.token)).expect(200);
    await http().patch(`/platform/users/${victim.id}`).set(as(admin.token)).send({ isActive: false }).expect(200);
    await http().get('/platform/auth/me').set(as(victim.token)).expect(401);

    // Reset de senha exige troca de novo e nunca aparece em auditoria em claro.
    await http().post(`/platform/users/${created.body.id}/reset-password`).set(as(admin.token)).send({ password: 'Outra-Temporaria-789!' }).expect(200);
    const logs = await owner.platformAuditLog.findMany({ where: { action: { in: ['INTERNAL_USER_CREATED', 'INTERNAL_USER_PASSWORD_RESET'] } } });
    expect(JSON.stringify(logs.map((l) => l.details))).not.toMatch(/Temporaria|Definitiva|password/i);
  });
});
