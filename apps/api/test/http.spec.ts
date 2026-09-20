import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { TenantAccessPolicy } from '../src/tenancy/tenant-access.policy';
import { closeAll, createTenant, owner } from './helpers';

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

const api = () => request(app.getHttpServer());

describe('resolução de tenant e login', () => {
  it('health não exige tenant; demais rotas exigem', async () => {
    await api().get('/health').expect(200);
    await api().post('/auth/login').send({ email: 'a@b.com', password: 'x' }).expect(404);
  });

  it('login emite JWT com tenantId e /auth/me devolve o contexto', async () => {
    const t = await createTenant(PASSWORD);
    const login = await api()
      .post('/auth/login')
      .set('x-tenant-slug', t.slug)
      .send({ email: t.adminEmail, password: PASSWORD })
      .expect(201);
    const me = await api()
      .get('/auth/me')
      .set('x-tenant-slug', t.slug)
      .set('authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(me.body).toEqual({ userId: t.adminId, tenantId: t.tenantId, role: 'ADMIN', mfaEnabled: false });
  });

  it('token de um tenant é recusado em outro tenant (401)', async () => {
    const a = await createTenant(PASSWORD);
    const b = await createTenant(PASSWORD);
    const login = await api()
      .post('/auth/login')
      .set('x-tenant-slug', a.slug)
      .send({ email: a.adminEmail, password: PASSWORD });
    await api()
      .get('/auth/me')
      .set('x-tenant-slug', b.slug)
      .set('authorization', `Bearer ${login.body.accessToken}`)
      .expect(401);
  });

  it('usuário de um tenant não autentica em outro', async () => {
    const a = await createTenant(PASSWORD);
    const b = await createTenant(PASSWORD);
    await api()
      .post('/auth/login')
      .set('x-tenant-slug', b.slug)
      .send({ email: a.adminEmail, password: PASSWORD })
      .expect(401);
  });

  it('senha errada e e-mail inexistente dão a mesma resposta genérica', async () => {
    const t = await createTenant(PASSWORD);
    const wrong = await api()
      .post('/auth/login')
      .set('x-tenant-slug', t.slug)
      .send({ email: t.adminEmail, password: 'errada-errada' })
      .expect(401);
    const missing = await api()
      .post('/auth/login')
      .set('x-tenant-slug', t.slug)
      .send({ email: 'ninguem@x.com', password: 'errada-errada' })
      .expect(401);
    expect(wrong.body.message).toBe('Credenciais inválidas');
    expect(missing.body.message).toBe(wrong.body.message);
  });
});

describe('status do tenant', () => {
  it.each(['SUSPENDED', 'CANCELLED'] as const)('%s bloqueia o login da equipe', async (status) => {
    const t = await createTenant(PASSWORD);
    await owner.tenant.update({ where: { id: t.tenantId }, data: { status } });
    await api()
      .post('/auth/login')
      .set('x-tenant-slug', t.slug)
      .send({ email: t.adminEmail, password: PASSWORD })
      .expect(403);
  });

  it('tenant inativo bloqueia o login mesmo com status ACTIVE', async () => {
    const t = await createTenant(PASSWORD);
    await owner.tenant.update({ where: { id: t.tenantId }, data: { status: 'ACTIVE', isActive: false } });
    await api()
      .post('/auth/login')
      .set('x-tenant-slug', t.slug)
      .send({ email: t.adminEmail, password: PASSWORD })
      .expect(403);
  });

  it('TRIAL e ACTIVE permitem login; o canal público nunca é bloqueado', () => {
    expect(TenantAccessPolicy.canStaffLogin({ status: 'TRIAL', isActive: true })).toBe(true);
    expect(TenantAccessPolicy.canStaffLogin({ status: 'ACTIVE', isActive: true })).toBe(true);
    expect(TenantAccessPolicy.canStaffLogin({ status: 'SUSPENDED', isActive: true })).toBe(false);
    expect(TenantAccessPolicy.canReceivePublicComplaints()).toBe(true);
  });
});
