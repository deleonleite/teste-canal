import { randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { FieldCipher } from '../crypto/field-cipher';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { RefreshTokensService, type ClientInfo } from './refresh-tokens.service';
import { SecurityConfig } from './security-config';

authenticator.options = { window: 1 };

const RECOVERY_CODES = 10;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function recoveryCode(): string {
  const chars = Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
const normalizeRecovery = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** MFA TOTP com códigos de recuperação de uso único e proteção contra reuso de código. */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: FieldCipher,
    private readonly refresh: RefreshTokensService,
    private readonly config: SecurityConfig,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private tenantId(): string {
    return this.cls.get('tenantId')!;
  }

  /** Passo 1: gera o segredo (cifrado) e devolve a URI para o app autenticador. Ainda não ativa. */
  async enroll(userId: string) {
    return this.prisma.run(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.mfaEnabled) throw new ConflictException('MFA já está ativo');
      const secret = authenticator.generateSecret();
      await tx.user.update({ where: { id: userId }, data: { mfaSecretEnc: await this.cipher.encrypt(this.tenantId(), secret) } });
      return { otpauthUri: authenticator.keyuri(user.email, 'OuviON', secret) };
    });
  }

  /** Passo 2: prova de posse do segundo fator; ativa e devolve os códigos de recuperação (uma vez). */
  async activate(userId: string, code: string, client: ClientInfo) {
    const plainCodes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
    const hashes = await Promise.all(plainCodes.map((c) => argon2.hash(normalizeRecovery(c), { type: argon2.argon2id })));
    await this.prisma.run(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.mfaEnabled) throw new ConflictException('MFA já está ativo');
      if (!user.mfaSecretEnc) throw new BadRequestException('Inicie o cadastro do segundo fator antes');
      const step = this.stepOf(code, await this.cipher.decrypt(this.tenantId(), user.mfaSecretEnc));
      if (step === null) throw new UnauthorizedException('Código inválido');
      await tx.user.update({
        where: { id: userId },
        data: { mfaEnabled: true, mfaRecoveryCodes: hashes, mfaLastStep: step },
      });
      await this.audit.record(tx, {
        action: 'MFA_ENROLL',
        resource: 'user',
        resourceId: userId,
        details: { event: 'activated' },
        userId,
        ...client,
      });
    });
    return { recoveryCodes: plainCodes };
  }

  /** Passo do TOTP aceito, ou null. Rejeita códigos já usados (passo <= último aceito). */
  private stepOf(code: string, secret: string, lastStep = 0): number | null {
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return null;
    const step = Math.floor(Date.now() / 30_000) + delta;
    return step > lastStep ? step : null;
  }

  /** Confere TOTP ou código de recuperação (que é consumido). Devolve false em qualquer falha. */
  async verify(tx: Tx, user: { id: string; mfaSecretEnc: string | null; mfaLastStep: number; mfaRecoveryCodes: string[] }, input: { code?: string; recoveryCode?: string }): Promise<boolean> {
    if (input.code && user.mfaSecretEnc) {
      const step = this.stepOf(input.code, await this.cipher.decrypt(this.tenantId(), user.mfaSecretEnc), user.mfaLastStep);
      if (step === null) return false;
      await tx.user.update({ where: { id: user.id }, data: { mfaLastStep: step } });
      return true;
    }
    if (input.recoveryCode) {
      const wanted = normalizeRecovery(input.recoveryCode);
      for (const hash of user.mfaRecoveryCodes) {
        if (await argon2.verify(hash, wanted)) {
          await tx.user.update({
            where: { id: user.id },
            data: { mfaRecoveryCodes: user.mfaRecoveryCodes.filter((h) => h !== hash) },
          });
          return true;
        }
      }
    }
    return false;
  }

  /** Desativar exige senha e código; perfis com MFA obrigatório não podem desativar. */
  async disable(userId: string, password: string, code: string, client: ClientInfo) {
    await this.prisma.run(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (this.config.requiresMfa(user.role)) throw new ConflictException('Seu perfil exige MFA e ele não pode ser desativado');
      if (!user.mfaEnabled) throw new BadRequestException('MFA não está ativo');
      const passOk = await argon2.verify(user.passwordHash, password);
      const codeOk = passOk && (await this.verify(tx, user, { code }));
      if (!codeOk) throw new UnauthorizedException('Senha ou código inválidos');
      await tx.user.update({
        where: { id: userId },
        data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryCodes: [], mfaLastStep: 0 },
      });
      await this.audit.record(tx, {
        action: 'MFA_ENROLL',
        resource: 'user',
        resourceId: userId,
        details: { event: 'disabled' },
        userId,
        ...client,
      });
    });
    return { mfaEnabled: false };
  }

  /** ADMIN reseta o MFA de um usuário (auditado); as sessões dele caem e ele recadastra no próximo login. */
  async reset(adminId: string, targetId: string, client: ClientInfo) {
    return this.prisma.run(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetId } });
      if (!target) throw new BadRequestException('Usuário não encontrado');
      await tx.user.update({
        where: { id: targetId },
        data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryCodes: [], mfaLastStep: 0 },
      });
      const revoked = await this.refresh.revokeAll(tx, targetId);
      await this.audit.record(tx, {
        action: 'MFA_ENROLL',
        resource: 'user',
        resourceId: targetId,
        details: { event: 'reset', revokedSessions: revoked },
        userId: adminId,
        ...client,
      });
      return { id: targetId, mfaEnabled: false };
    });
  }
}
