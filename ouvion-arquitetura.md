# PROMPT — OuviON · Arquitetura Técnica

> Este documento é o complemento técnico do **PROMPT — OuviON · Canal de Denúncias Corporativo (Regras de Negócio)**. Aquele documento define *o quê*; este define *como*: stack, infraestrutura, padrões de arquitetura, modelo de dados físico, segurança de plataforma, configuração de projeto e estrutura de pastas. Toda decisão aqui existe para viabilizar as regras do documento de negócio — especialmente RLS multi-tenant, operador sem acesso a conteúdo, auditoria com âncora externa, anonimato técnico e imutabilidade do relato.
>
> Stack definida pelo cliente: **NestJS** (API), **Next.js** (frontend), **Vercel** (deploy do frontend), **Render** (deploy do backend/infra). As demais escolhas (banco, ORM, filas, storage, padrões internos) são decisão técnica deste documento.

---

## 0. Decisões de arquitetura (resumo)

| Decisão | Escolha | Alternativa considerada | Por quê |
|---|---|---|---|
| Linguagem | TypeScript estrito em todo o monorepo | — | Único time, um só compilador mental, tipos compartilhados entre API e web |
| Monorepo | pnpm workspaces + Turborepo | Nx, poliretório | Build incremental com cache, DX simples, menor curva de aprendizado |
| Backend | NestJS 10 (Node 20 LTS), monólito modular | Microsserviços | Domínio único (compliance), equipe pequena/média; monólito modular com limites de módulo claros dá 90% do benefício de microsserviço com 10% do custo operacional |
| Banco de dados | PostgreSQL 16 (Render Postgres, plano com HA) | MySQL, Supabase | RLS nativo (requisito de isolamento §3/§7), JSONB, extensões (pgcrypto, pg_trgm), maturidade para auditoria/triggers |
| ORM | Prisma | Drizzle, TypeORM | Melhor DX/migrations do mercado; RLS resolvido via padrão conhecido (sessão de transação + `SET LOCAL`), documentado em §6 |
| Fila/jobs | BullMQ + Redis (Render Redis) | SQS, Kafka | Simplicidade, latência baixa, mesma infra (Render), suficiente para o volume esperado |
| Storage de anexos | Cloudflare R2 (S3-compatible) | AWS S3 | Sem custo de egress (dossiês/anexos baixados via URL pré-assinada geram tráfego), API idêntica a S3 |
| Antivírus | ClamAV self-hosted (Render Private Service) | API de terceiro (VirusTotal etc.) | Arquivo de denúncia **nunca** sai da infraestrutura contratada — requisito de confidencialidade |
| E-mail transacional | Resend | AWS SES | DX, templates React Email, deliverability boa para o volume inicial; migração para SES é trivial se o volume crescer |
| SMS / segundo fator por telefone | Twilio | — | Necessário para MFA por SMS de apoio e para o OTP do destinatário externo (§5.2.9 do doc de negócio) |
| Autorização fina | CASL | RBAC manual espalhado em `if` | Perfis + atributos (impedido, restrito, dono) não cabem em RBAC simples; CASL centraliza a regra e é testável isoladamente |
| Validação | Zod (schema único, compartilhado front/back) | class-validator isolado | Uma fonte de verdade; `nestjs-zod` no backend, `react-hook-form` + `@hookform/resolvers/zod` no frontend — elimina duplicação e drift de validação |
| Contrato de API | OpenAPI gerado do NestJS (`@nestjs/swagger`) + client TS gerado (`orval`) | tRPC | API pública é requisito de negócio (§5.15); OpenAPI serve tanto o client interno quanto integrações externas com o mesmo artefato |
| Frontend | Next.js 15 (App Router), Vercel | Remix, SPA pura | White-label com domínio próprio por tenant é caso de uso nativo do Vercel (Domains API); SSR resolve branding por tenant no servidor sem flash de tema errado |
| Comunicação Web↔API | **Next.js como BFF**: Route Handlers fazem proxy para a API NestJS | Browser chama a API diretamente | Resolve cookies httpOnly em domínio próprio de cliente sem CORS cross-site; ver §11 |
| Observabilidade | Sentry (erros) + OpenTelemetry → Grafana Cloud/Axiom (traces/logs) + pino (logs estruturados) | Datadog | Custo proporcional ao estágio da empresa, padrão aberto (OTel) evita lock-in |

---

## 1. Topologia de infraestrutura

```
                        ┌─────────────────────────────┐
   Navegador  ───────▶  │  Vercel — Next.js (app web)  │
 (slug/domínio próprio) │  BFF: Route Handlers /api/*  │
                        └───────────────┬──────────────┘
                                        │ HTTPS + header de serviço
                                        ▼
                        ┌─────────────────────────────┐
                        │  Render — Web Service        │
                        │  API NestJS (REST + OpenAPI) │
                        └───┬───────────┬──────────┬───┘
                            │           │          │
                 ┌──────────▼──┐ ┌──────▼─────┐ ┌──▼───────────────┐
                 │ Render       │ │ Render     │ │ Render Private   │
                 │ PostgreSQL   │ │ Redis      │ │ Service: ClamAV  │
                 │ (RLS)        │ │ (BullMQ,   │ │ (clamd via TCP,  │
                 │              │ │ rate-limit,│ │  rede privada)   │
                 │              │ │ idempotên.)│ │                  │
                 └──────────────┘ └─────┬──────┘ └──────────────────┘
                                        │
                        ┌───────────────▼───────────────┐
                        │ Render — Background Worker     │
                        │ (NestJS: consumers BullMQ)      │
                        │ notificações, dossiês, antivírus│
                        │ SLA, selos de auditoria, retenção│
                        │ webhooks de saída, digest        │
                        └───────────────┬───────────────┘
                                        │
                 ┌──────────────────────┼───────────────────────┐
                 ▼                      ▼                       ▼
        ┌─────────────────┐   ┌─────────────────┐    ┌─────────────────┐
        │ Cloudflare R2    │   │ Resend (e-mail) │    │ Twilio (SMS)     │
        │ (anexos/dossiês) │   │                 │    │                 │
        └─────────────────┘   └─────────────────┘    └─────────────────┘
```

- **Vercel**: dois projetos Next.js a partir do mesmo monorepo — `apps/web` (canal público + área autenticada do tenant, multi-domínio) e `apps/admin-web` opcionalmente separado para `/loginadm` e o painel SUPER_ADMIN (isolamento de superfície de ataque; pode começar como rotas do mesmo app e ser extraído depois — ver §17).
- **Render**: três serviços a partir de `apps/api` — Web Service (API), Background Worker (mesmo código, entrypoint diferente, processa filas), Cron Jobs nativos do Render para tarefas de calendário (retenção diária, verificação de âncora, digest diário) além dos jobs repetíveis do BullMQ.
- **Rede privada do Render** conecta API, Worker, Postgres, Redis e ClamAV sem sair para a internet.
- **Região**: escolher a mesma região para Render (serviços + Postgres + Redis) e o bucket R2 mais próximo, para respeitar o requisito de região de dados no Brasil (§3/§7 do doc de negócio); documentar a região exata contratada no DPA.

---

## 2. Monorepo e ferramentas de projeto

```
ouvion/
├── apps/
│   ├── web/                 # Next.js — canal público + área autenticada
│   ├── admin-web/           # Next.js — painel SUPER_ADMIN (opcional, fase 2+)
│   ├── api/                 # NestJS — API HTTP
│   └── worker/              # NestJS — consumidores BullMQ (reaproveita módulos de api via package)
├── packages/
│   ├── contracts/           # Schemas Zod + tipos compartilhados (DTOs, enums, eventos de domínio)
│   ├── api-client/          # Client TS gerado do OpenAPI (orval) + wrapper de fetch
│   ├── ui/                  # Design system (shadcn/ui customizado, tokens de tema)
│   ├── config/              # eslint-config, tsconfig base, prettier-config compartilhados
│   └── testing/             # fixtures, factories (fishery), helpers de teste e2e
├── infra/
│   ├── render.yaml          # Blueprint dos serviços Render (IaC)
│   ├── docker/              # Dockerfiles (api, worker, clamav) e docker-compose de dev
│   └── scripts/             # scripts de seed, migração, verificação de âncora local
├── .github/workflows/       # CI/CD
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── .env.example
```

Ferramentas de qualidade (raiz do monorepo, herdadas por todos os pacotes via `packages/config`):

**`packages/config/eslint-preset.cjs`**
```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { project: true, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'import', 'unicorn', 'sonarjs'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:sonarjs/recommended-legacy',
    'prettier', // desliga regras de estilo conflitantes com o Prettier
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
    'import/order': ['error', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'sonarjs/cognitive-complexity': ['warn', 15],
  },
};
```

**`packages/config/prettier.cjs`**
```js
module.exports = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  plugins: ['prettier-plugin-tailwindcss'],
};
```

**`tsconfig.base.json`** (herdado por todos os apps/pacotes)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true
  }
}
```

Git hooks e convenções de commit:

- **Husky** + **lint-staged**: `pre-commit` roda `eslint --fix` e `prettier --write` só nos arquivos staged; `pre-push` roda `turbo run typecheck test`.
- **commitlint** (Conventional Commits) + **Changesets** para versionar `packages/*` e gerar changelog.
- `.editorconfig` alinhando indentação/EOL entre IDEs.

**Scripts na raiz (`package.json`)**
```json
{
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:e2e": "turbo run test:e2e",
    "format": "prettier --write .",
    "prepare": "husky"
  }
}
```

**Ambiente local (`infra/docker/docker-compose.yml`)**: Postgres 16, Redis 7, ClamAV, MailHog (captura e-mails em dev), MinIO (S3 local para não depender do R2 em dev). `apps/api` e `apps/worker` sobem via `pnpm dev` apontando para esses serviços; `.env.example` documenta todas as variáveis com comentário do que cada uma faz e é validado no boot (§4).

---

## 3. Variáveis de ambiente e segredos

Toda variável de ambiente é validada **no boot** com Zod (`packages/contracts/env.ts`), e a aplicação falha rápido (fail-fast) se algo obrigatório faltar ou tiver formato inválido — nunca sobe em estado parcialmente configurado.

```ts
// packages/contracts/src/env.ts
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  DATABASE_URL: z.string().url(),          // pooled (pgbouncer), usado em runtime
  DIRECT_DATABASE_URL: z.string().url(),   // conexão direta, usado só em migrations
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  KMS_MASTER_KEY_ID: z.string(),
  R2_BUCKET: z.string(), R2_ACCESS_KEY_ID: z.string(), R2_SECRET_ACCESS_KEY: z.string(),
  CLAMAV_HOST: z.string(), CLAMAV_PORT: z.coerce.number(),
  RESEND_API_KEY: z.string(),
  TWILIO_ACCOUNT_SID: z.string(), TWILIO_AUTH_TOKEN: z.string(),
  SENTRY_DSN: z.string().url().optional(),
  SUPER_ADMIN_DATABASE_URL: z.string().url(), // papel de banco distinto — ver §6.3
});
```

- Segredos vivem nas variáveis de ambiente nativas do Vercel/Render (criptografadas em repouso pela plataforma), nunca em arquivo versionado. Para times maiores, avaliar Doppler ou Infisical como camada única de gestão de segredos com sincronização para os dois provedores.
- Rotação: `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` e `KMS_MASTER_KEY_ID` têm rotina de rotação documentada (dupla chave ativa durante a transição) — ver §8.4.
- Nenhum segredo do backend é exposto ao Next.js; variáveis `NEXT_PUBLIC_*` contêm só o estritamente necessário ao client (URL pública, chave pública de algum SDK de terceiro, se houver).

---

## 4. Arquitetura do backend (NestJS)

### 4.1 Estilo: monólito modular com bordas hexagonais

Cada módulo de negócio (bounded context) segue a mesma estrutura interna, para que qualquer desenvolvedor navegue qualquer módulo com o mesmo mapa mental:

```
apps/api/src/modules/complaints/
├── domain/
│   ├── entities/complaint.entity.ts        # regras e invariantes puras (sem Prisma, sem HTTP)
│   ├── value-objects/protocol.vo.ts
│   ├── value-objects/access-key.vo.ts
│   ├── events/complaint-created.event.ts
│   └── ports/complaint.repository.port.ts  # interface — o domínio não conhece Prisma
├── application/
│   ├── commands/create-complaint.command.ts
│   ├── commands/create-complaint.handler.ts
│   ├── queries/get-complaint-by-protocol.handler.ts
│   └── services/complaint-access-policy.service.ts  # regras de acesso (restrito/impedido) via CASL
├── infrastructure/
│   ├── persistence/prisma-complaint.repository.ts   # implementa o port com Prisma
│   ├── persistence/complaint.mapper.ts              # domain ⇄ Prisma model
│   └── storage/attachment-storage.adapter.ts        # implementa port de storage (R2)
└── interface/
    ├── http/complaints.controller.ts
    ├── http/dto/create-complaint.dto.ts   # gerado a partir de schema Zod de packages/contracts
    └── http/complaints.public.controller.ts  # rotas públicas (protocolo+chave) separadas das autenticadas
```

- **`domain/`** não importa Nest, Prisma nem Express — é TypeScript puro, testável sem infraestrutura. É aqui que vivem invariantes como "o relato original é imutável" (o próprio `ComplaintEntity` recusa `title`/`description` alterados fora do fluxo de anonimização) e a geração de protocolo/chave.
- **`application/`** orquestra casos de uso. Módulos com forte exigência de auditoria e efeitos colaterais (Complaints, Users, Attachments, Audit, ConflictOfInterest) usam **CQRS** (`@nestjs/cqrs`): todo `Command` passa por um `CommandBus`, e o handler, ao terminar, publica um `DomainEvent` (`ComplaintStatusChangedEvent`, `ConflictFlaggedEvent` etc.) consumido por listeners independentes — é assim que Notificações, SLA e Auditoria reagem sem acoplar o módulo de origem a eles. Módulos mais simples (Settings, Branding) usam serviço comum, sem CQRS — **não aplicar CQRS onde não compensa a complexidade**.
- **`infrastructure/`** é a única camada que conhece Prisma, R2, ClamAV, Resend, Twilio. Toda integração externa é um **adapter** atrás de uma **port** (interface) definida no domínio — troca de provedor (ex.: Resend → SES) não toca `domain/` nem `application/`.
- **`interface/`** expõe HTTP. DTOs são inferidos de schemas Zod centralizados em `packages/contracts`, validados por um `ZodValidationPipe` (`nestjs-zod`) — o mesmo schema valida o formulário no Next.js.

### 4.2 Módulos do domínio (mapeados às seções do documento de negócio)

`tenants` · `auth` (login, MFA, SSO/SCIM) · `users` · `complaints` · `complaint-messages` · `complaint-comments` · `attachments` · `dossiers` · `conflicts-of-interest` (ConflictFlag + ExternalAccess) · `investigations` (plano/tarefas/entrevistas) · `notifications` · `audit` (rowHash/seals/verificação) · `sla` · `settings` · `reports` · `integrations` (API keys/webhooks) · `billing` · `super-admin` (módulo à parte, com seu próprio `PrismaClient` sob o papel de banco restrito — ver §6.3) · `platform-shared` (branding público, health checks).

### 4.3 Guards, interceptors e filters (pipeline de request)

Ordem de execução por request autenticada:

1. **`TenantResolutionMiddleware`** — resolve o tenant por slug de rota, domínio customizado (header `Host`) ou claim do JWT; grava em contexto (`nestjs-cls`), rejeita se o `tenantId` do JWT não bater com o tenant resolvido pela URL.
2. **`JwtAuthGuard`** — valida o access token do cookie httpOnly; se expirado, retorna 401 específico que o BFF sabe interpretar para acionar o refresh.
3. **`RolesGuard`** — checagem grossa de papel (`@Roles('ADMIN', 'INVESTIGATOR')`).
4. **`CaslPoliciesGuard`** — checagem fina por recurso (`can('update', complaint)`), onde a `Ability` de cada usuário é construída considerando papel, `isRestricted`, `ConflictFlag` pendente/confirmado e propriedade (`createdBy`). É aqui que vive, de forma centralizada e testável, toda a matriz de permissões do §2 do documento de negócio.
5. **`TenantContextInterceptor`** — abre a transação Prisma e executa `SET LOCAL app.tenant_id = $1` antes de qualquer query do handler (detalhe em §6.2).
6. Handler do controller → `CommandBus`/`QueryBus`/serviço.
7. **`AuditInterceptor`** — para rotas marcadas com `@Audited('READ' | 'UPDATE' | ...)`, grava o registro de auditoria após a resposta, com o resultado (sucesso/erro) e o `resourceId`.
8. **`AllExceptionsFilter`** — mapeia exceções de domínio para HTTP, garantindo mensagens genéricas nos pontos exigidos pelo negócio (login, consulta por protocolo) e nunca vazando stack trace em produção.

### 4.4 Idempotência e concorrência

- Endpoints de criação sensíveis (`POST /complaints`, geração de dossiê, envio de mensagem) aceitam header `Idempotency-Key`; a API grava a chave no Redis com o hash do corpo e devolve a resposta anterior em caso de replay — protege contra duplo clique e retries do BFF.
- Atualizações concorrentes de `Complaint` usam `updatedAt` como *optimistic lock* (`WHERE id = $1 AND updatedAt = $2`), evitando condição de corrida entre dois investigadores editando o mesmo caso.

---

## 5. Multi-tenancy e isolamento de dados

Defesa em profundidade em três camadas, nenhuma delas sozinha é suficiente:

1. **Aplicação**: todo repositório recebe o `tenantId` do contexto de request (nunca do body do cliente) e o inclui em toda query.
2. **Postgres RLS**: cada tabela com dado de tenant tem política `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. Mesmo um bug na camada de aplicação que esqueça o filtro não vaza dado entre tenants.
3. **Testes automatizados de vazamento** (CI, bloqueante): suíte que cria dois tenants, popula dados, autentica como tenant A e tenta ler/escrever recurso do tenant B por todos os endpoints — espera 403/404 e, adicionalmente, roda a mesma tentativa **direto no banco** trocando `app.tenant_id` para confirmar que a política RLS por si só já barra.

### 5.1 Propagação do contexto de tenant sem `REQUEST`-scope

Providers `REQUEST`-scoped no Nest recriam toda a árvore de DI a cada request (custo de performance). Em vez disso, usamos **`nestjs-cls`** (Continuation-Local Storage sobre `AsyncLocalStorage`): o middleware grava `{ tenantId, userId, role }` no CLS assim que resolve o tenant, e qualquer serviço, em qualquer profundidade da call stack, lê esse contexto sem precisar recebê-lo por parâmetro nem pagar o custo do escopo de request.

### 5.2 `SET LOCAL` por transação (RLS com Prisma)

Prisma não expõe nativamente `SET LOCAL`. Solução: uma extensão de client (`$extends`) que envolve toda query em `$transaction`, executando `SET LOCAL app.tenant_id = ...` como primeiro statement:

```ts
// infrastructure/prisma/tenant-scoped-prisma.ts
export function tenantScopedClient(base: PrismaClient, cls: ClsService) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query, model, operation }) {
          const tenantId = cls.get('tenantId');
          return base.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
            return (tx[model] as any)[operation](args);
          });
        },
      },
    },
  });
}
```

> Nota deliberada: `SET LOCAL` embrulhando cada operação em transação tem custo de round-trip. Para os endpoints de leitura de alta frequência (listagem, dashboard), avaliar client Prisma dedicado com **pool de conexões pré-configurado por tenant via `PgBouncer` + `SET SESSION`** apenas se o perfil de carga justificar; começar com a abordagem simples e medir antes de otimizar.

### 5.3 SUPER_ADMIN sem acesso a conteúdo (garantia de banco, não só de aplicação)

Dois papéis de banco distintos, com `GRANT`/`REVOKE` explícitos em migration própria:

- **`app_runtime`**: usado por `apps/api` e `apps/worker`. Tem RLS habilitado e políticas de tenant em todas as tabelas de conteúdo (`Complaint`, `Attachment`, `ComplaintMessage`, `ComplaintComment`, `Dossier`, `Interview` etc.).
- **`platform_admin`**: usado **somente** pelo módulo `super-admin`, com sua própria instância de `PrismaClient` (`SUPER_ADMIN_DATABASE_URL`). Recebe `GRANT SELECT/INSERT/UPDATE` apenas em `Tenant`, `BillingAccount`, `UsageRecord`, `SystemSetting` (chaves de plataforma) e `AuditLog` **com a coluna `details` mascarada por uma view** (`audit_log_platform_view`) — não tem `GRANT` nenhum nas tabelas de conteúdo listadas acima. Uma tentativa de `SELECT * FROM complaints` sob esse papel falha com `permission denied` no próprio Postgres, não por regra de aplicação.
- Teste de CI dedicado: conecta como `platform_admin` e tenta ler cada tabela de conteúdo, espera erro de permissão em todas.
- **Quebra de vidro de plataforma**: usa uma terceira credencial, cofre à parte (não fica em variável de ambiente de longa duração dos serviços), acionada manualmente com aprovação de dois SUPER_ADMIN e expiração automática — implementado como um script operacional auditado, fora do fluxo normal da aplicação.

---

## 6. Banco de dados e ORM

### 6.1 Por que Prisma

Prisma foi escolhido sobre Drizzle por: (a) `prisma migrate` com histórico versionado e `prisma migrate diff` para revisão de PR; (b) Prisma Studio útil em triagem de suporte (sob o papel `app_runtime`, nunca `platform_admin`); (c) ecossistema de extensões (`$extends`) suficiente para resolver RLS (§5.2) sem abrir mão da produtividade de um ORM completo. O custo assumido (menos controle fino de SQL) é mitigado usando `$queryRaw` tipado nos poucos pontos que exigem SQL específico (triggers de hash, Merkle, particionamento).

### 6.2 O que **não** é feito via Prisma Client em runtime

- **`rowHash` do `AuditLog`**: calculado por **trigger `BEFORE INSERT`** no Postgres (não na aplicação), para que nenhum caminho de escrita — nem um bug, nem uma migration futura — consiga gravar auditoria sem hash.
- **`seq` monotônico por tenant**: `CREATE SEQUENCE audit_seq_<tenant_id>` criada no provisionamento do tenant (dentro da própria migration/transação de criação do tenant). Documentado como **não transacional por natureza** (números são consumidos mesmo em rollback) — isso é esperado e é o que sustenta a detecção de buracos no selo (ver doc de negócio §5.10).
- **Particionamento de `AuditLog`** por mês (via `pg_partman` ou partição declarativa nativa do Postgres 16), para que a tabela que mais cresce no sistema não degrade o desempenho de escrita/consulta com o tempo.
- **Índices** revisados manualmente além do que o Prisma gera: `GIN` em `tags[]` e em busca textual (`pg_trgm` sobre `title`/`description`, respeitando o opt-out `encrypt_complaint_body`), índice parcial em `Complaint(status) WHERE status NOT IN ('RESOLVED','DISMISSED')` para acelerar o dashboard de pendências.

### 6.3 Organização do schema Prisma

Um `schema.prisma` único (Prisma ainda não suporta múltiplos arquivos de forma madura em todas as versões-alvo; se a versão em uso suportar `prismaSchemaFolder`, dividir por domínio em `prisma/schema/*.prisma`), com `enum`s espelhando exatamente os do documento de negócio (§4) e comentários `///` documentando cada campo sensível (`/// PII — cifrado em nível de campo, ver AuditAction`).

- **Migrations**: toda migration passa por `prisma migrate diff` no CI comparando contra produção antes do merge; migrations destrutivas (`DROP COLUMN`, `ALTER ... NOT NULL`) exigem revisão humana explícita e, quando possível, são feitas em duas etapas (expand/contract) para permitir deploy sem downtime.
- **Seeds**: `infra/scripts/seed.ts` cria os tenants/usuários de demonstração do §8 do documento de negócio, cria as sequences por tenant e já verifica um selo de auditoria de exemplo, para que o ambiente de demo/staging nunca fique num estado que a suíte de verificação de auditoria reprove.

---

## 7. Autenticação, autorização e segurança de aplicação

### 7.1 Sessão

- Hash de senha: **Argon2id** (preferência sobre bcrypt, mesmo custo de implementação, melhor resistência a hardware dedicado).
- Access token JWT (15 min) + refresh token opaco (7 dias, hash armazenado, nunca o valor puro) — ambos em **cookies httpOnly, Secure, SameSite=Lax**, escopados ao domínio efetivo daquela sessão (subdomínio da plataforma ou domínio próprio do tenant). Proteção CSRF via *double-submit cookie* nas mutações feitas pelo BFF.
- Rotação de refresh com detecção de reuso (família de tokens) implementada como estava especificado no documento de negócio; a tabela `RefreshToken` é a fonte de verdade, o JWT de acesso nunca é a única checagem de revogação.

### 7.2 MFA e SSO

- TOTP via `otplib`, QR code gerado no backend (segredo nunca trafega em texto puro fora do enrollment). Passkeys (WebAuthn) via `@simplewebauthn/server`, biblioteca correspondente no frontend.
- SSO por tenant: SAML 2.0 (`@node-saml/passport-saml`) e OIDC (`openid-client`), configuração por tenant em `SsoConnection`; SCIM implementado como um controller dedicado com autenticação por token de longa duração próprio (`scimTokenHash`), fora do fluxo de JWT normal.

### 7.3 Autorização fina (CASL)

Uma função `defineAbilityFor(user, context)` centraliza toda a matriz de permissões do documento de negócio (§2), incluindo os predicados que dependem de estado do recurso (`isRestricted`, `ConflictFlag`, `createdBy`, `investigatorId`). É testada isoladamente com uma suíte que replica linha a linha a "matriz resumida por recurso" do documento de negócio — qualquer mudança de regra de acesso quebra um teste antes de chegar a produção.

### 7.4 Segurança de borda

- `helmet` com CSP restritiva (sem `unsafe-inline`), HSTS, `X-Frame-Options: DENY` (o produto nunca deve ser embutido em iframe de terceiro).
- Rate limiting via `@nestjs/throttler` com store Redis, com limites diferenciados por rota conforme o documento de negócio (login, consulta por protocolo, criação de denúncia, verificação de chave) — cada um com sua própria chave de bucket (IP, IP+protocolo).
- CORS: origem permitida é somente o próprio domínio do BFF (Next.js) chamando a API; navegador nunca chama a API do Render diretamente (ver §11), o que simplifica CORS a uma allowlist curta de origens de servidor.
- `helmet`/CSP, cabeçalhos e rate limits têm teste de contrato (verifica presença dos headers em resposta real) para não regredir silenciosamente.

### 7.5 Criptografia de campo

- PII (`reporterEmail`, `reporterPhone`, `metadata.reporterName`) cifrada com AES-256-GCM antes de chegar ao Prisma, usando uma **chave de dados por tenant**, por sua vez protegida por uma chave mestra num KMS (AWS KMS ou Google Cloud KMS, contratado à parte da hospedagem de app/BD — *envelope encryption*). A cifra/decifra é um serviço de infraestrutura (`EncryptionService`), nunca espalhada pelos módulos, e é o único ponto que conhece o KMS.
- Planos enterprise podem trazer sua própria chave (BYOK) — o `EncryptionService` já nasce com essa interface (`KeyProvider` port) para não exigir reescrita depois.

---

## 8. Filas, jobs assíncronos e cron

`apps/worker` reaproveita os módulos de `apps/api` (mesmo `packages/contracts`, mesma camada de domínio) e expõe apenas os `Processor`s do BullMQ. Filas:

| Fila | Consumidor | Retry/back-off | Observação |
|---|---|---|---|
| `notifications` | envio in-app/e-mail/push | 5x exponencial | falha de e-mail nunca falha a operação de negócio original |
| `attachment-scan` | ClamAV + magic bytes + strip de metadados | 3x, depois `ERROR` + alerta | resultado grava `scanStatus`, libera/quarentena o download |
| `dossier-generation` | monta PDF (Puppeteer/`@react-pdf/renderer`) + ZIP | 3x | arquivo grande vai para o worker, nunca bloqueia a request HTTP |
| `sla-check` (cron a cada 15 min) | calcula `SLA_WARNING`/`SLA_BREACHED`, escalonamento | idempotente por `complaintId+threshold` | |
| `audit-seal` (cron a cada 5 min, 1 min em enterprise) | agrega `AuditLog` por `seq`, calcula Merkle, grava `AuditSeal` | idempotente por intervalo `[fromSeq,toSeq]` | |
| `audit-anchor` (cron diário/horário) | publica hash do selo em TSA RFC 3161 e/ou bucket WORM | alerta se falhar 2x seguidas | credenciais de âncora distintas das da aplicação |
| `retention-purge` (cron diário) | aplica anonimização/expurgo respeitando `LegalHold` | transacional por caso | grava `integrityStatus=ANONYMIZED` |
| `webhook-delivery` | entrega assinada (HMAC) a webhooks de tenant | 5x exponencial + fila morta | log de entregas visível ao ADMIN |
| `daily-digest` | agrega notificações do dia por usuário | — | respeita `UserPreferences` |

Todas as filas usam **BullMQ Flows** onde há dependência entre etapas (ex.: `attachment-scan` só libera `dossier-generation` se todos os anexos estiverem `CLEAN`).

---

## 9. Frontend (Next.js) e padrão BFF

### 9.1 Next.js como BFF, não só como SSR

O navegador **nunca** chama `api.ouvion.com` diretamente. Toda chamada de dados passa por `apps/web/app/api/**/route.ts`, que:

1. Lê o cookie httpOnly da própria origem (funciona igual em `techcorp.ouvion.com` e em `denuncias.cliente.com.br`, porque o cookie é sempre do domínio que o navegador está vendo);
2. Encaminha a chamada para a API NestJS incluindo um header de serviço assinado (segredo compartilhado Vercel↔Render, rotacionável) que prova que a chamada veio do BFF e não de um cliente arbitrário;
3. Repassa (ou renova, se expirado) o cookie de sessão na resposta.

Isso resolve, de uma vez, dois problemas do white-label com domínio próprio: cookies cross-site (evitados, porque não há cross-site) e CORS (a API só precisa aceitar a origem do BFF, uma lista curta e estável).

### 9.2 Resolução de tenant e branding

`middleware.ts` do Next.js lê o `Host` da requisição, resolve o tenant (cache em Redis/Edge Config por alguns minutos) e injeta o `tenantId` num header interno lido pelo layout raiz, que busca o branding e define as variáveis CSS de tema (`--primary`, `--secondary`, `--logo-url`) **no servidor**, evitando flash de tema errado. Domínio próprio (`customDomain`) é adicionado programaticamente ao projeto Vercel via **Vercel Domains API** quando o ADMIN o cadastra (§3 do doc de negócio), e o status de verificação/TLS é espelhado de volta em `TenantDomain`.

### 9.3 Validação e formulários

Os mesmos schemas Zod de `packages/contracts` (ex.: `createComplaintSchema`) alimentam `react-hook-form` no cliente (validação instantânea) e o `ZodValidationPipe` no NestJS (validação de verdade, nunca confiar só no cliente). Mensagens de erro em português vêm de um dicionário único, evitando que front e back divirjam no texto mostrado ao usuário.

### 9.4 Estado, dados e UI

- **TanStack Query** para todo dado de servidor (cache, revalidação, estados de loading/erro padronizados); **Zustand** só para estado de UI puramente client-side (ex.: passo do formulário multi-etapa).
- **shadcn/ui + Radix + Tailwind**, componentes de `packages/ui` compartilháveis entre `web` e `admin-web`.
- **`next-intl`** para PT/EN/ES (§1 do doc de negócio), com PT-BR como *default locale* e fallback.
- Acessibilidade (WCAG 2.1 AA) verificada automaticamente com `axe-core` no Playwright, não só manualmente.

---

## 10. Observabilidade e auditoria técnica

- **Logs**: `nestjs-pino`, formato JSON estruturado, correlação por `x-request-id` propagado do BFF até a fila; **nunca** logar PII ou corpo de denúncia — um `redactPaths` fixo (`req.body.description`, `req.body.reporterEmail` etc.) é aplicado no logger, testado por um linter customizado que falha o CI se um novo campo sensível for adicionado ao Prisma sem redaction correspondente.
- **Erros**: Sentry no `web`, `api` e `worker`, com `beforeSend` removendo PII antes de enviar (mesma allowlist do logger).
- **Tracing**: OpenTelemetry instrumentando NestJS, Prisma e BullMQ, exportando para Grafana Cloud/Axiom; permite ver, numa única trace, uma criação de denúncia atravessando API → fila → worker → e-mail.
- **Métricas de negócio** (não só técnicas): dashboards de p95 de latência (requisito não funcional do doc de negócio), taxa de erro de varredura de antivírus, atraso médio de selagem de auditoria, tenants sem âncora válida nas últimas 48h — alimentam o alerta de plataforma exigido em §5.10 do documento de negócio.

---

## 11. CI/CD

**GitHub Actions**, um workflow por tipo de verificação, todos obrigatórios para merge em `main`:

1. `lint-and-typecheck.yml` — `turbo run lint typecheck` em todo o monorepo (cache do Turborepo entre execuções).
2. `unit-tests.yml` — Jest por pacote/app.
3. `integration-tests.yml` — sobe Postgres+Redis via *services* do Actions, roda migrations, roda testes de repositório/RLS/CASL.
4. `e2e.yml` — Playwright contra um ambiente efêmero (preview do Vercel + API apontando para banco de teste no Render ou container local).
5. `security.yml` — `pnpm audit`/`osv-scanner` (dependências), `trivy` nas imagens Docker (worker/ClamAV), `gitleaks` (segredo vazado em commit).
6. **Suítes bloqueantes específicas do negócio** (critério de pronto do roadmap): suíte de aceitação do anonimato, teste "todos os ADMINs citados", teste "SUPER_ADMIN sem acesso a conteúdo", teste "relato original imutável", teste de vazamento entre tenants — cada uma como job nomeado, para aparecer individualmente no status do PR e não poder ser silenciada por acidente.

**Deploy**:
- **Vercel**: build automático por push (preview por PR, produção em merge em `main`), variáveis de ambiente por ambiente (Preview/Production).
- **Render**: `infra/render.yaml` (Blueprint/IaC) define Web Service, Background Worker, Cron Jobs, Redis, Postgres, serviço privado do ClamAV. Deploy via GitHub Actions chamando o Render Deploy Hook após os testes passarem; **migrations do Prisma rodam como *pre-deploy command*** do Web Service, nunca no boot da aplicação (evita duas instâncias tentando migrar ao mesmo tempo em rolling deploy).
- **Ambientes**: `development` (local, docker-compose) → `staging` (Render/Vercel, dados sintéticos, MFA pode ser desativado só aqui) → `production`. Staging usa uma cópia anonimizada do schema de produção para testes realistas sem expor PII real.

---

## 12. Testes (pirâmide)

| Camada | Ferramenta | Escopo |
|---|---|---|
| Unitário | Jest | `domain/` puro (entidades, value objects), `application/` com repositórios mockados, `CaslPoliciesGuard`/`defineAbilityFor` |
| Integração | Jest + Supertest + Postgres/Redis reais (Testcontainers ou serviço do CI) | repositórios Prisma, RLS, triggers de auditoria, filas BullMQ |
| Contrato | `orval`/OpenAPI diff | garante que o client TS gerado nunca fica dessincronizado da API |
| E2E | Playwright | jornadas completas (denúncia anônima → mensagem → status → dossiê; login SSO; MFA; quebra de vidro) |
| Carga | k6 | valida p95 < 500 ms da listagem/detalhe sob carga simulada, antes de cada grande release |
| Segurança | ZAP baseline (CI, não bloqueante) + pentest externo anual (bloqueante para ficar `ACTIVE` em enterprise) | conforme requisito não funcional do doc de negócio |

Fixtures e factories (`packages/testing`, com `fishery`) geram tenants, usuários e denúncias de teste com dados realistas, sempre passando pelos mesmos casos de uso do domínio (nunca inserção direta via SQL em teste, para não mascarar regra de negócio quebrada).

---

## 13. Convenções de código

- **Nomenclatura**: entidades de domínio em `PascalCase` sem sufixo (`Complaint`, não `ComplaintEntity`, exceto para diferenciar explicitamente de outra camada quando ambíguo); DTOs terminam em `Dto`; ports terminam em `Port`; adapters terminam em `Adapter`; eventos terminam em `Event`.
- **Erros de domínio**: uma hierarquia própria (`DomainError` → `ForbiddenTransitionError`, `AccessKeyMismatchError` etc.), nunca `throw new Error('...')` solto; o `AllExceptionsFilter` mapeia cada subtipo para o status HTTP e mensagem (genérica onde o doc de negócio exige) corretos.
- **Comentários**: só onde o *porquê* não é óbvio pelo código (decisão de segurança, contorno de limitação de biblioteca); nunca comentário que repete o que a assinatura da função já diz.
- **Tamanho**: função com responsabilidade única; `sonarjs/cognitive-complexity` no lint como guarda-corpo, não como meta.
- **Checklist de PR** (modelo em `.github/pull_request_template.md`): regra de negócio nova tem teste automatizado? Toca tabela de conteúdo — RLS foi considerada? Toca fluxo anônimo — a suíte de anonimato roda contra a mudança? Toca permissão — a matriz do CASL foi atualizada e testada? Gera efeito auditável — `@Audited` foi aplicado?

---

## 14. Roteiro técnico (alinhado ao roadmap de negócio)

| Fase (doc de negócio) | Entrega técnica correspondente |
|---|---|
| 1. Fundação multi-tenant | Monorepo, CI base, schema Prisma completo, RLS, `nestjs-cls`, dois papéis de banco + teste, `render.yaml`, ambientes |
| 2. Privacidade e correções críticas | CASL completo, `AuditInterceptor`, triggers de `rowHash`, suíte de anonimato v1, BFF (Next.js) operando ponta a ponta |
| 3. Canal seguro do denunciante | Token de sessão de protocolo, filas de mensagens/anexo anônimo, rate limits dedicados |
| 4. Segurança de contas, arquivos e prova | MFA/passkeys, ClamAV em produção, `EncryptionService` + KMS, `audit-seal`/`audit-anchor` |
| 5. Processo e investigação | Módulo `investigations`, geração de dossiê no worker, relatórios |
| 6. Canais de volume | Adapters de WhatsApp/Twilio Voice/e-mail dedicado atrás das mesmas ports de `ComplaintSource` |
| 7. Retenção e LGPD | `retention-purge`, particionamento de `AuditLog`, exportação de tenant |
| 8. Enterprise | SSO/SCIM, domínio próprio via Vercel Domains API, billing, BYOK |
| 9. IA assistiva | Serviço isolado (`ai-assist`) chamando provedor de LLM contratado, nunca com PII em claro, com opt-in por tenant |

**Critério de pronto transversal (técnico):** nenhum módulo novo sem `domain/` testável isoladamente; nenhuma tabela de conteúdo sem política RLS antes do merge; nenhum PR verde sem os cinco testes bloqueantes de §11.6; `render.yaml` e `schema.prisma` são a fonte de verdade de infraestrutura e dados — mudança de infraestrutura fora do IaC é tratada como incidente.
