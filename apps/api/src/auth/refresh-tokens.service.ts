import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService, type Tx } from '../prisma/prisma.service';

const REFRESH_DAYS = 7;
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/**
 * Sessões da equipe. O refresh é opaco, rotativo e só o hash é guardado. O `familyId` identifica a
 * sessão (é o `sid` do access token): revogar a família derruba a sessão na hora, e reuso de um token
 * já rotacionado revoga TODAS as sessões do usuário (indício de roubo).
 */
@Injectable()
export class RefreshTokensService {
  constructor(private readonly prisma: PrismaService) {}

  private async insert(tx: Tx, userId: string, tenantId: string, familyId: string, client: ClientInfo) {
    const token = randomBytes(32).toString('base64url');
    const row = await tx.refreshToken.create({
      data: {
        tenantId,
        userId,
        familyId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000),
        ipAddress: client.ip ?? null,
        userAgent: client.userAgent ?? null,
      },
    });
    return { token, row };
  }

  /** Nova sessão (novo familyId). */
  create(tenantId: string, userId: string, client: ClientInfo) {
    return this.prisma.withTenant(tenantId, (tx) => this.insert(tx, userId, tenantId, randomUUID(), client));
  }

  /**
   * Rotaciona: revoga o token apresentado e emite outro na mesma família.
   * Devolve null se inválido/expirado/revogado; reuso de token rotacionado revoga tudo do usuário.
   */
  async rotate(tenantId: string, token: string, client: ClientInfo) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const current = await tx.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!current) return null;
      if (current.revokedAt) {
        if (current.replacedById) {
          await tx.refreshToken.updateMany({
            where: { userId: current.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return { reuse: true as const, userId: current.userId };
        }
        return null;
      }
      if (current.expiresAt <= new Date()) return null;
      const next = await this.insert(tx, current.userId, tenantId, current.familyId, client);
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { revokedAt: new Date(), replacedById: next.row.id, lastUsedAt: new Date() },
      });
      return { reuse: false as const, userId: current.userId, familyId: current.familyId, token: next.token };
    });
  }

  /** A sessão (família) continua viva? Conferido a cada request autenticado. */
  async isSessionActive(tx: Tx, familyId: string, userId: string): Promise<boolean> {
    const n = await tx.refreshToken.count({
      where: { familyId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    return n > 0;
  }

  async revokeSession(tx: Tx, userId: string, familyId: string): Promise<number> {
    const r = await tx.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count;
  }

  async revokeAll(tx: Tx, userId: string): Promise<number> {
    const r = await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return r.count;
  }

  async listActive(tx: Tx, userId: string) {
    const rows = await tx.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    // Uma linha viva por sessão (as anteriores da família já foram rotacionadas).
    return rows.map((r) => ({
      id: r.familyId,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }
}
