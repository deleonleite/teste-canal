import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Chave-mestra (KEK) que protege as chaves de dados dos tenants (envelope encryption).
 * Porta: hoje `LocalKek` (chave em variável de ambiente); em produção troca-se por um KMS
 * (AWS KMS/Cloud KMS) SEM tocar em `FieldCipher` — é aí que a equipe de aplicação e o DBA deixam de
 * poder usar a chave sem aprovação separada (doc §3).
 */
export abstract class Kek {
  abstract wrap(dek: Buffer, aad: string): string;
  abstract unwrap(wrapped: string, aad: string): Buffer;
  /** true se o `wrapped` foi protegido por uma chave-mestra que não é mais a atual. */
  abstract needsRewrap(wrapped: string): boolean;
}

const kidOf = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** KEK local com rotação: a atual embrulha; as anteriores (FIELD_ENCRYPTION_KEY_PREVIOUS) só desembrulham. */
@Injectable()
export class LocalKek extends Kek {
  private readonly current: { kid: string; key: Buffer };
  private readonly all = new Map<string, Buffer>();

  constructor() {
    super();
    const parse = (raw: string): Buffer => {
      const key = Buffer.from(raw, 'base64');
      if (key.length !== 32) throw new Error('Chave-mestra deve ter 32 bytes em base64');
      return key;
    };
    const raw = process.env.FIELD_ENCRYPTION_KEY;
    let key: Buffer;
    if (raw) key = parse(raw);
    else if (process.env.NODE_ENV === 'production') throw new Error('FIELD_ENCRYPTION_KEY obrigatória em produção');
    else key = createHash('sha256').update('ouvion-dev-only-field-key').digest();
    this.current = { kid: kidOf(key), key };
    this.all.set(this.current.kid, key);
    for (const prev of (process.env.FIELD_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').filter(Boolean)) {
      const k = parse(prev.trim());
      this.all.set(kidOf(k), k);
    }
  }

  wrap(dek: Buffer, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.current.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return [this.current.kid, iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  unwrap(wrapped: string, aad: string): Buffer {
    const [kid, iv, tag, ct] = wrapped.split('.');
    const key = kid ? this.all.get(kid) : undefined;
    if (!key || !iv || !tag || !ct) throw new Error('Chave de dados protegida por uma chave-mestra desconhecida');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  }

  needsRewrap(wrapped: string): boolean {
    return wrapped.split('.')[0] !== this.current.kid;
  }
}

const ACTIVE_TTL_MS = 30_000;

/**
 * Cifra de campo AES-256-GCM. Cada tenant tem chaves de dados (DEK) aleatórias e VERSIONADAS,
 * guardadas embrulhadas pela KEK (tabela `tenant_keys`). Texto cifrado: `v2.<versão>.<iv>.<tag>.<ct>`,
 * com o tenantId como AAD — cifrado de um tenant não decifra em outro.
 * Rotação: nova versão passa a cifrar; as antigas continuam decifrando os dados já gravados.
 */
@Injectable()
export class FieldCipher {
  private readonly deks = new Map<string, Buffer>();
  private readonly active = new Map<string, { version: number; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kek: Kek,
  ) {}

  private aad(tenantId: string, version: number): string {
    return `${tenantId}:${version}`;
  }

  /** Versão ativa do tenant; cria a primeira chave sob demanda (provisionamento tardio/idempotente). */
  private async activeVersion(tenantId: string): Promise<number> {
    const cached = this.active.get(tenantId);
    if (cached && Date.now() - cached.at < ACTIVE_TTL_MS) return cached.version;
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenantKey.findFirst({ where: { retiredAt: null }, orderBy: { version: 'desc' } }),
      );
      if (found) {
        this.active.set(tenantId, { version: found.version, at: Date.now() });
        return found.version;
      }
      try {
        await this.createVersion(tenantId);
      } catch {
        /* outra instância criou ao mesmo tempo (unique tenant+version): relê */
      }
    }
    throw new Error('Não foi possível obter a chave de dados do tenant');
  }

  private async createVersion(tenantId: string): Promise<number> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const last = await tx.tenantKey.findFirst({ orderBy: { version: 'desc' } });
      const version = (last?.version ?? 0) + 1;
      const dek = randomBytes(32);
      await tx.tenantKey.create({ data: { tenantId, version, wrappedKey: this.kek.wrap(dek, this.aad(tenantId, version)) } });
      this.deks.set(`${tenantId}:${version}`, dek);
      return version;
    });
  }

  private async dek(tenantId: string, version: number): Promise<Buffer> {
    const cached = this.deks.get(`${tenantId}:${version}`);
    if (cached) return cached;
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.tenantKey.findUnique({ where: { tenantId_version: { tenantId, version } } }));
    if (!row) throw new Error(`Chave de dados v${version} do tenant não existe`);
    const dek = this.kek.unwrap(row.wrappedKey, this.aad(tenantId, version));
    this.deks.set(`${tenantId}:${version}`, dek);
    return dek;
  }

  async encrypt(tenantId: string, plaintext: string): Promise<string> {
    const version = await this.activeVersion(tenantId);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', await this.dek(tenantId, version), iv);
    c.setAAD(Buffer.from(tenantId));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return ['v2', String(version), iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  async decrypt(tenantId: string, payload: string): Promise<string> {
    const [tag, version, iv, authTag, ct] = payload.split('.');
    if (tag !== 'v2' || !version || !iv || !authTag || !ct) throw new Error('Payload cifrado inválido');
    const d = createDecipheriv('aes-256-gcm', await this.dek(tenantId, Number(version)), Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(tenantId));
    d.setAuthTag(Buffer.from(authTag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  /** Rotação da chave de dados: aposenta a ativa e cria a próxima versão. Dados antigos seguem legíveis. */
  async rotate(tenantId: string): Promise<number> {
    const version = await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.tenantKey.updateMany({ where: { retiredAt: null }, data: { retiredAt: new Date() } });
      const last = await tx.tenantKey.findFirst({ orderBy: { version: 'desc' } });
      const next = (last?.version ?? 0) + 1;
      const dek = randomBytes(32);
      await tx.tenantKey.create({ data: { tenantId, version: next, wrappedKey: this.kek.wrap(dek, this.aad(tenantId, next)) } });
      this.deks.set(`${tenantId}:${next}`, dek);
      return next;
    });
    this.active.set(tenantId, { version, at: Date.now() });
    return version;
  }

  /** Após trocar a chave-mestra: reembrulha as DEKs do tenant com a KEK atual. Devolve quantas mudaram. */
  async rewrapKeys(tenantId: string): Promise<number> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      let n = 0;
      for (const row of await tx.tenantKey.findMany()) {
        if (!this.kek.needsRewrap(row.wrappedKey)) continue;
        const dek = this.kek.unwrap(row.wrappedKey, this.aad(tenantId, row.version));
        await tx.tenantKey.update({ where: { id: row.id }, data: { wrappedKey: this.kek.wrap(dek, this.aad(tenantId, row.version)) } });
        n++;
      }
      return n;
    });
  }
}
