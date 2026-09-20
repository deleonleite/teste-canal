import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PlatformRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SecurityConfig } from '../src/auth/security-config';
import { closeAll, owner } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
const NEW_PASSWORD = 'Definitiva-456!';
let app: INestApplication;
let config: SecurityConfig;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  config = app.get(SecurityConfig);
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

async function makeOperator(role: PlatformRole) {
  const email = `op-${role.toLowerCase()}-${uniq()}@ouvion.com`;
  await owner.platformUser.create({ data: { email, fullName: `Operador ${role}`, role, passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } });
  const login = await http().post('/platform/auth/login').send({ email, password: PASSWORD }).expect(200);
  const enrollToken = login.body.enrollToken as string;
  const enroll = await http().post('/platform/auth/mfa/enroll').send({ enrollToken }).expect(200);
  const secret = new URL(enroll.body.otpauthUri).searchParams.get('secret')!;
  const act = await http().post('/platform/auth/mfa/activate').send({ enrollToken, code: authenticator.generate(secret) }).expect(200);
  return { token: act.body.session.accessToken as string };
}

const newTenant = (over: Record<string, unknown> = {}) => {
  const slug = `ob-${uniq()}`;
  return { slug, companyName: `Empresa ${slug}`, adminEmail: `admin@${slug}.com`, adminFullName: 'Ana Administradora', ...over };
};

describe('Nova Empresa: convite por link (padrão)', () => {
  it('cria tenant em TRIAL sem senha, envia link de uso único e a plataforma nunca conhece a senha', async () => {
    const op = await makeOperator('SUPER_ADMIN');
    const b = newTenant();
    const res = await http().post('/platform/tenants').set(as(op.token)).send(b).expect(201);
    expect(res.body).toMatchObject({ slug: b.slug, mode: 'invite', sentTo: b.adminEmail });
    expect(res.body.temporaryPassword).toBeUndefined();
    const token = tokenOf(res.body.devInviteUrl);
    expect(res.body.devInviteUrl).toContain(`/${b.slug}/convite?token=`);

    const tenant = await owner.tenant.findUniqueOrThrow({ where: { slug: b.slug } });
    expect(tenant.status).toBe('TRIAL');
    expect(await owner.user.count({ where: { tenantId: tenant.id, role: 'ADMIN' } })).toBe(1);
    // Só o HASH do token existe no banco.
    const inv = await owner.tenantInvite.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(inv.tokenHash).not.toContain(token);
    expect(inv.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
    expect(inv.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(72 * 3600_000);

    // Antes de aceitar, ninguém entra (a senha é um valor aleatório que ninguém conhece).
    await http().post('/auth/login').set('x-tenant-slug', b.slug).send({ email: b.adminEmail, password: PASSWORD }).expect(401);

    // Auditoria da plataforma: criação e envio, sem token nem senha.
    const logs = await owner.platformAuditLog.findMany({ where: { tenantId: tenant.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(['TENANT_CREATED', 'TENANT_INVITE_SENT']);
    expect(JSON.stringify(logs.map((l) => l.details))).not.toContain(token);
  });

  it('aceite: mesma mensagem para inválido/vencido/usado; política de senha; uso único; a pessoa define a própria senha', async () => {
    const op = await makeOperator('SUPER_ADMIN');
    const b = newTenant();
    const created = await http().post('/platform/tenants').set(as(op.token)).send(b).expect(201);
    const token = tokenOf(created.body.devInviteUrl);
    const accept = (body: object) => http().post('/public/onboarding/admin-invite').set('x-tenant-slug', b.slug).send(body);

    const bad = await accept({ token: 'x'.repeat(43), password: NEW_PASSWORD }).expect(400);
    await accept({ token, password: '123' }).expect(400); // política de senha
    const ok = await accept({ token, password: NEW_PASSWORD }).expect(200);
    expect(ok.body).toEqual({ email: b.adminEmail });
    const reuse = await accept({ token, password: NEW_PASSWORD }).expect(400);
    expect(reuse.body.message).toBe(bad.body.message); // não revela se já foi usado
    await http().post('/auth/login').set('x-tenant-slug', b.slug).send({ email: b.adminEmail, password: NEW_PASSWORD }).expect(201);

    // Convite vencido dá a mesma mensagem.
    const c = newTenant();
    const created2 = await http().post('/platform/tenants').set(as(op.token)).send(c).expect(201);
    const tenant2 = await owner.tenant.findUniqueOrThrow({ where: { slug: c.slug } });
    await owner.tenantInvite.updateMany({ where: { tenantId: tenant2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await http().post('/public/onboarding/admin-invite').set('x-tenant-slug', c.slug).send({ token: tokenOf(created2.body.devInviteUrl), password: NEW_PASSWORD }).expect(400);
    expect(expired.body.message).toBe(bad.body.message);

    // Convite de uma empresa não vale em outra.
    const d = newTenant();
    const created3 = await http().post('/platform/tenants').set(as(op.token)).send(d).expect(201);
    await http().post('/public/onboarding/admin-invite').set('x-tenant-slug', b.slug).send({ token: tokenOf(created3.body.devInviteUrl), password: NEW_PASSWORD }).expect(400);
  });

  it('reenvio invalida o token antigo e gera outro; depois de aceito não reenvia', async () => {
    const op = await makeOperator('SUPER_ADMIN');
    const b = newTenant();
    const created = await http().post('/platform/tenants').set(as(op.token)).send(b).expect(201);
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { slug: b.slug } });
    const oldToken = tokenOf(created.body.devInviteUrl);

    const re = await http().post(`/platform/tenants/${tenant.id}/resend-invite`).set(as(op.token)).expect(200);
    const newToken = tokenOf(re.body.devInviteUrl);
    expect(newToken).not.toBe(oldToken);
    const accept = (token: string) => http().post('/public/onboarding/admin-invite').set('x-tenant-slug', b.slug).send({ token, password: NEW_PASSWORD });
    await accept(oldToken).expect(400); // o antigo nunca é reaproveitado
    await accept(newToken).expect(200);
    await http().post(`/platform/tenants/${tenant.id}/resend-invite`).set(as(op.token)).expect(409);

    const detail = await http().get(`/platform/tenants/${tenant.id}`).set(as(op.token)).expect(200);
    expect(detail.body.invite).toMatchObject({ email: b.adminEmail, state: 'accepted' });
  });

  it('só SUPER_ADMIN cria; identificador repetido e dados inválidos são recusados', async () => {
    const admin = await makeOperator('SUPER_ADMIN');
    const support = await makeOperator('SUPPORT');
    const b = newTenant();
    await http().post('/platform/tenants').set(as(support.token)).send(b).expect(403);
    await http().post('/platform/tenants').set(as(admin.token)).send({ ...b, slug: 'Slug Inválido' }).expect(400);
    await http().post('/platform/tenants').set(as(admin.token)).send({ ...b, adminEmail: 'nao-e-email' }).expect(400);
    await http().post('/platform/tenants').set(as(admin.token)).send(b).expect(201);
    await http().post('/platform/tenants').set(as(admin.token)).send({ ...newTenant(), slug: b.slug }).expect(409);
  });
});

describe('Nova Empresa: senha temporária (exceção auditada)', () => {
  it('exige motivo; mostra a senha gerada UMA vez; troca obrigatória no primeiro login; auditoria HIGH sem a senha', async () => {
    const op = await makeOperator('SUPER_ADMIN');
    const b = newTenant();
    await http().post('/platform/tenants').set(as(op.token)).send({ ...b, mode: 'temp_password' }).expect(400); // sem motivo

    const res = await http().post('/platform/tenants').set(as(op.token)).send({ ...b, mode: 'temp_password', reason: 'Onboarding assistido por telefone.' }).expect(201);
    const temp = res.body.temporaryPassword as string;
    expect(temp).toBeDefined();
    expect(res.body.devInviteUrl).toBeUndefined();

    // Login com a temporária: só a troca, sem sessão nem 2º fator ainda.
    const login = await http().post('/auth/login').set('x-tenant-slug', b.slug).send({ email: b.adminEmail, password: temp }).expect(201);
    expect(login.body).toMatchObject({ passwordChangeRequired: true });
    expect(login.body.accessToken).toBeUndefined();
    const change = (newPassword: string) => http().post('/auth/change-password').set('x-tenant-slug', b.slug).send({ token: login.body.token, newPassword });
    await change('fraca').expect(400);
    await change(temp).expect(400); // tem de ser diferente da temporária
    const changed = await change(NEW_PASSWORD).expect(200);
    expect(changed.body.accessToken ?? changed.body.mfaEnrollmentRequired ?? changed.body.authenticated).toBeDefined();

    // A temporária deixou de existir; a nova funciona e não pede troca de novo.
    await http().post('/auth/login').set('x-tenant-slug', b.slug).send({ email: b.adminEmail, password: temp }).expect(401);
    const again = await http().post('/auth/login').set('x-tenant-slug', b.slug).send({ email: b.adminEmail, password: NEW_PASSWORD }).expect(201);
    expect(again.body.passwordChangeRequired).toBeUndefined();

    const tenant = await owner.tenant.findUniqueOrThrow({ where: { slug: b.slug } });
    const logs = await owner.platformAuditLog.findMany({ where: { tenantId: tenant.id, action: 'TENANT_ADMIN_TEMP_PASSWORD_ISSUED' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ severity: 'HIGH', actorId: expect.any(String) });
    expect(JSON.stringify(logs[0]!.details)).toContain('Onboarding assistido por telefone.');
    expect(JSON.stringify(logs[0]!.details)).not.toContain(temp);
    // No banco só existe o hash.
    const admin = await owner.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'ADMIN' } });
    expect(admin.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('senha digitada pelo operador não volta na resposta', async () => {
    const op = await makeOperator('SUPER_ADMIN');
    const b = newTenant();
    const res = await http().post('/platform/tenants').set(as(op.token)).send({ ...b, mode: 'temp_password', reason: 'Cliente sem acesso ao e-mail agora.', password: 'Temporaria-789!' }).expect(201);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Temporaria-789!');
    await http().post('/platform/tenants').set(as(op.token)).send({ ...newTenant(), mode: 'temp_password', reason: 'Senha fraca de propósito.', password: 'fraca' }).expect(400);
  });
});

describe('ativação da empresa (sai de TRIAL só com os requisitos)', () => {
  it('exige MFA do ADMIN, destinatário alternativo verificado e DPO; depois vira ACTIVE uma única vez', async () => {
    const wasEnforcing = config.enforceMfa;
    config.enforceMfa = true;
    try {
      const op = await makeOperator('SUPER_ADMIN');
      const b = newTenant();
      const created = await http().post('/platform/tenants').set(as(op.token)).send(b).expect(201);
      const slug = b.slug;
      const t = (path: string, token?: string) => ({ path, headers: { 'x-tenant-slug': slug, ...(token ? as(token) : {}) } });
      await http().post('/public/onboarding/admin-invite').set('x-tenant-slug', slug).send({ token: tokenOf(created.body.devInviteUrl), password: NEW_PASSWORD }).expect(200);

      // Com MFA obrigatório: login pede o cadastro do 2º fator; só depois há sessão.
      const login = await http().post('/auth/login').set('x-tenant-slug', slug).send({ email: b.adminEmail, password: NEW_PASSWORD }).expect(201);
      expect(login.body.mfaEnrollmentRequired).toBe(true);
      const enrollToken = login.body.enrollToken as string;
      const enroll = await http().post('/auth/mfa/enroll').set('x-tenant-slug', slug).set(as(enrollToken)).expect(200);
      const secret = new URL(enroll.body.otpauthUri).searchParams.get('secret')!;
      const act = await http().post('/auth/mfa/activate').set('x-tenant-slug', slug).set(as(enrollToken)).send({ code: authenticator.generate(secret) }).expect(200);
      const admin = act.body.session.accessToken as string;
      const get = (path: string) => http().get(path).set(t(path, admin).headers);
      const put = (path: string) => http().put(path).set(t(path, admin).headers);

      const before = (await get('/onboarding/activation').expect(200)).body;
      expect(before).toMatchObject({ tenantStatus: 'TRIAL', ready: false });
      expect(before.missing).toEqual(expect.arrayContaining(['escalationRecipient.configured', 'dpo.informed']));
      expect(before.missing).not.toContain('admin.mfa'); // já cumprido
      const blocked = await http().post('/onboarding/activate').set(t('', admin).headers).expect(400);
      expect(blocked.body.missing).toEqual(before.missing);

      // Destinatário alternativo: link do e-mail → confirma → cadastra o 2º fator dele.
      const rec = await put('/onboarding/escalation-recipient').send({ email: 'destinatario@externo.com' }).expect(200);
      expect(rec.body.devConfirmUrl).toContain(`/${slug}/destinatario?token=`);
      const rtoken = tokenOf(rec.body.devConfirmUrl);
      const confirm = await http().post('/public/onboarding/escalation/confirm').set('x-tenant-slug', slug).send({ token: rtoken }).expect(200);
      const rsecret = new URL(confirm.body.otpauthUri).searchParams.get('secret')!;
      await http().post('/public/onboarding/escalation/enroll').set('x-tenant-slug', slug).send({ token: rtoken, code: authenticator.generate(rsecret) }).expect(200);
      expect((await get('/onboarding/activation')).body.missing).toEqual(['dpo.informed']);
      await http().post('/onboarding/activate').set(t('', admin).headers).expect(400); // ainda falta o DPO

      await put('/onboarding/dpo').send({ name: 'M', email: 'x' }).expect(400);
      await put('/onboarding/dpo').send({ name: 'Maria Encarregada', email: 'dpo@empresa.com' }).expect(200);
      expect((await get('/onboarding/activation')).body).toMatchObject({ ready: true, missing: [], dpo: { name: 'Maria Encarregada', email: 'dpo@empresa.com' } });

      await http().post('/onboarding/activate').set(t('', admin).headers).expect(200);
      expect((await owner.tenant.findUniqueOrThrow({ where: { slug } })).status).toBe('ACTIVE');
      await http().post('/onboarding/activate').set(t('', admin).headers).expect(409); // não ativa duas vezes
    } finally {
      config.enforceMfa = wasEnforcing;
    }
  });
});
