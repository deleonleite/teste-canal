import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { escalationConfirmSchema, escalationEnrollSchema, escalationRecipientSchema } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { OnboardingService } from './onboarding.service';

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
