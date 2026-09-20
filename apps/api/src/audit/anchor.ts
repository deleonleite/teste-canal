import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface AnchorPayload {
  tenantId: string;
  sealId: string;
  fromSeq: string;
  toSeq: string;
  merkleRoot: string;
  prevSealHash: string | null;
  sealHash: string;
  sealedAt: string;
}

/**
 * Âncora EXTERNA da trilha (doc §5.10): publica o hash do último selo FORA do controle do operador
 * da aplicação. Sem isso, quem controla o banco poderia reescrever a trilha e os selos juntos.
 */
export abstract class Anchor {
  abstract readonly type: 'WORM_BUCKET';
  abstract publish(p: AnchorPayload): Promise<string>;
  /** Devolve o payload publicado (ou null se não existir) para conferência. */
  abstract fetch(ref: string): Promise<AnchorPayload | null>;
}

/** Dev/teste. Em produção usa-se o bucket WORM em conta separada. */
export class MemoryAnchor extends Anchor {
  readonly type = 'WORM_BUCKET' as const;
  readonly objects = new Map<string, AnchorPayload>();

  async publish(p: AnchorPayload): Promise<string> {
    const ref = `memory://anchors/${p.tenantId}/${p.toSeq.padStart(12, '0')}-${p.sealId}.json`;
    if (this.objects.has(ref)) throw new Error('Âncora imutável: já publicada');
    this.objects.set(ref, structuredClone(p));
    return ref;
  }
  async fetch(ref: string): Promise<AnchorPayload | null> {
    return this.objects.get(ref) ?? null;
  }
}

/**
 * Bucket S3 com Object Lock (COMPLIANCE) em conta de nuvem SEPARADA, com credenciais distintas das da
 * aplicação: nem o operador consegue apagar/alterar o objeto durante a retenção.
 */
export class WormBucketAnchor extends Anchor {
  readonly type = 'WORM_BUCKET' as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    opts: { endpoint?: string; region?: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean },
    private readonly retentionDays: number,
  ) {
    super();
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? 'auto',
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async publish(p: AnchorPayload): Promise<string> {
    const key = `anchors/${p.tenantId}/${p.toSeq.padStart(12, '0')}-${p.sealId}.json`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(p),
        ContentType: 'application/json',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: new Date(Date.now() + this.retentionDays * 86_400_000),
      }),
    );
    return `s3://${this.bucket}/${key}`;
  }

  async fetch(ref: string): Promise<AnchorPayload | null> {
    const key = ref.replace(`s3://${this.bucket}/`, '');
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return JSON.parse(await res.Body!.transformToString()) as AnchorPayload;
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }
}

export function createAnchor(): Anchor {
  const { ANCHOR_S3_BUCKET, ANCHOR_S3_ENDPOINT, ANCHOR_S3_REGION, ANCHOR_S3_ACCESS_KEY_ID, ANCHOR_S3_SECRET_ACCESS_KEY, ANCHOR_S3_FORCE_PATH_STYLE, ANCHOR_RETENTION_DAYS } = process.env;
  if (ANCHOR_S3_BUCKET) {
    if (!ANCHOR_S3_ACCESS_KEY_ID || !ANCHOR_S3_SECRET_ACCESS_KEY) throw new Error('Credenciais da âncora ausentes');
    return new WormBucketAnchor(
      ANCHOR_S3_BUCKET,
      {
        endpoint: ANCHOR_S3_ENDPOINT,
        region: ANCHOR_S3_REGION,
        accessKeyId: ANCHOR_S3_ACCESS_KEY_ID,
        secretAccessKey: ANCHOR_S3_SECRET_ACCESS_KEY,
        forcePathStyle: ANCHOR_S3_FORCE_PATH_STYLE === 'true',
      },
      Number(ANCHOR_RETENTION_DAYS ?? 2555),
    );
  }
  if (process.env.NODE_ENV === 'production') throw new Error('ANCHOR_S3_BUCKET obrigatório em produção');
  return new MemoryAnchor();
}
