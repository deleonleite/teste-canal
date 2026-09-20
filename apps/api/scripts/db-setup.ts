import { PrismaClient } from '@prisma/client';

/** Define as senhas dos papéis de banco a partir do ambiente (nunca versionadas em migration). */
async function main(): Promise<void> {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) throw new Error('DIRECT_DATABASE_URL é obrigatório');
  const prisma = new PrismaClient({ datasourceUrl: url });
  const roles: Array<[string, string | undefined]> = [
    ['app_runtime', process.env.APP_RUNTIME_PASSWORD],
    ['platform_admin', process.env.PLATFORM_ADMIN_PASSWORD],
  ];
  for (const [role, password] of roles) {
    if (!password) throw new Error(`Senha do papel ${role} ausente no ambiente`);
    const escaped = password.replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${escaped}'`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
