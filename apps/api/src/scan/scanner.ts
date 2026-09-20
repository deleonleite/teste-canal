import { Socket } from 'node:net';

import { Injectable } from '@nestjs/common';

export type ScanResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string };

/** Porta de antivírus. Todo arquivo passa por aqui antes de poder ser baixado (doc §5.4). */
export abstract class Scanner {
  abstract scan(body: Buffer): Promise<ScanResult>;
}

/**
 * ClamAV (clamd) auto-hospedado: o arquivo da denúncia NUNCA sai da infraestrutura contratada.
 * Protocolo INSTREAM: comando, blocos [4 bytes BE de tamanho][dados], terminador de tamanho 0.
 * Erro de comunicação/limite LANÇA exceção (o job é retentado); nunca vira "limpo" por engano.
 */
export class ClamdScanner extends Scanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {
    super();
  }

  scan(body: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('Tempo esgotado no clamd')));
      socket.on('error', reject);
      socket.on('data', (d) => chunks.push(d));
      socket.on('close', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (reply.endsWith('OK')) return resolve({ status: 'CLEAN' });
        const found = /stream:\s*(.+?)\s+FOUND$/.exec(reply);
        if (found) return resolve({ status: 'INFECTED', signature: found[1]! });
        reject(new Error(`Resposta inesperada do clamd: ${reply || '(vazia)'}`));
      });
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < body.length; i += CHUNK) {
          const part = body.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // terminador
      });
    });
  }
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Somente dev/teste sem clamd: detecta apenas o arquivo de teste EICAR. Jamais em produção. */
@Injectable()
export class EicarOnlyScanner extends Scanner {
  async scan(body: Buffer): Promise<ScanResult> {
    return body.includes(EICAR) ? { status: 'INFECTED', signature: 'Eicar-Test-Signature' } : { status: 'CLEAN' };
  }
}

export function createScanner(): Scanner {
  const { CLAMAV_HOST, CLAMAV_PORT } = process.env;
  if (CLAMAV_HOST) return new ClamdScanner(CLAMAV_HOST, Number(CLAMAV_PORT ?? 3310));
  if (process.env.NODE_ENV === 'production') throw new Error('CLAMAV_HOST obrigatório em produção');
  return new EicarOnlyScanner();
}

export const EICAR_TEST_STRING = EICAR;
