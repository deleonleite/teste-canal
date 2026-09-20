import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { createComplaintSchema, lookupComplaintSchema } from '@ouvion/contracts';

import { SessionService } from '../auth/session.service';
import { ProtocolSessionService } from '../channel/protocol-session';
import { RateLimit, RateLimitGuard } from '../common/rate-limiter';
import { parseBody } from '../common/zod';
import { ComplaintsService } from './complaints.service';

/**
 * Canal público. ATENÇÃO (anonimato): este controller NÃO injeta @Req() nem lê IP/user-agent — nada
 * do cliente anônimo chega à aplicação além do corpo. O único ponto que toca o IP é o RateLimitGuard,
 * que o transforma em HMAC opaco (sal diário) só em memória. Não adicionar logging de requisição aqui.
 */
@Controller('public/complaints')
@UseGuards(RateLimitGuard)
export class ComplaintsPublicController {
  constructor(
    private readonly complaints: ComplaintsService,
    private readonly sessions: SessionService,
    private readonly protocolSessions: ProtocolSessionService,
  ) {}

  @Post()
  @RateLimit({ name: 'create-complaint', limit: 10, windowSec: 3600 })
  async create(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    const input = parseBody(createComplaintSchema, body);
    // Só denúncia identificada usa (e exige) sessão; a anônima ignora qualquer credencial enviada.
    const session = input.isAnonymous ? null : await this.sessions.tryResolve(authorization);
    const { complaintId, ...created } = await this.complaints.create(input, session);
    // Token temporário do protocolo: autoriza mensagens e anexos sem novo login.
    return { ...created, sessionToken: await this.protocolSessions.sign(complaintId) };
  }

  /** POST (não GET) para que a chave de acesso nunca apareça em URL/log de proxy. */
  @Post('lookup')
  @HttpCode(200)
  @RateLimit({ name: 'lookup', limit: 30, windowSec: 900 })
  async lookup(@Body() body: unknown) {
    const { protocol, accessKey } = parseBody(lookupComplaintSchema, body);
    const found = await this.complaints.lookup(protocol, accessKey);
    return { ...found, sessionToken: await this.protocolSessions.sign(found.id) };
  }
}
