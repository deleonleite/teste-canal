import { afterAll, describe, expect, it } from '@jest/globals';

import { asTenant, closeAll, createComplaint, createTenant, owner, platform } from './helpers';

afterAll(closeAll);

describe('provisionamento de tenant', () => {
  it('cria tenant, branding, ADMIN e a SEQUENCE de auditoria', async () => {
    const t = await createTenant();
    const seq = `audit_seq_${t.tenantId.replace(/-/g, '')}`;
    const rows = await owner.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname = ${seq}`;
    expect(rows[0]?.n).toBe(1);

    const tenant = await owner.tenant.findUniqueOrThrow({
      where: { id: t.tenantId },
      include: { branding: true, users: true },
    });
    expect(tenant.status).toBe('TRIAL');
    expect(tenant.branding?.primaryColor).toBe('#3b82f6');
    expect(tenant.users).toHaveLength(1);
    expect(tenant.users[0]?.role).toBe('ADMIN');
  });

  it('habilita RLS em todas as tabelas com dado de tenant', async () => {
    const rows = await owner.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('tenants','tenant_brandings','users','complaints','audit_logs')`;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('é atômico: slug duplicado não deixa SEQUENCE órfã', async () => {
    const t = await createTenant();
    const before = await owner.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname LIKE 'audit_seq_%'`;
    const { provisionTenant } = await import('../src/tenancy/provision-tenant');
    await expect(
      provisionTenant(owner, {
        slug: t.slug,
        companyName: 'Duplicada',
        adminEmail: 'x@y.com',
        adminFullName: 'X Y',
        adminPasswordHash: 'x'.repeat(30),
      }),
    ).rejects.toThrow();
    const after = await owner.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname LIKE 'audit_seq_%'`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe('vazamento entre tenants (RLS direto no banco)', () => {
  it('tenant A não lê, altera nem cria dados do tenant B', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const ca = await createComplaint(a.tenantId, 'Denúncia do tenant A 1234');
    const cb = await createComplaint(b.tenantId, 'Denúncia do tenant B 1234');

    const visible = await asTenant(a.tenantId, (tx) => tx.complaint.findMany());
    expect(visible.map((c) => c.id)).toEqual([ca]);

    expect(await asTenant(a.tenantId, (tx) => tx.complaint.findUnique({ where: { id: cb } }))).toBeNull();

    const updated = await asTenant(a.tenantId, (tx) =>
      tx.complaint.updateMany({ where: { id: cb }, data: { title: 'invadido pelo tenant A' } }),
    );
    expect(updated.count).toBe(0);
    // Denúncia nunca é excluída fisicamente: nem o próprio tenant tem DELETE.
    await expect(
      asTenant(a.tenantId, (tx) => tx.complaint.deleteMany({ where: { id: cb } })),
    ).rejects.toThrow(/permission denied/i);
    expect((await owner.complaint.findUniqueOrThrow({ where: { id: cb } })).title).toBe(
      'Denúncia do tenant B 1234',
    );

    await expect(
      asTenant(a.tenantId, (tx) =>
        tx.complaint.create({
          data: {
            tenantId: b.tenantId,
            protocol: 'DEN-2026-FORGED',
            isAnonymous: true,
            type: 'OTHER',
            reportedType: 'OTHER',
            involvedPeople: ['x'],
            integrityHash: 'x'.repeat(64),
            title: 'Inserção cruzada indevida',
            description: 'x'.repeat(60),
          },
        }),
      ),
    ).rejects.toThrow();

    const users = await asTenant(a.tenantId, (tx) => tx.user.findMany());
    expect(users.every((u) => u.tenantId === a.tenantId)).toBe(true);
  });

  it('sem contexto de tenant nenhuma linha de conteúdo é visível', async () => {
    const a = await createTenant();
    await createComplaint(a.tenantId);
    expect(await asTenant(null, (tx) => tx.complaint.count())).toBe(0);
    expect(await asTenant(null, (tx) => tx.user.count())).toBe(0);
    expect(await asTenant(null, (tx) => tx.auditLog.count())).toBe(0);
  });
});

describe('auditoria: seq e rowHash calculados pelo banco', () => {
  it('ignora seq/hash forjados, sequencia por tenant e é append-only', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const log = (tenantId: string) =>
      asTenant(tenantId, (tx) =>
        tx.auditLog.create({
          data: { tenantId, action: 'CREATE', resource: 'complaint', seq: 999n, rowHash: 'forjado' },
        }),
      );

    const a1 = await log(a.tenantId);
    const a2 = await log(a.tenantId);
    const b1 = await log(b.tenantId);
    expect([a1.seq, a2.seq, b1.seq]).toEqual([1n, 2n, 1n]);
    expect(a1.rowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a1.rowHash).not.toBe(a2.rowHash);

    await expect(
      asTenant(a.tenantId, (tx) => tx.auditLog.updateMany({ data: { resource: 'adulterado' } })),
    ).rejects.toThrow(/permission denied/i);
    await expect(asTenant(a.tenantId, (tx) => tx.auditLog.deleteMany())).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('SUPER_ADMIN sem acesso a conteúdo (papel platform_admin)', () => {
  it.each(['complaints', 'users', 'audit_logs'])(
    'não consegue ler a tabela %s',
    async (table) => {
      await expect(platform.$queryRawUnsafe(`SELECT * FROM ${table}`)).rejects.toThrow(
        /permission denied/i,
      );
    },
  );

  it('lê apenas metadados de tenants e a view de auditoria sem details', async () => {
    const a = await createTenant();
    await asTenant(a.tenantId, (tx) =>
      tx.auditLog.create({
        data: { tenantId: a.tenantId, action: 'READ', resource: 'complaint', details: { secreto: 1 } },
      }),
    );
    const tenants = await platform.$queryRaw<{ slug: string }[]>`SELECT slug FROM tenants`;
    expect(tenants.map((t) => t.slug)).toContain(a.slug);

    const rows = await platform.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM audit_log_platform_view WHERE tenant_id = ${a.tenantId}::uuid`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain('details');
    expect(Object.keys(rows[0] ?? {})).not.toContain('ip_address');
    await expect(platform.$queryRawUnsafe('SELECT details FROM audit_log_platform_view')).rejects.toThrow();
  });
});
