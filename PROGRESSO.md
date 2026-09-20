# OuviON — Progresso de implementação

Checklist derivado de `ouvion-arquitetura.md` (como) e `PROMPT-REGRAS-DE-NEGOCIO.md` (o quê, roadmap §10).
`[x]` = feito **e verificado** (build/testes rodando) · `[ ]` = pendente.

Como rodar: `docker compose -f infra/docker/docker-compose.yml up -d postgres` → `pnpm install` → `pnpm build` → `pnpm --filter @ouvion/api test`.

## Fase 1 — Fundação multi-tenant (arq. §1–§6, §14) — *núcleo concluído, 19 testes verdes*

### Monorepo e ferramentas (arq. §2)
- [x] pnpm workspace + Turborepo (`pnpm build` verde)
- [x] `packages/config`: preset ESLint, Prettier; `tsconfig.base.json`
- [x] `.editorconfig`, `.gitignore`, `.env.example`
- [x] `packages/contracts`: enums do doc de negócio §4 (parcial), `env.ts` (Zod), schema de provisionamento
- [x] `infra/docker/docker-compose.yml` (Postgres 16, Redis 7, ClamAV, MailHog, MinIO) — Postgres e MinIO (`quay.io/minio/minio`) subidos e usados nos testes; Redis/ClamAV/MailHog ainda não
- [ ] ESLint efetivamente instalado e rodando (`pnpm lint` ainda não existe)
- [ ] Husky + lint-staged + commitlint (exige repositório git — pasta ainda não é um repo)
- [ ] `packages/testing`, `packages/api-client`, `packages/ui`
- [ ] Next.js `apps/web` (BFF) e `apps/worker`

### Banco (arq. §5–§6)
- [x] `schema.prisma` núcleo: Tenant, TenantBranding, User, Complaint (mínimo), AuditLog
- [ ] Entidades restantes do doc §4 (RefreshToken, Dossier, Notification, UserPreferences, AuditSeal/AuditPayload, LegalHold, DSAR, ApiKey/Webhook, SsoConnection, InvestigationPlan/Task/Interview… — fases 4+)
- [x] Migration: papéis `app_runtime` e `platform_admin` (senhas via `db-setup`, fora da migration)
- [x] Migration: RLS em `tenants`, `tenant_brandings`, `users`, `complaints`, `audit_logs`
- [x] Trigger `BEFORE INSERT` calcula `seq` (SEQUENCE por tenant) e `rowHash` — valores forjados pela aplicação são ignorados
- [x] `audit_logs` append-only para a aplicação (sem UPDATE/DELETE) — testado
- [x] View `audit_log_platform_view` sem `details`/IP/UA para o `platform_admin`
- [x] Provisionamento atômico de tenant (tenant + branding + SEQUENCE + 1º ADMIN) — `scripts/provision-tenant.ts`
- [ ] Chave KMS por tenant no provisionamento (fase 4)
- [ ] Particionamento mensal de `audit_logs`, índices GIN/trgm (arq. §6.2)

### API NestJS (arq. §4–§5)
- [x] `apps/api` bootstrap com `helmet` e validação de env fail-fast (`parseEnv`)
- [x] `nestjs-cls` + `TenantResolutionMiddleware` (slug via header do BFF ou domínio próprio)
- [x] Execução por tenant: `PrismaService.withTenant/run` com `set_config('app.tenant_id')` na transação
- [x] Login da equipe com JWT contendo `tenantId`; `JwtAuthGuard` recusa token de outro tenant (403)
- [x] Status do tenant: SUSPENDED/CANCELLED/inativo bloqueiam login; política do canal público sempre aberto
- [x] Resposta genérica "Credenciais inválidas" (e-mail inexistente = senha errada)
- [x] Health check
- [x] Endpoint público de criação de denúncia — entregue na Fase 2
- [ ] Pipe Zod global (`nestjs-zod`) e OpenAPI
- [x] RolesGuard (fase 2) e regras de acesso ao caso centralizadas em `CaseAccessService`
- [ ] CASL / AuditInterceptor (auditoria hoje é gravada explicitamente em cada serviço)
- [x] Bloqueio por 5 falhas, MFA TOTP, cookies httpOnly, refresh rotativo — Fase 4A

### Testes bloqueantes da fase 1
- [x] Vazamento entre tenants: leitura, update, delete e insert cruzados barrados pelo RLS direto no banco
- [x] Sem contexto de tenant → nenhuma linha de conteúdo visível
- [x] `platform_admin` recebe `permission denied` em `complaints`, `users`, `audit_logs`
- [x] Provisionamento cria SEQUENCE + RLS ativo; slug duplicado não deixa SEQUENCE órfã
- [x] Isolamento no HTTP: token/usuário de um tenant não vale em outro
- [ ] Rodar como jobs nomeados no CI

### Infra / CI
- [ ] `infra/render.yaml`
- [ ] GitHub Actions
- [ ] Vercel / domínio próprio (fase 8)

## Fase 2 — Privacidade núcleo (doc de negócio §10) — *núcleo concluído, 36 testes verdes (fases 1+2)*

### Denúncia e canal público (§5.2)
- [x] Criação pública `POST /public/complaints`: validação Zod estrita (título 10–200, descrição ≥ 50, data não futura, citado obrigatório, texto único → lista)
- [x] Protocolo `DEN-{ANO}-{6}` com retentativa em colisão
- [x] Chave de acesso (20 chars, ~100 bits): exibida uma vez, guardada só como hash Argon2id
- [x] Consulta `POST /public/complaints/lookup` (protocolo + chave; POST para a chave não ir em URL): dados mínimos, erro genérico idêntico p/ protocolo inexistente e chave errada, verificação com custo constante
- [x] Aviso de identificação por conteúdo: `contentWarningAcknowledged` obrigatório na anônima (a tela do aviso é do frontend)
- [x] `allowAnonymousComplaints=false` exige identificação; `maintenanceMode` nunca bloqueia o registro
- [x] Denúncia identificada exige login (`createdBy`); anônima ignora qualquer credencial enviada
- [x] Listagem paginada com filtros (REPORTER só as suas), detalhe com auditoria `READ`, 403 em denúncia alheia
- [x] Atribuição de investigador (ADMIN) com status anterior REAL no histórico; recusa investigador inválido/suspenso
- [x] Comentários com visibilidade `INTERNAL`/`REPORTER` (REPORTER só lê os seus, só na própria denúncia)
- [ ] Editar/excluir comentário (autor ou ADMIN) — depende do `AuditPayload` cifrado (fases 4/7)
- [ ] Notificações de criação/atribuição/comentário (fase 5+)
- [x] Contato do denunciante (nome/e-mail/telefone) gravado cifrado — entregue na Fase 2b
- [x] Rate limits específicos e bloqueio após 5 falhas na consulta — entregue na Fase 3

### Relato imutável (§5.2.5)
- [x] Trigger no banco barra qualquer UPDATE nos campos do relato original (nem o dono do schema altera) — testado
- [x] `integrityHash` SHA-256 ampliado (título, descrição, tipo informado, citados, testemunhas, data, local) e `reportedType` imutável
- [x] `ComplaintAddendum` somente-inserção (com hash); PATCH aceita só classificação/gestão (`strict`) e audita o diff
- [x] Denúncia nunca é excluída fisicamente (DELETE revogado); histórico e complementos append-only
- [ ] Exceção controlada do job de retenção (fase 7)
- [x] Complemento enviado pelo denunciante — entregue na Fase 3

### Anonimato técnico (§5.2.1, §7)
- [x] Sem IP/UA em qualquer registro anônimo — o banco anula mesmo se a aplicação tentar gravar
- [x] Horários truncados ao minuto por trigger (denúncia, auditoria) e no histórico de criação
- [x] Auditoria anônima sem usuário; `seq` mascarado nas consultas de auditoria (`GET /audit`)
- [x] Controller público não lê IP/UA; nenhum cookie emitido
- [x] **Suíte de aceitação do anonimato v1**: varre todas as tabelas do tenant + logs da aplicação atrás de IP, UA, chave em claro, `createdBy`, cookies e horário fino
- [x] Extensão da suíte: mensagens e anexos (fase 3)
- [ ] Extensões futuras: metadados de arquivo (4), filas/e-mails, logs de proxy/WAF/CDN, WhatsApp/telefone (6)

### Acesso, configurações e correções (§5.1, §5.6, §5.9)
- [x] RolesGuard por perfil; sessão revalidada no banco a cada request (suspensão vale na hora)
- [x] Suspensão manual (ADMIN) com motivo interno fora da auditoria; login genérico; último ADMIN protegido; reativação — sem qualquer bloqueio automático
- [x] Configurações por tenant: leitura pública só de chaves `isPublic`, escrita só ADMIN, chave desconhecida rejeitada
- [x] Política única de senha (8–100, complexidade, lista de senhas comuns) + cadastro público REPORTER (409 em e-mail duplicado)
- [x] Login grava auditoria `LOGIN`; `lastLoginAt`
- [ ] Verificação de senha contra base de vazadas completa (hoje: lista mínima embutida)
- [ ] `includeAuditLog` restrito no dossiê (dossiês chegam na fase 5)
- [ ] `/loginadm` do SUPER_ADMIN, CASL, AuditInterceptor

## Fase 2b — Conflito de interesses e acesso restrito — *núcleo concluído, 51 testes verdes (fases 1+2+2b)*
**Pré-requisito para o primeiro tenant em produção.**

### Conflito de interesses e impedimento (§5.2.9)
- [x] Suspeita automática na criação (`ConflictFlag` PENDING) por nome (sem acento/caixa) ou e-mail contra ADMIN/INVESTIGATOR/AUDITOR ativos; **nunca altera a conta** — testado
- [x] Restrições cautelares enquanto pendente: lê (auditoria reforçada `suspectPending`), mas não decide (status/atribuição/restrição/conflito/comentário/complemento/revelação), não é atribuído e não decide a própria suspeita
- [x] Decisão por ADMIN não suspeito: **confirmada** → impedimento + perda de acesso + caso redistribuído ao investigador elegível menos carregado (sem elegível: sem investigador e volta a PENDING com histórico); **descartada** → libera
- [x] Autodeclaração de impedimento (`POST /complaints/:id/recuse`) com redistribuição
- [x] Falha na verificação de conflito nunca desfaz a denúncia (log sem conteúdo)
- [ ] Notificações `CONFLICT_SUSPECTED`/`RECUSAL_REASSIGNED`, prazo de revisão de 24 h e alerta imediato ao revisor (fase 5, com o módulo de notificações)
- [ ] Detecção de conflito também para denúncias por outros canais (fase 6)

### Anti-paralisia e acesso externo
- [x] Sem ADMIN elegível → aciona o destinatário alternativo automaticamente (idempotente); **teste "todos os ADMINs citados"** ponta a ponta
- [x] Onboarding: e-mail confirmado por link + TOTP enrolado (segredo cifrado); trocar o destinatário zera a verificação; `GET /onboarding/status` lista requisitos de ativação
- [x] Acesso externo: link mágico de uso único + TOTP, sessão 60 min sem refresh, validade 72 h, 5 erros revogam, revogável por ADMIN, escopo de UM caso (sem rotas de lista/usuários/config), e-mail só com protocolo + link, auditoria `EXTERNAL_ACCESS` com IP
- [x] Destinatário decide suspeitas e atribui investigador só no seu caso; token externo nunca vale como sessão de equipe
- [x] Sem destinatário verificado: denúncia é registrada e a indisponibilidade fica auditada
- [ ] Adapter real de e-mail (Resend) — hoje `OutboxMailer` em memória
- [ ] Decisão de **status** pelo destinatário (depende da máquina de estados, fase 5)
- [ ] Notificar AUDITOR/ADMIN a cada acesso externo (fase 5)
- [ ] Verificação por SMS como alternativa ao TOTP (Twilio)
- [ ] Bloqueio da transição TRIAL→ACTIVE pelo requisito (a API de SUPER_ADMIN/tenants é da fase 8; a checagem já existe em `OnboardingService`)

### Casos restritos e roteamento (§5.2.10)
- [x] `isRestricted` marcado por ADMIN ou por regra de tipo (`restrictedTypes`); só ADMIN não impedido, investigador atribuído e concessão vigente veem; some da listagem; 404 no acesso direto
- [x] Concessões com motivo e validade (≤ 90 dias), revogáveis, auditadas (`ACCESS_GRANT`); não concede a REPORTER nem a impedido
- [ ] Roteamento configurável por tipo/departamento → equipe (`routingRules`; fase 5)

### Identidade do denunciante (§5.2.4)
- [x] Nome/e-mail/telefone do denunciante identificado cifrados em nível de campo (AES-256-GCM, chave **derivada por tenant**, tenantId como AAD) e imutáveis; anônima rejeita esses campos
- [x] Nunca saem em listagem/detalhe; revelação só por ADMIN elegível ou investigador atribuído, justificativa ≥ 20 chars, `IdentityReveal` + auditoria `REVEAL_IDENTITY` sem PII
- [ ] Chave-mestra em KMS com rotação e BYOK (fase 4 — hoje `FIELD_ENCRYPTION_KEY` de ambiente)
- [ ] Notificação ao ADMIN a cada revelação (fase 5)

## Fase 3 — Canal seguro do denunciante — *núcleo concluído, 68 testes verdes (fases 1+2+2b+3)*

### Sessão do protocolo e chat (§5.2.1, §5.3.2)
- [x] Token temporário de sessão do protocolo (30 min, escopo de UMA denúncia, sem estado nem cookie) devolvido na criação e na consulta; token de equipe/externo não abre o canal e vice-versa
- [x] Chat bidirecional (`/public/channel/messages`) para anônimo e identificado; equipe/REPORTER com conta em `/complaints/:id/messages` (AUDITOR só lê; REPORTER só na própria)
- [x] Mensagens automáticas: recibo na criação e aviso de atribuição (autor nulo)
- [x] Complemento do denunciante entra como `ComplaintAddendum` (relato original intacto)
- [x] Mensagens nunca gravam IP/UA; em caso anônimo `createdAt`/`readAt` vão ao minuto (trigger); auditoria sem conteúdo
- [x] **Ordem por sequência, não por horário** (`seq` interno, IDENTITY): corrigido após teste revelar desempate por UUID; `seq` nunca sai nas respostas
- [ ] Notificações `REPORTER_MESSAGE` ao comitê / e-mail ao denunciante identificado (fase 5+)
- [ ] Contato descartável opcional do anônimo para avisos, criptografado e apagável (fase 5)
- [ ] Mensagem automática a cada mudança de status (depende da máquina de estados, fase 5)

### Anexos (§5.4)
- [x] Upload por sessão de protocolo (anônimo), equipe e REPORTER dono: extensões jpg/jpeg/png/gif/pdf/doc/docx/zip, **validação por assinatura (magic bytes)** e MIME, limite configurável (`max_file_size_mb`, padrão 25 MB), 20 arquivos por denúncia
- [x] Anônimo: nome original descartado (`anexo-N.ext`), sem `uploadedBy`, horário ao minuto, auditoria anônima
- [x] SHA-256 do arquivo, bucket privado, chave `complaints/{id}/{uuid}`; adaptadores memória e **S3 (testado contra MinIO real)**
- [x] Download só por URL pré-assinada (1 h) com auditoria, e **só de arquivo `CLEAN`**; `PENDING`/`INFECTED` bloqueiam
- [x] Verificação de integridade (ADMIN/AUDITOR) detecta objeto adulterado; exclusão lógica (ADMIN ou quem enviou) remove o objeto
- [ ] **Antivírus (ClamAV), remoção de metadados EXIF/autor, zip-bomb/aninhados (fase 4)** — até lá todo arquivo fica `PENDING` e não é baixável; `metadataStripped=false`
- [ ] Download por REPORTER identificado ainda depende de a varredura existir (mesma regra)
- [ ] Estatísticas de anexos (ADMIN/AUDITOR)

### Limites de taxa (§5.1)
- [x] Consulta por protocolo: **5 falhas bloqueiam o protocolo por 15 min** (mesmo com a chave certa); libera sozinho; por tenant; sucesso zera
- [x] Por origem: 10 denúncias/h, 30 consultas/15 min, escritas e uploads no canal — IP só como HMAC com sal diário **em memória** (nunca gravado nem logado)
- [x] Por sessão: 30 mensagens/15 min e 10 uploads/15 min por denúncia
- [ ] Adapter Redis do limitador (hoje em memória, por processo — em várias instâncias o limite é por instância)
- [x] Limite de login/força bruta — Fase 4A
- Risco conhecido: o bloqueio por protocolo permite que terceiro que conheça o protocolo trave a consulta por chave por 15 min (quem já tem token de sessão segue usando o canal). Exigido pelo doc de negócio; monitorar.

### Anonimato — suíte estendida
- [x] A suíte agora cobre mensagem, complemento, anexo com nome identificador (`selfie-joao-silva-crachá.png`), leitura da conversa e resposta do comitê: varre todas as tabelas do tenant, logs e o storage (chaves/tipos) atrás de IP, UA, chave, nome do arquivo, vínculo e horário fino
- [ ] Filas/e-mails/proxy-WAF-CDN (quando existirem)

## Fase 4A — Segurança de contas e sessões — *concluída, 86 testes verdes (fases 1–4A)*

### Bloqueio por tentativas (§5.1)
- [x] 5 falhas seguidas travam a conta por 15 min (`lockedUntil`, persistido) — vale mesmo com a senha certa; contador zera no sucesso
- [x] Cada falha grava `LOGIN_FAILED` (com IP/UA da equipe); e-mail inexistente também é contado (chave em memória) e recebe **a mesma resposta 429** — não revela se a conta existe
- [x] Verificação de senha com custo constante (hash descartável quando o usuário não existe)
- [ ] Contagem em Redis (hoje memória por processo; o `lockedUntil` no banco cobre contas existentes entre instâncias)

### Sessões: access curto + refresh rotativo (§5.1)
- [x] Access 15 min com `sid` (id da sessão); refresh opaco 7 dias, só o hash no banco, rotativo
- [x] **Reuso de refresh já rotacionado revoga todas as sessões do usuário** e é auditado (`refresh_reuse`)
- [x] Sessão conferida no banco a cada request: logout, revogação e suspensão valem **na hora**, sem esperar os 15 min
- [x] Sessões ativas: listar (IP/UA/criação, marca a atual), revogar uma, `logout`, `logout-all`; ninguém revoga sessão de outro usuário
- [x] Suspensão do usuário e tenant suspenso derrubam/recusam refresh
- [ ] Limite absoluto de vida da sessão (hoje o refresh renova 7 dias a cada rotação, sem teto)

### Cookies e CSRF (§5.1, §7)
- [x] Entrega em cookie `httpOnly` + `SameSite=Lax` (+ `Secure` em HTTPS/produção) com `x-token-delivery: cookie`; tokens **fora do corpo**; refresh com `Path=/auth`
- [x] CSRF double-submit (cookie legível + header) em toda mutação autenticada por cookie e no refresh por cookie; Bearer (BFF) não precisa
- [x] Rotas do canal anônimo nunca emitem cookie — testado
- [ ] Escopo de domínio dos cookies por tenant/domínio próprio e integração com o BFF Next.js (`apps/web`)

### MFA (§5.1)
- [x] TOTP com login em duas etapas; segredo **cifrado** (AES-GCM por tenant); **10 códigos de recuperação** (Argon2id, uso único, mostrados uma vez)
- [x] Obrigatório para ADMIN/INVESTIGATOR/AUDITOR (e SUPER_ADMIN): sem MFA o login só devolve um token de cadastro que não abre mais nada; ativa e abre a sessão
- [x] Código TOTP **não pode ser reutilizado** (replay recusado por passo); erros de MFA contam para o bloqueio (5 → 429)
- [x] REPORTER: opcional; desativar exige senha + código; perfis obrigados não desativam
- [x] ADMIN reseta MFA de outro usuário (auditado): sessões dele caem e o recadastro é exigido
- [x] Cadastro/remoção de MFA auditados (`MFA_ENROLL`)
- [x] Em produção a obrigatoriedade **não pode ser desligada** (`MFA_ENFORCEMENT=off` só em dev/staging) — testado
- [x] Ativação do tenant (`GET /onboarding/status`) passa a exigir ao menos um ADMIN com MFA
- [ ] **Passkeys (WebAuthn)** — o doc aceita "TOTP e/ou passkeys"; só TOTP por ora
- [ ] MFA por SMS (Twilio) como alternativa
- [ ] `/loginadm` do SUPER_ADMIN: exige tabela/role própria da plataforma (o `platform_admin` não lê `users`) — fase 8
- [ ] Troca/recuperação de senha por e-mail

## Fase 4B — Arquivos e prova — *concluída, 128 testes verdes (fases 1–4B); testes contra ClamAV, Redis, MinIO e bucket WORM reais*

### Worker e filas (arq. §8)
- [x] `JobQueue` (porta): BullMQ sobre Redis ou fila em memória (dev/teste); retentativa exponencial 3x; jobs concluídos somem na hora e os falhos expiram em 1 h (a fila não guarda histórico que reconstrua o instante de um evento)
- [x] Entrypoint do worker (`src/worker/worker-main.ts`, `pnpm worker` / `start:worker`): consome as filas e agenda `attachment-sweep` (1 min), `audit-seal` (5 min), `audit-anchor` (1 h), `audit-verify` (24 h)
- [x] Testado com **Redis + BullMQ + Worker reais**
- Decisão: worker e API são **o mesmo pacote com dois entrypoints** (imagem única, comandos diferentes no Render), não um `apps/worker` separado como no desenho original
- [ ] Filas restantes da arquitetura: `notifications`, `dossier-generation`, `sla-check`, `retention-purge`, `webhook-delivery`, `daily-digest` (fases 5, 7, 8)
- [ ] `infra/render.yaml` com Web Service + Background Worker + Redis + ClamAV

### Antivírus e limpeza de anexos (§5.4)
- [x] Varredura ClamAV via clamd (INSTREAM) — **testada contra o clamd real** (EICAR e arquivo limpo, inclusive > 64 KB); falha do clamd **lança e retenta, nunca vira "limpo"**; esgotadas as tentativas o anexo vira `ERROR` (bloqueado)
- [x] **Anexo de denúncia anônima não é enfileirado no ato**: o sweep periódico o pega (senão a fila guardaria o instante exato do evento anônimo) — testado com Redis real
- [x] Remoção de metadados nos anexos do denunciante anônimo: **JPEG** (EXIF/GPS/comentário), **PNG** (tEXt/eXIf/tIME, CRCs válidos), **GIF** (comentários/XMP), **PDF** (Info + XMP), **DOCX** (core/app, autores de revisão/comentário, miniatura, datas) e **ZIP** (datas); implementados em TS puro/pdf-lib/jszip
- [x] Cadeia de custódia: hash **original** guardado antes da limpeza + hash do arquivo limpo; auditoria com os dois
- [x] **Triggers no banco**: estado de varredura é final (nem o dono do schema volta INFECTED→CLEAN); hash só troca uma vez (só de PENDING, preservando o original); a aplicação não altera `s3_key` nem colunas de identidade
- [x] Anexo impossível de limpar → `ERROR` (bloqueado), em vez de vazar metadados; `.doc` (OLE) é recusado em denúncia anônima com orientação para PDF/DOCX
- [x] Zip-bomb (taxa de compressão > 100x ou > 512 MB), arquivos compactados aninhados e > 1000 entradas barrados **no upload**
- [x] `INFECTED` bloqueia o download e é auditado
- [ ] Quarentena física do arquivo infectado (hoje fica no lugar, com download impossível) e **alerta ao ADMIN** (depende das notificações, fase 5)
- [ ] Zip/DOCX gerados por terceiros com estruturas exóticas podem falhar na limpeza (viram `ERROR`); ampliar cobertura conforme casos reais
- [ ] Limpeza de `.doc`/formatos legados; vídeo/áudio (fase 6)

### Auditoria com prova (§5.10)
- [x] **Selos Merkle** periódicos por tenant, encadeados por `prevSealHash` e cobrindo o intervalo `[fromSeq,toSeq]` com a lista de **buracos**; raiz reproduzível "de fora" só com SHA-256 (testado)
- [x] Buraco de rollback é benigno (registrado, verificação passa); remoção antes do selo **deixa buraco visível** mesmo sem o conteúdo
- [x] Função única `audit_compute_hash` no banco (trigger e verificação usam a mesma); registro selado e selo **imutáveis** até para o dono do schema (trigger)
- [x] **Âncora externa**: adaptador de **bucket S3 com Object Lock COMPLIANCE** (testado contra MinIO real: objeto não pode ser apagado na retenção) + âncora em memória p/ dev; um selo âncora cobre os anteriores; selo ancorado é imutável
- [x] **Verificação** (`POST /audit/verify`, job diário): recalcula rowHash, raízes, hashes de selo, cadeia, buracos, registros tardios, referências órfãs e confere as âncoras; detecta **DBA que desliga trigger e reescreve/apaga** (testado); alerta em log de erro + evento de auditoria
- [x] `GET /audit/seals` (ADMIN/AUDITOR) e lista de tenants **sem âncora nas últimas 48 h** (`tenantsWithoutRecentAnchor`)
- [x] Corrigido: RLS de `audit_logs` não tinha política de UPDATE e o selamento afetava 0 linhas em silêncio (achado pelos testes)
- [ ] **TSA RFC 3161** (carimbo de tempo, de preferência ICP-Brasil): o doc aceita "TSA e/ou bucket WORM"; só WORM por ora. Nenhum código TSA foi escrito
- [ ] Alerta **ativo** a ADMIN/AUDITOR/SUPER_ADMIN e abertura de incidente (hoje log + evento de auditoria); âncora a cada hora só para enterprise (config por plano — fase 8)
- [ ] Exportação da auditoria em CSV/PDF com hash de verificação e prova de âncora
- [ ] Janela de risco declarada: um registro comprometido dentro do intervalo entre selos (padrão 5 min) só é provado depois do selo

### Chaves por tenant / KMS (§3, §7)
- [x] **Envelope encryption**: cada tenant tem chaves de dados (DEK) **aleatórias e versionadas** em `tenant_keys`, embrulhadas pela chave-mestra (AES-GCM, AAD com tenant+versão); texto cifrado `v2.<versão>.…` com tenantId como AAD
- [x] Chave criada sob demanda e de forma segura sob concorrência (uma só ativa); **rotação da chave de dados** (nova versão cifra; antigas seguem legíveis) — testada
- [x] **Rotação da chave-mestra**: a anterior (`FIELD_ENCRYPTION_KEY_PREVIOUS`) só desembrulha; `rewrapKeys` reembrulha e libera a antiga — testada; produção exige a chave e valida o tamanho
- [x] A aplicação não apaga nem edita chaves (só aposenta e reembrulha); `platform_admin` não as vê; RLS entre tenants
- [x] Trocado o uso da cifra (MFA, destinatário alternativo, PII do denunciante) para a API assíncrona
- [ ] **KMS real (AWS/Google Cloud)** atrás da porta `Kek` — hoje a chave-mestra vem de variável de ambiente (`LocalKek`). Sem KMS, quem controla o ambiente da aplicação ainda pode usá-la: a separação de funções do doc §3 (duas pessoas, uso registrado) só existe com KMS
- [ ] **BYOK** (chave do cliente) para enterprise; revogação/crypto-shredding no offboarding
- [ ] Recifrar dados antigos para a versão nova (job) — hoje só os novos usam a nova versão

## Fase 5A — Processo: fluxo do caso, SLAs e notificações — *concluída, 160 testes verdes (fases 1–5A)*

### Máquina de estados e encerramento (§5.2.7, §5.12)
- [x] `POST /complaints/:id/status`: transições do doc (PENDING→IN_PROGRESS/DISMISSED; IN_PROGRESS/UNDER_REVIEW/ESCALATED entre si, RESOLVED, DISMISSED); motivo ≥ 10; **ESCALATED exige a instância**; **encerrar exige conclusão estruturada** (procedente/parcial/improcedente/inconclusiva + medidas + notas)
- [x] **Reabrir só ADMIN** (→ IN_PROGRESS, auditoria `REOPEN`); transição inválida, mesmo status e caso encerrado → 400; AUDITOR/REPORTER 403; suspeito pendente não decide; impedido não vê (404)
- [x] Histórico com o **status anterior real**; `resolvedAt` marcado/limpo; auditoria sem texto livre (só de/para e conclusão)
- [x] "Remover" = **arquivar** (`DELETE /complaints/:id` → DISMISSED, "Denúncia removida", só ADMIN); nunca exclusão física
- [x] Mensagem automática ao denunciante a cada mudança de status (anônimo vê com protocolo + chave); **a conclusão nunca vai ao denunciante**
- [ ] Legal hold impedindo arquivamento destrutivo (fase 7)
- [ ] Exigir tarefas obrigatórias do plano para encerrar (Fase 5B, junto com o plano de investigação)

### Prioridade automática (§5.2.1)
- [x] Prioridade sugerida por tipo (corrupção/assédio/segurança → HIGH); o denunciante só pode **subir**, nunca rebaixar
- [x] Ajuste do triador **exige motivo**, registrado em comentário INTERNO (texto livre fora da auditoria); recalcula SLA

### SLAs (§5.11)
- [x] Prazos na criação: padrão **7 dias** (recebimento) e **90** (retorno); aviso a **80%**; configuráveis por tenant e **por prioridade** (`sla_by_priority`), com validação do formato
- [x] Recebimento confirmado pelo recibo automático (desligável: `auto_ack_message=false`), pela atribuição/triagem ou mensagem do comitê; retorno = mensagem do comitê ou encerramento (mensagens automáticas não contam)
- [x] **Job `sla-check`** (15 min, idempotente): `SLA_WARNING` e `SLA_BREACHED` ao investigador e ADMINs elegíveis; ignora encerrados, pausados e cumpridos; um alerta por (caso, tipo, nível)
- [x] Indicadores (`ON_TIME`/`AT_RISK`/`BREACHED`/`DONE`/`PAUSED`) no detalhe e na lista; filtro `?sla=on_time|at_risk|breached`
- [x] **Pausa** com motivo (auditada) e retomada que empurra os prazos pelo tempo pausado
- [x] Em denúncia anônima **todos** os carimbos de SLA são truncados ao minuto (trigger) — o prazo não revela o segundo exato da criação
- [ ] Prazos em dias úteis (opção por tenant) e escalonamento automático do vencido ao destinatário alternativo

### Notificações (§5.8)
- [x] Módulo in-app + e-mail: criação (ADMIN/INVESTIGATOR elegíveis, sem suspeitos; restrito só ADMIN), atribuição, comentário (denunciante só se `REPORTER`), mensagem do denunciante, status, anexo, suspeita de conflito (só revisores), **leitura por suspeito** (alerta imediato), redistribuição, SLA, acesso externo, revelação de identidade
- [x] Preferências por usuário/canal/tipo; **críticas (SLA vencido, suspeita, redistribuição) ignoram o silenciamento** (testado com todos os canais desligados)
- [x] Conteúdo **sem detalhes da denúncia**: só protocolo, tipo e link autenticado; endpoints do próprio usuário (listar, contar, marcar lida, marcar todas) — nunca as de outro
- [x] **Falha de notificação/e-mail nunca desfaz a operação** (testado com o módulo inteiro falhando); e-mail pendente é reenviado pelo job `notification-email`
- [x] Adaptador **Resend** (`RESEND_API_KEY`), testado contra servidor HTTP local; caixa de saída em memória em dev/teste
- [x] **Anonimato do e-mail**: notificação sobre denúncia anônima nasce com horário ao minuto e o e-mail só sai depois de um **atraso aleatório de 2–4 min** (`email_send_after`) — achado por teste: sem isso o provedor registraria quase o instante do evento
- [x] Roteamento configurável (`routingRules`): destinatários extras por tipo/departamento
- [ ] Resumo diário (`daily-digest`), WebSocket e WEB_PUSH/PWA
- [ ] Testado só contra Resend simulado (nenhum e-mail real enviado)
- [ ] Slack/Teams/webhooks (fase 8)

### Casos relacionados e retaliação (§5.2.1, §5.12)
- [x] Sugestão de casos relacionados por **citado em comum** (sem acento/caixa) + local/período; o triador confirma o vínculo (bidirecional, auditado); não sugere casos restritos alheios; desligado com `encrypt_complaint_body`
- [x] **Retaliação**: durante `followUpUntil` (padrão 180 dias, `retaliationFollowUpDays`) o denunciante relata pelo canal (anônimo) ou pela conta e gera **caso novo, vinculado, HIGH**, com o mesmo anonimato, restrição e identidade cifrada, e chave própria; fora do período/antes do encerramento → 400
- [ ] Classificação de **má-fé** (campo interno, ADMIN + justificativa) e lembrete de revisão de suspensões ao encerrar
- [ ] Prioridade/tags por regras configuráveis de workflow (fase 9)

### Anonimato — suíte estendida (5A)
- [x] Varre todas as tabelas do tenant, a caixa de saída de e-mail e as notificações: sem IP/UA/chave; nenhuma linha de origem anônima com horário fino (denúncia, SLA, mensagens, notificações, auditoria)

## Front-1 — Design system + canal público (PROMPTFRONT.md) — *concluído; web 25 / ui 16 unit, 13 e2e (desktop+mobile) verdes*

### Design system (`packages/ui`)
- [x] Tokens CSS (claro / escuro / contraste alto / movimento reduzido) + preset Tailwind; `cn` com tailwind-merge estendido (teste de regressão)
- [x] Cor de marca do tenant só em ação/destaque (`brandCss`: `--brand`, `--on-brand`, `--brand-text`), contraste ≥ 4,5 garantido por tema; semânticas fixas
- [x] Testes de contraste WCAG lendo os tokens do próprio CSS (14)
- [x] Componentes: Button, Field/Input/Textarea/Select/Checkbox/CharCounter, Card/Prose/Mono/Skeleton, Status/Priority/SLA/Scan badges (ícone + texto), Alert, Stepper, EmptyState, Timeline
- [ ] Desvio documentado: alguns tokens (tertiary, warning, border-strong no escuro) foram escurecidos/clareados para passar WCAG AA (comentário em `tokens.css`)

### App web (`apps/web`, Next 15, porta 3100)
- [x] BFF `/api/bff/[tenant]/[...path]`: allowlist só `public/*`, repassa segredo do BFF + IP real, sem cookies, no-store
- [x] Headers de segurança, Referrer-Policy no-referrer; i18n `pt` (todo o texto em `messages/pt.json`)
- [x] Landing por tenant (marca, garantias, documentos, DPO) e consulta de protocolo (resposta genérica em erro)
- [x] Formulário em 5 etapas (Anonimato, Fato, Envolvidos, Anexos, Revisão), validação com as regras do `contracts`, aviso de identificação por conteúdo + confirmação, barra fixa
- [x] Rascunho **opt-in** (localStorage 24 h); estado só em memória por padrão; chave de acesso exibida uma vez, sem cookie/storage
- [x] Acompanhamento: linha do tempo macro, prazos, chat (polling 30 s), complemento, retaliação, sessão expirada
- [x] E2E em navegador real: fluxo anônimo completo, axe WCAG AA (claro/escuro), mobile sem rolagem horizontal e alvos ≥ 44 px; revisão visual das capturas feita

## Front-2A — Login da equipe + painel de casos — *concluído; 14 e2e novos (desktop+mobile) verdes; total e2e 23, unit 25*

### Sessão da equipe (BFF `/api/staff/[tenant]/[...path]`)
- [x] Tokens da API viram cookies **httpOnly + SameSite=Strict** (um par por empresa) e **saem do corpo da resposta**; nada de token em JS/localStorage/sessionStorage (testado)
- [x] Renovação automática com refresh rotativo (no BFF), sessão vencida leva a `/entrar?expirada=1`
- [x] CSRF: cabeçalho `x-ouvion-csrf` obrigatório + `Origin` igual ao host em toda chamada que muda estado (testado: 403 sem o cabeçalho / com origem externa)
- [x] Allowlist de rotas (revelar identidade, exportações etc. **não** passam ainda); porteiro do painel no servidor
- [x] Login: mensagem única para e-mail inexistente e senha errada, foco no título a cada etapa, 2º fator (app / código de recuperação), cadastro do 2º fator com QR **gerado no navegador**, códigos de recuperação exibidos uma vez com confirmação
- [x] **Verificado de ponta a ponta com API real e MFA obrigatório**: cadastro → TOTP real → códigos → login com código → código de recuperação vale só uma vez

### Painel (`/{tenant}/painel`)
- [x] Shell: sidebar recolhível (preferência em localStorage, opcional), rodapé com perfil e sair, mobile em barra superior
- [x] Lista de casos: filtros (situação, assunto, prioridade, prazo), paginação, badges com ícone+texto, anônimo/identificado/restrito, estados de carregando/erro/vazio
- [x] Detalhe com abas acessíveis (setas/Home/End): Resumo (relato imutável, prazos, complementos, encerramento), Conversa com o denunciante, Notas internas, Histórico
- [x] Ações: mudar situação (só transições válidas, motivo ≥ 10, conclusão ao encerrar, instância ao escalar, reabrir só ADMIN), atribuir investigador (ADMIN), prioridade com motivo; AUDITOR somente leitura
- [x] axe WCAG AA (claro/escuro) em login, MFA, lista, detalhe; mobile sem rolagem horizontal e alvos ≥ 44 px

## Front-2B (parte 1) — Equipe, revelar identidade, Minha conta — *concluído; e2e total 28 (desktop), API 164*

- [x] Backend: `GET /users/manage` (só ADMIN; inclui suspensos e estado do MFA; nunca hash/segredo/motivo da suspensão) + teste
- [x] **Equipe** (ADMIN): lista com perfil, 2º fator, último acesso; suspender (motivo ≥ 10, só com os administradores), reativar, zerar 2º fator; sem botão para se suspender; investigador recebe 403 no servidor e não vê o menu
- [x] **Revelar identidade** (ADMIN/investigador, só em caso identificado): diálogo com aviso de auditoria e justificativa ≥ 20; dado só em memória, some ao fechar e exige justificar de novo; nada em storage
- [x] **Minha conta**: aparência (tema, texto grande, contraste alto, sem animações) aplicada antes da pintura, sessões ativas (encerrar / sair de todos), preferências de notificação, perfil e estado do 2º fator
- [x] Diálogo de confirmação sobre `<dialog>` nativo (foco preso, Esc fecha), axe AA em todas as telas novas
- [ ] Desvio: tema/fonte/contraste/movimento ficam só no aparelho (localStorage) — o modelo `UserPreferences` do backend não tem esses campos; guardar por usuário exige migration
- [ ] Ainda sem: alterar o próprio MFA/senha pela tela, e-mail/senha esquecida

## Front-2B (parte 2) — Conflitos, auditoria, configurações e marca — *concluído; e2e total 32 (desktop), API 165 com teste novo*

- [x] Backend: `GET/PUT /branding` (só ADMIN): nome, cores `#RRGGBB`, logo e favicon só http(s); `customCss` recusado (fora do contrato); auditoria grava só os **nomes** dos campos alterados; testes de validação, reflexo na marca pública e 403 para não-ADMIN
- [x] **Conflitos** (ADMIN): pendentes/confirmados/descartados, nome da pessoa citada, tipo de coincidência (e-mail/nome), abrir o caso, decidir com justificativa ≥ 10 (mensagens para "decidir a própria suspeita" e "já decidida")
- [x] **Auditoria** (ADMIN/AUDITOR): lista paginada com filtro por ação, rótulos em português, origem anônima sem horário exato nem identificação, **verificação de integridade** sob demanda (selos/âncoras) com resultado íntegro/divergências
- [x] **Configurações** (ADMIN): marca com **prévia nos dois temas** e **aviso de contraste** (mostra o tom ajustado que o sistema usará), validação de cor/endereço no navegador; canal público (anonimato, manutenção, contato, documentos)
- [x] Achado corrigido no e2e: o cache de 60 s da marca fazia a mudança demorar a aparecer no canal → o BFF invalida a tag do cache ao salvar marca/configurações
- [x] Menu por perfil (Equipe/Conflitos/Configurações só ADMIN; Auditoria ADMIN+AUDITOR); investigador recebe 403 no servidor nas quatro rotas
- [ ] Não faz ainda: editar `customCss` (exige sanitização), domínio próprio, upload de logo (hoje só endereço), tipos restritos/SLA/roteamento em tela

## Front-2C — Ferramentas do caso e notificações — *concluído; e2e total 37 (desktop), unit 25*

- [x] **Anexos** (aba do caso): envio (multipart pelo BFF), estado da varredura com ícone+texto (atualiza sozinho a cada 5 s enquanto pendente), download **só de arquivo verificado** por URL temporária aberta em nova aba, exclusão com confirmação, conferência de integridade (ADMIN/AUDITOR)
- [x] **Prazos**: pausar (motivo ≥ 10) e retomar; **Acesso restrito** liga/desliga (ADMIN)
- [x] **Impedimento** (qualquer perfil interno): diálogo com motivo, redireciona à lista e o caso some para quem se declarou impedido
- [x] **Casos relacionados**: sugestões por pessoas em comum/local, vincular; aviso quando a busca está desligada (conteúdo cifrado)
- [x] **Notificações**: contador na navegação (atualiza a cada 60 s, texto para leitor de tela), lista com "Importante" para as críticas, marcar uma/todas como lidas, link para o caso
- [x] BFF: allowlist ampliada só para essas rotas (anexos por id/download/verify, `notifications/:id/read`); axe AA nas telas novas
- [ ] **Não verificado de ponta a ponta**: baixar um arquivo já varrido (exige API + worker + MinIO + ClamAV juntos; a URL pré-assinada e a varredura estão cobertas nos testes da API). No e2e o arquivo fica "em verificação" e o download aparece bloqueado, como deve
- [ ] Ainda sem em tela: conceder/revogar acesso a caso restrito, acesso externo (destinatário alternativo), retaliação do lado do comitê, complemento (addendum) pela equipe

### Pendências do front (não iniciadas)
- [ ] Dashboard com gráficos (depende da 5B do backend: estatísticas)
- [ ] Registro/login de REPORTER e denúncia identificada; recuperação de senha (não existe no backend)
- [ ] i18n EN/ES, PWA, `customCss` sanitizado, `apps/admin-web`/SUPER_ADMIN, CSP com nonce, Lighthouse/CWV no CI, domínio próprio
- [ ] Registro/login de REPORTER e denúncia identificada; recuperação de senha (não existe no backend)
- [ ] i18n EN/ES, PWA (manifest por tenant, service worker network-only), `customCss` sanitizado, `apps/admin-web`/SUPER_ADMIN, CSP com nonce, Lighthouse/CWV no CI, domínio próprio por tenant

## Painel SUPER_ADMIN (tarefas.md) — Etapa A: fundação real — *concluída; API 174 testes, e2e 47 (11 novos da plataforma)*

### Backend (`apps/api/src/platform`, migration `platform_admin`)
- [x] Espaço **separado** dos usuários de tenant: tabelas `platform_users`, `platform_refresh_tokens`, `platform_audit_logs`; JWT com segredo e audiência próprios (token de empresa não vale aqui e vice-versa, testado nos dois sentidos)
- [x] Papel de banco `platform_admin` com GRANT só nessas tabelas + `tenants`/branding. **Sem acesso a complaints, users de tenant, mensagens, anexos nem auditoria de tenant** — testado com SQL direto (`permission denied`)
- [x] Contagens por empresa por função `SECURITY DEFINER` (`platform_tenant_stats`) que devolve **só números**
- [x] Login `/platform/auth`: mensagem única "Acesso restrito à equipe OuviON" (e-mail inexistente = senha errada), bloqueio após 5 falhas, **2º fator SEMPRE obrigatório** (sem opção que desligue), cadastro no primeiro acesso, código TOTP não reutilizável, recuperação de uso único, segredo do TOTP cifrado pela chave-mestra, refresh rotativo com detecção de reuso
- [x] Perfis SUPER_ADMIN / SUPPORT / FINANCIAL com permissões do §2 (SUPPORT lista empresas mas não suspende nem gere usuários; FINANCIAL não lista empresas)
- [x] Empresas: listar/filtrar/ver e **suspender/reativar (suspensão comercial)** com motivo ≥ 10, auditoria de gravidade alta; equipe da empresa perde o login e o **canal público continua recebendo denúncias** (testado)
- [x] Usuários internos: criar com senha **temporária** (troca obrigatória + 2º fator no primeiro acesso, antes de qualquer sessão), mudar perfil, desativar (derruba sessões), reset de senha; protege o último SUPER_ADMIN e o próprio operador; senha nunca vai para a auditoria
- [x] Auditoria da plataforma (`PlatformAuditAction`, gravidade LOW–CRITICAL), **somente de acréscimo por trigger** (nem o dono do schema altera/apaga)

### Frontend (`/loginadm` e `/admin/*` no mesmo app Next)
- [x] BFF próprio `/api/platform` com **cookies próprios** (`ouvion_pat`/`ouvion_prt`, httpOnly, SameSite=Strict), CSRF, lista fixa de rotas (nenhuma de conteúdo de denúncia), renovação de sessão
- [x] Login: senha → troca da temporária → 2º fator → cadastro com QR gerado no navegador → códigos de recuperação; foco no título a cada etapa
- [x] Layout com os 6 itens da sidebar filtrados por perfil (FINANCIAL não vê Empresas), cards planos com borda superior de 2px, token novo `--plan-enterprise: #8a6d1f` (≥ 4,5:1, com teste)
- [x] Empresas (lista com busca/filtro/contagens + detalhe com garantia de privacidade e suspensão), Usuários internos (banner de alerta, permissões por perfil), Auditoria (gravidade, filtro, detalhes técnicos, destaque de quebra de vidro), Configurações (política de MFA **informativa, sem toggle**)
- [x] **Dashboard e Assinaturas com dados de demonstração rotulados** ("Dados de demonstração") — nada mock aparece como métrica real; empresas recentes e contagens do dashboard são reais
- [x] e2e: login real com TOTP, primeiro acesso real de usuário novo, perfis (SUPPORT/FINANCIAL), suspensão ponta a ponta, CSRF, axe AA em todas as telas

### Ainda não feito (próximas etapas)
- [ ] **Nova Empresa** com convite por link (72 h, uso único, ADMIN define senha + MFA + destinatário alternativo + DPO antes de sair de TRIAL), opção de senha temporária auditada, reenvio de convite (§4.2.1)
- [ ] **Quebra de vidro** completa (§5): solicitação, 2º SUPER_ADMIN aprovando com MFA recente, janela de 1 h escopada ao recurso, aviso ao ADMIN da empresa, auditoria dupla, revogação automática
- [ ] Configurações globais: abas e valores reais (senha, tentativas, timeout, whitelist de IP, trial, limites por plano, SMTP, pagamento)
- [ ] Assinaturas/planos/MRR reais e limites de plano (fase 8 do roadmap); gráficos do dashboard; passkey como alternativa ao TOTP; whitelist de IP para SUPER_ADMIN
- [ ] Tela de troca da própria senha do operador; `PLATFORM_DATABASE_URL`/`PLATFORM_JWT_SECRET` em produção (o código exige)
- [ ] Observação de dev: o banco `ouvion` local tem 3 selos de auditoria da empresa demo ancorados em memória por um worker de teste antigo; a verificação os acusa (o e2e tolera só esse caso). Some ao recriar o banco de dev

## Fase 5B — Investigação, dossiê e relatórios (a fazer)
- [ ] Plano de investigação, tarefas/checklist (`mandatory`, atraso, exigência para encerrar), modelos por tipo
- [ ] Entrevistas (consentimento de gravação, retenção, acesso restrito por URL curta)
- [ ] Evidências vinculadas e **linha do tempo unificada**
- [ ] **Dossiê** PDF (CONFIDENCIAL) + ZIP com manifesto de hashes; `includeAuditLog` restrito a ADMIN/AUDITOR; `includeInvestigation`
- [ ] Relatórios gerenciais (volume, tempos, % no SLA, procedência, reincidência, taxa de reclassificação) com exportação PDF/CSV e auditoria `EXPORT`
- [ ] Estatísticas do dashboard (por tipo, prioridade, mês, SLA)

## Fases 6–9
Ver roadmap em `PROMPT-REGRAS-DE-NEGOCIO.md` §10. Serão detalhadas aqui ao iniciar cada fase.

## Fases 3–9
Ver roadmap em `PROMPT-REGRAS-DE-NEGOCIO.md` §10. Serão detalhadas aqui ao iniciar cada fase.
