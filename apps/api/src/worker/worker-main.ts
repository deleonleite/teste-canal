import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { AppModule } from '../app.module';
import { AttachmentScanHandler } from '../scan/attachment-scan.handler';
import { JOB_NAMES, type JobName } from '../queue/job-queue';
import { JobHandlers } from './handlers';

/** Jobs de calendário: nome -> intervalo. Cada um faz o fan-out por tenant dentro do handler. */
const SCHEDULE: Partial<Record<JobName, { every: number }>> = {
  'attachment-sweep': { every: 60_000 },
  'audit-seal': { every: 5 * 60_000 },
  'audit-anchor': { every: 60 * 60_000 },
  'audit-verify': { every: 24 * 60 * 60_000 },
  'sla-check': { every: 15 * 60_000 },
  'notification-email': { every: 60_000 },
};

/**
 * Entrypoint do worker (Render Background Worker): mesmo código da API, sem HTTP. Consome as filas
 * BullMQ e agenda os jobs periódicos. Esgotadas as retentativas de uma varredura, o anexo vira ERROR.
 */
async function main(): Promise<void> {
  const log = new Logger('Worker');
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL é obrigatório para o worker');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const handlers = app.get(JobHandlers);
  const scan = app.get(AttachmentScanHandler);
  const connection = new IORedis(url, { maxRetriesPerRequest: null });

  const workers = JOB_NAMES.map((name) => {
    const worker = new Worker(name, (job) => handlers.handle(name, job.data as Record<string, unknown>) as Promise<unknown>, {
      connection,
      concurrency: name === 'attachment-scan' ? 4 : 1,
    });
    worker.on('failed', (job, err) => {
      log.warn(`Job ${name} falhou (${err.name}) — tentativa ${job?.attemptsMade}/${job?.opts.attempts}`);
      const data = job?.data as { tenantId?: string; attachmentId?: string } | undefined;
      if (name === 'attachment-scan' && job && job.attemptsMade >= (job.opts.attempts ?? 1) && data?.tenantId && data.attachmentId) {
        scan.markError(data.tenantId, data.attachmentId, `scan_failed: ${err.message}`).catch((e: Error) => log.error(e.message));
      }
    });
    return worker;
  });

  for (const [name, { every }] of Object.entries(SCHEDULE)) {
    const queue = new Queue(name, { connection });
    await queue.upsertJobScheduler(`${name}-schedule`, { every }, { name, data: {}, opts: { removeOnComplete: true, removeOnFail: { age: 3600 } } });
  }
  log.log(`Worker no ar: ${JOB_NAMES.join(', ')}`);

  const stop = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.close()));
    await app.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
