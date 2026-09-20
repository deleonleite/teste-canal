import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { UserRole } from '@ouvion/contracts';

import type { Tx } from '../prisma/prisma.service';

/** Campos que nunca saem em respostas de denúncia (chave e PII cifrada do denunciante). */
export const SAFE_OMIT = {
  accessKeyHash: true,
  reporterNameEnc: true,
  reporterEmailEnc: true,
  reporterPhoneEnc: true,
} as const;

export interface CaseActor {
  userId: string;
  role: UserRole;
}

const OPEN_FLAG: Array<'PENDING' | 'CONFIRMED'> = ['PENDING', 'CONFIRMED'];

/**
 * Regras de acesso a um caso (doc §2, §5.2.9, §5.2.10):
 *  - impedido (recusal) não vê o caso;
 *  - caso restrito: só ADMIN não impedido, investigador atribuído e quem tem concessão vigente;
 *  - suspeita PENDENTE: continua lendo (leitura reforçada) mas não decide nada.
 */
@Injectable()
export class CaseAccessService {
  /** Filtro de listagem coerente com as regras acima (impedidos e restritos não aparecem). */
  listWhere(actor: CaseActor): Prisma.ComplaintWhereInput {
    if (actor.role === 'REPORTER') return { createdBy: actor.userId };
    const and: Prisma.ComplaintWhereInput[] = [{ recusals: { none: { userId: actor.userId } } }];
    if (actor.role !== 'ADMIN') {
      and.push({
        OR: [
          { isRestricted: false },
          { investigatorId: actor.userId },
          {
            accessGrants: {
              some: { userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
            },
          },
        ],
      });
    }
    return { AND: and };
  }

  /** Carrega o caso já aplicando as regras de leitura. 404 quando o usuário não pode nem saber que existe. */
  async requireRead(tx: Tx, actor: CaseActor, complaintId: string) {
    const complaint = await tx.complaint.findUnique({ where: { id: complaintId }, omit: SAFE_OMIT });
    if (!complaint) throw new NotFoundException('Denúncia não encontrada');

    if (actor.role === 'REPORTER') {
      if (complaint.createdBy !== actor.userId) throw new ForbiddenException();
      return { complaint, suspectPending: false };
    }

    const recused = await tx.complaintRecusal.count({ where: { complaintId, userId: actor.userId } });
    if (recused > 0) throw new NotFoundException('Denúncia não encontrada');

    if (complaint.isRestricted && actor.role !== 'ADMIN' && complaint.investigatorId !== actor.userId) {
      const grant = await tx.complaintAccessGrant.count({
        where: { complaintId, userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (grant === 0) throw new NotFoundException('Denúncia não encontrada');
    }

    const suspectPending =
      (await tx.conflictFlag.count({ where: { complaintId, userId: actor.userId, status: 'PENDING' } })) > 0;
    return { complaint, suspectPending };
  }

  /** Decisões (status, atribuição, restrição, conflito, revelação): vetadas a quem está sob suspeita. */
  async requireDecide(tx: Tx, actor: CaseActor, complaintId: string) {
    const ctx = await this.requireRead(tx, actor, complaintId);
    if (ctx.suspectPending) {
      throw new ForbiddenException('Você está sob suspeita de conflito de interesses neste caso');
    }
    return ctx;
  }

  /** IDs que não podem atuar no caso: impedidos e com suspeita pendente/confirmada. */
  async blockedUserIds(tx: Tx, complaintId: string): Promise<string[]> {
    const [recusals, flags] = await Promise.all([
      tx.complaintRecusal.findMany({ where: { complaintId }, select: { userId: true } }),
      tx.conflictFlag.findMany({ where: { complaintId, status: { in: OPEN_FLAG } }, select: { userId: true } }),
    ]);
    return [...new Set([...recusals, ...flags].map((r) => r.userId))];
  }

  /** ADMINs elegíveis a decidir o caso (ativos, não suspensos, sem impedimento nem suspeita). */
  async eligibleAdminCount(tx: Tx, complaintId: string): Promise<number> {
    const blocked = await this.blockedUserIds(tx, complaintId);
    return tx.user.count({
      where: { role: 'ADMIN', isActive: true, isBlocked: false, id: { notIn: blocked } },
    });
  }
}
