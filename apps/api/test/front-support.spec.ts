import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { RateLimiter } from '../src/common/rate-limiter';
import { closeAll, createTenant, owner } from './helpers';

const SECRET = 'segredo-compartilhado-do-bff-com-mais-de-32-caracteres';
const PASSWORD = 'Senha-Forte-123!';
let app: INestApplication;
let limiter: RateLimiter;

beforeAll(async () => {
  process.env.BFF_SHARED_SECRET = SECRET;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  limiter = app.get(RateLimiter);
});
afterAll(async () => {
  delete process.env.BFF_SHARED_SECRET;
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());
const report = () => ({
  isAnonymous: true, contentWarningAcknowledged: true, type: 'FRAUD', title: 'Suspeita de fraude em notas fiscais',
  description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas fiscais.', involvedPeople: ['Alguém'],
});

describe('IP real vindo do BFF', () => {
  it('só é confiado com o segredo do BFF: o limite passa a ser por cliente, e cabeçalho forjado é ignorado', async () => {
    const t = await createTenant(PASSWORD);
    limiter.ipLimitsEnabled = true;
    try {
      const post = (headers: Record<string, string>) => http().post('/public/complaints').set('x-tenant-slug', t.slug).set(headers).send(report());

      // Cliente A (via BFF autêntico) esgota o limite de 10/h; o cliente B continua livre.
      for (let i = 0; i < 10; i++) await post({ 'x-bff-secret': SECRET, 'x-real-client-ip': '198.51.100.10' }).expect(201);
      await post({ 'x-bff-secret': SECRET, 'x-real-client-ip': '198.51.100.10' }).expect(429);
      await post({ 'x-bff-secret': SECRET, 'x-real-client-ip': '198.51.100.11' }).expect(201);

      // Sem o segredo (ou com segredo errado) o cabeçalho é ignorado: vale o IP do socket — que aqui é um só.
      const spoof = (ip: string, secret?: string) => post({ ...(secret ? { 'x-bff-secret': secret } : {}), 'x-real-client-ip': ip });
      for (let i = 0; i < 10; i++) await spoof(`203.0.113.${i}`).expect(201); // 10 "IPs" diferentes, mesma origem real
      await spoof('203.0.113.200').expect(429); // forjar IP NÃO burla o limite
      await spoof('203.0.113.201', 'segredo-errado').expect(429);
    } finally {
      limiter.ipLimitsEnabled = false;
    }
  });
});

describe('marca pública do tenant', () => {
  it('devolve só o que é público; nada de configuração privada nem CSS arbitrário', async () => {
    const t = await createTenant(PASSWORD);
    const login = await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD }).expect(201);
    const put = (key: string, value: string) =>
      http().put(`/settings/${key}`).set('x-tenant-slug', t.slug).set('authorization', `Bearer ${login.body.accessToken}`).send({ value });

    await put('docCodigoEtica', 'https://exemplo.com/codigo-de-etica.pdf').expect(200);
    await put('docPoliticaAssedio', 'javascript:alert(1)').expect(400); // só http(s)
    await put('docPoliticaAnticorrupcao', 'data:text/html,<script>').expect(400);
    await put('companyPhone', '0800 123 4567').expect(200);
    await put('sla_ack_days', '3').expect(200); // privada
    await owner.tenant.update({ where: { id: t.tenantId }, data: { dpoName: 'Maria Encarregada', dpoEmail: 'dpo@empresa.com' } });
    await owner.tenantBranding.update({ where: { tenantId: t.tenantId }, data: { primaryColor: '#0a5c36', customCss: 'body{display:none}' } });

    const res = await http().get('/public/branding').set('x-tenant-slug', t.slug).expect(200); // sem autenticação
    expect(res.body).toMatchObject({
      slug: t.slug,
      primaryColor: '#0a5c36',
      allowAnonymousComplaints: true,
      maintenanceMode: false,
      dpo: { name: 'Maria Encarregada', email: 'dpo@empresa.com' },
      contact: { phone: '0800 123 4567', email: null },
    });
    expect(res.body.documents.codigoEtica).toBe('https://exemplo.com/codigo-de-etica.pdf');
    expect(res.body.documents.politicaAssedio).toBeNull();
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain('display:none'); // customCss não vai ao navegador
    expect(dump).not.toContain('sla_ack_days');
    await http().get('/public/branding').set('x-tenant-slug', 'nao-existe-mesmo').expect(404);
  });
});

describe('consulta pública: linha do tempo e prazos', () => {
  it('traz marcos macro ao minuto, prazos em aberto e se ainda cabe relato de retaliação', async () => {
    const t = await createTenant(PASSWORD);
    const login = await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD }).expect(201);
    const auth = { 'x-tenant-slug': t.slug, authorization: `Bearer ${login.body.accessToken}` };
    const created = await http().post('/public/complaints').set('x-tenant-slug', t.slug).send(report()).expect(201);
    const lookup = () => http().post('/public/complaints/lookup').set('x-tenant-slug', t.slug).send({ protocol: created.body.protocol, accessKey: created.body.accessKey }).expect(200);

    const first = (await lookup()).body;
    expect(first.timeline.map((x: { status: string }) => x.status)).toEqual(['PENDING']);
    expect(first.ackDueAt).toBeNull(); // recibo automático já confirmou o recebimento
    expect(first.feedbackDueAt).not.toBeNull();
    expect(first.canReportRetaliation).toBe(false);
    expect(first.timeline.every((x: { at: string }) => new Date(x.at).getUTCSeconds() === 0)).toBe(true);

    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: created.body.protocol } });
    const inv = await owner.user.create({ data: { tenantId: t.tenantId, email: `i-${Date.now()}@x.com`, fullName: 'Inv', passwordHash: 'x', role: 'INVESTIGATOR' } });
    await http().post(`/complaints/${row.id}/assign`).set(auth).send({ investigatorId: inv.id }).expect(201);
    await http().post(`/complaints/${row.id}/status`).set(auth).send({ status: 'RESOLVED', reason: 'Apuração concluída pelo comitê', conclusion: 'SUBSTANTIATED' }).expect(200);

    const closed = (await lookup()).body;
    expect(closed.timeline.map((x: { status: string }) => x.status)).toEqual(['PENDING', 'IN_PROGRESS', 'RESOLVED']);
    expect(closed.timeline.every((x: { at: string }) => new Date(x.at).getUTCSeconds() === 0)).toBe(true); // mesmo os marcos da equipe
    expect(closed.feedbackDueAt).toBeNull(); // encerramento = retorno dado
    expect(closed.canReportRetaliation).toBe(true);
    expect(JSON.stringify(closed)).not.toMatch(/SUBSTANTIATED|Apuração concluída/); // motivo/conclusão internos não vazam
  });
});

describe('gestão de equipe (lista para o painel)', () => {
  it('só o ADMIN vê; traz suspensos e estado do MFA; nunca hash, segredo nem motivo da suspensão', async () => {
    const t = await createTenant(PASSWORD);
    const login = await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD }).expect(201);
    const auth = { 'x-tenant-slug': t.slug, authorization: `Bearer ${login.body.accessToken}` };
    const inv = await owner.user.create({
      data: { tenantId: t.tenantId, email: `inv-${Date.now()}@x.com`, fullName: 'Inv Suspenso', passwordHash: 'x', role: 'INVESTIGATOR', isBlocked: true, blockedReason: 'motivo interno sigiloso' },
    });
    await owner.user.create({ data: { tenantId: t.tenantId, email: `rep-${Date.now()}@x.com`, fullName: 'Denunciante', passwordHash: 'x', role: 'REPORTER' } });

    const res = await http().get('/users/manage').set(auth).expect(200);
    const suspended = res.body.find((u: { id: string }) => u.id === inv.id);
    expect(suspended).toMatchObject({ role: 'INVESTIGATOR', isBlocked: true, mfaEnabled: false });
    expect(res.body.some((u: { role: string }) => u.role === 'REPORTER')).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|mfaSecret|motivo interno|blockedReason/);

    // Quem não é ADMIN não acessa.
    const reporter = await http().post('/auth/register').set('x-tenant-slug', t.slug).send({ email: `r-${Date.now()}@x.com`, fullName: 'Pessoa Denunciante', password: PASSWORD }).expect(201);
    await http().get('/users/manage').set({ 'x-tenant-slug': t.slug, authorization: `Bearer ${reporter.body.accessToken}` }).expect(403);
  });
});

describe('marca editável pelo ADMIN', () => {
  it('valida cores e endereços, audita só os nomes dos campos e reflete na marca pública', async () => {
    const t = await createTenant(PASSWORD);
    const login = await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD }).expect(201);
    const auth = { 'x-tenant-slug': t.slug, authorization: `Bearer ${login.body.accessToken}` };

    await http().put('/branding').set(auth).send({ primaryColor: 'vermelho' }).expect(400);
    await http().put('/branding').set(auth).send({ logoUrl: 'javascript:alert(1)' }).expect(400);
    await http().put('/branding').set(auth).send({ customCss: 'body{display:none}' }).expect(400); // fora do contrato
    await http().put('/branding').set(auth).send({}).expect(400);

    await http().put('/branding').set(auth).send({ companyName: 'Empresa Nova', primaryColor: '#0a5c36', logoUrl: 'https://exemplo.com/logo.png' }).expect(200);
    const pub = await http().get('/public/branding').set('x-tenant-slug', t.slug).expect(200);
    expect(pub.body).toMatchObject({ companyName: 'Empresa Nova', primaryColor: '#0a5c36', logoUrl: 'https://exemplo.com/logo.png' });

    const log = await owner.auditLog.findFirst({ where: { tenantId: t.tenantId, resource: 'tenant_branding' }, orderBy: { seq: 'desc' } });
    expect(JSON.stringify(log?.details)).toContain('primaryColor');
    expect(JSON.stringify(log?.details)).not.toContain('exemplo.com');

    const reporter = await http().post('/auth/register').set('x-tenant-slug', t.slug).send({ email: `r-${Date.now()}@x.com`, fullName: 'Pessoa Denunciante', password: PASSWORD }).expect(201);
    await http().put('/branding').set({ 'x-tenant-slug': t.slug, authorization: `Bearer ${reporter.body.accessToken}` }).send({ companyName: 'Hack' }).expect(403);
  });
});
