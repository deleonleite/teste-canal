import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseEnv } from '@ouvion/contracts';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const env = parseEnv(process.env); // fail-fast
  if (env.NODE_ENV === 'production' && !process.env.JWT_ACCESS_SECRET) {
    throw new Error('JWT_ACCESS_SECRET obrigatório em produção');
  }
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  await app.listen(env.PORT);
}

void bootstrap();
