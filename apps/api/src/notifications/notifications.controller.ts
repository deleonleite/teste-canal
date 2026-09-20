import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { preferencesSchema } from '@ouvion/contracts';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { parseBody } from '../common/zod';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { NotificationsService } from './notifications.service';

const listQuery = z.object({ unread: z.enum(['true', 'false']).optional() });

/** Sempre restrito às notificações do próprio usuário. */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private me(): string {
    return this.cls.get('userId')!;
  }

  @Get()
  list(@Query() raw: unknown) {
    return this.notifications.list(this.me(), parseBody(listQuery, raw).unread === 'true');
  }

  @Get('unread-count')
  async unread() {
    return { count: await this.notifications.unreadCount(this.me()) };
  }

  @Post('read-all')
  @HttpCode(200)
  readAll() {
    return this.notifications.markAllRead(this.me());
  }

  @Get('preferences')
  preferences() {
    return this.notifications.getPreferences(this.me());
  }

  @Put('preferences')
  updatePreferences(@Body() body: unknown) {
    return this.notifications.updatePreferences(this.me(), parseBody(preferencesSchema, body));
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@Param('id') id: string) {
    return this.notifications.markRead(this.me(), parseBody(z.string().uuid(), id));
  }
}
