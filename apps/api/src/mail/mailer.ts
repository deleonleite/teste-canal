import { Injectable } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  /** E-mails não revelam detalhes da denúncia: apenas protocolo/tipo e link. */
  text: string;
}

/** Porta de e-mail. Trocar de provedor não toca o domínio. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/** Adapter de desenvolvimento/teste: guarda em memória, não envia nada. */
@Injectable()
export class OutboxMailer extends Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Resend (https://resend.com). Erro HTTP LANÇA, para o chamador registrar e reprocessar. */
export class ResendMailer extends Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly baseUrl = 'https://api.resend.com',
  ) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    const res = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
    });
    if (!res.ok) throw new Error(`Resend respondeu ${res.status}`);
  }
}

export function createMailer(): Mailer {
  const { RESEND_API_KEY, MAIL_FROM, RESEND_BASE_URL } = process.env;
  if (RESEND_API_KEY) return new ResendMailer(RESEND_API_KEY, MAIL_FROM ?? 'OuviON <nao-responda@ouvion.com>', RESEND_BASE_URL);
  if (process.env.NODE_ENV === 'production') throw new Error('RESEND_API_KEY obrigatório em produção');
  return new OutboxMailer();
}
