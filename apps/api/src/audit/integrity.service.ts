import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { TenantContext } from '../scan/attachment-scan.handler';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { Anchor, type AnchorPayload } from './anchor';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const BATCH = 5000;
const ANCHOR_STALE_MS = 48 * 3600_000;

/** Raiz Merkle dos `rowHash` (folha e nó com prefixo distinto; nó ímpar é duplicado). */
export function merkleRoot(rowHashes: string[]): string {
  if (rowHashes.length === 0) throw new Error('Sem folhas');
  let level = rowHashes.map((h) => sha(`L${h}`));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(`N${level[i]}${level[i + 1] ?? level[i]}`));
    level = next;
  }
  return level[0]!;
}

export function sealHashOf(s: {
  tenantId: string;
  fromSeq: bigint;
  toSeq: bigint;
  gaps: bigint[];
  rowCount: number;
  merkleRoot: string;
  prevSealHash: string | null;
  sealedAt: Date;
}): string {
  return sha(
    [s.tenantId, s.fromSeq, s.toSeq, s.gaps.join(','), s.rowCount, s.merkleRoot, s.prevSealHash ?? '', s.sealedAt.toISOString()].join('|'),
  );
}

export interface VerificationProblem {
  type: 'row_hash_mismatch' | 'seal_mismatch' | 'chain_break' | 'orphan_seal_ref' | 'late_row' | 'anchor_mismatch' | 'anchor_missing' | 'anchor_stale';
  detail: string;
}
export interface VerificationReport {
  ok: boolean;
  sealsChecked: number;
  rowsChecked: number;
  problems: VerificationProblem[];
}

/**
 * Integridade probatória da auditoria em 3 camadas (doc §5.10): hash por registro (trigger), selos
 * Merkle periódicos encadeados entre si e âncora externa. A cadeia existe ENTRE selos, não entre
 * registros: a gravação da auditoria não serializa escritas concorrentes.
 */
@Injectable()
export class AuditIntegrityService {
  private readonly log = new Logger(AuditIntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly anchor: Anchor,
    private readonly tenants: TenantContext,
  ) {}

  async allTenantIds(): Promise<string[]> {
    return (await this.prisma.base.tenant.findMany({ select: { id: true } })).map((t) => t.id);
  }

  /** Sela os registros ainda não selados do tenant, em lotes. Devolve quantos selos criou. */
  async sealTenant(tenantId: string): Promise<number> {
    let created = 0;
    for (;;) {
      const sealed = await this.prisma.withTenant(tenantId, async (tx) => {
        const last = await tx.auditSeal.findFirst({ orderBy: { toSeq: 'desc' } });
        const fromSeq = last ? last.toSeq + 1n : 1n;
        const rows = await tx.auditLog.findMany({
          where: { seq: { gte: fromSeq }, sealId: null },
          orderBy: { seq: 'asc' },
          take: BATCH,
          select: { id: true, seq: true, rowHash: true },
        });
        if (rows.length === 0) return false;
        const toSeq = rows[rows.length - 1]!.seq;
        // Buracos: números da sequência consumidos sem registro (rollback benigno ou remoção indevida).
        const present = new Set(rows.map((r) => r.seq));
        const gaps: bigint[] = [];
        for (let s = fromSeq; s <= toSeq; s++) if (!present.has(s)) gaps.push(s);
        const base = {
          tenantId,
          fromSeq,
          toSeq,
          gaps,
          rowCount: rows.length,
          merkleRoot: merkleRoot(rows.map((r) => r.rowHash)),
          prevSealHash: last?.sealHash ?? null,
          sealedAt: new Date(),
        };
        const seal = await tx.auditSeal.create({ data: { ...base, sealHash: sealHashOf(base) } });
        await tx.auditLog.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { sealId: seal.id } });
        return true;
      });
      if (!sealed) break;
      created++;
    }
    return created;
  }

  /** Publica o hash do último selo fora do controle do operador e marca os selos cobertos por ele. */
  async anchorTenant(tenantId: string): Promise<string | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const latest = await tx.auditSeal.findFirst({ orderBy: { toSeq: 'desc' } });
      if (!latest || latest.anchoredAt) return null;
      const payload: AnchorPayload = {
        tenantId,
        sealId: latest.id,
        fromSeq: latest.fromSeq.toString(),
        toSeq: latest.toSeq.toString(),
        merkleRoot: latest.merkleRoot,
        prevSealHash: latest.prevSealHash,
        sealHash: latest.sealHash,
        sealedAt: latest.sealedAt.toISOString(),
      };
      const ref = await this.anchor.publish(payload);
      const now = new Date();
      // O selo âncora cobre os anteriores (cada um encadeia ao seguinte por prevSealHash).
      await tx.auditSeal.updateMany({
        where: { anchoredAt: null, toSeq: { lte: latest.toSeq } },
        data: { anchorType: this.anchor.type, anchorRef: ref, anchoredAt: now },
      });
      return ref;
    });
  }

  /** Recalcula tudo: hashes de linha, raízes, cadeia de selos, buracos, registros tardios e âncoras. */
  async verifyTenant(tenantId: string): Promise<VerificationReport> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const problems: VerificationProblem[] = [];

      // 1) rowHash de cada registro, recalculado no banco pela MESMA função do trigger.
      const bad = await tx.$queryRaw<{ seq: bigint }[]>`
        SELECT seq FROM audit_logs
        WHERE row_hash <> audit_compute_hash(tenant_id, seq, user_id, action::text, resource, resource_id, details, "timestamp")`;
      for (const b of bad) problems.push({ type: 'row_hash_mismatch', detail: `seq interno ${b.seq}` });
      const rowsChecked = await tx.auditLog.count();

      // 2) selos: raiz, hash, cadeia e continuidade.
      const seals = await tx.auditSeal.findMany({ orderBy: { toSeq: 'asc' } });
      let prev: (typeof seals)[number] | undefined;
      for (const s of seals) {
        const rows = await tx.auditLog.findMany({ where: { sealId: s.id }, orderBy: { seq: 'asc' }, select: { seq: true, rowHash: true } });
        if (rows.length !== s.rowCount || rows.length === 0 || merkleRoot(rows.map((r) => r.rowHash)) !== s.merkleRoot) {
          problems.push({ type: 'seal_mismatch', detail: `selo até ${s.toSeq}: raiz Merkle/contagem não confere` });
        }
        if (sealHashOf(s) !== s.sealHash) problems.push({ type: 'seal_mismatch', detail: `selo até ${s.toSeq}: hash do selo não confere` });
        if ((s.prevSealHash ?? null) !== (prev?.sealHash ?? null) || s.fromSeq !== (prev ? prev.toSeq + 1n : 1n)) {
          problems.push({ type: 'chain_break', detail: `selo até ${s.toSeq}: encadeamento/continuidade quebrado` });
        }
        const present = new Set(rows.map((r) => r.seq));
        const gaps: bigint[] = [];
        for (let x = s.fromSeq; x <= s.toSeq; x++) if (!present.has(x)) gaps.push(x);
        if (gaps.join(',') !== s.gaps.join(',')) {
          problems.push({ type: 'seal_mismatch', detail: `selo até ${s.toSeq}: buracos da sequência diferem do registrado ao selar` });
        }
        prev = s;
      }
      const knownSeals = new Set(seals.map((s) => s.id));
      const orphans = await tx.auditLog.count({ where: { sealId: { not: null, notIn: [...knownSeals] } } });
      if (orphans > 0) problems.push({ type: 'orphan_seal_ref', detail: `${orphans} registro(s) apontam para selo inexistente` });

      // 3) registros que apareceram DEPOIS de o intervalo ser selado (impossível sem adulteração/atraso extremo).
      if (prev) {
        const late = await tx.auditLog.count({ where: { sealId: null, seq: { lte: prev.toSeq } } });
        if (late > 0) problems.push({ type: 'late_row', detail: `${late} registro(s) em intervalo já selado` });
      }

      // 4) âncoras: o objeto publicado fora do banco tem de bater com o selo.
      const anchored = seals.filter((s) => s.anchorRef);
      const refs = [...new Set(anchored.map((s) => s.anchorRef!))].slice(-50);
      for (const ref of refs) {
        const covered = anchored.filter((s) => s.anchorRef === ref);
        const top = covered[covered.length - 1]!;
        const published = await this.anchor.fetch(ref);
        if (!published) problems.push({ type: 'anchor_missing', detail: `âncora ${ref} não encontrada` });
        else if (published.sealHash !== top.sealHash || published.tenantId !== tenantId) {
          problems.push({ type: 'anchor_mismatch', detail: `âncora ${ref} não confere com o selo` });
        }
      }
      const newest = seals[seals.length - 1];
      if (newest && !newest.anchoredAt && Date.now() - newest.sealedAt.getTime() > ANCHOR_STALE_MS) {
        problems.push({ type: 'anchor_stale', detail: 'sem âncora externa válida há mais de 48 h' });
      }
      return { ok: problems.length === 0, sealsChecked: seals.length, rowsChecked, problems };
    });
  }

  /** Verificação agendada: divergência gera alerta (log de erro + evento de auditoria). */
  async verifyAndAlert(tenantId: string): Promise<VerificationReport> {
    const report = await this.verifyTenant(tenantId);
    if (!report.ok) {
      this.log.error(`INTEGRIDADE DA AUDITORIA COMPROMETIDA no tenant ${tenantId}: ${report.problems.map((p) => p.type).join(', ')}`);
    }
    await this.tenants.run(tenantId, () =>
      this.prisma.withTenant(tenantId, (tx) =>
        this.audit.record(tx, {
          action: 'READ',
          resource: 'audit_verification',
          details: { ok: report.ok, problems: report.problems.map((p) => p.type), sealsChecked: report.sealsChecked },
        }),
      ),
    );
    return report;
  }

  /** Tenants sem âncora válida nas últimas `hours` horas (alimenta o alerta de plataforma). */
  async tenantsWithoutRecentAnchor(hours = 48): Promise<string[]> {
    const limit = new Date(Date.now() - hours * 3600_000);
    const out: string[] = [];
    for (const id of await this.allTenantIds()) {
      const stale = await this.prisma.withTenant(id, async (tx) => {
        const anyRows = await tx.auditLog.count();
        if (anyRows === 0) return false;
        const recent = await tx.auditSeal.count({ where: { anchoredAt: { gte: limit } } });
        return recent === 0;
      });
      if (stale) out.push(id);
    }
    return out;
  }
}
