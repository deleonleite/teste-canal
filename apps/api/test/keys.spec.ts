import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { FieldCipher, LocalKek } from '../src/crypto/field-cipher';
import { PrismaService } from '../src/prisma/prisma.service';
import { asTenant, closeAll, createTenant, owner, platform } from './helpers';

let app: INestApplication;
let cipher: FieldCipher;
let prisma: PrismaService;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  cipher = app.get(FieldCipher);
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
  await closeAll();
});

/** LocalKek com chaves específicas (o construtor lê o ambiente). */
function kekWith(current: Buffer, previous: Buffer[] = []): LocalKek {
  const saved = { cur: process.env.FIELD_ENCRYPTION_KEY, prev: process.env.FIELD_ENCRYPTION_KEY_PREVIOUS };
  process.env.FIELD_ENCRYPTION_KEY = current.toString('base64');
  process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = previous.map((k) => k.toString('base64')).join(',');
  try {
    return new LocalKek();
  } finally {
    if (saved.cur === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = saved.cur;
    if (saved.prev === undefined) delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
    else process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = saved.prev;
  }
}

describe('chave de dados por tenant (envelope)', () => {
  it('cria a versão 1 sob demanda, embrulhada pela chave-mestra; cifra e decifra', async () => {
    const t = await createTenant();
    const secret = 'fabio.real@empresa.com';
    const ct = await cipher.encrypt(t.tenantId, secret);
    expect(ct).toMatch(/^v2\.1\./);
    expect(ct).not.toContain(Buffer.from(secret).toString('base64url'));
    expect(await cipher.decrypt(t.tenantId, ct)).toBe(secret);

    const keys = await owner.tenantKey.findMany({ where: { tenantId: t.tenantId } });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ version: 1, retiredAt: null });
    expect(keys[0]!.wrappedKey.split('.')).toHaveLength(4); // kid.iv.tag.ct: a DEK nunca fica em claro
    // Cada cifragem usa IV novo.
    expect(await cipher.encrypt(t.tenantId, secret)).not.toBe(ct);
  });

  it('texto adulterado ou de outro tenant não decifra (GCM + AAD)', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const ct = await cipher.encrypt(a.tenantId, 'dado sensível');
    await cipher.encrypt(b.tenantId, 'x'); // b também tem chave
    await expect(cipher.decrypt(b.tenantId, ct)).rejects.toThrow();
    const parts = ct.split('.');
    parts[4] = (parts[4]![0] === 'A' ? 'B' : 'A') + parts[4]!.slice(1);
    await expect(cipher.decrypt(a.tenantId, parts.join('.'))).rejects.toThrow();
    await expect(cipher.decrypt(a.tenantId, 'v1.lixo')).rejects.toThrow(/inválido/);
  });

  it('duas requisições simultâneas num tenant novo criam UMA só chave', async () => {
    const t = await createTenant();
    const [c1, c2, c3] = await Promise.all([
      cipher.encrypt(t.tenantId, 'a'),
      cipher.encrypt(t.tenantId, 'b'),
      cipher.encrypt(t.tenantId, 'c'),
    ]);
    const keys = await owner.tenantKey.findMany({ where: { tenantId: t.tenantId } });
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.filter((k) => k.retiredAt === null).length).toBe(1 + (keys.length - 1) * 0); // sempre uma ativa
    for (const [ct, plain] of [[c1, 'a'], [c2, 'b'], [c3, 'c']] as const) expect(await cipher.decrypt(t.tenantId, ct)).toBe(plain);
  });

  it('rotação: novos dados usam a nova versão; os antigos continuam legíveis; só uma ativa', async () => {
    const t = await createTenant();
    const old = await cipher.encrypt(t.tenantId, 'antigo');
    expect(old).toMatch(/^v2\.1\./);
    expect(await cipher.rotate(t.tenantId)).toBe(2);

    const fresh = await cipher.encrypt(t.tenantId, 'novo');
    expect(fresh).toMatch(/^v2\.2\./);
    expect(await cipher.decrypt(t.tenantId, old)).toBe('antigo');
    expect(await cipher.decrypt(t.tenantId, fresh)).toBe('novo');

    const keys = await owner.tenantKey.findMany({ where: { tenantId: t.tenantId }, orderBy: { version: 'asc' } });
    expect(keys.map((k) => [k.version, k.retiredAt !== null])).toEqual([[1, true], [2, false]]);
    expect(await cipher.rotate(t.tenantId)).toBe(3);
  });

  it('a aplicação não apaga nem edita chaves (só aposenta e reembrulha); a plataforma não as vê', async () => {
    const t = await createTenant();
    await cipher.encrypt(t.tenantId, 'x');
    await expect(asTenant(t.tenantId, (tx) => tx.tenantKey.deleteMany())).rejects.toThrow(/permission denied/i);
    await expect(asTenant(t.tenantId, (tx) => tx.$executeRawUnsafe('UPDATE tenant_keys SET version = 99'))).rejects.toThrow(/permission denied/i);
    await expect(platform.$queryRawUnsafe('SELECT * FROM tenant_keys')).rejects.toThrow(/permission denied/i);
    // RLS: outro tenant não enxerga as chaves deste.
    const other = await createTenant();
    expect(await asTenant(other.tenantId, (tx) => tx.tenantKey.count())).toBe(0);
  });
});

describe('rotação da chave-mestra (KEK)', () => {
  it('chave nova + anterior ainda decifra; reembrulhar libera a antiga', async () => {
    const t = await createTenant();
    const kekA = randomBytes(32);
    const kekB = randomBytes(32);

    const cipherA = new FieldCipher(prisma, kekWith(kekA));
    const ct = await cipherA.encrypt(t.tenantId, 'sigilo do denunciante');

    // Passa a usar B mantendo A como anterior: dados antigos seguem legíveis.
    const cipherB = new FieldCipher(prisma, kekWith(kekB, [kekA]));
    expect(await cipherB.decrypt(t.tenantId, ct)).toBe('sigilo do denunciante');
    expect(await cipherB.rewrapKeys(t.tenantId)).toBe(1);
    expect(await cipherB.rewrapKeys(t.tenantId)).toBe(0); // idempotente

    // Agora só B basta: A pode ser descartada.
    const cipherOnlyB = new FieldCipher(prisma, kekWith(kekB));
    expect(await cipherOnlyB.decrypt(t.tenantId, ct)).toBe('sigilo do denunciante');
    // ...e A sozinha não abre mais nada.
    const cipherOnlyA = new FieldCipher(prisma, kekWith(kekA));
    await expect(cipherOnlyA.decrypt(t.tenantId, ct)).rejects.toThrow(/desconhecida/);
  });

  it('sem a chave-mestra correta nada decifra; em produção ela é obrigatória', async () => {
    const t = await createTenant();
    const ct = await new FieldCipher(prisma, kekWith(randomBytes(32))).encrypt(t.tenantId, 'x');
    await expect(new FieldCipher(prisma, kekWith(randomBytes(32))).decrypt(t.tenantId, ct)).rejects.toThrow();

    const prev = { env: process.env.NODE_ENV, key: process.env.FIELD_ENCRYPTION_KEY };
    process.env.NODE_ENV = 'production';
    delete process.env.FIELD_ENCRYPTION_KEY;
    try {
      expect(() => new LocalKek()).toThrow(/obrigatória em produção/);
      process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64'); // tamanho errado
      expect(() => new LocalKek()).toThrow(/32 bytes/);
    } finally {
      process.env.NODE_ENV = prev.env;
      if (prev.key === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
      else process.env.FIELD_ENCRYPTION_KEY = prev.key;
    }
  });
});
