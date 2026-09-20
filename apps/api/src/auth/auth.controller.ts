import { randomBytes } from 'node:crypto';

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { passwordSchema, registerSchema } from '@ouvion/contracts';
import * as argon2 from 'argon2';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { AuthService, type SessionTokens } from './auth.service';
import {
  clearSessionCookies,
  enforceCsrf,
  extractToken,
  parseCookies,
  REFRESH_COOKIE,
  setSessionCookies,
} from './cookies';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

const loginSchema = z
  .object({ email: z.string().email(), password: z.string().min(1).max(100) })
  .strict();
const otp = z.string().regex(/^\d{6}$/, 'Código inválido');
const mfaVerifySchema = z
  .object({ mfaToken: z.string().min(10), code: otp.optional(), recoveryCode: z.string().max(20).optional() })
  .strict()
  .refine((v) => !!v.code !== !!v.recoveryCode, 'Informe o código do app ou um código de recuperação');
const mfaActivateSchema = z.object({ code: otp }).strict();
const mfaDisableSchema = z.object({ password: z.string().min(1).max(100), code: otp }).strict();
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200).optional() }).strict();

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  /**
   * Entrega dos tokens: por padrão no corpo (BFF/servidor-a-servidor). Com `x-token-delivery: cookie`
   * (uso direto de navegador) vão em cookies httpOnly + SameSite=Lax (+ Secure em HTTPS) com CSRF
   * double-submit, e NÃO aparecem no corpo — inacessíveis a JavaScript.
   */
  private deliver(req: Request, res: Response, tokens: SessionTokens, forceCookie = false) {
    if (forceCookie || req.header('x-token-delivery') === 'cookie') {
      const csrfToken = randomBytes(24).toString('base64url');
      setSessionCookies(req, res, { ...tokens, csrfToken });
      return { authenticated: true, expiresIn: tokens.expiresIn, csrfToken };
    }
    return tokens;
  }

  @Post('login')
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const { email, password } = parseBody(loginSchema, body);
    const out = await this.auth.login(email, password, clientInfo(req));
    if (out.kind === 'mfa_required') return { mfaRequired: true, mfaToken: out.mfaToken };
    if (out.kind === 'mfa_enrollment_required') return { mfaEnrollmentRequired: true, enrollToken: out.enrollToken };
    return this.deliver(req, res, out.tokens);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  async mfaVerify(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const { mfaToken, code, recoveryCode } = parseBody(mfaVerifySchema, body);
    return this.deliver(req, res, await this.auth.verifyMfa(mfaToken, { code, recoveryCode }, clientInfo(req)));
  }

  /** Cadastro do 2º fator: sessão plena OU token de cadastro (perfil obrigado a ter MFA que ainda não tem). */
  private async mfaSubject(req: Request): Promise<{ userId: string; viaEnrollToken: boolean }> {
    const found = extractToken(req);
    if (!found) throw new UnauthorizedException();
    try {
      const userId = await this.auth.verifyScoped(found.token, 'mfa-enroll');
      return { userId, viaEnrollToken: true };
    } catch {
      /* não é token de cadastro: exige sessão plena */
    }
    if (found.fromCookie) enforceCsrf(req);
    return { userId: (await this.sessions.resolve(found.token)).userId, viaEnrollToken: false };
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  async mfaEnroll(@Req() req: Request) {
    const { userId } = await this.mfaSubject(req);
    return this.mfa.enroll(userId);
  }

  @Post('mfa/activate')
  @HttpCode(200)
  async mfaActivate(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const { code } = parseBody(mfaActivateSchema, body);
    const { userId, viaEnrollToken } = await this.mfaSubject(req);
    const { recoveryCodes } = await this.mfa.activate(userId, code, clientInfo(req));
    // Quem veio pelo token de cadastro ainda não tem sessão: abre agora.
    if (!viaEnrollToken) return { recoveryCodes };
    return { recoveryCodes, session: this.deliver(req, res, await this.auth.startSession(userId, clientInfo(req))) };
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  mfaDisable(@Req() req: Request, @Body() body: unknown) {
    const { password, code } = parseBody(mfaDisableSchema, body);
    return this.mfa.disable(this.cls.get('userId')!, password, code, clientInfo(req));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const { refreshToken } = parseBody(refreshSchema, body ?? {});
    const cookie = parseCookies(req.header('cookie'))[REFRESH_COOKIE];
    const token = refreshToken ?? cookie;
    if (!token) throw new UnauthorizedException();
    if (!refreshToken && cookie) enforceCsrf(req);
    return this.deliver(req, res, await this.auth.refresh(token, clientInfo(req)), !refreshToken && !!cookie);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(this.cls.get('userId')!, this.cls.get('sessionId'), clientInfo(req));
    clearSessionCookies(res);
    return { loggedOut: true };
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.logoutAll(this.cls.get('userId')!, clientInfo(req));
    clearSessionCookies(res);
    return r;
  }

  /** Sessões ativas do próprio usuário; `current` marca a sessão que fez a chamada. */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async sessionsList() {
    const current = this.cls.get('sessionId');
    return (await this.auth.listSessions(this.cls.get('userId')!)).map((s) => ({ ...s, current: s.id === current }));
  }

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  revokeSession(@Req() req: Request, @Param('id') id: string) {
    return this.auth.revokeSession(this.cls.get('userId')!, parseBody(z.string().uuid(), id), clientInfo(req));
  }

  @Post('register')
  async register(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const { email, fullName, password } = parseBody(registerSchema, body);
    parseBody(passwordSchema, password); // política única de senha
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.deliver(req, res, await this.auth.register({ email, fullName, passwordHash }, clientInfo(req)));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me() {
    const userId = this.cls.get('userId')!;
    const u = await this.prisma.run((tx) => tx.user.findUniqueOrThrow({ where: { id: userId } }));
    return { userId, tenantId: this.cls.get('tenantId'), role: u.role, mfaEnabled: u.mfaEnabled };
  }
}
