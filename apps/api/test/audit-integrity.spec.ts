import { createHash } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';

import { Anchor, MemoryAnchor, WormBucketAnchor } from '../src/audit/anchor';
import { AuditIntegrityService, merkleRoot } from '../src/audit/integrity.service';
import { AppModule } from '../src/app.module';
import { JobHandlers } from '../src/worker/handlers';
import { asTenant, closeAll, createTenant, owner, runtime } from './helpers';

const PASSWORD = 'Senha-Forte-123!';
let app: INestApplication;
let integrity: AuditIntegrityService;
let anchor: MemoryAnchor;
let handlers: JobHandlers;
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  integrity = app.get(AuditIntegrityService);
  anchor = app.get(Anchor) as MemoryAnchor;
  handlers = app.get(JobHandlers);
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

const http = () => request(app.getHttpServer());

/** Gera `n` eventos de auditoria como a aplicação (papel app_runtime, trigger calcula seq e hash). */
async function emit(tenantId: string, n: number, resource = 'complaint'): Promise<void> {
  for (let i = 0; i < n; i++) {
    await asTenant(tenantId, (tx) =>
      tx.auditLog.create({ data: { tenantId, action: 'READ', resource, resourceId: `r${i}`, details: { i } } }),
    );
  }
}

/** Transação de negócio revertida: consome um número da SEQUENCE (buraco benigno). */
async function rolledBackEvent(tenantId: string): Promise<void> {
  await runtime
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.auditLog.create({ data: { tenantId, action: 'CREATE', resource: 'complaint' } });
      throw new Error('rollback proposital');
    })
    .catch(() => undefined);
}

/** Simula um DBA mal-intencionado: desliga triggers de proteção, altera e religa. */
async function asRogueDba(triggers: Array<[string, string]>, sql: string): Promise<void> {
  await owner.$transaction(async (tx) => {
    for (const [table, trg] of triggers) await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trg}`);
    await tx.$executeRawUnsafe(sql);
    for (const [table, trg] of triggers) await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trg}`);
  });
}

const SEAL_GUARD: [string, string] = ['audit_logs', 'audit_logs_seal_guard'];
const SEALS_GUARD: [string, string] = ['audit_seals', 'audit_seals_guard'];
const problemTypes = async (tenantId: string) => (await integrity.verifyTenant(tenantId)).problems.map((p) => p.type);

describe('selos Merkle', () => {
  it('sela os registros novos, encadeia os selos e a raiz é reproduzível de fora', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 10);
    expect(await integrity.sealTenant(t.tenantId)).toBe(1);

    const s1 = await owner.auditSeal.findFirstOrThrow({ where: { tenantId: t.tenantId } });
    expect(s1).toMatchObject({ fromSeq: 1n, toSeq: 10n, rowCount: 10, prevSealHash: null, gaps: [] });
    const rows = await owner.auditLog.findMany({ where: { tenantId: t.tenantId }, orderBy: { seq: 'asc' } });
    expect(rows.every((r) => r.sealId === s1.id)).toBe(true);
    expect(s1.merkleRoot).toBe(merkleRoot(rows.map((r) => r.rowHash)));

    // Reproduz a raiz "de fora", só com SHA-256 e os rowHash (o que um auditor externo faria).
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    let level = rows.map((r) => sha(`L${r.rowHash}`));
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(sha(`N${level[i]}${level[i + 1] ?? level[i]}`));
      level = next;
    }
    expect(level[0]).toBe(s1.merkleRoot);

    expect(await integrity.sealTenant(t.tenantId)).toBe(0); // nada novo
    await emit(t.tenantId, 3);
    expect(await integrity.sealTenant(t.tenantId)).toBe(1);
    const s2 = await owner.auditSeal.findFirstOrThrow({ where: { tenantId: t.tenantId }, orderBy: { toSeq: 'desc' } });
    expect(s2).toMatchObject({ fromSeq: 11n, toSeq: 13n, prevSealHash: s1.sealHash });
    expect(await integrity.verifyTenant(t.tenantId)).toMatchObject({ ok: true, sealsChecked: 2, problems: [] });
  });

  it('seq é por tenant e o selo de um não mistura registros do outro', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await emit(a.tenantId, 4);
    await emit(b.tenantId, 2);
    await integrity.sealTenant(a.tenantId);
    await integrity.sealTenant(b.tenantId);
    expect((await owner.auditSeal.findFirstOrThrow({ where: { tenantId: a.tenantId } })).rowCount).toBe(4);
    expect((await owner.auditSeal.findFirstOrThrow({ where: { tenantId: b.tenantId } })).rowCount).toBe(2);
  });

  it('buraco de rollback é benigno: fica registrado no selo e a verificação passa', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 2);
    await rolledBackEvent(t.tenantId); // consome seq 3 sem gravar registro
    await emit(t.tenantId, 2);
    await integrity.sealTenant(t.tenantId);
    const seal = await owner.auditSeal.findFirstOrThrow({ where: { tenantId: t.tenantId } });
    expect(seal.gaps).toEqual([3n]);
    expect(seal.rowCount).toBe(4);
    expect((await integrity.verifyTenant(t.tenantId)).ok).toBe(true);
  });

  it('remoção ANTES do selo deixa um buraco visível, mesmo sem o conteúdo', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 5);
    const victim = await owner.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, seq: 3n } });
    await owner.$executeRaw`DELETE FROM audit_logs WHERE id = ${victim.id}::uuid`; // dono do schema apaga
    await integrity.sealTenant(t.tenantId);
    const seal = await owner.auditSeal.findFirstOrThrow({ where: { tenantId: t.tenantId } });
    expect(seal.gaps).toEqual([3n]); // o evento sumiu, o número não
  });
});

describe('detecção de adulteração', () => {
  it('a proteção normal barra até o dono do schema (registro selado e selo são imutáveis)', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 3);
    await integrity.sealTenant(t.tenantId);
    await expect(owner.$executeRaw`UPDATE audit_logs SET details = '{"x":1}'::jsonb WHERE tenant_id = ${t.tenantId}::uuid`).rejects.toThrow(/imutável/);
    await expect(owner.$executeRaw`UPDATE audit_seals SET merkle_root = 'x' WHERE tenant_id = ${t.tenantId}::uuid`).rejects.toThrow(/imutável/);
    // A aplicação nem consegue tocar nas colunas.
    await expect(
      asTenant(t.tenantId, (tx) => tx.$executeRawUnsafe(`UPDATE audit_seals SET seal_hash = 'x'`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asTenant(t.tenantId, (tx) => tx.$executeRawUnsafe(`UPDATE audit_logs SET row_hash = 'x'`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('DBA que desliga o trigger e reescreve um registro selado é flagrado (rowHash e Merkle)', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 6);
    await integrity.sealTenant(t.tenantId);
    expect(await problemTypes(t.tenantId)).toEqual([]);
    await asRogueDba([SEAL_GUARD], `UPDATE audit_logs SET resource = 'adulterado' WHERE tenant_id = '${t.tenantId}' AND seq = 2`);
    expect(await problemTypes(t.tenantId)).toContain('row_hash_mismatch');
  });

  it('DBA que apaga um registro já selado é flagrado (contagem/raiz e buraco novo)', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 6);
    await integrity.sealTenant(t.tenantId);
    await asRogueDba([SEAL_GUARD], `DELETE FROM audit_logs WHERE tenant_id = '${t.tenantId}' AND seq = 4`);
    expect(await problemTypes(t.tenantId)).toContain('seal_mismatch');
  });

  it('registro inserido em intervalo JÁ selado é apontado como tardio', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 2);
    await rolledBackEvent(t.tenantId); // seq 3 livre
    await emit(t.tenantId, 2);
    await integrity.sealTenant(t.tenantId);
    // Insere "atrás" do selo, com hash correto, desligando o trigger de sequência.
    await asRogueDba(
      [['audit_logs', 'audit_logs_before_insert']],
      `INSERT INTO audit_logs (tenant_id, seq, action, resource, "timestamp", row_hash)
       VALUES ('${t.tenantId}', 3, 'READ', 'forjado', now(),
         audit_compute_hash('${t.tenantId}', 3, NULL, 'READ', 'forjado', NULL, NULL, now()::timestamp(3)))`,
    );
    expect(await problemTypes(t.tenantId)).toContain('late_row');
  });

  it('cadeia de selos: remover ou trocar um selo do meio quebra o encadeamento', async () => {
    const t = await createTenant();
    for (let i = 0; i < 3; i++) {
      await emit(t.tenantId, 2);
      await integrity.sealTenant(t.tenantId);
    }
    expect((await integrity.verifyTenant(t.tenantId)).sealsChecked).toBe(3);
    const middle = await owner.auditSeal.findFirstOrThrow({ where: { tenantId: t.tenantId, fromSeq: 3n } });
    await asRogueDba([SEALS_GUARD, SEAL_GUARD], `DELETE FROM audit_seals WHERE id = '${middle.id}'`);
    const types = await problemTypes(t.tenantId);
    expect(types).toContain('chain_break');
    expect(types).toContain('orphan_seal_ref');
  });

  it('sequência de rowHash: hash recalculado pelo banco usa a MESMA função do trigger', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 3);
    const rows = await owner.$queryRaw<{ ok: boolean }[]>`
      SELECT row_hash = audit_compute_hash(tenant_id, seq, user_id, action::text, resource, resource_id, details, "timestamp") AS ok
      FROM audit_logs WHERE tenant_id = ${t.tenantId}::uuid`;
    expect(rows.every((r) => r.ok)).toBe(true);
  });
});

describe('âncora externa', () => {
  it('publica o hash do último selo fora do banco; adulterar o selo OU a âncora é detectado', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 4);
    await integrity.sealTenant(t.tenantId);
    const ref = await integrity.anchorTenant(t.tenantId);
    expect(ref).toMatch(/^memory:\/\/anchors\//);
    const seal = await owner.auditSeal.findFirstOrThrow({ where: { tenantId: t.tenantId } });
    expect(seal).toMatchObject({ anchorType: 'WORM_BUCKET', anchorRef: ref });
    expect(anchor.objects.get(ref!)!.sealHash).toBe(seal.sealHash);
    expect(await integrity.anchorTenant(t.tenantId)).toBeNull(); // já ancorado
    expect((await integrity.verifyTenant(t.tenantId)).ok).toBe(true);

    // Selo ancorado é imutável (mesmo para o dono do schema).
    await expect(owner.$executeRaw`UPDATE audit_seals SET anchor_ref = 'outro' WHERE id = ${seal.id}::uuid`).rejects.toThrow(/imutável/);

    // Âncora adulterada / sumida => alerta.
    anchor.objects.get(ref!)!.sealHash = 'f'.repeat(64);
    expect(await problemTypes(t.tenantId)).toContain('anchor_mismatch');
    anchor.objects.delete(ref!);
    expect(await problemTypes(t.tenantId)).toContain('anchor_missing');
  });

  it('um selo âncora cobre os anteriores; novos selos precisam de nova âncora', async () => {
    const t = await createTenant();
    for (let i = 0; i < 2; i++) {
      await emit(t.tenantId, 2);
      await integrity.sealTenant(t.tenantId);
    }
    const ref = await integrity.anchorTenant(t.tenantId);
    const seals = await owner.auditSeal.findMany({ where: { tenantId: t.tenantId } });
    expect(seals.every((s) => s.anchorRef === ref)).toBe(true);
    await emit(t.tenantId, 1);
    await integrity.sealTenant(t.tenantId);
    const ref2 = await integrity.anchorTenant(t.tenantId);
    expect(ref2).not.toBe(ref);
    expect((await integrity.verifyTenant(t.tenantId)).ok).toBe(true);
  });

  it('sem âncora há mais de 48 h: alerta; lista de tenants sem âncora recente', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 2);
    await integrity.sealTenant(t.tenantId);
    expect(await integrity.tenantsWithoutRecentAnchor(48)).toContain(t.tenantId);
    await asRogueDba([SEALS_GUARD], `UPDATE audit_seals SET sealed_at = now() - interval '3 days' WHERE tenant_id = '${t.tenantId}'`);
    // (sealedAt alterado invalida o hash do selo — aqui só interessa o alerta de âncora)
    expect(await problemTypes(t.tenantId)).toContain('anchor_stale');
    await asRogueDba([SEALS_GUARD], `UPDATE audit_seals SET sealed_at = now() WHERE tenant_id = '${t.tenantId}'`);
    await integrity.anchorTenant(t.tenantId);
    expect(await integrity.tenantsWithoutRecentAnchor(48)).not.toContain(t.tenantId);
  });
});

describe('jobs e API', () => {
  async function staff(role: UserRole, tenantId: string, slug: string) {
    const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@x.com`;
    await owner.user.create({ data: { tenantId, email, fullName: role, passwordHash, role } });
    const r = await http().post('/auth/login').set('x-tenant-slug', slug).send({ email, password: PASSWORD }).expect(201);
    return r.body.accessToken as string;
  }

  it('os jobs audit-seal / audit-anchor / audit-verify fazem o fan-out por tenant', async () => {
    const t = await createTenant();
    await emit(t.tenantId, 3);
    await handlers.handle('audit-seal', { tenantId: t.tenantId });
    expect(await owner.auditSeal.count({ where: { tenantId: t.tenantId } })).toBe(1);
    await handlers.handle('audit-anchor', { tenantId: t.tenantId });
    expect((await owner.auditSeal.findFirstOrThrow({ where: { tenantId: t.tenantId } })).anchoredAt).not.toBeNull();
    await handlers.handle('audit-verify', { tenantId: t.tenantId });
    const ev = await owner.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, resource: 'audit_verification' } });
    expect(ev.details).toMatchObject({ ok: true });
    // Sem tenantId: percorre todos e não falha.
    await expect(handlers.handle('audit-seal', {})).resolves.toBeGreaterThan(0);
  });

  it('ADMIN/AUDITOR consultam selos e verificam; demais perfis não', async () => {
    const t = await createTenant();
    const admin = (await http().post('/auth/login').set('x-tenant-slug', t.slug).send({ email: t.adminEmail, password: PASSWORD }).expect(201)).body.accessToken as string;
    const aud = await staff('AUDITOR', t.tenantId, t.slug);
    const inv = await staff('INVESTIGATOR', t.tenantId, t.slug);
    await integrity.sealTenant(t.tenantId);
    await integrity.anchorTenant(t.tenantId);
    const call = (m: 'get' | 'post', url: string, token: string) => http()[m](url).set('x-tenant-slug', t.slug).set('authorization', `Bearer ${token}`);

    const seals = await call('get', '/audit/seals', aud).expect(200);
    expect(seals.body.length).toBeGreaterThanOrEqual(1);
    expect(seals.body[0]).toHaveProperty('merkleRoot');
    expect(seals.body[0]).not.toHaveProperty('rowHash');
    const report = await call('post', '/audit/verify', admin).expect(200);
    expect(report.body).toMatchObject({ ok: true, problems: [] });
    await call('get', '/audit/seals', inv).expect(403);
    await call('post', '/audit/verify', inv).expect(403);
  });
});

describe('bucket WORM real (MinIO com Object Lock)', () => {
  const cfg = { endpoint: 'http://localhost:9000', region: 'us-east-1', accessKeyId: 'minio', secretAccessKey: 'minio12345', forcePathStyle: true };
  const bucket = `ouvion-anchor-${Date.now()}`;
  let available = false;

  beforeAll(async () => {
    try {
      if (!(await fetch('http://localhost:9000/minio/health/live')).ok) return;
      await new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }).send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
      available = true;
    } catch {
      available = false;
    }
  });

  it('publica, lê de volta e o objeto NÃO pode ser apagado durante a retenção', async () => {
    if (!available) return console.warn('MinIO indisponível: teste do bucket WORM ignorado');
    const worm = new WormBucketAnchor(bucket, cfg, 1);
    const payload = {
      tenantId: 't1', sealId: 's1', fromSeq: '1', toSeq: '10', merkleRoot: 'a'.repeat(64),
      prevSealHash: null, sealHash: 'b'.repeat(64), sealedAt: new Date().toISOString(),
    };
    const ref = await worm.publish(payload);
    expect(ref).toMatch(/^s3:\/\//);
    expect(await worm.fetch(ref)).toEqual(payload);
    expect(await worm.fetch(ref.replace('000000000010', '000000000099'))).toBeNull();

    const s3 = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
    const key = ref.replace(`s3://${bucket}/`, '');
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
    const versionId = versions.Versions![0]!.VersionId!;
    await expect(s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }))).rejects.toThrow();
    expect(await worm.fetch(ref)).toEqual(payload); // continua lá
  });
});
