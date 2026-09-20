import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { SecurityConfig } from '../src/auth/security-config';
import { RateLimiter } from '../src/common/rate-limiter';
import { closeAll, createTenant, owner } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
let app: INestApplication;
let passwordHash: string;
let config: SecurityConfig;
let limiter: RateLimiter;

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  config = app.get(SecurityConfig);
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

function client(slug: string) {
  const mk = (method: 'get' | 'post' | 'delete') => (url: string, token?: string) => {
    const r = http()[method](url).set('x-tenant-slug', slug);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  return { get: mk('get'), post: mk('post'), del: mk('delete') };
}

async function world() {
  const t = await createTenant(PASSWORD);
  const inv = await makeUser(t.tenantId, 'INVESTIGATOR', 'inv');
  const rep = await makeUser(t.tenantId, 'REPORTER', 'rep');
  const a = client(t.slug);
  const login = async (email: string, ua = 'TestUA/1') => {
    const r = await a.post('/auth/login').set('user-agent', ua).send({ email, password: PASSWORD }).expect(201);
    return r.body as { accessToken: string; refreshToken: string };
  };
  return { t, inv, rep, a, login };
}

/** Código TOTP de um instante deslocado (clone: não altera as opções globais do otplib). */
const codeAt = (secret: string, offsetMs: number): string =>
  authenticator.clone({ epoch: Date.now() + offsetMs }).generate(secret);
const secretOf = (uri: string) => new URL(uri).searchParams.get('secret')!;

describe('bloqueio por tentativas', () => {
  it('5 falhas travam por 15 min (até com a senha certa) e a resposta é uniforme para e-mail inexistente', async () => {
    const w = await world();
    const bad = (email: string) => w.a.post('/auth/login').send({ email, password: 'errada-errada-1' });

    for (let i = 0; i < 5; i++) await bad(w.inv.email).expect(401);
    const locked = await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(429);
    const row = await owner.user.findUniqueOrThrow({ where: { id: w.inv.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // E-mail que não existe recebe exatamente a mesma resposta depois de 5 falhas.
    for (let i = 0; i < 5; i++) await bad('fantasma@x.com').expect(401);
    const ghost = await bad('fantasma@x.com').expect(429);
    expect(ghost.body).toEqual(locked.body);

    const audits = await owner.auditLog.findMany({ where: { tenantId: w.t.tenantId, action: 'LOGIN_FAILED', userId: w.inv.id } });
    expect(audits).toHaveLength(5);
    expect(audits.every((a) => a.ipAddress !== null)).toBe(true); // equipe é identificada

    // Passado o tempo, libera.
    const real = limiter.now;
    limiter.now = () => real() + 16 * 60_000;
    try {
      await owner.user.update({ where: { id: w.inv.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      await w.login(w.inv.email);
    } finally {
      limiter.now = real;
    }
  });

  it('login bem-sucedido zera o contador; 4 falhas + acerto não travam', async () => {
    const w = await world();
    for (let i = 0; i < 4; i++) await w.a.post('/auth/login').send({ email: w.inv.email, password: 'errada-errada-1' }).expect(401);
    expect((await owner.user.findUniqueOrThrow({ where: { id: w.inv.id } })).failedLoginCount).toBe(4);
    await w.login(w.inv.email);
    expect((await owner.user.findUniqueOrThrow({ where: { id: w.inv.id } })).failedLoginCount).toBe(0);
    await w.a.post('/auth/login').send({ email: w.inv.email, password: 'errada-errada-1' }).expect(401); // segue sem travar
  });
});

describe('refresh rotativo', () => {
  it('rotaciona; reuso do token antigo derruba TODAS as sessões do usuário', async () => {
    const w = await world();
    const s1 = await w.login(w.inv.email);
    const other = await w.login(w.inv.email, 'Outro/2'); // segunda sessão do mesmo usuário

    const r = await w.a.post('/auth/refresh').send({ refreshToken: s1.refreshToken }).expect(200);
    expect(r.body.refreshToken).not.toBe(s1.refreshToken);
    await w.a.get('/auth/me', r.body.accessToken).expect(200);
    await w.a.get('/auth/me', s1.accessToken).expect(200); // mesma sessão: o access antigo vale até expirar

    // Reuso do refresh já rotacionado = indício de roubo: nada mais vale.
    await w.a.post('/auth/refresh').send({ refreshToken: s1.refreshToken }).expect(401);
    await w.a.post('/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(401);
    await w.a.get('/auth/me', r.body.accessToken).expect(401);
    await w.a.get('/auth/me', other.accessToken).expect(401);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.t.tenantId, action: 'LOGIN_FAILED', userId: w.inv.id } });
    expect(JSON.stringify(audit.details)).toContain('refresh_reuse');
  });

  it('recusa token inexistente, expirado e o guardado só como hash', async () => {
    const w = await world();
    const s = await w.login(w.inv.email);
    await w.a.post('/auth/refresh').send({ refreshToken: 'x'.repeat(43) }).expect(401);
    await w.a.post('/auth/refresh').send({}).expect(401);
    const rows = await owner.refreshToken.findMany({ where: { userId: w.inv.id } });
    expect(rows.map((r) => r.tokenHash)).not.toContain(s.refreshToken);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    await owner.refreshToken.updateMany({ where: { userId: w.inv.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await w.a.post('/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    await w.a.get('/auth/me', s.accessToken).expect(401); // sessão expirada também derruba o access
  });

  it('suspensão do usuário revoga as sessões e o refresh deixa de funcionar', async () => {
    const w = await world();
    const admin = await w.login(w.t.adminEmail);
    const s = await w.login(w.inv.email);
    await w.a.post(`/users/${w.inv.id}/block`, admin.accessToken).send({ reason: 'Afastamento cautelar decidido pelo RH' }).expect(201);
    expect(await owner.refreshToken.count({ where: { userId: w.inv.id, revokedAt: null } })).toBe(0);
    await w.a.post('/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    await w.a.get('/auth/me', s.accessToken).expect(401);
  });

  it('tenant suspenso: refresh também é recusado', async () => {
    const w = await world();
    const s = await w.login(w.inv.email);
    await owner.tenant.update({ where: { id: w.t.tenantId }, data: { status: 'SUSPENDED' } });
    await w.a.post('/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
  });
});

describe('sessões ativas', () => {
  it('lista com IP/UA e marca a atual; revoga outra na hora; logout e logout-all', async () => {
    const w = await world();
    const s1 = await w.login(w.inv.email, 'Navegador/1');
    const s2 = await w.login(w.inv.email, 'Celular/2');

    const list = await w.a.get('/auth/sessions', s1.accessToken).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.body.map((s: { userAgent: string }) => s.userAgent).sort()).toEqual(['Celular/2', 'Navegador/1']);
    expect(JSON.stringify(list.body)).not.toContain(s1.refreshToken);

    const other = list.body.find((s: { current: boolean }) => !s.current);
    await w.a.del(`/auth/sessions/${other.id}`, s1.accessToken).expect(200);
    await w.a.get('/auth/me', s2.accessToken).expect(401); // caiu imediatamente
    await w.a.get('/auth/me', s1.accessToken).expect(200);
    await w.a.del(`/auth/sessions/${other.id}`, s1.accessToken).expect(401); // já revogada
    await w.a.del('/auth/sessions/nao-e-uuid', s1.accessToken).expect(400);

    // Ninguém revoga sessão de outro usuário.
    const repSession = await w.a.post('/auth/login').send({ email: w.rep.email, password: PASSWORD }).expect(201);
    const repList = await w.a.get('/auth/sessions', repSession.body.accessToken).expect(200);
    await w.a.del(`/auth/sessions/${repList.body[0].id}`, s1.accessToken).expect(401);

    await w.a.post('/auth/logout', s1.accessToken).expect(200);
    await w.a.get('/auth/me', s1.accessToken).expect(401);

    const a = await w.login(w.inv.email);
    const b = await w.login(w.inv.email);
    expect((await w.a.post('/auth/logout-all', a.accessToken).expect(200)).body.revoked).toBeGreaterThanOrEqual(2);
    await w.a.get('/auth/me', b.accessToken).expect(401);
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, action: 'LOGOUT' } })).toBe(3); // revogar outra sessão, logout e logout-all
  });
});

describe('cookies httpOnly + CSRF', () => {
  const cookies = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const jar = (list: string[]) => list.map((c) => c.split(';')[0]).join('; ');

  it('tokens só em cookie httpOnly/SameSite, fora do corpo; CSRF exigido nas mutações', async () => {
    const w = await world();
    const res = await w.a
      .post('/auth/login')
      .set('x-token-delivery', 'cookie')
      .send({ email: w.inv.email, password: PASSWORD })
      .expect(201);
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('refreshToken');
    const set = cookies(res);
    const at = set.find((c) => c.startsWith('ouv_at='))!;
    const rt = set.find((c) => c.startsWith('ouv_rt='))!;
    const csrf = set.find((c) => c.startsWith('ouv_csrf='))!;
    for (const c of [at, rt]) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    expect(rt).toMatch(/Path=\/auth/);
    expect(csrf).not.toMatch(/HttpOnly/i); // legível para o double-submit
    const cookieHeader = jar(set);
    const csrfValue = res.body.csrfToken as string;

    // Leitura por cookie funciona sem CSRF; mutação exige.
    await http().get('/auth/me').set('x-tenant-slug', w.t.slug).set('cookie', cookieHeader).expect(200);
    const mutate = (headers: Record<string, string> = {}) =>
      http().post('/auth/logout-all').set('x-tenant-slug', w.t.slug).set('cookie', cookieHeader).set(headers);
    await mutate().expect(403);
    await mutate({ 'x-csrf-token': 'errado' }).expect(403);

    // Refresh por cookie: também exige CSRF e rotaciona o cookie.
    const refresh = (headers: Record<string, string> = {}) =>
      http().post('/auth/refresh').set('x-tenant-slug', w.t.slug).set('cookie', cookieHeader).set(headers).send({});
    await refresh().expect(403);
    const rotated = await refresh({ 'x-csrf-token': csrfValue }).expect(200);
    expect(rotated.body).not.toHaveProperty('refreshToken');
    expect(cookies(rotated).some((c) => c.startsWith('ouv_rt='))).toBe(true);

    // Depois de rotacionar, o cookie de refresh antigo é reuso => derruba tudo.
    await refresh({ 'x-csrf-token': csrfValue }).expect(401);

    await mutate({ 'x-csrf-token': csrfValue }).expect(401); // sessão já derrubada pelo reuso
  });

  it('logout por cookie limpa os cookies; Bearer não precisa de CSRF', async () => {
    const w = await world();
    const res = await w.a.post('/auth/login').set('x-token-delivery', 'cookie').send({ email: w.inv.email, password: PASSWORD }).expect(201);
    const cookie = jar(cookies(res));
    const out = await http()
      .post('/auth/logout')
      .set('x-tenant-slug', w.t.slug)
      .set('cookie', cookie)
      .set('x-csrf-token', res.body.csrfToken)
      .expect(200);
    expect(cookies(out).some((c) => /^ouv_at=;/.test(c))).toBe(true);
    const bearer = await w.login(w.inv.email);
    await w.a.post('/auth/logout', bearer.accessToken).expect(200); // sem CSRF
  });

  it('rotas públicas do canal anônimo nunca emitem cookie', async () => {
    const w = await world();
    const r = await w.a.post('/public/complaints').send({
      isAnonymous: true, contentWarningAcknowledged: true, type: 'ETHICS', title: 'Relato de teste de cookies',
      description: 'Descrição longa o suficiente para passar na validação do formulário público.', involvedPeople: ['Alguém'],
    }).expect(201);
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});

describe('MFA (TOTP + códigos de recuperação)', () => {
  beforeAll(() => {
    config.enforceMfa = true;
  });
  afterAll(() => {
    config.enforceMfa = false;
  });

  async function enrolled(w: Awaited<ReturnType<typeof world>>, email: string) {
    const first = await w.a.post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    const enrollToken = first.body.enrollToken as string;
    const start = await w.a.post('/auth/mfa/enroll', enrollToken).expect(200);
    const secret = secretOf(start.body.otpauthUri);
    const done = await w.a.post('/auth/mfa/activate', enrollToken).send({ code: authenticator.generate(secret) }).expect(200);
    return { secret, recoveryCodes: done.body.recoveryCodes as string[], session: done.body.session as { accessToken: string } };
  }

  it('perfil obrigado a ter MFA só entra depois de cadastrar o segundo fator', async () => {
    const w = await world();
    const first = await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(201);
    expect(first.body).toMatchObject({ mfaEnrollmentRequired: true });
    expect(first.body).not.toHaveProperty('accessToken');
    const enrollToken = first.body.enrollToken as string;

    // O token de cadastro não abre nada além do cadastro.
    await w.a.get('/complaints', enrollToken).expect(401);
    await w.a.get('/auth/me', enrollToken).expect(401);

    await w.a.post('/auth/mfa/enroll').expect(401);
    const start = await w.a.post('/auth/mfa/enroll', enrollToken).expect(200);
    const secret = secretOf(start.body.otpauthUri);
    await w.a.post('/auth/mfa/activate', enrollToken).send({ code: '000000' }).expect(401);
    const done = await w.a.post('/auth/mfa/activate', enrollToken).send({ code: authenticator.generate(secret) }).expect(200);

    expect(done.body.recoveryCodes).toHaveLength(10);
    await w.a.get('/auth/me', done.body.session.accessToken).expect(200);
    const row = await owner.user.findUniqueOrThrow({ where: { id: w.inv.id } });
    expect(row.mfaEnabled).toBe(true);
    expect(row.mfaSecretEnc).toMatch(/^v2\./);
    expect(row.mfaSecretEnc).not.toContain(secret);
    expect(row.mfaRecoveryCodes).toHaveLength(10);
    expect(row.mfaRecoveryCodes.every((h) => h.startsWith('$argon2id$'))).toBe(true);
    for (const c of done.body.recoveryCodes) expect(JSON.stringify(row.mfaRecoveryCodes)).not.toContain(c);
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, action: 'MFA_ENROLL', userId: w.inv.id } })).toBe(1);
    await w.a.post('/auth/mfa/enroll', done.body.session.accessToken).expect(409); // já ativo
  });

  it('login em duas etapas; erro de código falha; TOTP não pode ser reutilizado', async () => {
    const w = await world();
    const { secret } = await enrolled(w, w.inv.email);

    const step1 = await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(201);
    expect(step1.body).toMatchObject({ mfaRequired: true });
    expect(step1.body).not.toHaveProperty('accessToken');
    await w.a.get('/auth/me', step1.body.mfaToken).expect(401); // mfaToken não é sessão

    await w.a.post('/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(401);
    await w.a.post('/auth/mfa/verify').send({ mfaToken: 'lixo'.repeat(5), code: '123456' }).expect(401);
    await w.a.post('/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken }).expect(400);
    await w.a.post('/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '123456', recoveryCode: 'ABCDE-FGHIJ' }).expect(400);

    // O código usado no cadastro (mesmo passo) já não vale: replay recusado.
    await w.a.post('/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: authenticator.generate(secret) }).expect(401);

    // Código do passo seguinte (janela de tolerância) vale uma vez.
    const next = codeAt(secret, 30_000);
    const ok = await w.a.post('/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: next }).expect(200);
    await w.a.get('/auth/me', ok.body.accessToken).expect(200);
    const again = await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(201);
    await w.a.post('/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, code: next }).expect(401); // replay
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, action: 'LOGIN_FAILED', userId: w.inv.id } })).toBeGreaterThanOrEqual(3);
  });

  it('código de recuperação vale uma vez só', async () => {
    const w = await world();
    const { recoveryCodes } = await enrolled(w, w.inv.email);
    const login = () => w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(201);

    const a = await login();
    const used = recoveryCodes[0]!;
    await w.a.post('/auth/mfa/verify').send({ mfaToken: a.body.mfaToken, recoveryCode: used.toLowerCase().replace('-', '') }).expect(200);
    expect((await owner.user.findUniqueOrThrow({ where: { id: w.inv.id } })).mfaRecoveryCodes).toHaveLength(9);

    const b = await login();
    await w.a.post('/auth/mfa/verify').send({ mfaToken: b.body.mfaToken, recoveryCode: used }).expect(401);
    await w.a.post('/auth/mfa/verify').send({ mfaToken: b.body.mfaToken, recoveryCode: recoveryCodes[1] }).expect(200);
  });

  it('erros de MFA contam para o bloqueio (5 => 429)', async () => {
    const w = await world();
    await enrolled(w, w.inv.email);
    const step1 = await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(201);
    for (let i = 0; i < 5; i++) {
      await w.a.post('/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '111111' }).expect(401);
    }
    await w.a.post('/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '111111' }).expect(429);
    await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(429);
  });

  it('REPORTER entra sem MFA e pode ativar/desativar; ADMIN não pode desativar', async () => {
    const w = await world();
    const rep = await w.login(w.rep.email);
    const start = await w.a.post('/auth/mfa/enroll', rep.accessToken).expect(200);
    const secret = secretOf(start.body.otpauthUri);
    await w.a.post('/auth/mfa/activate', rep.accessToken).send({ code: authenticator.generate(secret) }).expect(200);

    const relog = await w.a.post('/auth/login').send({ email: w.rep.email, password: PASSWORD }).expect(201);
    expect(relog.body.mfaRequired).toBe(true);
    const next = codeAt(secret, 30_000);
    const s = await w.a.post('/auth/mfa/verify').send({ mfaToken: relog.body.mfaToken, code: next }).expect(200);

    const nextNext = codeAt(secret, 60_000); // passo +2: fora da janela de tolerância
    await w.a.post('/auth/mfa/disable', s.body.accessToken).send({ password: 'errada', code: nextNext }).expect(401);

    const admin = await enrolled(w, w.t.adminEmail);
    await w.a.post('/auth/mfa/disable', admin.session.accessToken).send({ password: PASSWORD, code: '123456' }).expect(409);
  });

  it('ADMIN reseta o MFA de outro usuário: sessões caem e o recadastro é exigido', async () => {
    const w = await world();
    const admin = await enrolled(w, w.t.adminEmail);
    const inv = await enrolled(w, w.inv.email);
    const step = await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(201);
    expect(step.body.mfaRequired).toBe(true);
    // sessão viva do investigador (criada no cadastro)
    await w.a.get('/auth/me', inv.session.accessToken).expect(200);

    await w.a.post(`/users/${w.inv.id}/mfa/reset`, inv.session.accessToken).expect(403); // não é ADMIN
    await w.a.post(`/users/${w.inv.id}/mfa/reset`, admin.session.accessToken).expect(201);

    await w.a.get('/auth/me', inv.session.accessToken).expect(401);
    const relog = await w.a.post('/auth/login').send({ email: w.inv.email, password: PASSWORD }).expect(201);
    expect(relog.body.mfaEnrollmentRequired).toBe(true);
    const audit = await owner.auditLog.findFirstOrThrow({
      where: { tenantId: w.t.tenantId, action: 'MFA_ENROLL', userId: admin.session ? (await owner.user.findFirstOrThrow({ where: { email: w.t.adminEmail } })).id : undefined, resourceId: w.inv.id },
    });
    expect(JSON.stringify(audit.details)).toContain('reset');
  });

  it('a ativação do tenant passa a exigir um ADMIN com MFA', async () => {
    const w = await world();
    const admin = await enrolled(w, w.t.adminEmail);
    // Sem destinatário alternativo o status ainda tem outras pendências; conferimos só o requisito de MFA.
    const before = await w.a.get('/onboarding/status', admin.session.accessToken).expect(200);
    expect(before.body.missing).not.toContain('admin.mfa');

    const t2 = await world();
    config.enforceMfa = false;
    const adminToken = (await t2.login(t2.t.adminEmail)).accessToken;
    config.enforceMfa = true;
    const missing = await t2.a.get('/onboarding/status', adminToken).expect(200);
    expect(missing.body.missing).toContain('admin.mfa');
  });
});

describe('MFA em produção', () => {
  it('a obrigatoriedade não pode ser desligada em produção', () => {
    const prevEnv = { node: process.env.NODE_ENV, mfa: process.env.MFA_ENFORCEMENT };
    process.env.NODE_ENV = 'production';
    process.env.MFA_ENFORCEMENT = 'off';
    try {
      expect(new SecurityConfig().enforceMfa).toBe(true);
    } finally {
      process.env.NODE_ENV = prevEnv.node;
      process.env.MFA_ENFORCEMENT = prevEnv.mfa;
    }
    expect(new SecurityConfig().requiresMfa('REPORTER')).toBe(false);
  });
});
