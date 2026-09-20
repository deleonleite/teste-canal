import { createHmac, randomBytes } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { originIp } from './client-info';

/**
 * Limitador de taxa em MEMÓRIA (transitório). Adapter Redis entra com a infraestrutura de filas.
 *
 * Anonimato: o IP nunca é gravado nem logado. Serve só como chave de contagem, transformado em
 * HMAC com sal aleatório que gira todo dia e fica apenas na memória do processo, com janelas curtas.
 */
@Injectable()
export class RateLimiter {
  /** Limites por origem (IP). Só desativável por ambiente de teste; regras por protocolo/sessão são sempre ativas. */
  ipLimitsEnabled = process.env.RATE_LIMIT_DISABLED !== 'true';

  /** Relógio injetável (testes). */
  now: () => number = () => Date.now();

  private hits = new Map<string, number[]>();
  private blocked = new Map<string, number>();
  private salt = randomBytes(32);
  private saltDay = -1;

  /** Chave opaca derivada do IP (sal diário, só em memória). */
  ipKey(ip: string | undefined): string {
    const day = Math.floor(this.now() / 86_400_000);
    if (day !== this.saltDay) {
      this.salt = randomBytes(32);
      this.saltDay = day;
    }
    return createHmac('sha256', this.salt).update(ip ?? 'unknown').digest('base64url').slice(0, 22);
  }

  /** Registra um evento e devolve quantos existem na janela. */
  hit(key: string, windowMs: number): number {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    arr.push(t);
    this.hits.set(key, arr);
    return arr.length;
  }

  count(key: string, windowMs: number): number {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((x) => x > t - windowMs).length;
  }

  block(key: string, ms: number): void {
    this.blocked.set(key, this.now() + ms);
  }

  isBlocked(key: string): boolean {
    const until = this.blocked.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.blocked.delete(key);
      return false;
    }
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
    this.blocked.delete(key);
  }
}

export const tooMany = (): HttpException =>
  new HttpException('Muitas tentativas. Aguarde alguns minutos e tente novamente.', HttpStatus.TOO_MANY_REQUESTS);

const RATE_KEY = 'rate-limit';
export interface RateRule {
  name: string;
  limit: number;
  windowSec: number;
}
/** Limite por origem (IP transitório e opaco) para rotas do canal público. */
export const RateLimit = (rule: RateRule) => SetMetadata(RATE_KEY, rule);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const rule = this.reflector.get<RateRule | undefined>(RATE_KEY, ctx.getHandler());
    if (!rule || !this.limiter.ipLimitsEnabled) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = `${rule.name}:${this.limiter.ipKey(originIp(req))}`;
    if (this.limiter.hit(key, rule.windowSec * 1000) > rule.limit) throw tooMany();
    return true;
  }
}
