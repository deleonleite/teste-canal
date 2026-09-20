import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createAddendumSchema, messageSchema, retaliationSchema } from '@ouvion/contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { clientInfo } from '../common/client-info';
import { RateLimit, RateLimitGuard } from '../common/rate-limiter';
import { parseBody } from '../common/zod';
import type { Actor } from '../complaints/complaints.service';
import type { TenantClsStore } from '../tenancy/tenant-context';
import { AttachmentsService, type UploadedFile as UploadedFileType } from './attachments.service';
import { MessagesService } from './messages.service';
import { ComplaintsService } from '../complaints/complaints.service';
import { WorkflowService } from '../workflow/workflow.service';
import { ProtocolGuard, ProtocolSessionService } from './protocol-session';

const HARD_CAP_BYTES = 100 * 1024 * 1024; // teto absoluto; o limite do tenant é conferido no serviço
const uuid = z.string().uuid();
const upload = () => FileInterceptor('file', { limits: { fileSize: HARD_CAP_BYTES, files: 1 } });

function requireFile(file: UploadedFileType | undefined): UploadedFileType {
  if (!file) throw new BadRequestException('Envie o arquivo no campo "file"');
  return file;
}

/**
 * Canal do denunciante por sessão de protocolo (anônimo ou não). NÃO injeta @Req(): nada do
 * cliente (IP, user-agent, cabeçalhos) chega a estes handlers.
 */
@Controller('public/channel')
@UseGuards(RateLimitGuard, ProtocolGuard)
export class ChannelPublicController {
  constructor(
    private readonly messages: MessagesService,
    private readonly attachments: AttachmentsService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly workflow: WorkflowService,
    private readonly protocolSessions: ProtocolSessionService,
    private readonly complaints: ComplaintsService,
  ) {}

  private id(): string {
    return this.cls.get('protocolComplaintId')!;
  }

  /** Situação atual do relato (linha do tempo, prazos) para quem já tem sessão de protocolo. */
  @Get('summary')
  summary() {
    return this.complaints.summary(this.id());
  }

  @Get('messages')
  read() {
    return this.messages.readAsReporterSession(this.id());
  }

  @Post('messages')
  @RateLimit({ name: 'channel-write', limit: 60, windowSec: 900 })
  send(@Body() body: unknown) {
    return this.messages.sendAsReporterSession(this.id(), parseBody(messageSchema, body).content);
  }

  @Post('addenda')
  @RateLimit({ name: 'channel-write', limit: 60, windowSec: 900 })
  addendum(@Body() body: unknown) {
    return this.messages.addendumAsReporterSession(this.id(), parseBody(createAddendumSchema, body).content);
  }

  /** Relato de retaliação após o encerramento: gera um caso novo, vinculado, com prioridade HIGH. */
  @Post('retaliation')
  @RateLimit({ name: 'channel-write', limit: 60, windowSec: 900 })
  async retaliation(@Body() body: unknown) {
    const { content } = parseBody(retaliationSchema, body);
    const { complaintId, ...created } = await this.workflow.reportRetaliation(this.id(), content, { anonymousSession: true });
    return { ...created, sessionToken: await this.protocolSessions.sign(complaintId) };
  }

  @Post('attachments')
  @RateLimit({ name: 'channel-upload', limit: 30, windowSec: 900 })
  @UseInterceptors(upload())
  attach(@UploadedFile() file: UploadedFileType | undefined) {
    return this.attachments.uploadAsReporterSession(this.id(), requireFile(file));
  }
}

/** Mensagens e anexos para a equipe e para o REPORTER com conta (nas próprias denúncias). */
@Controller('complaints/:id')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChannelController {
  constructor(
    private readonly messages: MessagesService,
    private readonly attachments: AttachmentsService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private actor(req: Request): Actor {
    return { userId: this.cls.get('userId')!, role: this.cls.get('role')!, ...clientInfo(req) };
  }

  @Get('messages')
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR', 'REPORTER')
  listMessages(@Req() req: Request, @Param('id') id: string) {
    return this.messages.list(this.actor(req), parseBody(uuid, id));
  }

  @Post('messages')
  @Roles('ADMIN', 'INVESTIGATOR', 'REPORTER')
  sendMessage(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.messages.send(this.actor(req), parseBody(uuid, id), parseBody(messageSchema, body).content);
  }

  @Get('attachments')
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR', 'REPORTER')
  listAttachments(@Req() req: Request, @Param('id') id: string) {
    return this.attachments.list(this.actor(req), parseBody(uuid, id));
  }

  @Post('attachments')
  @Roles('ADMIN', 'INVESTIGATOR', 'REPORTER')
  @UseInterceptors(upload())
  upload(@Req() req: Request, @Param('id') id: string, @UploadedFile() file: UploadedFileType | undefined) {
    return this.attachments.upload(this.actor(req), parseBody(uuid, id), requireFile(file));
  }

  @Get('attachments/:attachmentId/download')
  @Roles('ADMIN', 'INVESTIGATOR', 'AUDITOR', 'REPORTER')
  download(@Req() req: Request, @Param('id') id: string, @Param('attachmentId') aid: string) {
    return this.attachments.downloadUrl(this.actor(req), parseBody(uuid, id), parseBody(uuid, aid));
  }

  @Delete('attachments/:attachmentId')
  @Roles('ADMIN', 'INVESTIGATOR', 'REPORTER')
  remove(@Req() req: Request, @Param('id') id: string, @Param('attachmentId') aid: string) {
    return this.attachments.remove(this.actor(req), parseBody(uuid, id), parseBody(uuid, aid));
  }

  @Post('attachments/:attachmentId/verify')
  @Roles('ADMIN', 'AUDITOR')
  verify(@Req() req: Request, @Param('id') id: string, @Param('attachmentId') aid: string) {
    return this.attachments.verifyIntegrity(this.actor(req), parseBody(uuid, id), parseBody(uuid, aid));
  }
}
