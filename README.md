# OuviON

SaaS **multi-tenant, white-label, de canal de denúncias** (compliance/ética). Cada empresa-cliente tem o seu canal
público, o seu painel de investigação e os seus dados isolados. A equipe da plataforma (OuviON) opera as empresas por
um painel próprio que, **por desenho, não lê conteúdo de denúncia** — só uma "quebra de vidro" aprovada, pontual,
auditada e avisada ao cliente abre exceção.

> Este README é técnico e cobre: arquitetura, como subir cada módulo do zero, banco local, testes, **usuários e
> senhas de demonstração**, e **o que cada perfil pode fazer**. Documentos de regras e de acompanhamento:
> [`PROMPT-REGRAS-DE-NEGOCIO.md`](PROMPT-REGRAS-DE-NEGOCIO.md) · [`ouvion-arquitetura.md`](ouvion-arquitetura.md) ·
> [`PROMPTFRONT.md`](PROMPTFRONT.md) (design system/UX) · [`tarefas.md`](tarefas.md) (painel da plataforma) ·
> [`PROGRESSO.md`](PROGRESSO.md) (o que está feito e verificado, item a item).

---

## Sumário

1. [Arquitetura](#1-arquitetura)
2. [Stack](#2-stack)
3. [Estrutura do repositório](#3-estrutura-do-repositório)
4. [Pré-requisitos](#4-pré-requisitos)
5. [Subir tudo do zero (passo a passo)](#5-subir-tudo-do-zero-passo-a-passo)
6. [Variáveis de ambiente](#6-variáveis-de-ambiente)
7. [Módulo a módulo](#7-módulo-a-módulo)
8. [Banco de dados](#8-banco-de-dados)
9. [Testes](#9-testes)
10. [URLs e portas](#10-urls-e-portas)
11. [Usuários e senhas de demonstração](#11-usuários-e-senhas-de-demonstração)
12. [Perfis e permissões](#12-perfis-e-permissões)
13. [Fluxos principais](#13-fluxos-principais)
14. [Segurança e privacidade (o que é garantido e onde)](#14-segurança-e-privacidade-o-que-é-garantido-e-onde)
15. [O que é real, o que é mock, o que falta](#15-o-que-é-real-o-que-é-mock-o-que-falta)
16. [Solução de problemas](#16-solução-de-problemas)

---

## 1. Arquitetura

```
 Navegador ──▶ Next.js (apps/web, :3100) ──BFF──▶ API NestJS (apps/api, :3001) ──▶ PostgreSQL 16 (RLS)
   │             │  /api/bff/{tenant}/…  (canal público, sem cookies)           ├──▶ Redis  ◀── Worker (BullMQ, mesmo pacote)
   │             │  /api/staff/{tenant}/… (equipe da empresa, cookies httpOnly) ├──▶ MinIO/S3 (anexos + âncora WORM)
   │             └  /api/platform/…       (plataforma, cookies próprios)        ├──▶ ClamAV (antivírus, INSTREAM)
   └ nunca fala direto com a API                                                └──▶ Resend (e-mail; em dev: caixa em memória)
```

- **O navegador só fala com o Next.** O Next tem três BFFs (proxies) com lista fixa de rotas permitidas. Nenhum
  token da API chega ao JavaScript do navegador: ficam em **cookies httpOnly + SameSite=Strict**; toda chamada que
  muda estado exige o cabeçalho `x-ouvion-csrf` e `Origin` igual ao host.
- **Multi-tenant por slug:** a empresa é resolvida pelo `x-tenant-slug` (injetado pelo BFF a partir da URL
  `/{slug}/…`). No banco, cada tabela de conteúdo tem `tenant_id` + **Row-Level Security**: a API executa cada
  requisição numa transação com `set_config('app.tenant_id', …)`.
- **Três espaços de identidade, sem mistura:** (1) **denunciante** (protocolo + chave, sem conta; ou conta
  REPORTER), (2) **equipe da empresa** (ADMIN/INVESTIGATOR/AUDITOR — tabela `users`, segredo JWT `JWT_ACCESS_SECRET`),
  (3) **equipe da plataforma** (SUPER_ADMIN/SUPPORT/FINANCIAL — tabela `platform_users`, segredo `PLATFORM_JWT_SECRET`,
  papel de banco `platform_admin`). Um token de um espaço **não vale** nos outros.
- **Worker:** mesmo pacote da API (`apps/api`), entrypoint próprio (`src/worker/worker-main.ts`), consome filas
  BullMQ (varredura de anexos, selagem/âncora/verificação da auditoria, SLAs, e-mails de notificação).

## 2. Stack

| Camada | Tecnologia |
|---|---|
| Monorepo | pnpm 9 + Turborepo, Node ≥ 20 (testado em Node 24) |
| API | NestJS 10, Prisma 6, Zod (contratos compartilhados), Argon2id, otplib (TOTP), helmet |
| Banco | PostgreSQL 16 (RLS, triggers de imutabilidade/anonimato/auditoria, funções `SECURITY DEFINER`) |
| Fila | Redis 7 + BullMQ |
| Arquivos | S3-compatível (MinIO local), ClamAV, Object Lock para a âncora da auditoria |
| Front | Next.js 15 (App Router, React 19), Tailwind 3, Radix, lucide, next-intl (só `pt`), TanStack Query, react-hook-form, zustand, sonner |
| Design system | `packages/ui` (tokens CSS claro/escuro/contraste alto, WCAG AA testado) |
| Testes | Jest + supertest (API), Vitest (web/ui), Playwright + axe-core (e2e, acessibilidade) |

## 3. Estrutura do repositório

```
apps/
  api/                 API NestJS + worker
    src/               módulos: auth, users, complaints, channel, workflow(sla), conflicts, external, audit,
                       notifications, onboarding, settings, branding, scan, storage, crypto, queue, worker,
                       platform/ (painel SUPER_ADMIN), tenancy, common
    prisma/            schema.prisma + migrations/ (SQL versionado, inclui RLS, triggers e funções)
    scripts/           db-setup.ts · provision-tenant.ts · e2e-seed.ts
    test/              suítes Jest (banco real)
  web/                 Next.js (canal público, painel da empresa, painel da plataforma)
    src/app/[tenant]/  canal público (landing, nova denúncia, acompanhar, convite, destinatário, entrar)
                       e painel (painel/…: casos, equipe, conflitos, auditoria, configurações, ativação…)
    src/app/loginadm   login da plataforma        src/app/admin/…  painel da plataforma
    src/app/api/       BFFs: bff/[tenant] (público) · staff/[tenant] (equipe) · platform (plataforma)
    messages/pt.json   todo o texto da interface
    e2e/               Playwright
packages/
  contracts/           schemas Zod, enums, regras compartilhadas (API + web) — precisa de build (dist)
  ui/                  design system (tokens, componentes)
  config/              presets de lint/prettier
infra/docker/          docker-compose.yml (Postgres, Redis, ClamAV, MinIO, MailHog)
```

## 4. Pré-requisitos

- **Node ≥ 20** e **pnpm 9** (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- **Docker** (Postgres, Redis, ClamAV, MinIO)
- Para os e2e: navegador do Playwright (`pnpm --filter @ouvion/web exec playwright install chromium`)

## 5. Subir tudo do zero (passo a passo)

Os comandos abaixo funcionam em **bash** (Git Bash/WSL/macOS/Linux). No **PowerShell**, troque `export VAR=x` por
`$env:VAR = "x"` (a variação está indicada no passo 4).

### Passo 1 — Dependências

```bash
pnpm install
```

### Passo 2 — Infraestrutura local (Docker)

```bash
docker compose -f infra/docker/docker-compose.yml up -d
# sobe: postgres:5432 (db "ouvion", user postgres/postgres), redis:6379, clamav:3310,
#       minio:9000 (API) e :9001 (console, minio/minio12345), mailhog:1025/:8025 (não usado pelo app hoje)
```

O ClamAV demora ~1–2 min para ficar saudável na primeira vez (baixa as assinaturas): `docker ps` mostra `(healthy)`.

Crie os **buckets** no MinIO (uma vez). Console em http://localhost:9001 (`minio` / `minio12345`) ou por script:

```bash
# bucket de anexos + bucket da âncora da auditoria (este PRECISA de Object Lock)
cd apps/api && node -e "
const {S3Client,CreateBucketCommand}=require('@aws-sdk/client-s3');
const c=new S3Client({endpoint:'http://localhost:9000',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'minio',secretAccessKey:'minio12345'}});
(async()=>{
  await c.send(new CreateBucketCommand({Bucket:'ouvion-dev'})).catch(()=>{});
  await c.send(new CreateBucketCommand({Bucket:'ouvion-anchors',ObjectLockEnabledForBucket:true})).catch(()=>{});
  console.log('buckets ok');
})()"
cd ../..
```

### Passo 3 — Build dos pacotes compartilhados e da API

```bash
pnpm build           # turbo: contracts → api (prisma generate + tsc) → web (next build)
```

Só precisa do build dos pacotes quando quiser rodar a API/web em modo "produção" (`node dist/main.js`, `next start`).
Em desenvolvimento, o `contracts` **precisa** ter `dist` (a API e o web o importam): rode ao menos
`pnpm --filter @ouvion/contracts build` e refaça quando alterar `packages/contracts/src`.

### Passo 4 — Variáveis de ambiente

A API e o worker **não leem arquivo `.env`**: só o ambiente do processo. Exporte antes de subir cada um (o
`.env.example` na raiz documenta todas as variáveis; a seção 6 explica cada uma). Conjunto mínimo de desenvolvimento:

```bash
# ── bash ──
export DATABASE_URL=postgresql://app_runtime:app_runtime@localhost:5432/ouvion
export DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ouvion
export PLATFORM_DATABASE_URL=postgresql://platform_admin:platform_admin@localhost:5432/ouvion
export APP_RUNTIME_PASSWORD=app_runtime PLATFORM_ADMIN_PASSWORD=platform_admin
export JWT_ACCESS_SECRET=dev-jwt-secret-dev-jwt-secret-dev-jwt-secret
export BFF_SHARED_SECRET=dev-bff-secret-dev-bff-secret-dev-bff-secret
export PUBLIC_WEB_URL=http://localhost:3100
export MFA_ENFORCEMENT=off                      # facilita testes da equipe das empresas (a plataforma SEMPRE exige MFA)
export S3_BUCKET=ouvion-dev S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 \
       S3_ACCESS_KEY_ID=minio S3_SECRET_ACCESS_KEY=minio12345 S3_FORCE_PATH_STYLE=true
export ANCHOR_S3_BUCKET=ouvion-anchors ANCHOR_S3_ENDPOINT=http://localhost:9000 ANCHOR_S3_REGION=us-east-1 \
       ANCHOR_S3_ACCESS_KEY_ID=minio ANCHOR_S3_SECRET_ACCESS_KEY=minio12345 ANCHOR_S3_FORCE_PATH_STYLE=true ANCHOR_RETENTION_DAYS=1
export REDIS_URL=redis://localhost:6379 CLAMAV_HOST=localhost CLAMAV_PORT=3310
```

```powershell
# ── PowerShell (mesmas variáveis) ──
$env:DATABASE_URL="postgresql://app_runtime:app_runtime@localhost:5432/ouvion"
$env:DIRECT_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ouvion"
$env:PLATFORM_DATABASE_URL="postgresql://platform_admin:platform_admin@localhost:5432/ouvion"
$env:APP_RUNTIME_PASSWORD="app_runtime"; $env:PLATFORM_ADMIN_PASSWORD="platform_admin"
$env:JWT_ACCESS_SECRET="dev-jwt-secret-dev-jwt-secret-dev-jwt-secret"
$env:BFF_SHARED_SECRET="dev-bff-secret-dev-bff-secret-dev-bff-secret"
$env:PUBLIC_WEB_URL="http://localhost:3100"; $env:MFA_ENFORCEMENT="off"
$env:S3_BUCKET="ouvion-dev"; $env:S3_ENDPOINT="http://localhost:9000"; $env:S3_REGION="us-east-1"
$env:S3_ACCESS_KEY_ID="minio"; $env:S3_SECRET_ACCESS_KEY="minio12345"; $env:S3_FORCE_PATH_STYLE="true"
$env:ANCHOR_S3_BUCKET="ouvion-anchors"; $env:ANCHOR_S3_ENDPOINT="http://localhost:9000"; $env:ANCHOR_S3_REGION="us-east-1"
$env:ANCHOR_S3_ACCESS_KEY_ID="minio"; $env:ANCHOR_S3_SECRET_ACCESS_KEY="minio12345"; $env:ANCHOR_S3_FORCE_PATH_STYLE="true"; $env:ANCHOR_RETENTION_DAYS="1"
$env:REDIS_URL="redis://localhost:6379"; $env:CLAMAV_HOST="localhost"; $env:CLAMAV_PORT="3310"
```

> Dica: guarde o bloco num arquivo (`dev-env.sh`, fora do git) e faça `source dev-env.sh` em cada terminal.
> Sem `S3_BUCKET`/`REDIS_URL`, a API cai para **memória** (só dev): funciona para o canal e o painel, **mas o worker
> não enxerga a memória da API** — para o ciclo de anexo (enviar → varrer → baixar) use MinIO + Redis + worker.

### Passo 5 — Banco: migrations, senhas dos papéis e dados de demonstração

```bash
# 1) aplica TODAS as migrations (cria tabelas, RLS, triggers, funções e os papéis app_runtime/platform_admin)
pnpm --filter @ouvion/api db:migrate

# 2) define as senhas dos papéis de banco (usa APP_RUNTIME_PASSWORD e PLATFORM_ADMIN_PASSWORD)
pnpm --filter @ouvion/api db:setup

# 3) dados de demonstração (idempotente): empresa "demo", empresa "e2e-suspensao" e os operadores da plataforma
pnpm --filter @ouvion/api e2e:seed
```

Detalhes dos papéis e do reset do banco: [seção 8](#8-banco-de-dados).

### Passo 6 — Subir os módulos (um terminal para cada)

**API** (porta 3001):

```bash
# desenvolvimento (recarrega ao salvar)
pnpm --filter @ouvion/api dev
# ou "produção" a partir do build
pnpm --filter @ouvion/api build && pnpm --filter @ouvion/api start
```

**Worker** (varredura de anexos, selos/âncora/verificação da auditoria, SLA, e-mails) — exige Redis:

```bash
pnpm --filter @ouvion/api worker          # desenvolvimento
pnpm --filter @ouvion/api start:worker    # a partir do build
```

**Web** (porta 3100) — precisa de `API_URL` e do **mesmo** `BFF_SHARED_SECRET` da API:

```bash
export API_URL=http://localhost:3001 NEXT_TELEMETRY_DISABLED=1
pnpm --filter @ouvion/web dev                          # desenvolvimento
# ou produção:
pnpm --filter @ouvion/web build && pnpm --filter @ouvion/web start
```

(`pnpm dev` na raiz roda `turbo run dev` em paralelo em todos os pacotes com script `dev`; como a API exige as
variáveis do passo 4, prefira subir cada módulo separado.)

### Passo 7 — Conferir

```bash
curl http://localhost:3001/health        # {"status":"ok"}
```

Abra http://localhost:3100/demo (canal público) e http://localhost:3100/loginadm (plataforma). Logins na
[seção 11](#11-usuários-e-senhas-de-demonstração).

## 6. Variáveis de ambiente

| Variável | Quem usa | Obrigatória | Descrição |
|---|---|---|---|
| `DATABASE_URL` | API, worker | sim | Conexão como **`app_runtime`** (sujeito a RLS). |
| `DIRECT_DATABASE_URL` | Prisma CLI, scripts | migrations/seed | Conexão como dono do schema (`postgres`). |
| `PLATFORM_DATABASE_URL` | API (painel da plataforma) | **produção** | Conexão como **`platform_admin`**. Em dev, se ausente, é derivada de `DATABASE_URL` trocando o usuário. |
| `APP_RUNTIME_PASSWORD`, `PLATFORM_ADMIN_PASSWORD` | `db:setup` | ao rodar o setup | Senhas dos papéis de banco. |
| `PORT` | API | não (3001) | Porta da API. |
| `NODE_ENV` | todos | não | `production` liga as travas (segredos, S3, Redis, Resend e âncora passam a ser obrigatórios; MFA sempre ligado; cookies `Secure`). |
| `JWT_ACCESS_SECRET` | API | **produção** | Segredo dos tokens da equipe das empresas. |
| `PLATFORM_JWT_SECRET` | API | **produção** | Segredo dos tokens da plataforma (em dev deriva do anterior). |
| `BFF_SHARED_SECRET` | API **e** web | recomendado | Prova que a chamada veio do BFF; habilita confiar no IP real do cliente (`x-real-client-ip`). Deve ser igual nos dois. |
| `PUBLIC_WEB_URL` | API | não | Base dos links de convite/destinatário nos e-mails. Local: `http://localhost:3100`. |
| `FIELD_ENCRYPTION_KEY` | API, worker | **produção** | Chave-mestra (32 bytes, base64) das chaves de dados por empresa. Em dev há uma chave fixa de desenvolvimento. `…_PREVIOUS` para rotação. |
| `MFA_ENFORCEMENT` | API | não | `off` desliga o MFA obrigatório **das empresas** (só dev/staging). O da plataforma nunca desliga. |
| `RATE_LIMIT_DISABLED` | API | não | `true` desliga só o limite por IP (usado nos e2e). |
| `S3_*` | API, worker | anexos reais | Bucket/endpoint/credenciais dos anexos. Vazio = memória. |
| `ANCHOR_S3_*`, `ANCHOR_RETENTION_DAYS` | API, worker | **produção** | Bucket **com Object Lock** da âncora da auditoria. Vazio = memória (a verificação acusa âncora perdida se API e worker forem processos separados). |
| `REDIS_URL` | API, worker | worker | Fila BullMQ. Vazio = fila em memória (só dev). |
| `CLAMAV_HOST`, `CLAMAV_PORT` | API, worker | **produção** | Antivírus. Vazio = só reconhece o arquivo de teste EICAR. |
| `RESEND_API_KEY`, `MAIL_FROM` | API, worker | **produção** | E-mail. Vazio = caixa em memória; as respostas de convite/destinatário trazem `devInviteUrl`/`devConfirmUrl`. |
| `API_URL` | web | sim (web) | Onde o BFF encontra a API. |
| `INSECURE_COOKIES` | web | não | `1` remove `Secure` dos cookies ao rodar `next start` em http (nunca em produção). |

## 7. Módulo a módulo

### 7.1 `apps/api` — API NestJS

Monólito modular. Principais áreas:

| Área | O que faz |
|---|---|
| `auth` | Login da equipe, MFA (TOTP + códigos de recuperação), sessões (access 15 min + refresh rotativo com detecção de reuso), troca de senha temporária, cookies/CSRF. |
| `complaints`, `channel` | Denúncia (anônima/identificada), canal por protocolo+chave, chat com o comitê, anexos, complementos, comentários. |
| `workflow` | Máquina de estados (PENDENTE → EM INVESTIGAÇÃO → EM ANÁLISE/ESCALADA → RESOLVIDA/ENCERRADA), SLAs, casos relacionados, retaliação. |
| `conflicts`, `external` | Suspeita de conflito de interesses, impedimento (recusal), destinatário alternativo (sem conta: link + TOTP). |
| `access` | Regras de leitura/decisão por caso (restrito, impedido, atribuído, concessão de acesso). |
| `audit` | Auditoria por empresa com **hash por registro, selos Merkle encadeados e âncora externa**, verificação de integridade. |
| `notifications` | In-app + e-mail (com regras de anonimato); notificações críticas ignoram silenciamento. |
| `onboarding` | Destinatário alternativo, DPO, ativação da empresa (TRIAL → ACTIVE), aceite de convite do primeiro ADMIN. |
| `settings`, `branding` | Configurações e marca da empresa (o ADMIN edita; o canal público lê). |
| `scan`, `storage`, `crypto`, `queue`, `worker` | Antivírus, S3, criptografia de campo (AES-256-GCM, DEK por empresa, envelope), filas e jobs. |
| `platform/*` | **Painel da plataforma**: login próprio, empresas, usuários internos, auditoria, quebra de vidro. Usa `PlatformPrismaService` (papel `platform_admin`). |

Comandos (`pnpm --filter @ouvion/api <script>`): `dev`, `build`, `start`, `worker`, `start:worker`, `typecheck`,
`test`, `db:migrate`, `db:setup`, `tenant:provision`, `e2e:seed`.

Provisionar uma empresa por script (alternativa ao painel):

```bash
SLUG=acme COMPANY="Acme S.A." ADMIN_EMAIL=admin@acme.com ADMIN_NAME="Ana Admin" ADMIN_PASSWORD='Senha-Forte-123!' \
  pnpm --filter @ouvion/api tenant:provision   # exige DIRECT_DATABASE_URL
```

### 7.2 Worker (`apps/api/src/worker`)

Jobs recorrentes (BullMQ, agendados no boot): `attachment-sweep` (1 min), `audit-seal` (5 min), `audit-anchor`
(1 h), `audit-verify` (24 h), `sla-check` (15 min), `notification-email` (1 min). Sob demanda: `attachment-scan`
(varredura ClamAV de cada anexo enviado). **Sem o worker**: anexos ficam "em verificação" para sempre, e-mails de
notificação não saem, a auditoria não é selada/ancorada.

### 7.3 `apps/web` — Next.js

- **Canal público** (`/{slug}`): landing com a marca da empresa, nova denúncia em 5 etapas, confirmação (protocolo +
  chave exibidos uma vez), acompanhar por protocolo+chave, chat com o comitê, retaliação. Sem cookies, sem storage
  persistente (rascunho só com opt-in).
- **Painel da empresa** (`/{slug}/painel/…`, login em `/{slug}/entrar`): casos, equipe, conflitos, auditoria,
  configurações/marca, ativação, notificações, minha conta (tema/fonte/contraste/animações).
- **Painel da plataforma** (`/loginadm` → `/admin/…`): dashboard, empresas, assinaturas, usuários internos,
  auditoria, configurações, quebra de vidro.
- **BFFs** (`src/app/api/*`): `bff/[tenant]` (só `public/*`), `staff/[tenant]` (lista fixa de rotas da equipe,
  renovação automática de sessão), `platform` (lista fixa da plataforma; nenhuma rota de conteúdo de denúncia).
- Textos em `messages/pt.json`. Tema: tokens em `packages/ui/src/tokens.css`; a cor da marca da empresa só afeta
  ação/destaque (contraste ≥ 4,5:1 garantido por tema).

### 7.4 `packages/contracts`

Schemas Zod, enums e regras compartilhadas (validação de denúncia, política de senha, workflow/transições, chaves de
configuração, notificações críticas). **Compilado para `dist/`** — após editar `src`, rode
`pnpm --filter @ouvion/contracts build`.

### 7.5 `packages/ui`

Design system (Button, Field, Card, Badge de status/prioridade/SLA/varredura, Alert, Stepper, Timeline…). Consumido
por código-fonte (`main: src/index.ts`). Testes de contraste WCAG leem os tokens do próprio CSS.

## 8. Banco de dados

**Bancos:** `ouvion` (desenvolvimento, criado pelo Docker) e `ouvion_test` (recriado do zero a cada execução do Jest).

**Papéis de banco (menor privilégio):**

| Papel | Usado por | Pode |
|---|---|---|
| `postgres` (dono) | migrations, seed, scripts | Tudo. Nunca usado pela aplicação em produção. |
| `app_runtime` | API e worker | Ler/escrever as tabelas de conteúdo **sob RLS** (só o tenant da transação). Auditoria é só de acréscimo. Sem acesso às tabelas da plataforma. |
| `platform_admin` | painel da plataforma | Ler/escrever `tenants`/`tenant_brandings`, tabelas `platform_*` e `tenant_invites`, ler `break_glass_*`; executar funções `platform_*`. **Sem nenhum GRANT em denúncias, anexos, mensagens, comentários, usuários e auditoria das empresas.** |

**Migrations** (`apps/api/prisma/migrations`, aplicadas em ordem): `init` e `security` (RLS, papéis, auditoria),
fases 2/2b/3/4a/4b/5a (privacidade, conflitos, canal seguro, MFA/sessões, arquivos/selos, workflow/SLA/notificações),
`platform_admin` (operadores, auditoria da plataforma, contagens), `tenant_invites` (convite + provisionamento) e
`break_glass` (quebra de vidro).

**Triggers e funções relevantes:** imutabilidade do relato original; anonimato técnico (horários truncados ao
minuto em eventos anônimos; sem IP/UA); `seq` e `row_hash` da auditoria sempre calculados no banco; selos
imutáveis; auditoria da plataforma somente de acréscimo; `platform_tenant_stats` (só números);
`platform_provision_tenant`; `platform_bg_create/approve/deny/revoke/read`.

**Comandos úteis:**

```bash
pnpm --filter @ouvion/api db:migrate                       # aplica migrations pendentes
cd apps/api && npx prisma generate                          # regenera o client (feche a API/worker antes no Windows)
cd apps/api && npx prisma migrate dev --create-only --name minha_mudanca   # cria migration a partir do schema.prisma
cd apps/api && npx prisma studio                            # inspeção visual (use DIRECT_DATABASE_URL)

# resetar o banco de dev do zero (APAGA tudo):
docker exec -i docker-postgres-1 psql -U postgres -c "DROP DATABASE ouvion WITH (FORCE)" -c "CREATE DATABASE ouvion"
pnpm --filter @ouvion/api db:migrate && pnpm --filter @ouvion/api db:setup && pnpm --filter @ouvion/api e2e:seed
```

(O nome do container pode variar — veja `docker ps`.)

## 9. Testes

| Suíte | Comando | O que cobre | Situação atual |
|---|---|---|---|
| API (Jest + supertest, **banco real**) | `pnpm --filter @ouvion/api test` | isolamento entre empresas (RLS), anonimato, MFA/sessões, arquivos/antivírus/MinIO, auditoria/selos, workflow/SLA, conflitos, onboarding/convite, plataforma, quebra de vidro | 192 testes |
| Web (Vitest) | `pnpm --filter @ouvion/web test` | normalização, validação, linha do tempo | 25 testes |
| UI (Vitest) | `pnpm --filter @ouvion/ui test` | contraste WCAG dos tokens, `cn` | 17 testes |
| E2E (Playwright + axe) | `pnpm --filter @ouvion/web test:e2e` | jornadas reais em navegador (canal, painel, plataforma, convite, quebra de vidro), acessibilidade WCAG AA, mobile | 59 testes (+3 de captura de tela, opcionais) |

Observações importantes:

- **API:** o `globalSetup` faz `DROP DATABASE ouvion_test` e recria (precisa do usuário `postgres` no Postgres do
  Docker). Postgres, Redis, MinIO e ClamAV devem estar no ar. Roda com `--runInBand`.
- **E2E:** exige **build feito** (`pnpm build`: `apps/api/dist` e `apps/web/.next`). O Playwright sobe
  `node ../api/dist/main.js` (:3001) e `next start -p 3100` sozinho — **se já houver processos nessas portas, ele os
  reutiliza** (`reuseExistingServer`), inclusive um build velho. Pare o ambiente antes de rodar. O e2e usa o
  **banco de dev `ouvion`** (não o de teste) e roda o seed (`e2e:seed`), então cria empresas/denúncias de teste ali.
  Ele sobe a API com `MFA_ENFORCEMENT=off` e `RATE_LIMIT_DISABLED=true`.
- **Teste instável conhecido:** `TOTP não pode ser reutilizado` (MFA de empresa) pode falhar raramente por timing na
  virada do passo de 30 s do código; reexecutar resolve.
- Capturas de tela para revisão visual: `SCREENS=1 pnpm --filter @ouvion/web exec playwright test screens`.

Outros: `pnpm typecheck`, `pnpm lint`, `pnpm build` (todos via Turborepo).

## 10. URLs e portas

| O quê | Endereço |
|---|---|
| Canal público da empresa demo | http://localhost:3100/demo |
| Nova denúncia (demo) | http://localhost:3100/demo/nova-denuncia |
| Acompanhar protocolo (demo) | http://localhost:3100/demo/acompanhar |
| Login da equipe da empresa (demo) | http://localhost:3100/demo/entrar |
| Painel da empresa (demo) | http://localhost:3100/demo/painel |
| **Login da plataforma** | http://localhost:3100/loginadm |
| Painel da plataforma | http://localhost:3100/admin/dashboard |
| API (health) | http://localhost:3001/health |
| MinIO — console | http://localhost:9001 (`minio` / `minio12345`) |
| Postgres / Redis / ClamAV | `localhost:5432` / `:6379` / `:3310` |

Rotas de empresa seguem `/{slug}/…`. Slugs reservados na prática: `admin`, `loginadm`, `api`.

## 11. Usuários e senhas de demonstração

> **Só desenvolvimento.** São criados por `e2e:seed` (que recusa criar operadores da plataforma em produção).
> Reexecutar o seed **redefine** o estado do 2º fator desses usuários e derruba as sessões dos operadores.

### 11.1 Empresa "Empresa Demo" — slug `demo` (login: `/demo/entrar`)

| E-mail | Senha | Perfil | Observação |
|---|---|---|---|
| `admin@demo.com` | `Senha-Forte-123!` | **ADMIN** | Criado no provisionamento. O seed o mantém sem 2º fator. |
| `investigador@demo.com` | `Senha-Forte-123!` | **INVESTIGATOR** ("Ivo Investigador") | Elegível para receber atribuição de casos. |

Com `MFA_ENFORCEMENT=on` (padrão fora do dev), ADMIN/INVESTIGATOR/AUDITOR são obrigados a cadastrar o 2º fator no
primeiro login (QR code + códigos de recuperação). Com `off`, entram só com e-mail e senha.

### 11.2 Empresa `e2e-suspensao` (usada só pelos testes de suspensão)

| E-mail | Senha | Perfil |
|---|---|---|
| `admin@e2e-suspensao.com` | `Senha-Forte-123!` | ADMIN |

### 11.3 Plataforma — login em `/loginadm` — senha de todos: `Demo123!@`

| E-mail | Perfil | Uso |
|---|---|---|
| `superadmin@ouvion.com` | **SUPER_ADMIN** | Uso geral / demonstração |
| `suporte@ouvion.com` | **SUPPORT** | Demonstração do suporte |
| `financeiro@ouvion.com` | **FINANCIAL** | Demonstração do financeiro |
| `e2e-approver-a@ouvion.com`, `-b`, `-c` | SUPER_ADMIN | **Segundo aprovador** da quebra de vidro (e dos testes) |
| `e2e-ops@ouvion.com`, `e2e-login@ouvion.com`, `e2e-logout@ouvion.com` | SUPER_ADMIN | Contas dedicadas aos testes e2e |

**2º fator da plataforma (obrigatório, sempre).** Todos os operadores acima já têm o MFA ativo com **a mesma
chave TOTP de desenvolvimento**:

```
KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD
```

Cadastre no app autenticador (Google Authenticator/Authy/Microsoft Authenticator): *Adicionar conta → Inserir chave
de configuração → nome livre, chave acima, tipo baseado em tempo*. Um cadastro serve para todos os e-mails; só
troque o e-mail no login.

- Cada usuário aceita **um código por janela de 30 s** (o código usado não vale de novo): se errar logo após um login
  do mesmo usuário, espere o próximo código.
- A tela do código **expira em 5 minutos** depois da senha: se demorar, recarregue e refaça o login.
- O relógio do celular precisa estar no automático.
- Em produção **não existe chave fixa**: cada operador cadastra o próprio 2º fator por QR code no primeiro acesso.

### 11.4 Outras identidades

- **Denunciante anônimo:** não tem conta. Ao enviar o relato recebe **protocolo + chave de acesso** (exibidos uma
  única vez). Acompanha em `/{slug}/acompanhar`.
- **Denunciante com conta (REPORTER):** criado por `POST /auth/register` (com `x-tenant-slug`). Não há tela de
  cadastro/login de REPORTER no front ainda.
- **Destinatário alternativo:** sem conta; confirma o e-mail e cadastra o TOTP pelo link recebido (página
  `/{slug}/destinatario?token=…`).
- **Empresas criadas pelo painel/testes:** o e2e cria empresas com slug `e2e-…` e administrador
  `admin@<slug>.com`; as senhas são definidas durante o teste (`Definitiva-456!` / senhas temporárias) e mudam.

## 12. Perfis e permissões

### 12.1 Perfis da EMPRESA (tabela `users`)

| Perfil | Quem é |
|---|---|
| **ADMIN** | Administrador da empresa. Configura, distribui e decide. |
| **INVESTIGATOR** | Investigador. Conduz os casos que recebe. |
| **AUDITOR** | Leitura e verificação (somente leitura sobre os casos; foco em auditoria). |
| **REPORTER** | Denunciante com conta: vê e acompanha só as **próprias** denúncias. |
| (sem conta) | **Denunciante anônimo** (protocolo + chave) e **destinatário alternativo** (link + TOTP). |

> Limitação atual: **não há tela nem endpoint para criar INVESTIGATOR/AUDITOR/ADMIN adicionais**. O primeiro ADMIN vem
> do provisionamento/convite; outros usuários da equipe hoje entram por seed/SQL (`users`). A tela **Equipe** lista,
> suspende, reativa e zera o 2º fator, mas não cria usuários.

Capacidades (✅ pode · — não pode · 👁 só leitura):

| Capacidade | ADMIN | INVESTIGATOR | AUDITOR | REPORTER |
|---|:-:|:-:|:-:|:-:|
| Listar/abrir casos | ✅ todos (menos onde impedido) | ✅ não restritos, atribuídos a ele ou com acesso concedido | 👁 mesma regra do investigador | 👁 só os próprios |
| Alterar situação (fluxo) e classificar prioridade/tipo | ✅ | ✅ | — | — |
| Reabrir caso encerrado | ✅ | — | — | — |
| Arquivar ("remover") caso | ✅ | — | — | — |
| Atribuir investigador | ✅ | — | — | — |
| Conversar com o denunciante (chat) | ✅ | ✅ | 👁 | ✅ (o próprio) |
| Notas internas / complemento | ✅ | ✅ | 👁 (ler) | — |
| Anexos: enviar / excluir | ✅ | ✅ | — | ✅ (os próprios) |
| Anexos: baixar (só arquivo já varrido) | ✅ | ✅ | ✅ | ✅ |
| Anexos: conferir integridade (hash) | ✅ | — | ✅ | — |
| Pausar/retomar prazos (SLA); vincular casos relacionados | ✅ | ✅ | — | — |
| Declarar **impedimento** (recusal) | ✅ | ✅ | ✅ | — |
| **Revelar identidade** do denunciante (com justificativa, auditado) | ✅ | ✅ (só no caso atribuído a ele) | — | — |
| Marcar caso **restrito**; conceder/revogar acesso; acionar destinatário alternativo | ✅ | — | — | — |
| Revisar **conflitos de interesse** | ✅ | — | — | — |
| **Equipe**: listar (gestão), suspender/reativar, zerar 2º fator | ✅ | — | — | — |
| **Configurações** e **marca** da empresa | ✅ | — | — | — |
| **Ativação** da empresa (destinatário alternativo, DPO, ativar) | ✅ | — | — | — |
| **Auditoria** (lista, selos, verificar integridade) | ✅ | — | ✅ | — |
| Notificações e "Minha conta" | ✅ | ✅ | ✅ | ✅ |
| Relatar retaliação (conta) | — | — | — | ✅ |

Regras transversais: relato original é **imutável**; o caso restrito só aparece para ADMIN, o investigador atribuído
e quem tem concessão vigente; quem tem **suspeita de conflito pendente** perde o acesso ao caso; toda leitura de caso
gera auditoria; suspensão de usuário derruba as sessões na hora.

Menu do painel da empresa por perfil: **Casos**, **Notificações**, **Minha conta** (todos) · **Equipe**,
**Conflitos**, **Configurações** (ADMIN) · **Auditoria** (ADMIN, AUDITOR) · **Ativação** (ADMIN, enquanto a empresa
está em período de teste).

### 12.2 Perfis da PLATAFORMA (tabela `platform_users`, login `/loginadm`, MFA sempre obrigatório)

| Perfil | Quem é | Pode | **Não** pode |
|---|---|---|---|
| **SUPER_ADMIN** | Sócios/liderança técnica | Tudo do painel: empresas (listar, criar com convite/senha temporária, reenviar convite, suspender/reativar), usuários internos (criar, mudar perfil, desativar, redefinir senha), auditoria da plataforma, configurações, assinaturas, **aprovar/recusar/revogar** quebra de vidro (sendo outra pessoa que pediu) | Ler conteúdo de empresa fora de uma quebra de vidro aprovada; aprovar o **próprio** pedido |
| **SUPPORT** | Suporte ao cliente | Ver dados operacionais das empresas (situação, limites, contagens de usuários/denúncias, onboarding); **solicitar** quebra de vidro e usar **o próprio** acesso aprovado | Suspender/criar empresa, gerir usuários internos, ver auditoria, aprovar; ler denúncia/anexo/mensagem/identidade sem quebra de vidro; resetar senha de usuário de empresa |
| **FINANCIAL** | Financeiro | Dashboard e Assinaturas (billing/planos/faturas — hoje demonstração) | Ver empresas, quebra de vidro, auditoria; qualquer conteúdo de denúncia |

Menu da plataforma: **Dashboard** (todos) · **Empresas** (SUPER_ADMIN, SUPPORT) · **Assinaturas** (SUPER_ADMIN,
FINANCIAL) · **Usuários internos**, **Auditoria**, **Configurações** (SUPER_ADMIN). A tela de **Quebra de vidro** não
é item de menu: abre pelo botão *Solicitar acesso de suporte* no detalhe da empresa e pelo card do Dashboard
(SUPER_ADMIN e SUPPORT).

**Nenhum perfil da plataforma lê conteúdo por padrão** — isso é imposto no banco (papel `platform_admin` sem GRANT
em tabelas de conteúdo), não só na interface.

### 12.3 Papéis de banco

Ver [seção 8](#8-banco-de-dados): `postgres` (dono), `app_runtime` (API/worker sob RLS), `platform_admin` (painel da
plataforma, sem conteúdo).

## 13. Fluxos principais

**Denúncia anônima:** `/{slug}/nova-denuncia` → 5 etapas (anonimato, fato, envolvidos, anexos, revisão com aviso de
identificação por conteúdo) → protocolo + chave (uma única vez) → `/{slug}/acompanhar` → chat com o comitê, complemento,
relato de retaliação. Sem IP/UA gravados; horários truncados ao minuto; e-mail de evento anônimo com atraso aleatório.

**Condução do caso (equipe):** ADMIN atribui um investigador → investigador muda a situação com motivo (encerrar exige
conclusão; reabrir só ADMIN) → conversa com o denunciante, anota, anexa, pausa prazos → prazos (SLA) e alertas.

**Nova empresa (plataforma → empresa):**
1. SUPER_ADMIN cria a empresa em *Empresas → Nova empresa* (**convite por link**, padrão; ou senha temporária, exceção
   auditada com motivo).
2. O administrador abre o link (uso único, 72 h), define a **própria senha** (a OuviON nunca a conhece) e, se exigido,
   cadastra o 2º fator.
3. Em `/{slug}/painel/ativacao` conclui: destinatário alternativo (e-mail confirmado + TOTP dele), DPO informado, MFA do
   administrador → **Ativar** (TRIAL → ACTIVE). Em dev, os links aparecem na tela (marcados "Ambiente de desenvolvimento").

**Quebra de vidro:**
1. SUPPORT/SUPER_ADMIN pede acesso a **um item** (denúncia por protocolo ou anexo por protocolo + nome do arquivo), com
   motivo e chamado.
2. **Outro** SUPER_ADMIN aprova com um **código novo do 2º fator** e janela de 5–60 min (sem prorrogação).
3. O ADMIN da empresa é **avisado na hora** (notificação crítica + e-mail); o registro aparece na auditoria dele.
4. Quem pediu abre o conteúdo (cada abertura é auditada dos dois lados); a janela termina sozinha ou é revogada.

## 14. Segurança e privacidade (o que é garantido e onde)

| Garantia | Onde é imposta |
|---|---|
| Isolamento entre empresas | RLS no Postgres (`app.tenant_id` por transação) + testes de vazamento |
| Plataforma não lê conteúdo | Papel `platform_admin` sem GRANT; leitura só via `platform_bg_read` (aprovada, na janela, escopo de 1 item, trilha atômica) |
| Anonimato do denunciante | Sem IP/UA nos eventos anônimos; horários truncados por trigger; e-mail com atraso aleatório; metadados de anexo removidos |
| Relato original imutável | Trigger no banco (`complaints_immutable_report`) |
| Auditoria à prova de adulteração | `seq` e `row_hash` no banco; selos Merkle imutáveis e encadeados; âncora externa (S3 Object Lock); verificação sob demanda e diária |
| Auditoria da plataforma | Somente de acréscimo (trigger nega UPDATE/DELETE até ao dono) |
| Sessões | Access curto + refresh rotativo (reuso derruba tudo); cookies httpOnly + SameSite=Strict; CSRF por cabeçalho + Origin; tokens nunca no JavaScript |
| Senhas e 2º fator | Argon2id; política única (≥ 8, maiúscula/minúscula/número/símbolo); TOTP sem reuso; códigos de recuperação de uso único; segredos TOTP cifrados |
| Dados sensíveis | Campos PII cifrados (AES-256-GCM, chave de dados por empresa embrulhada pela chave-mestra) |
| Arquivos | Tipo/tamanho validados, antivírus, download só de arquivo `CLEAN` por URL temporária |
| Convites | Token de 256 bits, só o hash guardado, uso único, 72 h, reenvio revoga o anterior |
| Erros de login | Mensagem genérica (não revela se o e-mail existe) |

## 15. O que é real, o que é mock, o que falta

**Real (API + banco):** canal público, painel da empresa completo (casos, equipe, conflitos, auditoria, configurações/marca,
notificações, anexos, prazos, ativação), login/MFA/sessões, plataforma (empresas, criação com convite, usuários internos,
auditoria, quebra de vidro), convite e ativação de empresa.

**Mock rotulado ("Dados de demonstração"):** métricas financeiras do Dashboard da plataforma (MRR, ARR, churn, LTV,
novos no mês) e a tela **Assinaturas** inteira. Empresas, usuários e denúncias do mês no dashboard são reais (só números).

**Ainda não existe:**
- Plano/assinatura/cobrança reais (modelos e API — fase 8); campo "plano" no cadastro de empresa; gráficos do dashboard.
- Configurações globais da plataforma (só o texto da política de MFA); passkey; lista de IPs do SUPER_ADMIN; troca da
  própria senha do operador.
- Investigação estruturada, dossiê PDF/ZIP e relatórios/estatísticas por empresa (fase 5B).
- Criação de usuários INVESTIGATOR/AUDITOR/ADMIN adicionais pela interface; login/cadastro de REPORTER no front;
  recuperação de senha; i18n EN/ES; PWA; CSP; CI/deploy; KMS real e carimbo de tempo RFC 3161.
- Interface do **destinatário alternativo** para decidir casos (a API `/external/*` existe; só a página de onboarding tem tela).

O detalhe item a item, com o que foi verificado, está em [`PROGRESSO.md`](PROGRESSO.md).

## 16. Solução de problemas

| Sintoma | Causa provável / solução |
|---|---|
| `/loginadm`: "Código incorreto ou vencido" | A tela do código vale 5 min; ou o relógio do celular está errado; ou o código já foi usado nesta janela (espere o próximo). Confira a chave TOTP (32 caracteres). |
| API não sobe: "Variáveis de ambiente inválidas" | `DATABASE_URL` ausente — a API não lê `.env`; exporte as variáveis (passo 4). |
| API: "PLATFORM_JWT_SECRET é obrigatório" | Sem `JWT_ACCESS_SECRET` (que serve de base em dev) ou `NODE_ENV=production` sem `PLATFORM_JWT_SECRET`. |
| Anexo fica "em verificação" | Worker parado, Redis/ClamAV fora do ar, ou API sem `S3_BUCKET` (memória não é vista pelo worker). |
| Log do worker: `NoSuchKey` | Jobs antigos na fila do Redis apontando para anexos que estavam em memória. Inofensivo; esvazie o Redis se incomodar. |
| Verificação de auditoria acusa "âncora … não encontrada" | Âncora em memória em processo diferente do que selou. Use `ANCHOR_S3_*` (bucket com Object Lock) em API e worker. Selos já gravados são imutáveis: só recriando o banco de dev. |
| `prisma generate` falha (EPERM/arquivo em uso, Windows) | API/worker rodando seguram a DLL do Prisma. Pare os processos e rode de novo. |
| E2E falha estranhamente / testa código velho | Havia servidor antigo nas portas 3001/3100 (Playwright reutiliza). Pare tudo, `pnpm build` e rode de novo. |
| Login da empresa: "Acesso indisponível" | Empresa **suspensa/cancelada** (a plataforma suspendeu). Reative em *Empresas → detalhe*. |
| Login da empresa pede troca de senha | Empresa criada com **senha temporária**: a troca é obrigatória no primeiro acesso. |
| Cookies não gravam em `next start` (http) | Cookies são `Secure` em produção. Use `INSECURE_COOKIES=1` só em teste local, ou rode `next dev`. |
| Porta ocupada (3001/3100) | Encerre o processo antigo: `netstat -ano | findstr :3100` (Windows) e finalize o PID. |

---

**Convenções:** commits em português, mensagens curtas; toda regra de negócio nova entra em `packages/contracts` e é
coberta por teste; mudança de banco só por migration (nunca editar migration já aplicada); texto de interface só em
`messages/pt.json`.
