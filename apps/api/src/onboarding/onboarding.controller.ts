import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { escalationConfirmSchema, escalationEnrollSchema, escalationRecipientSchema } from '@ouvion/contracts';
import { z } from 'zod';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { OnboardingService } from './onboarding.service';

const dpoSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().max(200) }).strict();
const inviteSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(100) }).strict();

@Controller()
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  @Put('onboarding/escalation-recipient')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  setRecipient(@Req() req: Request, @Body() body: unknown) {
    const { email } = parseBody(escalationRecipientSchema, body);
    return this.onboarding.setRecipient(email, { userId: this.cls.get('userId'), ...clientInfo(req) });
  }

  @Get('onboarding/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  status() {
    return this.onboarding.status();
  }

  @Put('onboarding/dpo')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  setDpo(@Req() req: Request, @Body() body: unknown) {
    const { name, email } = parseBody(dpoSchema, body);
    return this.onboarding.setDpo(name, email, { userId: this.cls.get('userId'), ...clientInfo(req) });
  }

  @Get('onboarding/activation')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  activation() {
    return this.onboarding.activation();
  }

  /** Só sai de TRIAL com destinatário alternativo verificado, MFA do ADMIN e DPO informado. */
  @Post('onboarding/activate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  activate(@Req() req: Request) {
    return this.onboarding.activate({ userId: this.cls.get('userId'), ...clientInfo(req) });
  }

  /** Link do convite enviado pela plataforma ao primeiro ADMIN: define a própria senha (uso único, 72 h). */
  @Post('public/onboarding/admin-invite')
  @HttpCode(200)
  acceptInvite(@Req() req: Request, @Body() body: unknown) {
    const { token, password } = parseBody(inviteSchema, body);
    return this.onboarding.acceptInvite(token, password, clientInfo(req).ip);
  }

  /** Links do e-mail do destinatário alternativo (sem conta): protegidos por token de 256 bits. */
  @Post('public/onboarding/escalation/confirm')
  @HttpCode(200)
  confirm(@Body() body: unknown) {
    return this.onboarding.confirm(parseBody(escalationConfirmSchema, body).token);
  }

  @Post('public/onboarding/escalation/enroll')
  @HttpCode(200)
  enroll(@Body() body: unknown) {
    const { token, code } = parseBody(escalationEnrollSchema, body);
    return this.onboarding.enroll(token, code);
  }
}
