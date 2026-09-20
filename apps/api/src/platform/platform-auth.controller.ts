import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { PlatformAuthService, type PlatformLoginResult } from './platform-auth.service';
import { PlatformPrismaService } from './platform-prisma.service';
import { PlatformGuard, type PlatformRequest } from './platform.guard';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(100) }).strict();
const otp = z.string().regex(/^\d{6}$/, 'Código inválido');
const verifySchema = z
  .object({ mfaToken: z.string().min(10), code: otp.optional(), recoveryCode: z.string().max(20).optional() })
  .strict()
  .refine((v) => !!v.code !== !!v.recoveryCode, 'Informe o código do app ou um código de recuperação');
const changePasswordSchema = z.object({ token: z.string().min(10), newPassword: z.string().min(1).max(100) }).strict();
const activateSchema = z.object({ enrollToken: z.string().min(10), code: otp }).strict();
const enrollSchema = z.object({ enrollToken: z.string().min(10) }).strict();
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) }).strict();

function step(r: PlatformLoginResult) {
  switch (r.kind) {
    case 'session':
      return r.tokens;
    case 'password_change_required':
      return { passwordChangeRequired: true, token: r.token };
    case 'mfa_required':
      return { mfaRequired: true, mfaToken: r.mfaToken };
    case 'mfa_enrollment_required':
      return { mfaEnrollmentRequired: true, enrollToken: r.enrollToken };
  }
}

/** Login da plataforma (`/loginadm`): endpoints, tokens e segredo próprios; nunca compartilha nada com o login de tenant. */
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly prisma: PlatformPrismaService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown) {
    const { email, password } = parseBody(loginSchema, body);
    return step(await this.auth.login(email, password, clientInfo(req)));
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: unknown) {
    const { token, newPassword } = parseBody(changePasswordSchema, body);
    return step(await this.auth.changePassword(token, newPassword));
  }

  @Post('mfa/verify')
  @HttpCode(200)
  async verify(@Req() req: Request, @Body() body: unknown) {
    const { mfaToken, code, recoveryCode } = parseBody(verifySchema, body);
    return this.auth.verifyMfa(mfaToken, { code, recoveryCode }, clientInfo(req));
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  enroll(@Body() body: unknown) {
    return this.auth.enroll(parseBody(enrollSchema, body).enrollToken);
  }

  @Post('mfa/activate')
  @HttpCode(200)
  activate(@Req() req: Request, @Body() body: unknown) {
    const { enrollToken, code } = parseBody(activateSchema, body);
    return this.auth.activate(enrollToken, code, clientInfo(req));
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: Request, @Body() body: unknown) {
    return this.auth.refresh(parseBody(refreshSchema, body).refreshToken, clientInfo(req));
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(PlatformGuard)
  async logout(@Req() req: PlatformRequest) {
    await this.auth.logout(req.operator.userId, req.operator.sessionId, clientInfo(req));
    return { loggedOut: true };
  }

  @Get('me')
  @UseGuards(PlatformGuard)
  async me(@Req() req: PlatformRequest) {
    const u = await this.prisma.db.platformUser.findUnique({
      where: { id: req.operator.userId },
      select: { id: true, email: true, fullName: true, role: true, mfaEnabled: true },
    });
    if (!u) throw new UnauthorizedException();
    return { userId: u.id, email: u.email, fullName: u.fullName, role: u.role, mfaEnabled: u.mfaEnabled };
  }
}
