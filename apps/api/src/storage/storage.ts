import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';

/** Porta de storage de anexos (bucket privado). Objetos nunca ficam públicos: só URL pré-assinada. */
export abstract class Storage {
  abstract readonly bucket: string;
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  abstract get(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
  abstract presignGet(key: string, expiresInSeconds: number): Promise<string>;
}

/** Desenvolvimento/teste. Guarda apenas bytes e tipo — nenhum metadado do remetente. */
@Injectable()
export class MemoryStorage extends Storage {
  readonly bucket = 'memory';
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error('Objeto não encontrado');
    return o.body;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return `memory://${this.bucket}/${key}?expires=${expiresInSeconds}`;
  }
}

/** S3-compatível (Cloudflare R2 em produção, MinIO em dev). */
export class S3Storage extends Storage {
  private readonly client: S3Client;

  constructor(
    readonly bucket: string,
    opts: { endpoint?: string; region?: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean },
  ) {
    super();
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? 'auto',
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}

export function createStorage(): Storage {
  const { S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE } = process.env;
  if (S3_BUCKET) {
    if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) throw new Error('Credenciais S3 ausentes');
    return new S3Storage(S3_BUCKET, {
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      forcePathStyle: S3_FORCE_PATH_STYLE === 'true',
    });
  }
  if (process.env.NODE_ENV === 'production') throw new Error('S3_BUCKET obrigatório em produção');
  return new MemoryStorage();
}
