import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const JOB_NAMES = [
  'attachment-scan', 'attachment-sweep', 'audit-seal', 'audit-anchor', 'audit-verify', 'sla-check', 'notification-email',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface EnqueueOptions {
  /** Deduplica: o mesmo id não entra duas vezes na fila. */
  jobId?: string;
}

/** Porta de fila. Produtores (API) e consumidores (worker) só conhecem esta interface. */
export abstract class JobQueue {
  abstract enqueue(name: JobName, data: object, opts?: EnqueueOptions): Promise<void>;
  abstract close(): Promise<void>;
}

/** Dev/teste sem Redis: guarda os jobs em memória (o teste os executa chamando os handlers). */
@Injectable()
export class InMemoryJobQueue extends JobQueue {
  readonly jobs: Array<{ name: JobName; data: Record<string, unknown>; jobId?: string }> = [];

  async enqueue(name: JobName, data: object, opts: EnqueueOptions = {}): Promise<void> {
    if (opts.jobId && this.jobs.some((j) => j.jobId === opts.jobId)) return;
    this.jobs.push({ name, data: data as Record<string, unknown>, jobId: opts.jobId });
  }
  async close(): Promise<void> {
    /* nada */
  }
}

/**
 * BullMQ sobre Redis. Retentativa exponencial (3x). Jobs concluídos somem na hora e os falhos
 * expiram em 1 h: a fila não guarda histórico que permita reconstruir o instante de um evento.
 */
export class BullJobQueue extends JobQueue {
  private readonly log = new Logger(BullJobQueue.name);
  private readonly connection: IORedis;
  private readonly queues = new Map<JobName, Queue>();

  constructor(url: string) {
    super();
    this.connection = new IORedis(url, { maxRetriesPerRequest: null });
  }

  private queue(name: JobName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(name: JobName, data: object, opts: EnqueueOptions = {}): Promise<void> {
    await this.queue(name).add(name, data, {
      jobId: opts.jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { age: 3600 },
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connection.disconnect();
  }
}

export function createJobQueue(): JobQueue {
  const url = process.env.REDIS_URL;
  if (url) return new BullJobQueue(url);
  if (process.env.NODE_ENV === 'production') throw new Error('REDIS_URL obrigatório em produção');
  return new InMemoryJobQueue();
}
