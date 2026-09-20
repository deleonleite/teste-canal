import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { Mailer, OutboxMailer, ResendMailer } from '../src/mail/mailer';
import { NotificationsService } from '../src/notifications/notifications.service';
import { TenantContext } from '../src/scan/attachment-scan.handler';
import { SlaService } from '../src/workflow/sla.service';
import { JobHandlers } from '../src/worker/handlers';
import { closeAll, createTenant, owner } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
let app: INestApplication;
let passwordHash: string;
let mailer: OutboxMailer;
let sla: SlaService;
let notifications: NotificationsService;
let tenants: TenantContext;
let handlers: JobHandlers;

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  mailer = app.get(Mailer) as OutboxMailer;
  sla = app.get(SlaService);
  notifications = app.get(NotificationsService);
  tenants = app.get(TenantContext);
  handlers = app.get(JobHandlers);
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());
const DAY = 86_400_000;
const zeroSeconds = (d: Date | null) => d === null || (d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0);

async function mkUser(tenantId: string, role: UserRole, tag: string, fullName = `Pessoa ${tag}`) {
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const u = await owner.user.create({ data: { tenantId, email, fullName, passwordHash, role } });
  return { id: u.id, email, fullName };
}

const report = (over: Record<string, unknown> = {}) => ({
  isAnonymous: true,
  contentWarningAcknowledged: true,
  type: 'FRAUD',
  title: 'Titulo sigiloso do caso',
  description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas fiscais.',
  involvedPeople: ['Pessoa Externa Qualquer'],
  ...over,
});

async function world() {
  const t = await createTenant(PASSWORD);
  const adminB = await mkUser(t.tenantId, 'ADMIN', 'adminb', 'Beatriz Administradora');
  const inv1 = await mkUser(t.tenantId, 'INVESTIGATOR', 'inv1', 'Carlos Investigador');
  const inv2 = await mkUser(t.tenantId, 'INVESTIGATOR', 'inv2', 'Diana Investigadora');
  const aud = await mkUser(t.tenantId, 'AUDITOR', 'aud', 'Eduardo Auditor');
  const rep = await mkUser(t.tenantId, 'REPORTER', 'rep', 'Fabio Denunciante');
  const adminA = { id: t.adminId, email: t.adminEmail };
  const login = async (email: string) =>
    (await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email, password: PASSWORD }).expect(201)).body.accessToken as string;
  const tok = {
    adminA: await login(adminA.email),
    adminB: await login(adminB.email),
    inv1: await login(inv1.email),
    inv2: await login(inv2.email),
    aud: await login(aud.email),
    rep: await login(rep.email),
  };
  const req = (m: 'get' | 'post' | 'put' | 'patch' | 'delete') => (url: string, token?: string) => {
    const r = http()[m](url).set('x-tenant-slug', t.slug);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  const a = { get: req('get'), post: req('post'), put: req('put'), patch: req('patch'), del: req('delete') };
  const complaint = async (over: Record<string, unknown> = {}, token?: string) => {
    const r = await a.post('/public/complaints', token).send(report(over)).expect(201);
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol: r.body.protocol } });
    return { row, protocol: r.body.protocol as string, key: r.body.accessKey as string, session: r.body.sessionToken as string };
  };
  const setting = (key: string, value: string) => a.put(`/settings/${key}`, tok.adminA).send({ value }).expect(200);
  const notifs = (userId: string) => owner.notification.findMany({ where: { tenantId: t.tenantId, userId }, orderBy: { createdAt: 'asc' } });
  const status = (id: string, token: string, body: Record<string, unknown>) => a.post(`/complaints/${id}/status`, token).send(body);
  return { t, adminA, adminB, inv1, inv2, aud, rep, tok, a, complaint, setting, notifs, status };
}
type W = Awaited<ReturnType<typeof world>>;
const assign = (w: W, id: string, investigatorId: string) => w.a.post(`/complaints/${id}/assign`, w.tok.adminA).send({ investigatorId }).expect(201);

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('máquina de estados e encerramento estruturado', () => {
  it('percorre o fluxo válido; escalada exige instância; encerrar exige conclusão; histórico com status real', async () => {
    const w = await world();
    const c = await w.complaint();
    await assign(w, c.row.id, w.inv1.id);

    await w.status(c.row.id, w.tok.inv1, { status: 'UNDER_REVIEW', reason: 'curto' }).expect(400); // motivo < 10
    await w.status(c.row.id, w.tok.inv1, { status: 'UNDER_REVIEW', reason: 'Entrevistas concluídas, em análise' }).expect(200);
    await w.status(c.row.id, w.tok.inv1, { status: 'ESCALATED', reason: 'Envolve a diretoria estatutária' }).expect(400); // sem instância
    await w.status(c.row.id, w.tok.inv1, { status: 'ESCALATED', reason: 'Envolve a diretoria estatutária', escalatedTo: 'Conselho de Administração' }).expect(200);
    await w.status(c.row.id, w.tok.inv1, { status: 'IN_PROGRESS', reason: 'Conselho devolveu para apuração' }).expect(200);

    await w.status(c.row.id, w.tok.inv1, { status: 'RESOLVED', reason: 'Apuração concluída pelo comitê' }).expect(400); // sem conclusão
    const closed = await w
      .status(c.row.id, w.tok.inv1, {
        status: 'RESOLVED',
        reason: 'Apuração concluída pelo comitê',
        conclusion: 'SUBSTANTIATED',
        correctiveActions: 'Treinamento e advertência formal',
        conclusionNotes: 'Lições aprendidas para o relatório gerencial',
      })
      .expect(200);
    expect(closed.body.previousStatus).toBe('IN_PROGRESS');

    const row = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(row).toMatchObject({ status: 'RESOLVED', conclusion: 'SUBSTANTIATED', correctiveActions: 'Treinamento e advertência formal' });
    expect(row.resolvedAt).not.toBeNull();
    expect(row.feedbackSentAt).not.toBeNull(); // o encerramento conta como retorno ao denunciante
    const days = Math.round((row.followUpUntil!.getTime() - row.resolvedAt!.getTime()) / DAY);
    expect(days).toBe(180); // padrão do acompanhamento pós-caso

    const hist = await owner.complaintStatusHistory.findMany({ where: { complaintId: c.row.id }, orderBy: { createdAt: 'asc' } });
    expect(hist.map((h) => [h.previousStatus, h.newStatus])).toEqual([
      [null, 'PENDING'], ['PENDING', 'IN_PROGRESS'], ['IN_PROGRESS', 'UNDER_REVIEW'], ['UNDER_REVIEW', 'ESCALATED'],
      ['ESCALATED', 'IN_PROGRESS'], ['IN_PROGRESS', 'RESOLVED'],
    ]);
    expect(hist.find((h) => h.newStatus === 'ESCALATED')!.reason).toContain('Conselho de Administração');

    // Auditoria: sem texto livre; com a conclusão.
    const audit = await owner.auditLog.findMany({ where: { tenantId: w.t.tenantId, resource: 'complaint_status', resourceId: c.row.id } });
    expect(audit).toHaveLength(4); // 4 mudanças de status (a atribuição é outro evento)
    expect(JSON.stringify(audit.map((a) => a.details))).not.toMatch(/diretoria|Treinamento|Lições/);
    expect(audit.some((a) => JSON.stringify(a.details).includes('SUBSTANTIATED'))).toBe(true);
  });

  it('bloqueia transições inválidas; só ADMIN reabre (e gera REOPEN)', async () => {
    const w = await world();
    const c = await w.complaint();
    const id = c.row.id;
    await w.status(id, w.tok.adminA, { status: 'PENDING', reason: 'Voltar para pendente por engano' }).expect(400);
    await w.status(id, w.tok.adminA, { status: 'RESOLVED', reason: 'Pular etapas sem investigar', conclusion: 'INCONCLUSIVE' }).expect(400);
    await w.status(id, w.tok.adminA, { status: 'UNDER_REVIEW', reason: 'Pular etapas sem investigar' }).expect(400);
    await w.status(id, w.tok.adminA, { status: 'DISMISSED', reason: 'Improcedente, sem materialidade', conclusion: 'UNSUBSTANTIATED' }).expect(200);

    await w.status(id, w.tok.adminA, { status: 'DISMISSED', reason: 'Já está arquivada mesmo' }).expect(400);
    await w.status(id, w.tok.adminA, { status: 'ESCALATED', reason: 'Não pode escalar um caso encerrado', escalatedTo: 'Conselho' }).expect(400);
    await w.status(id, w.tok.inv1, { status: 'IN_PROGRESS', reason: 'Tentando reabrir sem ser ADMIN' }).expect(403);
    await w.status(id, w.tok.adminA, { status: 'IN_PROGRESS', reason: 'Fato novo trazido pelo denunciante' }).expect(200);

    const row = await owner.complaint.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null, followUpUntil: null });
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, action: 'REOPEN', resourceId: id } })).toBe(1);
  });

  it('perfis fora da matriz e impedidos não alteram o status', async () => {
    const w = await world();
    const c = await w.complaint({ involvedPeople: [w.adminB.fullName] }); // adminB sob suspeita pendente
    const body = { status: 'DISMISSED', reason: 'Tentativa sem permissão', conclusion: 'INCONCLUSIVE' };
    await w.status(c.row.id, w.tok.aud, body).expect(403);
    await w.status(c.row.id, w.tok.rep, body).expect(403);
    await w.a.post(`/complaints/${c.row.id}/status`).send(body).expect(401);
    await w.status(c.row.id, w.tok.adminB, body).expect(403); // suspeito pendente não decide
    await w.a.post(`/complaints/${c.row.id}/recuse`, w.tok.inv2).send({ reason: 'Conflito pessoal com o caso' }).expect(201);
    await w.status(c.row.id, w.tok.inv2, body).expect(404); // impedido não enxerga o caso
  });

  it('"remover" é arquivar: DISMISSED, nunca exclusão física; só ADMIN', async () => {
    const w = await world();
    const c = await w.complaint();
    await w.a.del(`/complaints/${c.row.id}`, w.tok.inv1).expect(403);
    const r = await w.a.del(`/complaints/${c.row.id}`, w.tok.adminA).expect(200);
    expect(r.body.status).toBe('DISMISSED');
    const row = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(row).toMatchObject({ status: 'DISMISSED', conclusion: 'INCONCLUSIVE' });
    const h = await owner.complaintStatusHistory.findFirstOrThrow({ where: { complaintId: c.row.id, newStatus: 'DISMISSED' } });
    expect(h.reason).toBe('Denúncia removida');
    await w.a.del(`/complaints/${c.row.id}`, w.tok.adminA).expect(400); // já encerrada
  });

  it('o anônimo vê a mudança de status como mensagem automática; nada identificador e horários ao minuto', async () => {
    const w = await world();
    const c = await w.complaint();
    await assign(w, c.row.id, w.inv1.id);
    await w.status(c.row.id, w.tok.inv1, { status: 'UNDER_REVIEW', reason: 'Documentos em análise pelo comitê' }).expect(200);
    await w.status(c.row.id, w.tok.inv1, { status: 'RESOLVED', reason: 'Apuração concluída pelo comitê', conclusion: 'UNSUBSTANTIATED' }).expect(200);

    const chat = await w.a.get('/public/channel/messages', c.session).expect(200);
    const texts = chat.body.map((m: { content: string }) => m.content);
    expect(texts).toContain('O status da sua denúncia foi atualizado: Em análise.');
    expect(texts).toContain('Sua denúncia foi encerrada.');
    expect(JSON.stringify(texts)).not.toMatch(/improcedente|UNSUBSTANTIATED|Documentos/i); // conclusão não vai ao denunciante

    const row = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    for (const d of [row.createdAt, row.updatedAt, row.acknowledgedAt, row.ackDueAt, row.ackWarnAt, row.feedbackDueAt, row.feedbackWarnAt, row.feedbackSentAt, row.resolvedAt, row.followUpUntil]) {
      expect(zeroSeconds(d)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('prioridade automática', () => {
  it('sugere por tipo (o denunciante só pode subir); ajuste do triador exige motivo e fica registrado', async () => {
    const w = await world();
    expect((await w.complaint({ type: 'CORRUPTION' })).row.priority).toBe('HIGH');
    expect((await w.complaint({ type: 'HARASSMENT' })).row.priority).toBe('HIGH');
    expect((await w.complaint({ type: 'SAFETY' })).row.priority).toBe('HIGH');
    expect((await w.complaint({ type: 'FRAUD' })).row.priority).toBe('MEDIUM');
    expect((await w.complaint({ type: 'CORRUPTION', priority: 'LOW' })).row.priority).toBe('HIGH'); // não rebaixa
    const bumped = await w.complaint({ type: 'FRAUD', priority: 'CRITICAL' });
    expect(bumped.row.priority).toBe('CRITICAL');

    const c = await w.complaint({ type: 'FRAUD' });
    await w.a.patch(`/complaints/${c.row.id}`, w.tok.inv1).send({ priority: 'LOW' }).expect(400); // sem motivo
    const r = await w.a.patch(`/complaints/${c.row.id}`, w.tok.inv1).send({ priority: 'LOW', reason: 'Valor irrelevante e sem reincidência' }).expect(200);
    expect(r.body.priority).toBe('LOW');
    const comment = await owner.complaintComment.findFirstOrThrow({ where: { complaintId: c.row.id } });
    expect(comment).toMatchObject({ visibility: 'INTERNAL', authorId: w.inv1.id });
    expect(comment.content).toContain('MEDIUM para LOW');
    expect(comment.content).toContain('Valor irrelevante');
    // O motivo (texto livre) fica no comentário interno, não na auditoria.
    const audit = await owner.auditLog.findMany({ where: { tenantId: w.t.tenantId, action: 'UPDATE', resourceId: c.row.id } });
    expect(JSON.stringify(audit.map((a) => a.details))).not.toContain('irrelevante');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('SLAs', () => {
  it('calcula prazos na criação: padrão 7/90 dias, aviso a 80%, recibo automático confirma o recebimento', async () => {
    const w = await world();
    const c = await w.complaint({ type: 'FRAUD' });
    const r = c.row;
    expect(Math.round((r.ackDueAt!.getTime() - r.createdAt.getTime()) / DAY)).toBe(7);
    expect(Math.round((r.feedbackDueAt!.getTime() - r.createdAt.getTime()) / DAY)).toBe(90);
    expect(Math.round((r.feedbackWarnAt!.getTime() - r.createdAt.getTime()) / DAY)).toBe(72); // 80% de 90
    expect(r.acknowledgedAt).not.toBeNull(); // mensagem automática de recebimento
    expect(r.feedbackSentAt).toBeNull();
    const chat = await w.a.get('/public/channel/messages', c.session).expect(200);
    expect(chat.body).toHaveLength(1);
  });

  it('configurável por tenant e por prioridade; valores inválidos são rejeitados', async () => {
    const w = await world();
    await w.a.put('/settings/sla_ack_days', w.tok.adminA).send({ value: 'abc' }).expect(400);
    await w.a.put('/settings/sla_by_priority', w.tok.adminA).send({ value: 'not-json' }).expect(400);
    await w.a.put('/settings/sla_by_priority', w.tok.adminA).send({ value: '{"URGENTE":{"ack":1}}' }).expect(400);
    await w.a.put('/settings/routingRules', w.tok.adminA).send({ value: '[{"match":{"type":"NADA"},"notifyUserIds":[]}]' }).expect(400);
    await w.a.put('/settings/auto_ack_message', w.tok.adminA).send({ value: 'talvez' }).expect(400);

    await w.setting('sla_ack_days', '10');
    await w.setting('sla_feedback_days', '60');
    await w.setting('sla_by_priority', '{"HIGH":{"ack":2,"feedback":30}}');
    const normal = await w.complaint({ type: 'FRAUD' });
    const high = await w.complaint({ type: 'CORRUPTION' }); // HIGH
    const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);
    expect(days(normal.row.ackDueAt!, normal.row.createdAt)).toBe(10);
    expect(days(normal.row.feedbackDueAt!, normal.row.createdAt)).toBe(60);
    expect(days(high.row.ackDueAt!, high.row.createdAt)).toBe(2);
    expect(days(high.row.feedbackDueAt!, high.row.createdAt)).toBe(30);
  });

  it('sem recibo automático o recebimento só é confirmado pelo comitê; o retorno só por mensagem do comitê ou encerramento', async () => {
    const w = await world();
    await w.setting('auto_ack_message', 'false');
    const c = await w.complaint();
    expect(c.row.acknowledgedAt).toBeNull();
    expect((await w.a.get('/public/channel/messages', c.session)).body).toHaveLength(0); // nenhum recibo automático

    await assign(w, c.row.id, w.inv1.id);
    let row = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(row.acknowledgedAt).not.toBeNull(); // triagem/atribuição confirma o recebimento
    expect(row.feedbackSentAt).toBeNull(); // mensagem automática de atribuição NÃO é retorno

    await w.a.post(`/complaints/${c.row.id}/messages`, w.tok.inv1).send({ content: 'Estamos apurando os fatos relatados.' }).expect(201);
    row = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(row.feedbackSentAt).not.toBeNull();
  });

  it('alterar a prioridade recalcula os prazos ainda não cumpridos', async () => {
    const w = await world();
    await w.setting('auto_ack_message', 'false');
    await w.setting('sla_by_priority', '{"CRITICAL":{"ack":1,"feedback":15}}');
    const c = await w.complaint({ type: 'FRAUD' });
    expect(Math.round((c.row.ackDueAt!.getTime() - c.row.createdAt.getTime()) / DAY)).toBe(7);
    await w.a.patch(`/complaints/${c.row.id}`, w.tok.inv1).send({ priority: 'CRITICAL', reason: 'Risco de perda de provas' }).expect(200);
    const row = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(Math.round((row.ackDueAt!.getTime() - row.createdAt.getTime()) / DAY)).toBe(1);
    expect(Math.round((row.feedbackDueAt!.getTime() - row.createdAt.getTime()) / DAY)).toBe(15);
  });

  it('job: SLA_WARNING a 80% e SLA_BREACHED ao vencer; idempotente; ignora encerrados, pausados e cumpridos', async () => {
    const w = await world();
    await w.setting('auto_ack_message', 'false');
    const a = await w.complaint(); // vai receber aviso
    const b = await w.complaint(); // vai vencer
    const paused = await w.complaint();
    const closed = await w.complaint();
    const done = await w.complaint();
    for (const c of [a, b, paused, closed, done]) await assign(w, c.row.id, w.inv1.id); // confirma recebimento
    // reabre o "não confirmado" simulando prazo de recebimento em aberto
    const open = async (id: string, data: Record<string, unknown>) => owner.complaint.update({ where: { id }, data: { acknowledgedAt: null, ...data } });
    const now = Date.now();
    await open(a.row.id, { ackWarnAt: new Date(now - 3600_000), ackDueAt: new Date(now + DAY) });
    await open(b.row.id, { ackWarnAt: new Date(now - 2 * DAY), ackDueAt: new Date(now - 3600_000) });
    await open(paused.row.id, { ackWarnAt: new Date(now - 2 * DAY), ackDueAt: new Date(now - 3600_000), slaPausedAt: new Date(now - 7200_000), slaPauseReason: 'Aguardando informações do denunciante' });
    await open(closed.row.id, { ackDueAt: new Date(now - 3600_000), status: 'RESOLVED' });
    await owner.complaint.update({ where: { id: done.row.id }, data: { ackDueAt: new Date(now - 3600_000) } }); // recebimento cumprido

    const first = await sla.checkTenant(w.t.tenantId);
    expect(first).toMatchObject({ warnings: 1, breaches: 1 });
    expect(await sla.checkTenant(w.t.tenantId)).toEqual({ warnings: 0, breaches: 0 }); // idempotente

    const invNotifs = await w.notifs(w.inv1.id);
    const warn = invNotifs.filter((n) => n.type === 'SLA_WARNING');
    const breach = invNotifs.filter((n) => n.type === 'SLA_BREACHED');
    expect(warn.map((n) => n.relatedId)).toEqual([a.row.id]);
    expect(breach.map((n) => n.relatedId)).toEqual([b.row.id]);
    expect((await w.notifs(w.adminA.id)).filter((n) => n.type === 'SLA_BREACHED')).toHaveLength(1); // ADMINs também
    expect(breach[0]!.message).toContain(b.protocol);
    expect(breach[0]!.message).not.toMatch(/sigiloso|fraude nas notas/i);
    expect(await owner.slaAlert.count({ where: { tenantId: w.t.tenantId } })).toBe(2);

    // Vence depois de já ter avisado: agora é BREACHED (novo nível), uma única vez.
    await owner.complaint.update({ where: { id: a.row.id }, data: { ackDueAt: new Date(now - 1000) } });
    expect(await sla.checkTenant(w.t.tenantId)).toEqual({ warnings: 0, breaches: 1 });
  });

  it('indicadores no detalhe/lista e filtro por situação (no prazo / próximo / vencido)', async () => {
    const w = await world();
    await w.setting('auto_ack_message', 'false');
    const ok = await w.complaint();
    const risk = await w.complaint();
    const late = await w.complaint();
    const now = Date.now();
    await owner.complaint.update({ where: { id: risk.row.id }, data: { ackWarnAt: new Date(now - 1000), ackDueAt: new Date(now + DAY) } });
    await owner.complaint.update({ where: { id: late.row.id }, data: { ackDueAt: new Date(now - 1000) } });

    const ids = async (sla: string) => (await w.a.get(`/complaints?sla=${sla}`, w.tok.adminA).expect(200)).body.data.map((c: { id: string }) => c.id);
    expect(await ids('breached')).toEqual([late.row.id]);
    expect(await ids('at_risk')).toEqual([risk.row.id]);
    expect(await ids('on_time')).toEqual([ok.row.id]);

    const detail = await w.a.get(`/complaints/${late.row.id}`, w.tok.adminA).expect(200);
    expect(detail.body.sla.ack.state).toBe('BREACHED');
    expect(detail.body.sla.feedback.state).toBe('ON_TIME');
    await w.a.get('/complaints?sla=invalido', w.tok.adminA).expect(400);
  });

  it('pausar exige motivo e só vale para caso aberto; retomar empurra os prazos pelo tempo pausado', async () => {
    const w = await world();
    await w.setting('auto_ack_message', 'false');
    const c = await w.complaint();
    await w.a.post(`/complaints/${c.row.id}/sla/pause`, w.tok.aud).send({ reason: 'Aguardando informações do denunciante' }).expect(403);
    await w.a.post(`/complaints/${c.row.id}/sla/pause`, w.tok.inv1).send({ reason: 'curto' }).expect(400);
    await w.a.post(`/complaints/${c.row.id}/sla/pause`, w.tok.inv1).send({ reason: 'Aguardando informações do denunciante' }).expect(200);
    await w.a.post(`/complaints/${c.row.id}/sla/pause`, w.tok.inv1).send({ reason: 'Aguardando informações do denunciante' }).expect(400); // já pausado
    expect((await w.a.get(`/complaints/${c.row.id}`, w.tok.inv1)).body.sla.ack.state).toBe('PAUSED');

    await owner.complaint.update({ where: { id: c.row.id }, data: { slaPausedAt: new Date(Date.now() - 2 * 3600_000) } });
    const before = (await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } })).ackDueAt!;
    await w.a.post(`/complaints/${c.row.id}/sla/resume`, w.tok.inv1).expect(200);
    const after = (await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } })).ackDueAt!;
    expect(Math.abs(after.getTime() - before.getTime() - 2 * 3600_000)).toBeLessThan(60_000);
    await w.a.post(`/complaints/${c.row.id}/sla/resume`, w.tok.inv1).expect(400); // não está pausado
    expect(await owner.auditLog.count({ where: { tenantId: w.t.tenantId, resource: 'complaint_sla' } })).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('notificações', () => {
  it('criação avisa ADMIN e INVESTIGATOR elegíveis (não AUDITOR, não suspeitos); texto sem detalhes', async () => {
    const w = await world();
    const c = await w.complaint({ involvedPeople: [w.inv2.fullName] }); // inv2 sob suspeita pendente
    const who = async (id: string) => (await w.notifs(id)).filter((n) => n.type === 'COMPLAINT_CREATED');
    expect(await who(w.adminA.id)).toHaveLength(1);
    expect(await who(w.adminB.id)).toHaveLength(1);
    expect(await who(w.inv1.id)).toHaveLength(1);
    expect(await who(w.inv2.id)).toHaveLength(0); // suspeito não recebe
    expect(await who(w.aud.id)).toHaveLength(0);
    expect(await who(w.rep.id)).toHaveLength(0);

    const n = (await who(w.inv1.id))[0]!;
    expect(n.message).toContain(c.protocol);
    expect(n.message).toContain('Fraude');
    expect(JSON.stringify(n)).not.toMatch(/sigiloso|Pessoa Externa|Diana/);
    expect(n).toMatchObject({ relatedType: 'complaint', relatedId: c.row.id, isRead: false, inApp: true });
  });

  it('caso restrito: só ADMINs são avisados', async () => {
    const w = await world();
    await w.setting('restrictedTypes', 'HARASSMENT');
    const c = await w.complaint({ type: 'HARASSMENT' });
    expect(c.row.isRestricted).toBe(true);
    const created = async (id: string) => (await w.notifs(id)).filter((n) => n.type === 'COMPLAINT_CREATED').length;
    expect([await created(w.adminA.id), await created(w.adminB.id), await created(w.inv1.id), await created(w.inv2.id)]).toEqual([1, 1, 0, 0]);
  });

  it('atribuição, comentário, mensagem do denunciante e status chegam a quem deve (e não ao autor)', async () => {
    const w = await world();
    const c = await w.complaint({ isAnonymous: false, contentWarningAcknowledged: undefined }, w.tok.rep);
    await assign(w, c.row.id, w.inv1.id);
    expect((await w.notifs(w.inv1.id)).filter((n) => n.type === 'COMPLAINT_ASSIGNED')).toHaveLength(1);

    // Comentário INTERNAL: só o investigador (se não for o autor). REPORTER: também o denunciante.
    await w.a.post(`/complaints/${c.row.id}/comments`, w.tok.adminA).send({ content: 'nota interna' }).expect(201);
    await w.a.post(`/complaints/${c.row.id}/comments`, w.tok.adminA).send({ content: 'pergunta ao denunciante', visibility: 'REPORTER' }).expect(201);
    await w.a.post(`/complaints/${c.row.id}/comments`, w.tok.inv1).send({ content: 'autor não se auto-notifica' }).expect(201);
    expect((await w.notifs(w.inv1.id)).filter((n) => n.type === 'COMPLAINT_COMMENT')).toHaveLength(2);
    expect((await w.notifs(w.rep.id)).filter((n) => n.type === 'COMPLAINT_COMMENT')).toHaveLength(1);

    // Mensagem do denunciante (conta) → investigador atribuído.
    await w.a.post(`/complaints/${c.row.id}/messages`, w.tok.rep).send({ content: 'Tenho mais informações.' }).expect(201);
    expect((await w.notifs(w.inv1.id)).filter((n) => n.type === 'REPORTER_MESSAGE')).toHaveLength(1);

    // Status: investigador (não é o autor) e o denunciante identificado.
    await w.status(c.row.id, w.tok.adminA, { status: 'UNDER_REVIEW', reason: 'Documentos em análise pelo comitê' }).expect(200);
    expect((await w.notifs(w.rep.id)).filter((n) => n.type === 'COMPLAINT_STATUS_CHANGED')).toHaveLength(1);
    expect((await w.notifs(w.inv1.id)).filter((n) => n.type === 'COMPLAINT_STATUS_CHANGED')).toHaveLength(1);
    expect((await w.notifs(w.adminA.id)).filter((n) => n.type === 'COMPLAINT_STATUS_CHANGED')).toHaveLength(0); // autor
  });

  it('mensagem do anônimo sem investigador vai aos ADMINs; com investigador, só a ele', async () => {
    const w = await world();
    const c = await w.complaint();
    await w.a.post('/public/channel/messages', c.session).send({ content: 'Sem investigador ainda.' }).expect(201);
    const admins = async (id: string) => (await w.notifs(id)).filter((n) => n.type === 'REPORTER_MESSAGE').length;
    expect([await admins(w.adminA.id), await admins(w.adminB.id), await admins(w.inv1.id)]).toEqual([1, 1, 0]);
    await assign(w, c.row.id, w.inv1.id);
    await w.a.post('/public/channel/messages', c.session).send({ content: 'Agora com investigador.' }).expect(201);
    expect([await admins(w.adminA.id), await admins(w.inv1.id)]).toEqual([1, 1]);
  });

  it('endpoints do próprio usuário: listar, contar, marcar lida (nunca a de outro), marcar todas', async () => {
    const w = await world();
    await w.complaint();
    await w.complaint();
    const list = await w.a.get('/notifications', w.tok.inv1).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0]).not.toHaveProperty('userId');
    expect((await w.a.get('/notifications/unread-count', w.tok.inv1).expect(200)).body.count).toBe(2);
    await w.a.get('/notifications').expect(401);

    const mine = list.body[0].id as string;
    expect((await w.a.post(`/notifications/${mine}/read`, w.tok.inv2).expect(200)).body.updated).toBe(0); // é do inv1
    expect((await w.a.post(`/notifications/${mine}/read`, w.tok.inv1).expect(200)).body.updated).toBe(1);
    expect((await w.a.get('/notifications?unread=true', w.tok.inv1)).body).toHaveLength(1);
    expect((await w.a.get('/notifications/unread-count', w.tok.inv2)).body.count).toBe(2); // as do inv2 seguem não lidas
    expect((await w.a.post('/notifications/read-all', w.tok.inv1).expect(200)).body.updated).toBe(1);
    expect((await w.a.get('/notifications/unread-count', w.tok.inv1)).body.count).toBe(0);
  });

  it('preferências: silenciar o tipo some da tela/e-mail; críticas ignoram o silenciamento', async () => {
    const w = await world();
    expect((await w.a.get('/notifications/preferences', w.tok.inv1).expect(200)).body).toMatchObject({ emailNotifications: true, inAppNotifications: true });
    await w.a.put('/notifications/preferences', w.tok.inv1).send({ inAppMutedTypes: ['COMPLAINT_ASSIGNED'], emailMutedTypes: ['COMPLAINT_ASSIGNED'], emailDigest: true, emailDigestTime: '07:30' }).expect(200);
    await w.a.put('/notifications/preferences', w.tok.inv1).send({ emailDigestTime: '25:99' }).expect(400);
    await w.a.put('/notifications/preferences', w.tok.inv1).send({ userId: 'x' }).expect(400);

    const c = await w.complaint();
    await assign(w, c.row.id, w.inv1.id);
    expect((await w.notifs(w.inv1.id)).filter((n) => n.type === 'COMPLAINT_ASSIGNED')).toHaveLength(0); // silenciada nos dois canais
    expect((await w.a.get('/notifications', w.tok.inv1)).body.map((n: { type: string }) => n.type)).not.toContain('COMPLAINT_ASSIGNED');

    // Só e-mail (in-app desligado): a linha existe para o outbox, mas não aparece na tela.
    await w.a.put('/notifications/preferences', w.tok.inv2).send({ inAppNotifications: false }).expect(200);
    const c2 = await w.complaint();
    const row = (await w.notifs(w.inv2.id)).find((n) => n.relatedId === c2.row.id)!;
    expect(row).toMatchObject({ inApp: false, emailPending: true });
    expect((await w.a.get('/notifications', w.tok.inv2)).body.map((n: { id: string }) => n.id)).not.toContain(row.id);

    // Crítica (SLA vencido) ignora tudo: mesmo com canais desligados.
    await w.a.put('/notifications/preferences', w.tok.inv1).send({ inAppNotifications: false, emailNotifications: false }).expect(200);
    await w.setting('auto_ack_message', 'false');
    const late = await w.complaint();
    await assign(w, late.row.id, w.inv1.id);
    await owner.complaint.update({ where: { id: late.row.id }, data: { acknowledgedAt: null, ackDueAt: new Date(Date.now() - 1000) } });
    await sla.checkTenant(w.t.tenantId);
    const critical = (await w.notifs(w.inv1.id)).filter((n) => n.type === 'SLA_BREACHED');
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({ inApp: true, emailPending: true });
  });

  it('suspeita de conflito avisa só os ADMINs revisores; leitura pelo suspeito gera alerta; redistribuição avisa o novo investigador', async () => {
    const w = await world();
    const c = await w.complaint({ involvedPeople: [w.adminB.fullName] }); // adminB suspeito
    const suspected = async (id: string) => (await w.notifs(id)).filter((n) => n.type === 'CONFLICT_SUSPECTED');
    expect(await suspected(w.adminA.id)).toHaveLength(1); // revisor
    expect(await suspected(w.adminB.id)).toHaveLength(0); // o suspeito NÃO é avisado

    await w.a.get(`/complaints/${c.row.id}`, w.tok.adminB).expect(200); // leitura reforçada
    const alerts = await suspected(w.adminA.id);
    expect(alerts).toHaveLength(2);
    expect(alerts.some((n) => (n.data as { kind?: string })?.kind === 'suspect_read')).toBe(true);

    // Redistribuição: inv1 atribuído se declara impedido → inv2 recebe.
    await assign(w, c.row.id, w.inv1.id);
    await w.a.post(`/complaints/${c.row.id}/recuse`, w.tok.inv1).send({ reason: 'Conflito pessoal com o caso' }).expect(201);
    expect((await w.notifs(w.inv2.id)).filter((n) => n.type === 'RECUSAL_REASSIGNED')).toHaveLength(1);
  });

  it('roteamento configurável: destinatários extras por tipo/departamento', async () => {
    const w = await world();
    await w.setting('routingRules', JSON.stringify([{ match: { type: 'FRAUD' }, notifyUserIds: [w.aud.id] }]));
    await w.complaint({ type: 'FRAUD' });
    await w.complaint({ type: 'ETHICS' });
    const got = (await w.notifs(w.aud.id)).filter((n) => n.type === 'COMPLAINT_CREATED');
    expect(got).toHaveLength(1);
    expect(got[0]!.message).toContain('Fraude');
  });

  it('falha de notificação nunca desfaz a operação de negócio', async () => {
    const w = await world();
    // Simula falha total do módulo de notificações no meio do fluxo.
    (notifications as unknown as { persist: () => Promise<never> }).persist = async () => {
      throw new Error('falha simulada');
    };
    try {
      const c = await w.complaint();
      await assign(w, c.row.id, w.inv1.id);
      await w.status(c.row.id, w.tok.inv1, { status: 'UNDER_REVIEW', reason: 'Em análise, sem notificações' }).expect(200);
      expect((await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } })).status).toBe('UNDER_REVIEW');
      expect(await owner.notification.count({ where: { tenantId: w.t.tenantId } })).toBe(0);
    } finally {
      delete (notifications as unknown as { persist?: unknown }).persist; // volta ao método do protótipo
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('e-mail', () => {
  const mailsTo = (to: string) => mailer.sent.filter((m) => m.to === to);

  it('denúncia identificada: e-mail imediato só com protocolo/tipo e link autenticado', async () => {
    const w = await world();
    const before = mailsTo(w.inv1.email).length;
    const c = await w.complaint({ isAnonymous: false, contentWarningAcknowledged: undefined }, w.tok.rep);
    const mail = mailsTo(w.inv1.email).slice(before).pop()!;
    expect(mail.subject).toBe('Nova denúncia aguardando triagem');
    expect(mail.text).toContain(c.protocol);
    expect(mail.text).toContain(`/${w.t.slug}/complaints/${c.row.id}`);
    expect(mail.text).not.toMatch(/sigiloso|fraude nas notas|Pessoa Externa/);
    const row = (await w.notifs(w.inv1.id)).find((n) => n.relatedId === c.row.id)!;
    expect(row).toMatchObject({ emailSent: true, emailPending: false });
  });

  it('denúncia ANÔNIMA: nenhum e-mail no instante do evento; só o sweep envia, com horário ao minuto', async () => {
    const w = await world();
    const before = mailer.sent.length;
    const c = await w.complaint();
    expect(mailer.sent.length).toBe(before); // nada saiu no ato
    const rows = (await w.notifs(w.inv1.id)).filter((n) => n.relatedId === c.row.id);
    expect(rows[0]).toMatchObject({ emailPending: true, emailSent: false });
    expect(zeroSeconds(rows[0]!.createdAt)).toBe(true);

    // O envio tem atraso aleatório (2–4 min, ao minuto): antes disso o sweep não manda nada.
    expect(rows[0]!.emailSendAfter!.getTime() - Date.now()).toBeGreaterThan(60_000);
    expect(zeroSeconds(rows[0]!.emailSendAfter)).toBe(true);
    await handlers.handle('notification-email', { tenantId: w.t.tenantId });
    expect(mailer.sent.length).toBe(before);
    await owner.notification.updateMany({ where: { tenantId: w.t.tenantId }, data: { emailSendAfter: new Date(Date.now() - 1000) } });
    await handlers.handle('notification-email', { tenantId: w.t.tenantId });
    expect(mailsTo(w.inv1.email).length).toBeGreaterThanOrEqual(1);
    expect((await w.notifs(w.inv1.id)).find((n) => n.relatedId === c.row.id)).toMatchObject({ emailSent: true, emailPending: false });
    expect(mailer.sent.slice(before).every((m) => !/sigiloso|fraude nas notas/.test(m.text))).toBe(true);
  });

  it('falha do provedor de e-mail não derruba a operação; fica pendente com o erro e é reenviado depois', async () => {
    const w = await world();
    const realSend = mailer.send.bind(mailer);
    mailer.send = async () => {
      throw new Error('provedor fora do ar');
    };
    let c;
    try {
      c = await w.complaint({ isAnonymous: false, contentWarningAcknowledged: undefined }, w.tok.rep);
    } finally {
      mailer.send = realSend;
    }
    const row = (await w.notifs(w.inv1.id)).find((n) => n.relatedId === c.row.id)!;
    expect(row).toMatchObject({ emailSent: false, emailPending: true });
    expect(row.emailError).toContain('provedor fora do ar');

    await handlers.handle('notification-email', { tenantId: w.t.tenantId });
    expect((await w.notifs(w.inv1.id)).find((n) => n.relatedId === c.row.id)).toMatchObject({ emailSent: true, emailPending: false, emailError: null });
  });

  it('adaptador Resend: chamada HTTP correta e erro do provedor lança', async () => {
    const seen: Array<{ auth?: string; body: Record<string, unknown> }> = [];
    let status = 200;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.statusCode = status;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const resend = new ResendMailer('re_test_key', 'OuviON <nao-responda@ouvion.com>', `http://127.0.0.1:${port}`);
      await resend.send({ to: 'a@b.com', subject: 'Assunto', text: 'Corpo' });
      expect(seen[0]).toEqual({
        auth: 'Bearer re_test_key',
        body: { from: 'OuviON <nao-responda@ouvion.com>', to: ['a@b.com'], subject: 'Assunto', text: 'Corpo' },
      });
      status = 500;
      await expect(resend.send({ to: 'a@b.com', subject: 'x', text: 'y' })).rejects.toThrow(/500/);
    } finally {
      server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('casos relacionados', () => {
  it('sugere por citado em comum (ignora acento/caixa), o triador confirma o vínculo nos dois sentidos', async () => {
    const w = await world();
    const a = await w.complaint({ involvedPeople: ['João Sávio', 'Outro Nome'] });
    const b = await w.complaint({ involvedPeople: ['joao savio'], location: 'Filial Sul' });
    await w.complaint({ involvedPeople: ['Pessoa Sem Relação'] });

    const s = await w.a.get(`/complaints/${a.row.id}/related-suggestions`, w.tok.inv1).expect(200);
    expect(s.body.enabled).toBe(true);
    expect(s.body.suggestions.map((x: { id: string }) => x.id)).toEqual([b.row.id]);
    expect(s.body.suggestions[0]).toMatchObject({ sharedPeople: 1 });

    await w.a.post(`/complaints/${a.row.id}/links`, w.tok.aud).send({ relatedId: b.row.id }).expect(403);
    await w.a.post(`/complaints/${a.row.id}/links`, w.tok.inv1).send({ relatedId: a.row.id }).expect(400);
    await w.a.post(`/complaints/${a.row.id}/links`, w.tok.inv1).send({ relatedId: b.row.id }).expect(201);
    await w.a.post(`/complaints/${a.row.id}/links`, w.tok.inv1).send({ relatedId: b.row.id }).expect(400); // duplicado
    expect((await owner.complaint.findUniqueOrThrow({ where: { id: a.row.id } })).linkedComplaintIds).toEqual([b.row.id]);
    expect((await owner.complaint.findUniqueOrThrow({ where: { id: b.row.id } })).linkedComplaintIds).toEqual([a.row.id]);
    // Já vinculado não é sugerido de novo.
    expect((await w.a.get(`/complaints/${a.row.id}/related-suggestions`, w.tok.inv1)).body.suggestions).toHaveLength(0);
  });

  it('respeita casos restritos e a chave de sigilo máximo', async () => {
    const w = await world();
    const a = await w.complaint({ involvedPeople: ['Fulano de Tal'] });
    await w.setting('restrictedTypes', 'CORRUPTION');
    const secret = await w.complaint({ type: 'CORRUPTION', involvedPeople: ['Fulano de Tal'] });
    expect(secret.row.isRestricted).toBe(true);
    expect((await w.a.get(`/complaints/${a.row.id}/related-suggestions`, w.tok.inv1)).body.suggestions).toHaveLength(0); // restrito não vaza
    expect((await w.a.get(`/complaints/${a.row.id}/related-suggestions`, w.tok.adminA)).body.suggestions.map((x: { id: string }) => x.id)).toEqual([secret.row.id]);
    await w.a.post(`/complaints/${a.row.id}/links`, w.tok.inv1).send({ relatedId: secret.row.id }).expect(404);

    await w.setting('encrypt_complaint_body', 'true');
    expect((await w.a.get(`/complaints/${a.row.id}/related-suggestions`, w.tok.adminA)).body).toEqual({ enabled: false, suggestions: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('acompanhamento pós-caso: retaliação', () => {
  async function closed(w: W, over: Record<string, unknown> = {}, token?: string) {
    const c = await w.complaint(over, token);
    await assign(w, c.row.id, w.inv1.id);
    await w.status(c.row.id, w.tok.inv1, { status: 'RESOLVED', reason: 'Apuração concluída pelo comitê', conclusion: 'SUBSTANTIATED' }).expect(200);
    return c;
  }

  it('anônimo: relato de retaliação gera caso NOVO, vinculado, HIGH, com o mesmo anonimato e nova chave', async () => {
    const w = await world();
    const c = await closed(w);
    const res = await w.a.post('/public/channel/retaliation', c.session).send({ content: 'Fui rebaixado de função depois da denúncia.' }).expect(201);
    expect(res.body.protocol).toMatch(/^DEN-\d{4}-[A-Z0-9]{6}$/);
    expect(res.body.protocol).not.toBe(c.protocol);
    expect(res.body.accessKey).toMatch(/^([A-Z0-9]{4}-){4}[A-Z0-9]{4}$/);
    expect(res.body.sessionToken).toBeTruthy();

    const novo = await owner.complaint.findUniqueOrThrow({ where: { protocol: res.body.protocol } });
    expect(novo).toMatchObject({ isAnonymous: true, priority: 'HIGH', status: 'PENDING', createdBy: null, type: 'FRAUD' });
    expect(novo.linkedComplaintIds).toEqual([c.row.id]);
    expect([novo.createdAt, novo.ackDueAt, novo.feedbackDueAt].every((d) => zeroSeconds(d))).toBe(true);
    const original = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(original.retaliationReported).toBe(true);
    expect(original.linkedComplaintIds).toEqual([novo.id]);
    expect(original.status).toBe('RESOLVED'); // o caso original não muda

    // A chave nova funciona e o comitê foi avisado.
    await w.a.post('/public/complaints/lookup').send({ protocol: res.body.protocol, accessKey: res.body.accessKey }).expect(200);
    expect((await w.notifs(w.adminA.id)).filter((n) => n.relatedId === novo.id && n.type === 'COMPLAINT_CREATED')).toHaveLength(1);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.t.tenantId, resourceId: novo.id, action: 'CREATE' } });
    expect(audit).toMatchObject({ anonymousOrigin: true, userId: null, ipAddress: null });
  });

  it('só após o encerramento e dentro do período de acompanhamento; o prazo é configurável', async () => {
    const w = await world();
    const open = await w.complaint();
    await w.a.post('/public/channel/retaliation', open.session).send({ content: 'Sofri retaliação enquanto o caso está aberto.' }).expect(400);

    await w.setting('retaliationFollowUpDays', '10');
    const c = await closed(w);
    const row = await owner.complaint.findUniqueOrThrow({ where: { id: c.row.id } });
    expect(Math.round((row.followUpUntil!.getTime() - row.resolvedAt!.getTime()) / DAY)).toBe(10);

    await owner.complaint.update({ where: { id: c.row.id }, data: { followUpUntil: new Date(Date.now() - 1000) } });
    await w.a.post('/public/channel/retaliation', c.session).send({ content: 'Fui perseguido depois do prazo de acompanhamento.' }).expect(400);
    await w.a.post('/public/channel/retaliation', c.session).send({ content: 'curto' }).expect(400);
  });

  it('REPORTER com conta relata na própria denúncia; herda restrição e identidade cifrada', async () => {
    const w = await world();
    await w.setting('restrictedTypes', 'HARASSMENT');
    const c = await closed(w, { type: 'HARASSMENT', isAnonymous: false, contentWarningAcknowledged: undefined, reporterEmail: 'fabio.real@empresa.com' }, w.tok.rep);
    await w.a.post(`/complaints/${c.row.id}/retaliation`, w.tok.inv1).send({ content: 'Tentativa de outro perfil que não deveria valer.' }).expect(403);
    const other = await mkUser(w.t.tenantId, 'REPORTER', 'rep2');
    const otherTok = (await http().post('/auth/login').set('x-tenant-slug', w.t.slug).send({ email: other.email, password: PASSWORD }).expect(201)).body.accessToken;
    await w.a.post(`/complaints/${c.row.id}/retaliation`, otherTok).send({ content: 'Não é o meu caso, deve ser recusado.' }).expect(403);

    const res = await w.a.post(`/complaints/${c.row.id}/retaliation`, w.tok.rep).send({ content: 'Meu gestor passou a me isolar da equipe.' }).expect(201);
    const novo = await owner.complaint.findUniqueOrThrow({ where: { protocol: res.body.protocol } });
    expect(novo).toMatchObject({ isAnonymous: false, createdBy: w.rep.id, isRestricted: true, priority: 'HIGH' });
    expect(novo.reporterEmailEnc).toBe(c.row.reporterEmailEnc); // mesma identidade cifrada, nada em claro
    // Restrito: investigador não atribuído não vê o novo caso.
    await w.a.get(`/complaints/${novo.id}`, w.tok.inv2).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('SUÍTE DE ANONIMATO — extensão da Fase 5A (e-mails, notificações, status, retaliação)', () => {
  const UA = 'AnonProbe5A/1.0 (marcador-5a-unico)';
  const NEEDLES = ['marcador-5a-unico', '203.0.113.99', '127.0.0.1', '::ffff', '"::1"'];

  it('nenhum IP/UA/chave em lugar algum e nenhum carimbo fino nas linhas de origem anônima', async () => {
    const t = await createTenant(PASSWORD);
    const inv = await mkUser(t.tenantId, 'INVESTIGATOR', 'inv');
    const workflow = app.get((await import('../src/workflow/workflow.service')).WorkflowService);
    const complaints = app.get((await import('../src/complaints/complaints.service')).ComplaintsService);
    const tenantCtx = app.get(TenantContext);
    const staff = { userId: inv.id, role: 'INVESTIGATOR' as const }; // sem IP/UA: não há login de equipe neste tenant
    const admin = { userId: t.adminId, role: 'ADMIN' as const };
    const mailsBefore = mailer.sent.length;

    const anon = (m: 'get' | 'post', url: string, token?: string) => {
      const r = http()[m](url).set('x-tenant-slug', t.slug).set('user-agent', UA).set('x-forwarded-for', '203.0.113.99');
      return token ? r.set('authorization', `Bearer ${token}`) : r;
    };
    const created = await anon('post', '/public/complaints').send(report());
    expect(created.status).toBe(201);
    const { protocol, accessKey, sessionToken } = created.body as { protocol: string; accessKey: string; sessionToken: string };
    const row = await owner.complaint.findUniqueOrThrow({ where: { protocol } });

    // Comitê atua (sem IP): atribui e encerra; o anônimo conversa e depois relata retaliação.
    await tenantCtx.run(t.tenantId, () => complaints.assign(admin, row.id, inv.id));
    await anon('post', '/public/channel/messages', sessionToken).send({ content: 'Mensagem anônima durante a apuração.' }).expect(201);
    await tenantCtx.run(t.tenantId, () => workflow.changeStatus(staff, row.id, { status: 'RESOLVED', reason: 'Apuração concluída pelo comitê', conclusion: 'SUBSTANTIATED' }));
    const retaliation = await anon('post', '/public/channel/retaliation', sessionToken).send({ content: 'Fui perseguido após a denúncia original.' });
    expect(retaliation.status).toBe(201);
    const newKey = retaliation.body.accessKey as string;

    // E-mails só depois do atraso aleatório; o conteúdo não carrega nada do remetente.
    expect(mailer.sent.length).toBe(mailsBefore);
    await owner.notification.updateMany({ where: { tenantId: t.tenantId }, data: { emailSendAfter: new Date(Date.now() - 1000) } });
    await handlers.handle('notification-email', { tenantId: t.tenantId });
    const newMails = mailer.sent.slice(mailsBefore);
    expect(newMails.length).toBeGreaterThan(0);

    // 1) Varredura de TODAS as tabelas com dados do tenant.
    const tables = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`;
    const dump: string[] = [];
    for (const { table_name } of tables) {
      const rows = await owner.$queryRawUnsafe<{ j: string }[]>(`SELECT to_jsonb(x)::text AS j FROM "${table_name}" x WHERE tenant_id = '${t.tenantId}'`);
      dump.push(...rows.map((r) => r.j));
    }
    const everything = dump.join('\n');
    for (const needle of [...NEEDLES, accessKey, accessKey.replace(/-/g, ''), newKey, newKey.replace(/-/g, '')]) {
      expect(everything).not.toContain(needle);
    }
    // 2) E-mails (fila de saída) e log de notificações.
    const mailText = JSON.stringify(newMails);
    for (const needle of [...NEEDLES, accessKey, newKey]) expect(mailText).not.toContain(needle);

    // 3) Carimbos: nenhuma linha de origem anônima com horário fino.
    const cases = await owner.complaint.findMany({ where: { tenantId: t.tenantId, isAnonymous: true } });
    expect(cases).toHaveLength(2); // original + retaliação
    for (const c of cases) {
      const times = [c.createdAt, c.updatedAt, c.acknowledgedAt, c.ackDueAt, c.ackWarnAt, c.feedbackDueAt, c.feedbackWarnAt, c.feedbackSentAt, c.resolvedAt, c.followUpUntil];
      expect(times.every((d) => zeroSeconds(d))).toBe(true);
      expect(c.createdBy).toBeNull();
    }
    const msgs = await owner.complaintMessage.findMany({ where: { tenantId: t.tenantId } });
    expect(msgs.length).toBeGreaterThanOrEqual(4); // recibos, atribuição, mensagem, status/encerramento
    expect(msgs.every((m) => zeroSeconds(m.createdAt) && zeroSeconds(m.readAt))).toBe(true);
    const notifs = await owner.notification.findMany({ where: { tenantId: t.tenantId } });
    expect(notifs.length).toBeGreaterThan(0);
    for (const n of notifs) {
      expect(zeroSeconds(n.createdAt)).toBe(true);
      expect(n.message).not.toMatch(/sigiloso|Mensagem anônima|perseguido/);
    }
    const audits = await owner.auditLog.findMany({ where: { tenantId: t.tenantId, anonymousOrigin: true } });
    expect(audits.length).toBe(3); // criação, mensagem e retaliação (atribuição/encerramento são da equipe)
    expect(audits.every((a) => a.ipAddress === null && a.userAgent === null && a.userId === null && zeroSeconds(a.timestamp))).toBe(true);
    // Sem cookie em nenhuma resposta anônima.
    expect([created, retaliation].every((r) => r.headers['set-cookie'] === undefined)).toBe(true);
  });
});
