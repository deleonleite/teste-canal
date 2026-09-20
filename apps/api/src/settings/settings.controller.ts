import { BadRequestException, Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { isSettingKey, SETTING_KEYS, updateSettingSchema, validateSettingValue } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { parseBody } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantClsStore } from '../tenancy/tenant-context';

@Controller()
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  /** Leitura pública: apenas chaves marcadas como públicas. */
  @Get('public/settings')
  async publicSettings() {
    const rows = await this.prisma.run((tx) =>
      tx.systemSetting.findMany({ where: { isPublic: true }, select: { key: true, value: true } }),
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  @Get('settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async all() {
    const rows = await this.prisma.run((tx) => tx.systemSetting.findMany());
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Escrita somente ADMIN; chaves desconhecidas são rejeitadas. Valor não vai para a auditoria. */
  @Put('settings/:key')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async update(@Req() req: Request, @Param('key') key: string, @Body() body: unknown) {
    if (!isSettingKey(key)) throw new BadRequestException('Configuração desconhecida');
    const { value } = parseBody(updateSettingSchema, body);
    const invalid = validateSettingValue(key, value);
    if (invalid) throw new BadRequestException(invalid);
    const userId = this.cls.get('userId')!;
    const isPublic = SETTING_KEYS[key].public;
    await this.prisma.run(async (tx) => {
      const tenantId = (await tx.$queryRaw<{ t: string }[]>`SELECT app_current_tenant()::text AS t`)[0]!.t;
      await tx.systemSetting.upsert({
        where: { tenantId_key: { tenantId, key } },
        create: { tenantId, key, value, isPublic, updatedBy: userId },
        update: { value, isPublic, updatedBy: userId },
      });
      await this.audit.record(tx, {
        action: 'UPDATE',
        resource: 'system_setting',
        resourceId: key,
        userId,
        ...clientInfo(req),
      });
    });
    return { key, updated: true };
  }
}
