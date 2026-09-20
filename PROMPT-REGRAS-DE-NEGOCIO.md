# PROMPT — OuviON · Canal de Denúncias Corporativo (Regras de Negócio)

> Este documento descreve **somente regras de negócio, modelo de dados e comportamentos esperados**. Não prescreve stack, estrutura de pastas nem código. Use-o como especificação para (re)construir, evoluir ou auditar o sistema.
>
> **Legenda:** itens marcados com 🆕 foram incluídos na revisão de 2026-09-19 (avaliação de mercado) e **ainda não existem no código**. Itens sem marca são a regra base já especificada. Todos os 🆕 devem ser tratados como pendências de implementação (ver §9 e o roadmap em §10).
>
> **Revisão 2 (crítica técnica/jurídica)** ajustou: ordem das fases (fundação multi-tenant primeiro), criptografia × busca, **fim do bloqueio automático de citados**, impedimento sem risco de paralisia do comitê, **SUPER_ADMIN sem acesso a conteúdo**, auditoria com selos + âncora externa obrigatória, **relato original imutável**, gestão da investigação e canais de volume (WhatsApp/0800) priorizados, e suíte de aceitação do anonimato.

---

## 1. Papel e objetivo

Você é um time sênior de produto + engenharia. Construa/evolua o **OuviON**, plataforma SaaS **multi-tenant white-label** de **canal de denúncias corporativo** (compliance), que permite:

1. Receber denúncias **anônimas ou identificadas**, com protocolo de acompanhamento.
2. 🆕 Manter **comunicação bidirecional segura** com o denunciante (inclusive anônimo), por protocolo + chave de acesso.
3. Permitir que o comitê de compliance **triar, investigar, comentar, anexar provas e resolver** cada caso, com rastreabilidade total.
4. 🆕 Cumprir **SLAs de processo** (confirmação de recebimento e retorno ao denunciante) com alertas e escalonamento.
5. Permitir ao ADMIN **suspender manualmente** o acesso de um colaborador como medida cautelar (decisão humana, documentada fora do canal), de forma auditável e revisável. **O sistema nunca bloqueia contas automaticamente** com base em denúncia.
6. Gerar **dossiês** (PDF/ZIP) com a cadeia de evidências.
7. Notificar as partes (in-app e e-mail) respeitando preferências individuais.
8. Oferecer **dashboard/estatísticas**, 🆕 **relatórios gerenciais**, **auditoria imutável e verificável** e **personalização visual por empresa** (inclusive domínio próprio).
9. Atender princípios de **LGPD, ISO 27001, ISO 37002 e ISO 37301**, 🆕 além de **Lei 14.457/22, Lei 12.846/13 e Decreto 11.129/22** (minimização de dados, confidencialidade, integridade de evidências, trilha de auditoria, retenção, tratamento de conflito de interesses e não retaliação).

Idioma de todas as telas, mensagens de erro e e-mails: **português do Brasil** (🆕 estrutura preparada para i18n: PT/EN/ES).

---

## 2. Atores e perfis (RBAC)

| Perfil | Quem é | Pode |
|---|---|---|
| **PUBLIC** (não autenticado) | Qualquer pessoa | Registrar denúncia; consultar status por protocolo (🆕 + chave de acesso); 🆕 trocar mensagens e enviar anexos na própria denúncia via protocolo + chave; ver landing page e documentos normativos; ver configurações públicas de marca |
| **REPORTER** | Denunciante com conta | Ver **apenas as próprias** denúncias; comentar/enviar mensagens e anexar **apenas nas próprias**; baixar dossiê/anexos das próprias; **não edita** a denúncia após criada |
| **INVESTIGATOR** | Membro do comitê que investiga | Ver denúncias **não restritas** (🆕 e as restritas em que estiver atribuído); editar; alterar status; comentar (interno e ao denunciante); anexar; gerar/baixar dossiê; listar usuários; 🆕 declarar impedimento |
| **AUDITOR** | Compliance/auditoria (somente leitura + relatórios) | Ver denúncias (🆕 exceto restritas, salvo concessão), anexos, comentários, estatísticas; verificar integridade de anexos e da trilha de auditoria; gerar/baixar dossiê (inclusive com log de auditoria); listar usuários. **Não** cria/edita/atribui/comenta/anexa |
| **ADMIN** | Administrador da empresa (tenant) | Tudo do INVESTIGATOR **+** atribuir investigador, arquivar denúncia, 🆕 reabrir casos encerrados, 🆕 marcar/liberar caso restrito, 🆕 revisar suspeitas de conflito de interesses, 🆕 revelar identidade do denunciante (quebra de vidro), gerenciar usuários (CRUD), excluir dossiê, editar configurações e marca da empresa, editar/excluir qualquer comentário e anexo |
| **SUPER_ADMIN** | Operador da plataforma OuviON (sem tenant) | Gerencia empresas (tenants), assinaturas/planos, usuários internos, auditoria global **(somente metadados)** e configurações da plataforma; entra por **login próprio** (`/loginadm`) 🆕 com MFA obrigatório; nenhum outro perfil pode usar esse login. 🆕 **Não acessa conteúdo de denúncias** (§3) |

### Matriz resumida por recurso

| Ação | PUBLIC | REPORTER | INVESTIGATOR | AUDITOR | ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|
| Criar denúncia | ✅ | ✅ | ✅ | ✅ | ✅ |
| Consultar por protocolo (dados mínimos) | ✅ (🆕 c/ chave) | ✅ | ✅ | ✅ | ✅ |
| 🆕 Mensagens com denunciante (ler/enviar) | ✅ (c/ chave, só na sua) | só nas suas | ✅ | ler | ✅ |
| Listar/ver denúncias | ❌ | só as suas | todas não restritas | todas não restritas | todas |
| Editar denúncia | ❌ | ❌ | ✅ | ❌ | ✅ |
| Alterar status | ❌ | ❌ | ✅ (conforme §5.2) | ❌ | ✅ |
| 🆕 Reabrir caso encerrado | ❌ | ❌ | ❌ | ❌ | ✅ |
| Atribuir investigador | ❌ | ❌ | ❌ | ❌ | ✅ |
| 🆕 Declarar impedimento (conflito de interesses) | ❌ | ❌ | ✅ | ✅ | ✅ |
| 🆕 Marcar caso como restrito | ❌ | ❌ | ❌ | ❌ | ✅ |
| Arquivar (remover) denúncia | ❌ | ❌ | ❌ | ❌ | ✅ |
| Estatísticas / relatórios gerenciais | ❌ | ❌ | ❌ | ✅ | ✅ |
| Comentar (nota interna) | ❌ | ❌ | ✅ | ❌ | ✅ |
| Ler notas internas | ❌ | ❌ | ✅ | ✅ | ✅ |
| Anexar arquivo | ✅ (c/ chave, só na sua) | só nas suas | ✅ | ❌ | ✅ |
| Ler/baixar anexo | ❌ | só nas suas | ✅ | ✅ | ✅ |
| Verificar integridade de anexo / stats de anexos | ❌ | ❌ | ❌ | ✅ | ✅ |
| Excluir anexo | ❌ | só o que enviou | só o que enviou | ❌ | ✅ |
| Gerar dossiê | ❌ | ❌ | ✅ | ✅ | ✅ |
| Ler/baixar dossiê | ❌ | só das suas | ✅ | ✅ | ✅ |
| Excluir dossiê / stats de dossiês | ❌ | ❌ | ❌ | stats | ✅ |
| 🆕 Revelar identidade do denunciante (quebra de vidro) | ❌ | ❌ | só se atribuído | ❌ | ✅ |
| Suspender/reativar acesso de usuário (manual, §5.6) | ❌ | ❌ | ❌ | ❌ | ✅ |
| 🆕 Revisar suspeita de conflito de interesses (§5.2.9) | ❌ | ❌ | ❌ | ❌ | ✅ (não suspeito) |
| 🆕 Gerir plano/tarefas/entrevistas da investigação (§5.16) | ❌ | ❌ | ✅ (atribuído) | ler | ✅ |
| Listar/ver usuários | ❌ | ❌ | ✅ | ✅ | ✅ |
| CRUD de usuários | ❌ | ❌ | ❌ | ❌ | ✅ |
| Editar configurações da empresa | ❌ | ❌ | ❌ | ❌ | ✅ |
| 🆕 Consultar/exportar auditoria do tenant | ❌ | ❌ | ❌ | ✅ | ✅ |
| 🆕 Gerir API keys/webhooks/SSO | ❌ | ❌ | ❌ | ❌ | ✅ |

Regras transversais de acesso:
- **REPORTER** só acessa recursos cujo `createdBy` seja ele mesmo. Qualquer tentativa em recurso alheio → **403**.
- Denúncia **anônima nunca é vinculada a usuário** (`createdBy = null`); logo, um REPORTER não a enxerga depois. O acompanhamento do anônimo é feito **exclusivamente por protocolo + chave de acesso** (§5.2).
- Perfil não autorizado → 403; não autenticado em rota protegida → 401.
- 🆕 **Conflito de interesses**: quem **declarar impedimento** ou tiver a suspeita **confirmada** por um ADMIN não suspeito perde o acesso ao caso, mesmo sendo ADMIN; enquanto a suspeita está pendente valem as restrições cautelares do §5.2.9 (que não permitem paralisar o comitê citando todos os ADMINs).
- 🆕 **Casos restritos**: denúncia marcada como restrita só é visível ao investigador atribuído, a ADMINs não impedidos e a quem receber concessão explícita (auditada).
- 🆕 **SUPER_ADMIN (operador da plataforma) nunca acessa conteúdo** de denúncia, anexo, mensagem, comentário, dossiê ou identidade de denunciante (§3).

---

## 3. Multi-tenant e white-label

- Cada **empresa cliente = Tenant** com `slug` único (ex.: `techcorp`), acessível em `/{slug}` (landing da empresa), `/{slug}/login` e `/{slug}/dashboard`.
- 🆕 **Domínio próprio** por tenant (ex.: `denuncias.cliente.com.br`) via CNAME, com validação de posse do domínio e certificado TLS automático; o domínio resolve o tenant da mesma forma que o slug.
- **Isolamento total de dados**: usuários, denúncias, anexos, comentários, mensagens, dossiês, notificações e logs de auditoria pertencem a um tenant; toda consulta é filtrada pelo tenant do usuário/da rota; o JWT carrega o `tenantId`; validação cruzada usuário↔tenant no login. 🆕 Defesa em profundidade: **Row-Level Security no banco** + testes automatizados de vazamento entre tenants (obrigatórios no CI).
- 🆕 **Chaves de criptografia por tenant** (envelope encryption/KMS) com rotação; 🆕 **região de dados** configurável (padrão: Brasil).
- **Status do tenant**: `TRIAL` (padrão), `ACTIVE`, `SUSPENDED`, `CANCELLED`, mais flag `isActive`.
  - 🆕 **Suspenso/cancelado/inativo**: bloqueia o login da equipe, mas o **canal público continua recebendo denúncias** durante um período de carência configurável (denúncias ficam enfileiradas/guardadas e o ADMIN é avisado por e-mail); nenhum relato pode ser perdido por inadimplência. Após o encerramento do contrato, o cliente tem janela de **exportação de dados (portabilidade)** e depois aplica-se a política de exclusão do tenant.
- **Limites por plano**: `maxUsers` (padrão 10), `maxComplaintsPerMonth` (padrão 100), `subscriptionExpiresAt`. Planos exibidos no painel: FREE, BASIC, PRO, ENTERPRISE (com MRR por assinatura).
  - 🆕 `maxUsers` é **bloqueante** na criação de usuários.
  - 🆕 `maxComplaintsPerMonth` **nunca bloqueia** o recebimento de denúncias (canal de compliance não pode ficar indisponível por limite comercial): excedente é registrado como **uso adicional cobrável** e o ADMIN é alertado ao atingir 80% e 100%.
  - 🆕 **Cobrança integrada** (gateway de pagamento), medição de uso, self-service de onboarding e troca de plano.
- **Branding por tenant** (1:1): `companyName`, `primaryColor` (padrão `#3b82f6`), `secondaryColor` (padrão `#f59e0b`), `logoUrl`, `faviconUrl`, `loginBackgroundUrl`, `customCss`, 🆕 `customDomain`. Aplicado dinamicamente em landing, login, favicon e tema. Endpoint público de branding por slug; atualização somente ADMIN do tenant.
- 🆕 **DPO/Encarregado** do tenant (`dpoName`, `dpoEmail`) exibido no canal público (LGPD).
- **SUPER_ADMIN** não pertence a nenhum tenant e administra a plataforma: empresas, planos/assinaturas, usuários internos, uso/MRR, configurações da plataforma e auditoria global **apenas de metadados**. Painel: Dashboard, Empresas (listar/criar/editar/suspender/ver plano, nº de usuários, **contagem** de denúncias, MRR), Assinaturas, Usuários internos, Auditoria, Configurações.
- 🆕 **Operador da plataforma não lê conteúdo — escopo exato da garantia.** À pergunta "funcionário da OuviON consegue ler nossas denúncias?", a resposta é: **não pela aplicação nem pelo painel, e não sem controles verificáveis na infraestrutura**; a OuviON **não** promete impossibilidade absoluta, porque, como em qualquer SaaS, quem administra a infraestrutura detém tecnicamente meios de acesso.
  - **Nível aplicação/banco (garantia dura, testada):** SUPER_ADMIN e o painel **não acessam** denúncias (título, descrição, envolvidos), comentários, mensagens, anexos, dossiês, identidade do denunciante nem o `details` da auditoria — o papel de banco do painel não tem `SELECT` nessas tabelas e fica fora das políticas RLS de conteúdo, com teste automatizado.
  - **Nível infraestrutura (controles reais, auditáveis pelo cliente):**
    - credenciais de administração do banco/infra **segregadas** das da aplicação, sem uso cotidiano; acesso **just-in-time**, com aprovação, expiração curta e registro (cópia do registro ao tenant sob pedido);
    - **KMS** configurado para que equipe de aplicação e DBA **não possam usar a chave de dados** sem aprovação separada (duas pessoas), com todo uso da chave registrado; chaves por tenant permitem revogação e, em planos enterprise, **chave gerenciada pelo cliente (BYOK)**;
    - **backups cifrados** com chave inacessível ao time de aplicação; restauração exige aprovação e é registrada;
    - storage de anexos acessado apenas por identidade de serviço da aplicação, sem console humano permanente;
    - logs de acesso da infraestrutura imutáveis e ancorados (§5.10); relatórios de auditoria independente/pentest (ISO 27001, SOC 2) disponíveis ao cliente.
  - **Risco residual** (administrador de infraestrutura mal-intencionado que burle os controles) é **declarado no DPA**, com as medidas compensatórias e o direito de auditoria do cliente, em vez de prometido como inexistente.
  - **Quebra de vidro de plataforma** (suporte/incidente, exceção): exige justificativa, MFA recente, **aprovação de um segundo SUPER_ADMIN**, janela máxima de 1 h, **notificação imediata ao ADMIN do tenant** e registro na auditoria **do tenant** (`BREAK_GLASS_PLATFORM`).
- 🆕 **Papéis contratuais (LGPD)**: o cliente (tenant) é o **controlador** dos dados das denúncias; a OuviON é **operadora** (DPA no contrato: finalidade, suboperadores, região, incidentes, devolução/exclusão). Requisições de titulares recebidas pela OuviON são **encaminhadas ao controlador**; a OuviON não decide DSAR do cliente (§5.13).
- 🆕 **Provisionamento do tenant** (fluxo único e testado): cria o registro do tenant, as **políticas RLS**, a **chave de criptografia (KMS)** e a **`SEQUENCE` de auditoria** do tenant (§5.10), e o primeiro ADMIN. No offboarding: chaves e sequence seguem a política de retenção/exportação (§5.13), não são descartadas de imediato.
- 🆕 **Onboarding**: um tenant só passa de `TRIAL` para `ACTIVE` após (a) definir e **verificar o destinatário alternativo** (`escalationRecipientEmail`, §5.2.9) — a verificação inclui **confirmar o e-mail por link e enrolar o segundo fator** do destinatário (TOTP ou telefone verificado); sem isso o cenário anti-paralisia travaria justamente quando fosse acionado —, (b) ter ao menos um ADMIN com MFA ativo e (c) informar o DPO. Cada condição passa a ser exigida a partir da fase em que a funcionalidade correspondente existe (§10).

---

## 4. Modelo de dados (entidades e regras de integridade)

**User** — `email` (único), `passwordHash`, `fullName`, `role` (padrão PUBLIC), `isActive` (padrão true), `isBlocked` (padrão false), `blockedReason`, `blockedAt`, `blockedBy`, `lastLoginAt`, timestamps. (+ `tenantId`.) Possui `UserPreferences` 1:1.
🆕 Campos adicionais: `mfaEnabled`, `mfaSecret` (criptografado), `mfaRecoveryCodes` (hash), `failedLoginCount`, `lockedUntil`, `ssoSubject` (identificador do IdP), `deactivatedAt`.

**Complaint** — `protocol` (único), `isAnonymous`, `reporterEmail`/`reporterPhone` (**criptografados**), `type`, `priority` (padrão MEDIUM), `status` (padrão PENDING), `title`, `description`, `department`, `location`, `incidentDate`, `involvedPeople[]` (citados/acusados), `witnesses[]`, `metadata` (JSON livre, ex.: nome do denunciante), `investigatorId`, `investigationNotes`, `resolutionNotes`, `resolvedAt`, `createdBy`, `integrityHash`, timestamps. Índices por data, investigador, protocolo e status.
🆕 Campos adicionais:
- `accessKeyHash` — hash (Argon2/bcrypt) da chave de acesso do denunciante; a chave em claro **nunca** é armazenada.
- `source` (`ComplaintSource`) — canal de entrada.
- `isRestricted` — caso restrito (need-to-know).
- `acknowledgedAt`, `ackDueAt`, `feedbackDueAt`, `feedbackSentAt` — controle de SLA (§5.11).
- `conclusion` (`ComplaintConclusion`), `correctiveActions`, `conclusionNotes` — encerramento estruturado (§5.12).
- `retaliationReported` (boolean) e `followUpUntil` — acompanhamento pós-encerramento.
- `reportedType` — tipo **conforme informado pelo denunciante** (imutável); `type` passa a ser a classificação vigente do comitê (editável).
- Campos do **relato original imutáveis** após a criação: `title`, `description`, `involvedPeople`, `witnesses`, `incidentDate`, `location`, `reportedType` (cobertos pelo `integrityHash`). Complementos entram em **ComplaintAddendum**.
- `linkedComplaintIds[]` — casos relacionados/duplicados.
- `tags[]`.
- `integrityStatus` (`VERIFIABLE` | `ANONYMIZED`, padrão `VERIFIABLE`) e `anonymizedAt` — ver exceção da retenção em §5.13.

🆕 **ComplaintAddendum** — complementos/correções ao relato (somente inserção): `complaintId`, `authorType` (`REPORTER` | `COMMITTEE`), `authorId?`, `content`, `integrityHash`, `createdAt`. O relato original nunca é alterado.

**ComplaintStatusHistory** — `complaintId`, `previousStatus` (nulo na criação), `newStatus`, `changedBy`, `reason`, `createdAt`. Cascata ao excluir denúncia.

**ComplaintComment** — `complaintId`, `authorId`, `content`, timestamps. 🆕 `visibility` (`CommentVisibility`: `INTERNAL` = só comitê; `REPORTER` = visível ao denunciante).

🆕 **ComplaintMessage** — mensagens do canal seguro com o denunciante: `complaintId`, `direction` (`FROM_REPORTER` | `TO_REPORTER`), `authorId?` (nulo quando vem do denunciante anônimo), `content`, `readAt`, `createdAt`. Nunca guarda IP/user-agent nas mensagens anônimas.

🆕 **ComplaintRecusal** (impedimento/conflito) — `complaintId`, `userId`, `reason`, `declaredBy`, `origin` (`SELF` | `AUTOMATIC` | `ADMIN`), `createdAt`.

🆕 **ComplaintAccessGrant** — concessões explícitas de acesso a caso restrito: `complaintId`, `userId`, `grantedBy`, `reason`, `expiresAt`, `revokedAt`.

🆕 **ExternalAccess** — acesso pontual do destinatário alternativo, sem conta de usuário: `tenantId`, `complaintId`, `recipientEmail`, `triggeredBy` (`SYSTEM` | id do ADMIN), `reason`, `createdAt`, `expiresAt`, `revokedAt`, `lastUsedAt`, `usedCount` (§5.2.9).

🆕 **ConflictFlag** — suspeita de conflito de interesses para revisão: `complaintId`, `userId`, `matchType` (`EMAIL` | `NAME`), `status` (`PENDING` | `CONFIRMED` | `DISMISSED`), `decidedBy`, `decidedAt`, `decisionNote`, `createdAt`. **Nunca altera a conta do usuário**; afeta apenas o acesso ao caso (§5.2.9).

🆕 **InvestigationPlan** — `complaintId`, `objective`, `scope`, `hypotheses`, `dueAt`, `templateId?`. **InvestigationTask** — `planId`, `title`, `assigneeId`, `dueAt`, `status` (`TODO` | `DOING` | `DONE` | `CANCELLED`), `mandatory`, `completedAt`, `attachmentIds[]`. **Interview** — `complaintId`, `intervieweeName`, `intervieweeRole` (testemunha | citado | denunciante identificado | outro), `interviewerId`, `interviewedAt`, `summary`, `attachmentIds[]`, `recordingConsentAt?`, `recordingRetentionUntil?`. Todos restritos ao comitê do caso (§5.16).

🆕 **IdentityReveal** — cada exibição do e-mail/telefone descriptografado do denunciante: `complaintId`, `userId`, `justification`, `createdAt` (espelhado em `AuditLog`).

**Attachment** — `complaintId`, `filename`, `mimeType`, `size`, `s3Key`, `s3Bucket`, `sha256Hash`, `uploadedBy`, `uploadedAt`, `deletedAt`, `deletedBy` (**soft delete**). 🆕 `scanStatus` (`ScanStatus`), `scannedAt`, `metadataStripped` (boolean), `detectedMime` (por magic bytes).

**Dossier** — `complaintId`, `title`, `summary`, `generatedBy`, `generatedAt`, `s3PdfKey`, `s3ZipKey`, 🆕 `purgedAt` (dossiê apagado pelo expurgo; §5.13).

**Notification** — `userId`, `type`, `channel`, `title`, `message`, `data` (JSON), `relatedId`/`relatedType`, `isRead`/`readAt`, `sentAt`, `emailSent`/`emailSentAt`/`emailError`, `createdAt`.

**UserPreferences** — flags por tipo × canal (e-mail e in-app para os tipos de notificação), mais `emailNotifications`, `inAppNotifications`, `websocketNotifications`, `notificationSound`, `emailDigest` (padrão false) e `emailDigestTime` (padrão `09:00`). Tudo `true` por padrão, exceto digest.

**RefreshToken** — `token` (único), `userId`, `expiresAt`, `isRevoked`, `ipAddress`, `userAgent`. 🆕 O usuário pode listar e revogar suas **sessões ativas**.

**AuditLog** — `userId?`, `action`, `resource`, `resourceId`, `details` (JSON), `ipAddress`, `userAgent`, `timestamp`. 🆕 `tenantId`, `seq` (número de sequência **monotônico por tenant**, de uma `SEQUENCE` dedicada do tenant, não transacional; **interno** — mascarado em consultas/exportações de eventos anônimos), `rowHash` (hash do próprio registro, **independente do anterior**) e `sealId?` (selo que o cobre; §5.10). 🆕 `timestamp` é **truncado ao minuto** em eventos originados por denunciantes anônimos (a ordem é dada por `seq`). 🆕 `ipAddress`/`userAgent` ficam **nulos** em eventos originados por denunciantes anônimos.

🆕 **AuditSeal** — selo periódico da trilha: `tenantId`, `fromSeq`, `toSeq`, `gaps[]` (buracos de sequência vistos ao selar), `merkleRoot`, `prevSealHash`, `sealHash`, `sealedAt`, `anchorType` (`TSA_RFC3161` | `WORM_BUCKET`), `anchorRef`, `anchoredAt`.

🆕 **AuditPayload** — conteúdo sensível referenciado pela auditoria: `auditLogId`, `payload` (cifrado), `payloadHash` (coberto pelo `rowHash`), `purgeAt`, `purgedAt`. Permite expurgar o texto sem alterar registros já selados (§5.13).

🆕 **LegalHold** — `tenantId`, `complaintId?` (nulo = escopo amplo), `reason`, `createdBy`, `createdAt`, `releasedAt`. Suspende expurgo/anonimização (§5.13).

🆕 **DataSubjectRequest (DSAR)** — `tenantId`, `requesterName`, `requesterContact`, `type` (`ACCESS` | `RECTIFICATION` | `DELETION` | `ANONYMIZATION` | `PORTABILITY` | `OBJECTION`), `status` (`OPEN` | `IN_REVIEW` | `FULFILLED` | `DENIED`), `dueAt`, `resolutionNotes`, `handledBy`, timestamps.

🆕 **ApiKey** / **Webhook** — `tenantId`, `name`, `keyHash`/`url`, `scopes[]`, `events[]`, `secret` (assinatura HMAC), `lastUsedAt`, `revokedAt`.

🆕 **SsoConnection** — `tenantId`, `protocol` (`SAML` | `OIDC`), configurações do IdP, `defaultRole`, `domainAllowList[]`, `scimTokenHash`.

🆕 **TenantDomain** — `tenantId`, `domain`, `verifiedAt`, `tlsStatus`.

🆕 **BillingAccount / UsageRecord** — vínculo com gateway de pagamento, plano, ciclo e medição de uso (usuários, denúncias/mês, armazenamento).

**SystemSetting** — pares `key`/`value` (texto ou JSON serializado), `description`, `updatedBy`, 🆕 `isPublic`.

**Enums**
- `ComplaintType`: HARASSMENT (assédio moral/sexual), DISCRIMINATION, FRAUD, CORRUPTION, SAFETY (segurança do trabalho), ETHICS, OTHER.
- `ComplaintPriority`: LOW, MEDIUM, HIGH, CRITICAL.
- `ComplaintStatus`: PENDING, IN_PROGRESS, UNDER_REVIEW, RESOLVED, DISMISSED, ESCALATED.
- 🆕 `ComplaintConclusion`: SUBSTANTIATED (procedente), PARTIALLY_SUBSTANTIATED, UNSUBSTANTIATED (improcedente), INCONCLUSIVE.
- 🆕 `ComplaintSource`: WEB, WHATSAPP, PHONE, AUDIO, EMAIL, INTERNAL (registrada pelo comitê).
- 🆕 `CommentVisibility`: INTERNAL, REPORTER.
- 🆕 `ScanStatus`: PENDING, CLEAN, INFECTED, ERROR.
- `NotificationType`: COMPLAINT_CREATED, COMPLAINT_ASSIGNED, COMPLAINT_STATUS_CHANGED, COMPLAINT_COMMENT, ATTACHMENT_UPLOADED, DOSSIER_GENERATED, SYSTEM_ALERT, DEADLINE_REMINDER, 🆕 REPORTER_MESSAGE, 🆕 SLA_WARNING, 🆕 SLA_BREACHED, 🆕 CONFLICT_SUSPECTED, 🆕 RECUSAL_REASSIGNED.
- `NotificationChannel`: EMAIL, IN_APP, WEBSOCKET (🆕 WEB_PUSH).
- `AuditAction`: CREATE, READ, UPDATE, DELETE, LOGIN, LOGOUT, EXPORT, DOWNLOAD, BLOCK, UNBLOCK, 🆕 REVEAL_IDENTITY, 🆕 RECUSE, 🆕 REOPEN, 🆕 ACCESS_GRANT, 🆕 LOGIN_FAILED, 🆕 MFA_ENROLL, 🆕 LEGAL_HOLD, 🆕 BREAK_GLASS_PLATFORM, 🆕 EXTERNAL_ACCESS.
- `UserRole`: PUBLIC, REPORTER, INVESTIGATOR, ADMIN, AUDITOR, SUPER_ADMIN.
- `TenantStatus`: ACTIVE, SUSPENDED, TRIAL, CANCELLED.

---

## 5. Regras de negócio por módulo

### 5.1 Autenticação e sessão
- **Login** por e-mail + senha. Falha (mensagem genérica "Credenciais inválidas") se: e-mail inexistente, senha incorreta. Mensagens específicas se o usuário estiver **inativo** ("Contate o administrador").
  - 🆕 Usuário **bloqueado** (§5.6) recebe **mensagem genérica** ("Acesso suspenso. Contate o RH/administrador"); o motivo do bloqueio **nunca** é exibido ao bloqueado.
- 🆕 **Proteção contra força bruta**: após **5 falhas consecutivas**, a conta fica bloqueada por 15 minutos (`lockedUntil`); cada falha grava `LOGIN_FAILED`; o contador zera no sucesso. A resposta não revela se o e-mail existe.
- 🆕 **MFA (TOTP e/ou passkeys)**: **obrigatório** para ADMIN, INVESTIGATOR, AUDITOR e SUPER_ADMIN; opcional para REPORTER. Inclui códigos de recuperação de uso único. Login em duas etapas (senha → segundo fator). Cadastro/remoção de MFA gera auditoria.
- Login bem-sucedido atualiza `lastLoginAt`, emite **access token curto (15 min)** e **refresh token (7 dias)**, persiste o refresh token (com IP e user-agent) e grava auditoria `LOGIN`. 🆕 Tokens são entregues em **cookies httpOnly + Secure + SameSite** (não acessíveis por JavaScript), com proteção CSRF.
- **Refresh**: só aceita token existente, **não revogado** e **não expirado**, de usuário ativo e não bloqueado; **rotaciona** (revoga o antigo e emite novo par). 🆕 Reuso de refresh token já revogado revoga toda a família de tokens do usuário.
- **Logout** revoga o refresh token e grava `LOGOUT`. Deve existir operação para **revogar todos** os tokens de um usuário (ex.: ao bloquear/desativar). 🆕 Usuário pode ver e revogar suas sessões ativas.
- **Cadastro público** cria usuário com perfil **REPORTER**, e-mail único (senão "Email já cadastrado"), 🆕 **política de senha única em todo o sistema**: mínimo 8 e máximo 100 caracteres, com complexidade e verificação contra senhas vazadas comuns; hash bcrypt (custo 12) ou Argon2, auditoria `CREATE`, já retorna tokens.
- **Login de Super Admin** é distinto: rejeita qualquer perfil ≠ SUPER_ADMIN ("Acesso restrito a Super Administradores") e registra auditoria com `loginType: SUPER_ADMIN`.
- 🆕 **SSO corporativo (SAML 2.0 / OIDC)** por tenant (Entra ID, Google Workspace, Okta) para a equipe do comitê, com mapeamento de perfil por grupo e **SCIM** para provisionamento/desprovisionamento automático (desativar no IdP desativa e revoga sessões no OuviON).
- Tentativas de login (sucesso/falha) são registradas em log.
- Rate limiting global (padrão 100 req/60 s), CORS restrito e cabeçalhos de segurança. 🆕 Rate limit **específico** e mais restrito para: login, consulta por protocolo, verificação de chave de acesso, envio de mensagem/anexo anônimo e criação de denúncia (por IP e por protocolo).

### 5.2 Denúncias

**5.2.1 Criação (pública, com ou sem login)**
- 🆕 Se `allowAnonymousComplaints = false`, a denúncia exige identificação; se `maintenanceMode = true`, o canal exibe aviso, **mas continua aceitando denúncias** (manutenção nunca impede o registro de um relato).
- Campos obrigatórios: `isAnonymous`, `type`, `title` (10–200 chars), `description` (mín. 50 chars). Opcionais: `priority` (padrão MEDIUM), `department`, `location`, `incidentDate` (não pode ser futura no formulário), `involvedPeople[]`, `witnesses[]`, `metadata`, `reporterEmail` (e-mail válido), `reporterPhone` (telefone BR).
- No formulário público, **"acusado/denunciado" é obrigatório** (vai para `involvedPeople`); "testemunhas/outras pessoas envolvidas" vai para `witnesses` (uma por linha); nome do denunciante vai em `metadata.reporterName`. Nome/e-mail/telefone do denunciante só são solicitados se **não** anônima.
- Se `involvedPeople` chegar como texto único, normalizar para lista.
- 🆕 **Denúncia contra terceiros** (fornecedor, cliente, parceiro): o formulário permite indicar a relação do citado com a empresa, e o roteamento (§5.2.10) pode encaminhar a Compras/Jurídico.
- **Protocolo**: `DEN-{ANO}-{6 caracteres alfanuméricos maiúsculos}`, único.
- 🆕 **Chave de acesso**: gerada no ato da criação (mín. 16 caracteres aleatórios alfanuméricos, agrupados para leitura), **exibida uma única vez** na tela de confirmação (com opção de imprimir/copiar), guardada apenas como hash. Perda da chave **não é recuperável** para denúncias anônimas (o denunciante pode abrir nova denúncia referenciando a anterior). Para denunciantes identificados, o acompanhamento também é possível pela conta.
- **Estado inicial**: `PENDING`.
- **Criptografia**: a **PII** do denunciante — `reporterEmail`, `reporterPhone`, `metadata.reporterName` e contato descartável de anônimos — é gravada **criptografada em nível de campo (AES-256-GCM)**, com chave por tenant, nunca em claro. 🆕 O **texto do relato** (`title`, `description`, `witnesses`) **não** é cifrado por campo, para preservar busca livre e detecção de duplicidade; é protegido por criptografia do banco/storage em repouso, RLS, controle de acesso e auditoria. Tenants que exigirem sigilo máximo podem ativar `encrypt_complaint_body` (padrão `false`), aceitando **perder** busca por texto e detecção automática de duplicidade (resta busca por protocolo, tipo, data e tags).
- **Hash de integridade** SHA-256 de `{title, description, reportedType, involvedPeople, witnesses, incidentDate, location}` gravado na criação. 🆕 Esses campos são **imutáveis** (o relato como recebido é a prova); correções e complementos entram como `ComplaintAddendum` (§5.2.5).
- `createdBy = userId` apenas se **não anônima** e autenticado; anônima → `createdBy = null`.
- 🆕 **Anonimato técnico**: para denúncias anônimas **não se grava IP nem user-agent** (nem em logs de aplicação, proxy, WAF/CDN vinculáveis à requisição) e o sistema remove metadados dos anexos (§5.4). **Redução de correlação temporal**: em denúncias anônimas, `createdAt`/`updatedAt` e os horários de mensagens, anexos e eventos de auditoria são **truncados ao minuto** e **nenhum timestamp fino** é guardado em lugar algum do fluxo (banco, filas, logs); a ordem dos eventos é dada por sequência, não por horário. O anonimato é verificado por suíte de aceitação automatizada (§7).
- 🆕 **Aviso de identificação por conteúdo** (exibido antes do envio, obrigatório de reconhecer nas denúncias anônimas): o **conteúdo** do relato pode identificar o denunciante mesmo sem dados pessoais (setor pequeno, horário/local específico, detalhe que só ele conheceria, estilo de escrita, metadados de arquivos). O formulário orienta a generalizar detalhes, oferece checklist de boas práticas e permite ao denunciante rever o texto antes de enviar. Ao encerrar, o sistema **não repete** detalhes potencialmente identificadores em comunicações ao denunciado.
- 🆕 **Prioridade automática**: prioridade inicial sugerida por tipo (ex.: `CORRUPTION`, assédio sexual e `SAFETY` com risco à vida iniciam em `HIGH`/`CRITICAL`); o triador pode ajustar com motivo registrado.
- 🆕 **Detecção de casos relacionados/duplicados**: ao criar, o sistema sugere vínculos com denúncias semelhantes (mesmo citado, mesmo período/local) para o triador confirmar (indisponível se `encrypt_complaint_body` estiver ativo).
- Efeitos colaterais: histórico de status inicial ("Denúncia criada"), auditoria `CREATE`, notificação in-app a todos os **ADMIN e INVESTIGATOR ativos e não bloqueados e não impedidos** ("Denúncia {protocolo} ({tipo}) aguardando triagem"), 🆕 cálculo dos prazos de SLA (§5.11), 🆕 verificação de suspeita de conflito de interesses (§5.2.9). Falhas em notificação, verificação de conflito e SLA **não impedem** a criação (são registradas e reprocessadas).
- **Sanitização de saída**: para denúncia anônima, nunca devolver `createdBy`, `creator`, `reporterEmail`, `reporterPhone`.
- Anexos podem ser enviados logo após a criação: 🆕 a criação devolve um **token temporário de sessão do protocolo** (escopo restrito àquela denúncia, curta duração) que autoriza upload e mensagens sem login — resolve o upload de anônimos (§5.4). Falha no upload não desfaz a denúncia, apenas avisa.
- Após criar, exibir **tela de confirmação com protocolo + chave de acesso**.

**5.2.2 Consulta pública por protocolo**
- 🆕 Exige **protocolo + chave de acesso**. Retorna apenas: `id`, `protocol`, `status`, `type`, `priority`, `title`, `createdAt`, `updatedAt`, `resolvedAt`, `isAnonymous`, 🆕 prazos de retorno e mensagens `TO_REPORTER`. **Nunca** dados sensíveis. Protocolo inexistente **ou chave incorreta** → mesma resposta genérica ("Protocolo ou chave inválidos"), para evitar enumeração; tentativas limitadas por IP e por protocolo (bloqueio temporário após 5 falhas).
- Tela `/acompanhar`: linha do tempo visual — Pendente → Em Investigação → Em Análise → Resolvida → Arquivada/Encerrada — destacando etapa atual, concluídas e futuras; imprimível; 🆕 com **caixa de mensagens** (§5.3.2).

**5.2.3 Listagem (autenticada)**
- Paginação (`page` ≥ 1, `limit` 1–100, padrão 20). Filtros: `status`, `type`, `priority`, 🆕 `tags`, 🆕 `sla` (no prazo / próximo do vencimento / vencido), busca livre (protocolo, título ou descrição, sem diferenciar maiúsculas). Ordenação por `createdAt|updatedAt|priority|status|protocol`, `asc|desc` (padrão `createdAt desc`). REPORTER é filtrado às suas. 🆕 Casos restritos e casos em que o usuário está impedido **não aparecem**. Resposta traz `data` + `pagination{page,limit,total,totalPages}` e contagem de anexos/histórico.

**5.2.4 Detalhe**
- Inclui criador (se não anônima), investigador, anexos, histórico de status (mais recente primeiro), dossiês, 🆕 complementos ao relato, 🆕 indicadores de SLA e 🆕 casos relacionados. **Toda leitura gera auditoria `READ`.**
- 🆕 **Identidade do denunciante identificado** (`reporterEmail/Phone`, nome) fica **oculta por padrão**. Para revelar: ADMIN (ou investigador atribuído) informa **justificativa (≥ 20 caracteres)** — a ação exibe os dados naquela sessão, grava `IdentityReveal` e auditoria `REVEAL_IDENTITY`, e notifica o ADMIN do tenant.
- 🆕 **O que não é revelação de identidade**: o **envio automático de notificação ao denunciante identificado** (o sistema descriptografa e-mail/telefone apenas para entregar a mensagem, sem exibir a ninguém nem gravar em log) **não** é revelação e **não** gera `REVEAL_IDENTITY` nem `IdentityReveal` — não deve ser bloqueado nem poluir a auditoria. Só a **exibição a uma pessoa** dispara a regra acima.

**5.2.5 Edição**
- Somente ADMIN/INVESTIGATOR (REPORTER nunca). Gera auditoria `UPDATE` com as mudanças (valor anterior e novo).
- 🆕 **O relato original é imutável**: `title`, `description`, `involvedPeople`, `witnesses`, `incidentDate`, `location` e `reportedType` **não podem ser alterados** por ninguém, nem ADMIN — **com uma única exceção**: a rotina de anonimização/expurgo da retenção (§5.13), que é o único processo autorizado a reescrevê-los. **Editáveis** (classificação e gestão do caso): `type` (reclassificação), `priority`, `department`, `tags`, `linkedComplaintIds`, `isRestricted`, `investigationNotes` e demais dados de gestão.
- Correções e informações adicionais entram como **`ComplaintAddendum`** (do comitê ou do denunciante via canal seguro), exibidos junto ao relato, com data/autor e hash, sem sobrescrevê-lo.

**5.2.6 Atribuição de investigador (somente ADMIN)**
- Define `investigatorId`, muda status para `IN_PROGRESS`, cria histórico ("Atribuída ao investigador …") 🆕 com o **status anterior real** (corrige o `PENDING` fixo), notifica o investigador (in-app; e-mail conforme preferências) e audita.
- 🆕 Não pode atribuir investigador que esteja **impedido** ou **citado** no caso; o sistema recusa com mensagem clara. 🆕 Registra `acknowledgedAt` quando aplicável (§5.11).

**5.2.7 Alteração de status (ADMIN/INVESTIGATOR)** — 🆕 **máquina de estados**
- Exige `status` válido e `reason` com **mín. 10 caracteres**.
- Transições permitidas:

| De | Para |
|---|---|
| `PENDING` | `IN_PROGRESS`, `DISMISSED` |
| `IN_PROGRESS` | `UNDER_REVIEW`, `ESCALATED`, `RESOLVED`, `DISMISSED` |
| `UNDER_REVIEW` | `IN_PROGRESS`, `ESCALATED`, `RESOLVED`, `DISMISSED` |
| `ESCALATED` | `IN_PROGRESS`, `UNDER_REVIEW`, `RESOLVED`, `DISMISSED` |
| `RESOLVED` / `DISMISSED` | somente **ADMIN** pode **reabrir** (→ `IN_PROGRESS`), com motivo; gera `REOPEN` |

- `ESCALATED` = encaminhado à instância superior (diretoria/conselho/comitê externo); exige indicar o destinatário/instância no motivo e tem ação própria na UI.
- Ao encerrar (`RESOLVED`/`DISMISSED`) é **obrigatório** registrar a conclusão estruturada (§5.12).
- `resolvedAt` = agora quando o novo status é `RESOLVED` ou `DISMISSED`; caso contrário volta a `null`.
- Sempre cria registro em `ComplaintStatusHistory` (anterior, novo, quem, motivo), audita e **notifica o denunciante** se a denúncia **não** for anônima e tiver `createdBy`; 🆕 para o denunciante anônimo, gera uma **mensagem automática** no canal seguro (visível ao consultar com protocolo + chave).
- Ações disponíveis na tela de detalhe: Pendente, Em Investigação, Em Análise, Escalada, Resolvida, Arquivada (respeitando a tabela acima).

**5.2.8 Remoção (somente ADMIN)**
- **Nunca exclui fisicamente**: é um arquivamento — muda para `DISMISSED` com motivo "Denúncia removida" e responde "Denúncia arquivada com sucesso". 🆕 Sujeito a **legal hold** e à retenção (§5.13).

**5.2.9 🆕 Conflito de interesses e impedimento**
- **Impedimento efetivo** (o usuário perde o acesso ao caso) ocorre somente quando: (a) o próprio usuário **declara impedimento** (INVESTIGATOR/AUDITOR/ADMIN, com motivo); ou (b) uma suspeita de conflito é **confirmada** por um ADMIN que **não seja o suspeito**.
- **Suspeita automática**: ao criar a denúncia, o sistema compara `involvedPeople`/`witnesses` com e-mail/nome de usuários internos e abre `ConflictFlag` `PENDING`, notificando o ADMIN revisor (`CONFLICT_SUSPECTED`; revisão esperada em até 24 h). A suspeita **nunca bloqueia nem altera a conta** do usuário.
- **Restrições cautelares enquanto a suspeita está pendente** (não retiram o acesso, para que uma citação maliciosa não paralise o comitê): o suspeito **não recebe notificações** do caso, **não pode ser atribuído** como investigador nem decidir sobre o caso (status, atribuição, restrição, conflito), e **toda leitura** do caso por ele gera auditoria reforçada e **alerta imediato** ao revisor.
- **Confirmada**: o usuário perde acesso (listagem, detalhe, anexos, mensagens, dossiê, estatísticas com drill-down), é removido como investigador atribuído e o caso é **redistribuído** a outro investigador elegível (`RECUSAL_REASSIGNED`); tudo auditado (`RECUSE`). **Descartada**: registra a decisão e libera as restrições.
- **Anti-paralisia (obrigatório)**: se **todos** os ADMINs elegíveis forem suspeitos ou impedidos, o caso é roteado ao **destinatário alternativo** (`escalationRecipientEmail`: diretoria/conselho/comitê externo), que recebe acesso restrito e temporário e decide as suspeitas. Essa configuração é **obrigatória e verificada** (link de confirmação enviado ao destinatário) para o tenant ficar `ACTIVE` (§3) e é coberta por **teste automatizado** do cenário "todos os ADMINs citados".
- 🆕 **Acesso externo do destinatário alternativo** (`ExternalAccess`): o destinatário (conselheiro, advogado, comitê externo) **não tem conta** no tenant, não conta em `maxUsers` e não usa o login comum. Mecanismo:
  1. o acesso é acionado **para um caso específico** — automaticamente no cenário anti-paralisia ou por ADMIN não suspeito — com motivo registrado;
  2. o e-mail **já verificado** no onboarding (§3) recebe um **link mágico de uso único**;
  3. **segundo fator obrigatório** antes de abrir a sessão: TOTP **enrolado no onboarding do tenant (§3)** ou, na falta, código OTP por **canal independente do e-mail** (telefone verificado **também no onboarding**); o segundo fator nunca é coletado só na hora do acionamento;
  4. **sessão curta** (padrão 60 min, sem refresh) e **validade do acesso limitada** (padrão 72 h; prorrogação só por novo acionamento auditado);
  5. **escopo restrito àquele caso**: lê o relato, complementos, anexos e mensagens, e pode decidir suspeitas de conflito, atribuição e status **daquele caso**; não vê outros casos, usuários, configurações nem estatísticas;
  6. **revogável** a qualquer momento; cada acesso e ação é auditado (`EXTERNAL_ACCESS`, com IP/dispositivo — o destinatário é identificado, não anônimo) e gera notificação ao AUDITOR/ADMIN elegíveis, quando houver;
  7. o e-mail de acionamento **não contém dados do caso**, apenas protocolo e o link.

**5.2.10 🆕 Casos restritos e roteamento**
- ADMIN pode marcar `isRestricted` (ou o tipo pode ser restrito por regra: assédio sexual, corrupção, alta gestão). Só investigador atribuído, ADMINs não impedidos e quem tiver `ComplaintAccessGrant` (com motivo e validade) acessam. Auditoria em concessões/revogações.
- **Roteamento configurável por tenant**: regras `tipo/departamento → destinatários/equipe` (ex.: assédio → RH + Jurídico; fraude → Auditoria; fornecedor → Compras/Jurídico).

**5.2.11 Estatísticas (ADMIN/AUDITOR)**
- Total; contagem por status (pendentes, em andamento, resolvidas); agrupamento por tipo; agrupamento por prioridade. O dashboard exibe KPIs, gráficos (barras por tipo, pizza por prioridade, linha por mês), as 5 denúncias mais recentes e 🆕 indicadores de SLA (vencidos/próximos do vencimento). Relatórios completos em §5.14.
- 🆕 **Campo de agrupamento**: estatísticas e relatórios agrupam sempre por **`type`** (classificação vigente do comitê), nunca por `reportedType`, para que os números não mudem de significado entre telas. O `reportedType` alimenta um **indicador de reclassificação** separado (% de casos com `type` ≠ `reportedType` e matriz de/para), dado de maturidade do programa e de clareza das categorias para o denunciante.

### 5.3 Comentários e mensagens

**5.3.1 Comentários (notas do caso)**
- Criar: ADMIN e INVESTIGATOR (não impedidos). 🆕 `visibility = INTERNAL` (padrão; só comitê) ou `REPORTER` (visível ao denunciante). AUDITOR apenas lê. REPORTER **não** cria comentário: usa o canal de mensagens (§5.3.2).
- Ler/listar: ADMIN, INVESTIGATOR, AUDITOR (todos) e REPORTER (🆕 somente os de visibilidade `REPORTER` nas próprias denúncias).
- **Editar/excluir: apenas o autor ou ADMIN.** Exclusão é física, mas gera auditoria com o conteúdo removido (guardado em `AuditPayload` cifrado, referenciado por hash; §5.13).
- Ao criar: auditoria `CREATE`; notificar o **investigador** (se não for o autor) e, **somente se `visibility = REPORTER`**, o denunciante (se houver e não for o autor), in-app.

**5.3.2 🆕 Canal de mensagens com o denunciante (chat seguro)**
- Disponível para **anônimos e identificados**, autenticado por **protocolo + chave de acesso** (ou pela conta do REPORTER). Permite ao comitê **pedir informações complementares** e ao denunciante responder e enviar anexos.
- Mensagens `TO_REPORTER` são enviadas por INVESTIGATOR/ADMIN; `FROM_REPORTER` pelo denunciante. Notificações: comitê recebe `REPORTER_MESSAGE`; denunciante identificado recebe e-mail; anônimo vê ao consultar (opcionalmente informa e-mail/telefone descartável para aviso, guardado criptografado e apagável).
- Não há IP/user-agent em mensagens de anônimos. Conteúdo passível de exportação no dossiê (respeitando sigilo).

### 5.4 Anexos (evidências / cadeia de custódia)
- **Upload**: ADMIN, INVESTIGATOR, REPORTER (só na própria) 🆕 e **denunciante anônimo/sem login via token temporário do protocolo** (escopo único, curta duração, limitado por tamanho/quantidade/taxa). Nunca permite upload em denúncia alheia.
- **Validação**: tamanho máx. **25 MB** (configurável via `MAX_FILE_SIZE`); MIME permitido e extensão em `jpg, jpeg, png, gif, pdf, doc, docx, zip`. 🆕 **Validação por assinatura do arquivo (magic bytes)**, rejeitando divergência entre extensão/MIME declarado e conteúdo real; 🆕 limites de arquivos por denúncia e bloqueio de zip-bomb/arquivos aninhados.
- 🆕 **Antivírus**: todo arquivo passa por varredura (ex.: ClamAV) antes de ser disponibilizado. `scanStatus = PENDING` impede download; `INFECTED` → quarentena, alerta ao ADMIN e auditoria; `ERROR` → nova tentativa/alerta.
- 🆕 **Remoção de metadados** (EXIF/GPS, autor/empresa em PDF/DOCX) em anexos de **denúncias anônimas** por padrão (o hash original é guardado antes da limpeza, e o hash do arquivo limpo também, registrando a transformação na cadeia de custódia); opcional para as demais.
- Ao gravar: armazenar em bucket privado (chave `complaints/{complaintId}/…`), calcular e guardar **SHA-256**, salvar metadados, auditar `CREATE`.
- **Download** apenas por **URL pré-assinada temporária** (padrão 1 h), com auditoria `READ` (arquivo, expiração).
- **Verificação de integridade** (ADMIN/AUDITOR): recalcula o SHA-256 do arquivo armazenado e compara com o registrado; audita o resultado; divergência gera log de erro e alerta.
- **Exclusão**: ADMIN ou o próprio autor do upload; remove o objeto do storage e faz **soft delete** (`deletedAt/deletedBy`), auditando `DELETE`. Anexos excluídos não entram em estatísticas nem em dossiês.
- **Estatísticas** (ADMIN/AUDITOR): total, tamanho total (MB) e distribuição por tipo MIME.

### 5.5 Dossiês
- **Gerar** (ADMIN, AUDITOR, INVESTIGATOR): para uma denúncia, com opções `includeSummary` (padrão true), `includeTimeline` (true), `includeAttachments` (true), `includeAuditLog` (false; 🆕 **restrito a ADMIN/AUDITOR** — pedido de outro perfil → 403), `includeMessages` 🆕 (false), `format` = `pdf | zip | both` (padrão `both`).
- **PDF** (A4, marca d'água/aviso **CONFIDENCIAL**, cabeçalho/rodapé e paginação): "DOSSIÊ DE INVESTIGAÇÃO" com protocolo; Informações gerais; Descrição; Investigador responsável (se houver); Linha do tempo (histórico de status); Anexos e evidências (nome, tipo, tamanho, hash); 🆕 Conclusão e medidas; Log de auditoria (até 20 eventos, opcional). 🆕 O dossiê **nunca** inclui identidade de denunciante anônimo nem a chave de acesso.
- **ZIP**: contém o PDF, `README.txt` com **aviso de confidencialidade** e pasta `anexos/` com os arquivos não excluídos (🆕 e não infectados). 🆕 Inclui `manifesto.json` com hash SHA-256 de cada item, para verificação posterior.
- Persistir registro `Dossier` (título "Dossiê - {protocolo}", resumo textual, chaves S3) e auditar `CREATE` com formato gerado; notificar (`DOSSIER_GENERATED`).
- **Listar/ver/baixar** (ADMIN, AUDITOR, INVESTIGATOR, REPORTER-dono): download por URL pré-assinada (1 h), com auditoria; baixar PDF/ZIP inexistente → 400 "Este dossiê não possui PDF/ZIP gerado".
- **Excluir**: somente ADMIN ("Apenas administradores podem deletar dossiês"). **Estatísticas**: ADMIN/AUDITOR.
- Na tela de detalhe da denúncia há botão "Baixar relatório" com estados de carregando/erro e toast.

### 5.6 Suspensão manual de acesso de usuário 🆕
- 🆕 **O sistema nunca bloqueia contas automaticamente com base em denúncia** — nem por e-mail, nem (muito menos) por nome. Bloquear alguém citado em relato não verificado (possivelmente anônimo e ainda não triado) afeta a relação de trabalho, sofre com homônimos e revela ao citado que algo ocorreu, contrariando a não retaliação/sigilo (§7). A decisão de afastar ou suspender é da gestão/RH, **documentada fora do canal**; o ADMIN apenas **executa**.
- **Suspender** (ADMIN): `isBlocked = true`, `blockedAt`, `blockedBy`, `blockedReason` **interno e obrigatório** (a UI orienta a **não** citar protocolo, denúncia ou denunciante); revoga todos os tokens do usuário; audita `BLOCK`.
- Usuário suspenso **não consegue logar nem renovar token** e vê apenas mensagem genérica (§5.1); o `blockedReason` **nunca** é exibido a ele.
- **Reativar** (ADMIN): limpa motivo, data e autor, audita `UNBLOCK` e permite novo login.
- O ADMIN recebe **lembrete a cada 30 dias** das suspensões ainda em aberto para revisão; suspensão é medida cautelar, não punição. Não é possível suspender o último ADMIN do tenant.
- **Removidos da especificação**: configurações `auto_block_involved_users`/`auto_block_mode`, a entidade `BlockSuggestion` e a tela `/bloqueios`. A suspeita de **conflito de interesses** (§5.2.9) é um mecanismo distinto: restringe o acesso ao **caso**, não à conta.

### 5.7 Usuários (ADMIN)
- Listar (com filtro por perfil) e ver detalhe (sem `passwordHash`/`mfaSecret`); INVESTIGATOR e AUDITOR também podem listar/ver (o formulário de atribuição usa `?role=INVESTIGATOR`, 🆕 excluindo impedidos).
- Criar: e-mail único (senão 409 "Email já está em uso"), nome, senha (🆕 política única de §5.1, mín. 8), perfil obrigatório, `isActive` (padrão true), hash. 🆕 Respeitar `maxUsers` do plano (bloqueante); usuários provisionados por SCIM/SSO também contam.
- Atualizar: troca de e-mail revalida unicidade; nova senha é re-hasheada; bloquear registra `blockedAt`, 🆕 **revoga tokens ativos e audita `BLOCK`**; desbloquear limpa os dados de bloqueio e 🆕 audita `UNBLOCK`.
- 🆕 **Excluir = desativar**: por padrão, `isActive = false` + `deactivatedAt` (preserva autoria em auditoria, comentários e mensagens). Exclusão física só via rotina de anonimização (§5.13), que troca dados pessoais por identificador anônimo mantendo a integridade da trilha.
- 🆕 Admin pode **resetar MFA** de um usuário (auditado); não pode desativar/rebaixar o último ADMIN do tenant.

### 5.8 Notificações
- **Tipos** e disparos: criação de denúncia (ADMIN/INVESTIGATOR/AUDITOR), atribuição (investigador), mudança de status (denunciante não anônimo + investigador), comentário com visibilidade `REPORTER` (denunciante) e comentários gerais (investigador), 🆕 mensagem do denunciante (comitê), anexo enviado, dossiê gerado, alerta de sistema, lembrete de prazo / 🆕 `SLA_WARNING` (80% do prazo) e `SLA_BREACHED` (vencido), 🆕 suspeita de conflito de interesses, 🆕 redistribuição por impedimento. Templates de e-mail para cada um + **resumo diário** (`daily-digest`).
- **Canais**: IN_APP, EMAIL, WEBSOCKET, 🆕 WEB_PUSH (PWA). Antes de enviar, consultar `UserPreferences`: se o usuário desabilitou o tipo/canal, **não envia**; sem preferências cadastradas → envia. 🆕 Notificações críticas (`SLA_BREACHED`, `CONFLICT_SUSPECTED`, impedimento) **ignoram** preferências de silenciamento.
- Para e-mail: registra a notificação, tenta envio, guarda `emailSent`, `emailSentAt`, `emailError` e `sentAt`. **Falha de e-mail nunca derruba a operação de negócio.** 🆕 E-mails **não revelam detalhes da denúncia** (apenas protocolo/tipo e link autenticado), para reduzir vazamento por caixa de e-mail.
- Usuário pode: listar (últimas 50, filtro lida/não lida), contar não lidas, marcar uma ou todas como lidas — **sempre restrito às suas notificações**.

### 5.9 Configurações do sistema (por tenant)
- 🆕 **Leitura pública apenas das chaves públicas** (`isPublic = true`: marca, cores, contato, documentos normativos, política de privacidade/termos, DPO, `allowAnonymousComplaints`, `maintenanceMode`); as demais só ADMIN. **Escrita somente ADMIN.** Valores são texto ou JSON.
- Chaves de negócio: `companyName`, `companyLogo`, `footerLogo`, `companyPhone`, `companyEmail`, `primaryColor`, `secondaryColor`, `privacyPolicy`, `termsOfService`, **documentos normativos** (`docCodigoEtica`, `docPoliticaFornecedores`, `docPoliticaAnticorrupcao`, `docPoliticaLicitacoes`, `docPoliticaPldFtp`, `docPoliticaAssedio`), **`allowAnonymousComplaints`** (se `false`, o canal deve exigir identificação — 🆕 **aplicado** na criação), **`maintenanceMode`** (🆕 aviso; nunca bloqueia o registro de denúncias), `emailNotifications`, `systemAlerts`, `max_file_size_mb`, 🆕 `encrypt_complaint_body` (padrão `false`; ver §5.2.1), `data_retention_days` (padrão **2555 dias ≈ 7 anos**).
- 🆕 Novas chaves: `sla_ack_days` (padrão 7), `sla_feedback_days` (padrão 90), `sla_by_priority` (JSON), `escalationRecipientEmail` (**obrigatória e verificada** para o tenant ficar `ACTIVE`; §3 e §5.2.9), `routingRules` (JSON), `restrictedTypes` (lista), `dpoName`, `dpoEmail`, `retaliationFollowUpDays`, `reportRecipients`, `defaultLanguage`.
- Propriedades desconhecidas são rejeitadas.
- 🆕 **Categorias, prioridades, campos do formulário e workflow** podem ser personalizados por tenant dentro dos limites da máquina de estados base.

### 5.10 Auditoria
- **Trilha somente-inserção** com usuário (ou nulo), ação, recurso, id do recurso, detalhes, IP e user-agent (🆕 nulos para anônimos), timestamp. 🆕 O papel de banco usado pela aplicação **não tem `UPDATE`/`DELETE`** na tabela de auditoria.
- 🆕 **Integridade probatória em três camadas** (encadear no mesmo banco que o operador controla **não** prova nada por si só; a âncora externa é o que dá valor probatório):
  1. **Hash por registro** (`rowHash`): SHA-256 dos campos canônicos do registro, **sem dependência do registro anterior** — a gravação da auditoria continua na mesma transação da ação de negócio (rollback consistente) e **não serializa** escritas concorrentes.
  2. **Selos periódicos** (`AuditSeal`): job assíncrono (padrão a cada 5 min) agrupa os registros novos de cada tenant, calcula a **raiz Merkle** e encadeia ao selo anterior (`prevSealHash`). A cadeia existe entre **selos**, não entre registros.
     - **Sequência por tenant contra remoção antes do selo**: cada registro recebe `seq` monotônico (sequência do banco, sem lock de cadeia) e o selo cobre o **intervalo** `[fromSeq, toSeq]` e lista os **buracos** encontrados ao selar. Assim, um registro inserido e removido antes do selo **deixa um buraco visível**, mesmo sem o conteúdo.
     - Buracos benignos existem (a transação de negócio revertida descarta também o seu registro de auditoria, mas consome o número). Por isso os buracos são **registrados no selo e comparados com a taxa de rollbacks**; geram alerta quando **excedem o padrão esperado** ou quando surgem em intervalo **já selado** (impossível sem adulteração).
     - A janela de risco fica reduzida ao intervalo de selagem (padrão 5 min; 1 min em planos enterprise) e o **risco residual dentro dela é declarado**.
     - **Implementação do `seq`: uma `SEQUENCE` do banco por tenant**, criada no **provisionamento** do tenant (§3) — não um contador em tabela, que travaria a linha e **serializaria** a auditoria do tenant. O custo (DDL no provisionamento, migrations e limpeza no offboarding) é aceito e coberto por teste. No offboarding a sequence é **arquivada** (não descartada) até o fim da retenção da auditoria do tenant.
     - **A sequence não é transacional, por projeto**: o número é consumido mesmo em rollback. Isso é o que explica os buracos benignos acima; **não "consertar"** tornando-a transacional/sem buracos, pois reintroduz o lock e a serialização. Registrar isso em comentário e teste de regressão.
     - **`seq` de eventos anônimos é interno**: usado só para selagem e detecção de buracos e **nunca exposto** em consulta, tela ou exportação da auditoria (mascarado na leitura); o evento anônimo é apresentado só com horário truncado ao minuto. Sem isso, o evento ficaria entre dois `seq` vizinhos de usuários internos (com timestamps finos, como logins) e o instante da denúncia seria reconstruído com precisão de segundos. A verificação de integridade é feita pelo sistema, sem entregar `seq` de eventos anônimos ao usuário.
  3. **Âncora externa obrigatória**: no mínimo **diariamente** (a cada hora para planos enterprise), o hash do último selo é publicado **fora do controle do operador da aplicação**: carimbo de tempo **RFC 3161** (TSA, preferencialmente ICP-Brasil) e/ou bucket **WORM/Object Lock** em conta de nuvem separada, com credenciais distintas das da aplicação. A referência fica em `anchorRef`; o tenant pode receber cópia do hash.
- 🆕 **Verificação** (sob demanda e agendada): recalcula `rowHash`, raízes Merkle, cadeia de selos e confere as âncoras; qualquer divergência gera alerta a ADMIN/AUDITOR/SUPER_ADMIN e abre incidente. Tenant sem âncora válida nas últimas 48 h gera alerta de plataforma.
- Eventos obrigatórios: criar/ler/atualizar/arquivar denúncia; mudança de status; atribuição; comentário e mensagem (criar/editar/excluir); anexo (upload, download URL, verificação, exclusão, varredura); dossiê (gerar/baixar/excluir); login/logout/falha de login/MFA; suspensão/reativação de usuário; 🆕 suspeita de conflito e decisão; 🆕 quebra de vidro de plataforma; 🆕 revelação de identidade; 🆕 impedimento/redistribuição; 🆕 concessão de acesso; 🆕 reabertura; 🆕 legal hold; 🆕 DSAR; exportações.
- Consulta de auditoria por SUPER_ADMIN (global, **somente metadados**: `details` mascarado, sem conteúdo de denúncias/comentários) e ADMIN/AUDITOR (do tenant, com detalhes), com filtros (usuário, ação, recurso, período). Deve ser **exportável** (CSV/PDF, com hash de verificação e prova de âncora).

### 5.11 🆕 SLAs e prazos
- Na criação calcula-se `ackDueAt = createdAt + sla_ack_days` (padrão **7 dias**) e `feedbackDueAt = createdAt + sla_feedback_days` (padrão **90 dias**); prazos por prioridade podem ser mais curtos (`sla_by_priority`).
- **Confirmação de recebimento** (`acknowledgedAt`): registrada quando o comitê confirma/triage o caso ou envia a mensagem automática de recebimento (para anônimos, visível na consulta por protocolo + chave; a mensagem automática pode ser enviada logo na criação).
- **Retorno ao denunciante** (`feedbackSentAt`): registrado ao enviar mensagem `TO_REPORTER` de retorno sobre as providências ou ao encerrar o caso.
- Alertas: `SLA_WARNING` a 80% do prazo e `SLA_BREACHED` ao vencer, para investigador e ADMIN; escalonamento automático do caso vencido ao ADMIN/destinatário alternativo. Implementa `DEADLINE_REMINDER`.
- Indicadores exibidos na lista, no detalhe e no dashboard (no prazo / próximo do vencimento / vencido); prazos contados em dias corridos (opção de dias úteis por tenant). Pausa do prazo somente com motivo (ex.: aguardando informações do denunciante), auditada.

### 5.12 🆕 Conclusão estruturada e pós-caso
- Ao encerrar, registrar: `conclusion` (procedente / parcialmente procedente / improcedente / inconclusiva), `correctiveActions` (medidas corretivas/disciplinares adotadas, sem dados desnecessários), `conclusionNotes` e lições aprendidas (para o relatório gerencial).
- **Acompanhamento de retaliação**: após o encerramento, o sistema mantém `followUpUntil` (padrão `retaliationFollowUpDays`) e permite ao denunciante reportar retaliação pelo mesmo canal; `retaliationReported` gera novo caso vinculado com prioridade `HIGH`.
- **Má-fé**: campo interno opcional para classificar relato de má-fé, **sem** expor o denunciante e **nunca** aplicável a relato de boa-fé; exige ADMIN e justificativa.
- Ao encerrar, o ADMIN recebe lembrete para **revisar suspensões de acesso** ainda em aberto (§5.6); o sistema não vincula suspensões a casos.

### 5.13 🆕 Retenção, LGPD e direitos do titular
- **Retenção**: `data_retention_days` (padrão 2555 dias ≈ 7 anos) contados do encerramento; **job de expurgo/anonimização** agendado: anonimiza PII (denunciante, citados, testemunhas), remove anexos e mantém dados estatísticos agregados e a cadeia de auditoria (com identificadores anonimizados). Registra o resultado (quantidade tratada) em auditoria.
- 🆕 **Escopo completo da anonimização/expurgo.** O mesmo texto livre com PII existe em vários lugares; **todos** entram no mesmo job, com a mesma data de corte: `Complaint` (relato, `investigationNotes`, `resolutionNotes`, `conclusionNotes`, `correctiveActions`, `metadata`); `ComplaintAddendum`; `ComplaintMessage` (o chat inteiro); `ComplaintComment`; `InvestigationPlan`, `InvestigationTask` e `Interview` (nome do entrevistado, resumo/termo, gravações); `Attachment` (objetos no storage); `Notification.data` e contatos descartáveis.
  - **Dossiês e exportações já gerados** (PDF/ZIP no storage, fora do alcance de qualquer `UPDATE`) são **apagados fisicamente** junto, e o registro `Dossier` fica marcado `purgedAt` (resta só o metadado).
  - **Cópias em backup** expiram pela rotação de backups (retenção máxima documentada, ex.: ≤ 35 dias) e esse prazo consta no DPA.
  - **Conteúdo em auditoria**: `AuditLog.details` **não guarda texto livre com PII**; conteúdo sensível (ex.: comentário excluído) vai para `AuditPayload` cifrado, referenciado por hash no registro (o `rowHash` cobre o hash do payload). O expurgo remove o payload sem alterar o registro já selado.
  - Um teste percorre **todas as tabelas e prefixos de storage** do caso para provar que nenhuma PII sobrevive ao job.
- 🆕 **Exceção controlada à imutabilidade do relato**: o expurgo/anonimização reescreve campos imutáveis (`title`, `description`, `involvedPeople`, `witnesses`, `location`, PII). Para não quebrar a verificação de integridade sem explicação: (a) a rotina roda **somente como job autorizado**, nunca por ação manual ad hoc; (b) grava em auditoria o `integrityHash` **anterior**, a data e o escopo do que foi reescrito; (c) marca o caso com `integrityStatus = ANONYMIZED` e `anonymizedAt`, e a verificação de integridade passa a tratá-lo como **"hash original não verificável a partir de `anonymizedAt`"** — estado esperado, **não** violação; (d) a existência e o conteúdo original **até aquela data** continuam provados pelos selos de auditoria já ancorados no período anterior; (e) há teste automatizado cobrindo o job e a verificação.
- **Papéis**: o tenant é **controlador** e a OuviON é **operadora** (§3). Requisições de titulares e de autoridades que chegarem à OuviON são **encaminhadas ao controlador**, que decide; a OuviON apoia tecnicamente (exportação, anonimização) sem acessar o conteúdo (§3).
- **Legal hold**: casos com `LegalHold` ativo **nunca** são expurgados/anonimizados nem arquivados de forma destrutiva, mesmo vencida a retenção.
- **DSAR** (direitos do titular): abertura por formulário público do tenant ou pelo comitê; prazo legal de resposta acompanhado (`dueAt`), com alertas; tipos: acesso, retificação, exclusão, anonimização, portabilidade, oposição. Respeita restrições legais (ex.: não revelar identidade do denunciante ao citado; manter dados sob obrigação legal/legal hold) e registra a justificativa da decisão.
- **Transparência**: base legal por finalidade, política de privacidade, aviso de tratamento no formulário, contato do **Encarregado (DPO)**, RIPD/DPIA documentado, **registro de incidentes** e fluxo de comunicação à ANPD/titulares.
- **Portabilidade/encerramento de contrato**: exportação completa do tenant (denúncias, anexos, auditoria) em formato aberto, com manifesto de hash.

### 5.14 🆕 Relatórios gerenciais e indicadores
- Relatórios periódicos para diretoria/conselho (mensal/trimestral/semestral): volume por período, por tipo, departamento e canal; tempo médio de triagem e de resolução; % dentro do SLA; taxa de procedência; reincidência; casos escalados; retaliações reportadas; mapa de calor por área. Dados **agregados/anonimizados** (sem PII); exportáveis em PDF/CSV e agendáveis por e-mail (`reportRecipients`).
- Indicadores de maturidade do programa (ISO 37301/37002): tendências, comparativo entre períodos, cobertura de treinamento/divulgação e 🆕 **taxa de reclassificação** (`type` × `reportedType`, §5.2.11). Os agrupamentos por tipo usam `type`.
- Acesso: ADMIN e AUDITOR; toda exportação gera auditoria `EXPORT`.

### 5.15 🆕 Integrações e recursos modernos
- **API pública** autenticada por **API key** com escopos (leitura de estatísticas, criação de denúncias por sistema externo, etc.) e **webhooks** assinados (HMAC) para eventos (`complaint.created`, `status.changed`, `sla.breached`…), com retentativas e log de entregas. Somente ADMIN gerencia; segredo exibido uma vez.
- **Integrações**: Slack/Teams (alertas sem dados sensíveis), Jira/ServiceNow (tarefas), SIEM (exportação da trilha de auditoria).
- **Canais de entrada adicionais** (prioridade comercial: dão **volume** e alcançam quem não usa o formulário web, como o chão de fábrica): WhatsApp, telefone/0800, **relato por áudio** (com transcrição), e-mail dedicado e **QR Code** em cartazes; todos criam denúncia com `source` correspondente e geração de protocolo + chave (entregues ao denunciante no próprio canal ou por locução/mensagem).
  - **Limites do anonimato por canal (informados ao denunciante antes do relato)**: no WhatsApp e no telefone o número do remetente é dado pessoal e é retido pelo provedor; a OuviON **não o armazena** em relatos anônimos (descartado ao fim da sessão, sem log) e o aviso informa a limitação. No áudio, a **voz pode identificar** o denunciante; oferecer transcrição e descarte do áudio original quando o denunciante optar.
  - Esses canais passam pela mesma suíte de aceitação do anonimato (§7) na medida do que a OuviON controla.
- **IA assistiva (sempre com decisão humana)**: sugestão de tipo/prioridade, resumo do caso, detecção de duplicidade/casos relacionados, sugestão de trechos que identifiquem o denunciante, tradução. Restrições: sem treinar modelos com dados do cliente, processamento em região contratada, PII minimizada/mascarada no envio, registro do uso em auditoria e opt-in por tenant.
- **Workflow configurável** por tenant e **multi-idioma** (PT/EN/ES) no canal público. A gestão da investigação é núcleo do produto e está em §5.16.
- **PWA/push** para o comitê. **Campanhas/divulgação** do canal (materiais em PDF/cartaz por tenant e métricas de conhecimento).

### 5.16 🆕 Gestão da investigação (dia a dia do comitê)
- **Plano de investigação** por caso (`InvestigationPlan`): objetivo, escopo, hipóteses, prazo e responsáveis. **Modelos por tipo** de denúncia (assédio, fraude, corrupção, segurança…), configuráveis por tenant, que já geram as tarefas padrão.
- **Tarefas/checklist** (`InvestigationTask`): título, responsável, prazo, status (`TODO`, `DOING`, `DONE`, `CANCELLED`), marcação `mandatory` e vínculo a evidências. Alerta de atraso ao responsável e ao ADMIN; **encerrar o caso exige** concluir as tarefas obrigatórias do modelo (configurável por tenant, com justificativa para exceção).
- **Entrevistas** (`Interview`): entrevistado (testemunha, citado, denunciante identificado, outro), data, entrevistador, resumo/termo e anexos (gravação, termo assinado). Ficam **restritas ao comitê do caso** — nunca visíveis ao denunciante — e exibem lembrete de sigilo e não retaliação.
  - 🆕 **Gravação de entrevista** é dado pessoal sensível (a voz identifica) e só ocorre com **consentimento livre e informado do entrevistado, registrado antes de gravar** (`recordingConsentAt`, texto de aviso com finalidade, base legal, retenção e direitos); sem consentimento, registra-se apenas resumo/termo. O entrevistado pode recusar sem prejuízo.
  - **Retenção específica** da gravação (`recordingRetentionUntil`, padrão: descartar após aprovação do termo/transcrição, no máximo o prazo do caso), com descarte auditado; a gravação **não** é enviada a terceiros nem entra no dossiê por padrão.
  - **Acesso e download restritos** ao investigador atribuído e ADMIN não impedidos, por URL pré-assinada curta, com auditoria de cada reprodução/download; o entrevistado tem direitos de titular (§5.13) sobre o que disse.
- **Evidências vinculadas**: anexos podem ser associados a tarefas, entrevistas e hipóteses; **linha do tempo unificada** do caso (status, tarefas, entrevistas, mensagens, complementos, anexos).
- **Permissões**: INVESTIGATOR atribuído e ADMIN (não impedidos) criam/editam; AUDITOR lê; conteúdo respeita casos restritos e impedimentos; toda ação é auditada.
- O dossiê pode incluir a investigação (`includeInvestigation`, padrão `false`; restrito a ADMIN/AUDITOR/INVESTIGATOR atribuído).

---

## 6. Experiência por jornada (frontend)

**Público**
- **Landing `/` (ou `/{tenant}`)**: hero, card "Fazer uma denúncia", busca de protocolo, 6 documentos normativos em PDF (Código de Ética, Política de Fornecedores, Anticorrupção, Licitações, PLD/FTP, Assédio), garantias (anonimato, sigilo, sem retaliação), contato, 🆕 contato do DPO e link para requisição do titular (DSAR), rodapé; logo/cores vêm do branding do tenant; 🆕 acessível (WCAG 2.1 AA) e multi-idioma.
- **`/nova-denuncia`**: checkbox de anonimato; dados do denunciante só se não anônima; título, categoria, prioridade, departamento, descrição, acusado (obrigatório), testemunhas, data e local do fato, upload múltiplo de anexos com validação de tamanho/tipo; 🆕 **aviso de identificação por conteúdo** com checklist de boas práticas (generalizar horários/locais, evitar detalhes que só o denunciante conheceria, não incluir dados pessoais em arquivos, usar rede segura), revisão do texto antes do envio e reconhecimento obrigatório nas denúncias anônimas (§5.2.1). Validação no cliente com mensagens em toast.
- **`/denuncia-confirmada?protocol=`**: mostra o **protocolo + chave de acesso (exibida uma única vez, com botão de copiar/imprimir e confirmação "guardei minha chave")** e orienta guardá-los.
- **`/acompanhar`**: consulta por protocolo **+ chave** (ver 5.2.2), linha do tempo, prazos e 🆕 **caixa de mensagens** para responder ao comitê e anexar arquivos.

**Autenticado**
- **`/login`** e **`/{tenant}/login`** → `/dashboard` (🆕 com etapa de MFA e botão de SSO); **`/loginadm`** → área SUPER_ADMIN (MFA obrigatório).
- **Menu lateral por perfil** (ex.: Usuários, Configurações, Integrações e SSO só para ADMIN). Sem sessão → redireciona ao login. Sessão persiste com renovação automática (cookies httpOnly); 🆕 página "Minha conta" com MFA e sessões ativas.
- **`/dashboard`**: KPIs + gráficos + recentes + 🆕 indicadores de SLA; **`/denuncias`**: lista com filtros/busca/paginação (🆕 filtro de SLA e tags); **`/denuncias/[id]`**: detalhes, timeline, 🆕 abas **Notas internas / Mensagens ao denunciante / Complementos / Investigação (plano, tarefas, entrevistas)**, anexos (🆕 com status de varredura), dossiê, alterar status (modal com motivo ≥ 10 chars; 🆕 conclusão obrigatória ao encerrar), atribuir investigador (ADMIN), 🆕 declarar impedimento, 🆕 marcar restrito e conceder acesso, 🆕 revelar identidade (quebra de vidro com justificativa), 🆕 casos relacionados (o relato original é exibido somente leitura); **`/usuarios`**: CRUD e suspensão manual (ADMIN); 🆕 **`/conflitos`**: suspeitas de conflito de interesses pendentes (ADMIN não suspeito); 🆕 **`/relatorios`**; 🆕 **`/auditoria`** (ADMIN/AUDITOR, com verificação da cadeia); 🆕 **`/lgpd`** (DSAR, legal hold, retenção); **`/configuracoes`**: marca, cores, logo, documentos, toggles, 🆕 SLAs, roteamento, domínio próprio, SSO, API keys/webhooks.
- **SUPER_ADMIN**: `/admin/dashboard`, `/admin/empresas`, `/admin/assinaturas`, `/admin/usuarios-internos`, `/admin/auditoria`, `/admin/configuracoes`; qualquer outro perfil que acesse é redirecionado.
- Interface responsiva (mobile-first, 🆕 PWA), tema por tenant, feedback por toasts, estados de carregando/vazio/erro.

---

## 7. Segurança, privacidade e conformidade (requisitos de negócio)

- **Confidencialidade**: PII do denunciante criptografada em repouso **campo a campo** (AES-256-**GCM**, chave por tenant, com rotação); o texto do relato é protegido por criptografia do banco/storage, RLS e auditoria (opt-in de cifra de conteúdo em §5.2.1); anonimato real (nenhum vínculo a usuário, 🆕 nenhum IP/user-agent guardado, 🆕 metadados de anexos removidos); respostas públicas mínimas; 🆕 identidade de denunciante identificado revelada apenas por quebra de vidro auditada; 🆕 e-mails sem conteúdo sensível.
- **Integridade**: SHA-256 do relato original (🆕 e de cada complemento) e de cada anexo; verificação sob demanda; downloads sempre por URL temporária; nenhuma exclusão física de denúncia; 🆕 **relato original imutável**; 🆕 trilha de auditoria com hash por registro, selos Merkle e **âncora externa obrigatória**, com verificação periódica.
- **Não repúdio**: auditoria de toda leitura/alteração sensível.
- **Contas e sessões**: bcrypt/Argon2; tokens de curta duração em cookies httpOnly; refresh rotativo e revogável; 🆕 MFA obrigatório para perfis internos; 🆕 bloqueio por tentativas; 🆕 SSO/SCIM; 🆕 sessões ativas.
- **Validação estrita**: rejeitar campos não declarados; sanitizar entradas; limitar tamanho de payload e de upload; 🆕 validação de arquivo por magic bytes e antivírus.
- **Isolamento**: filtro por tenant na aplicação **e** 🆕 Row-Level Security no banco; testes automatizados de vazamento entre tenants.
- 🆕 **Operador sem acesso ao conteúdo**: o papel de banco do painel SUPER_ADMIN não lê tabelas de conteúdo (§3); acesso excepcional só por quebra de vidro com dupla aprovação, notificação ao ADMIN do tenant e auditoria no tenant. Teste automatizado comprova a negação.
- 🆕 **Suíte de aceitação do anonimato** (obrigatória no CI; **bloqueia release**): percorre o fluxo anônimo completo — criar denúncia, anexar arquivo, trocar mensagens, consultar, receber atualização de status e encerrar — e verifica que **não existe**, em nenhum lugar, IP, user-agent, cookie persistente, vínculo por `createdBy` nem **timestamp fino** (só horário truncado ao minuto para eventos anônimos), e que **nenhum outro evento correlacionável** — sessão, log de proxy, entrada de fila, registro de auditoria — compartilha o mesmo instante com a denúncia; e que **consultas e exportações da auditoria não expõem o `seq`** de eventos anônimos (§5.10). A verificação cobre **todas as tabelas do banco**, **logs da aplicação**, **logs de proxy/WAF/CDN** (configurados para não registrar IP nas rotas anônimas ou truncá-lo/rotacioná-lo em curto prazo), **storage** (metadados de anexos), **filas e e-mails**. Executada também contra WhatsApp/telefone/áudio quando implementados.
- **LGPD**: minimização (apenas dados necessários), base legal e política de privacidade exibidas, 🆕 DPO visível, direitos do titular (DSAR) com prazo, **retenção de 7 anos** configurável com **job de expurgo/anonimização** e **legal hold**, 🆕 RIPD e registro de incidentes.
- **Não retaliação**: denunciante e testemunhas nunca são expostos ao denunciado; 🆕 **nenhum bloqueio é automático** e o motivo de uma suspensão nunca é exibido ao suspenso; 🆕 conflito de interesses excluído do caso; 🆕 acompanhamento pós-encerramento e canal para reportar retaliação; comentários e dossiês só circulam entre perfis autorizados.
- **Continuidade**: falhas em notificações, e-mails, verificação de conflito e antivírus (não críticas, reprocessadas depois) **não impedem** o registro; o registro da denúncia sempre prevalece (🆕 inclusive com tenant suspenso ou em manutenção).
- **Requisitos não funcionais** 🆕: disponibilidade-alvo ≥ 99,9% (canal público); RPO ≤ 1 h e RTO ≤ 4 h; backups criptografados com teste de restauração periódico; região de dados no Brasil por padrão; teste de intrusão anual e varredura de dependências contínua; observabilidade (logs estruturados sem PII, métricas, alertas); acessibilidade WCAG 2.1 AA; desempenho: consulta/lista p95 < 500 ms.

---

## 8. Dados de demonstração (seed)

Senha de todos: `Demo123!@`

| E-mail | Perfil |
|---|---|
| superadmin@ouvion.com | SUPER_ADMIN |
| admin@empresa.com | ADMIN |
| investigador@empresa.com | INVESTIGATOR |
| denunciante@empresa.com | REPORTER |
| auditor@empresa.com | AUDITOR |

Configurações iniciais: `company_name`, `enable_anonymous_reports`, `max_file_size_mb`, `data_retention_days`, 🆕 `sla_ack_days` (7), `sla_feedback_days` (90), `escalationRecipientEmail` (já verificado no seed de demonstração). 🆕 Em ambiente de demonstração o MFA pode ser desativado por variável de ambiente; **nunca** em produção.

---

## 9. Divergências conhecidas entre a especificação e o código atual

Ao implementar/auditar, tratar estes pontos como **pendências** (a regra desejada está descrita acima). **Todos os itens 🆕 das seções 1–7 também são pendências** e estão priorizados no roadmap (§10).

1. **Multi-tenant não está no `schema.prisma` atual** (só em `schema-additions.prisma` e docs); `SUPER_ADMIN` foi adicionado por migration mas o enum do schema não o inclui; `auth.service` já referencia `user.tenantId`.
2. **Nenhuma consulta filtra por tenant** e o JWT ainda não carrega `tenantId`; middleware/guards de tenant (`tenant.middleware`, `tenant.guard`, `super-admin.guard`) e o módulo `tenant` (branding) constam nos docs mas **não existem em `src/`**.
3. **Upload de anexo exige JWT**, então denunciante **anônimo/sem login não consegue anexar** pelo formulário público — resolver com o token temporário do protocolo (§5.2.1/§5.4).
4. **`includeAuditLog` no dossiê não é restrito** por perfil no código; a regra desejada limita a ADMIN/AUDITOR (§5.5).
5. **Transições de status são livres** (qualquer → qualquer); implementar a máquina de estados (§5.2.7) e usar `ESCALATED`, que existe no enum mas não tem ação na UI.
6. `assignInvestigator` grava `previousStatus = PENDING` fixo no histórico, mesmo que o status anterior fosse outro; deve usar o status real.
7. `GET /settings` é público e devolve **todas** as chaves; expor publicamente só as marcadas `isPublic` (§5.9).
8. **`allowAnonymousComplaints`/`enable_anonymous_reports` e `maintenanceMode` não são aplicados** na criação de denúncia (§5.2.1 define o comportamento).
9. Senha mínima diverge: 8 no cadastro público, 6 no cadastro administrativo — unificar em 8 com a política de §5.1.
10. Usuário é excluído fisicamente e o bloqueio manual/desbloqueio não gera auditoria `BLOCK/UNBLOCK` nem revoga tokens ativos (§5.7).
11. Front (`types/index.ts`, `acompanhar`) usa status/prioridades que **não existem no backend** (`URGENT`, `UNDER_INVESTIGATION`, `IN_ANALYSIS`, `IN_INVESTIGATION`, `CLOSED`, `VIEWER`); alinhar aos enums da seção 4.
12. Telas `/admin/empresas` e `/admin/assinaturas` usam **dados mock**; faltam APIs de tenants/assinaturas e a aplicação dos limites de plano.
13. Digest diário, lembretes de prazo (`DEADLINE_REMINDER`), WebSocket em tempo real, exportação CSV/PDF de relatórios/auditoria e rotina de retenção ainda não têm implementação completa.
14. Retenção (`data_retention_days`) é apenas configuração; não há job de expurgo/anonimização (§5.13).
15. 🆕 **Auto-bloqueio atual bloqueia direto (inclusive por nome) e expõe o motivo no login** (`blockedReason` visível ao bloqueado); **remover o auto-bloqueio** (bloqueio somente manual, §5.6) e usar mensagem genérica (§5.1).
16. 🆕 **Auditoria grava IP/user-agent também em denúncias anônimas**; deve gravar nulo (§5.10).
17. 🆕 Comentários não têm `visibility`; REPORTER vê hoje as análises internas (§5.3.1).
18. 🆕 Consulta pública por protocolo aceita só o protocolo (sem chave) e não existe canal de mensagens com o denunciante (§5.2.2/§5.3.2).
19. 🆕 O relato (título, descrição, envolvidos, testemunhas) é **editável** hoje e o `integrityHash` cobre só `{title, description, type}`; tornar o relato original imutável e ampliar o hash (§5.2.1/§5.2.5).
20. 🆕 Não há separação de dados entre operador e cliente: definir papel de banco do SUPER_ADMIN sem acesso ao conteúdo (§3).
21. 🆕 Auditoria não tem selos nem âncora externa (§5.10) e não há suíte de aceitação do anonimato (§7).

---

## 10. Roadmap de implementação (ordem sugerida)

Cada fase deve entregar código + migrations + testes automatizados (inclusive de autorização/isolamento) + atualização deste documento.

| Fase | Entrega | Refs |
|---|---|---|
| **1. Fundação multi-tenant real** *(primeiro: tudo o mais depende de `tenantId` e RLS)* | Schema de Tenant/Branding; `tenantId` no JWT e em todas as queries; guards/middleware; **RLS**; **fluxo de provisionamento do tenant** (RLS, chave KMS e **`SEQUENCE` de auditoria**) com teste; **papel de banco do SUPER_ADMIN sem acesso a conteúdo** + teste; testes de vazamento entre tenants; status do tenant aplicado (suspenso bloqueia o login da equipe, mas o canal público continua recebendo); DPA/controlador×operador. Tenants criados por script/CLI interno. *(APIs/telas reais de empresas e assinaturas e limites de plano **saem daqui** e vão para a fase 8: não bloqueiam nada técnico.)* | §3, §9 (1, 2, 20) |
| **2. Privacidade — núcleo** *(sobre a fundação)* | **Remoção do auto-bloqueio** (suspensão só manual) + mensagem genérica; `visibility` de comentários; **chave de acesso** na consulta pública; **relato original imutável** + `ComplaintAddendum` + hash ampliado; configurações públicas filtradas (`isPublic`); **auditoria sem IP/UA** (e timestamp truncado) para anônimos; **aviso de identificação por conteúdo**; **suíte de aceitação do anonimato** (nasce aqui e cresce a cada canal). Correções pontuais baratas: política de senha única, `includeAuditLog` restrito, status anterior real no histórico | §5.1, 5.2, 5.3, 5.5, 5.6, 5.9, §7, §9 |
| **2b. Conflito de interesses e acesso restrito** *(subprojeto próprio; **pré-requisito para o primeiro tenant em produção**, pois sem ele uma denúncia contra os próprios ADMINs não tem destino)* | Suspeita de conflito + impedimento + **anti-paralisia**; **acesso externo do destinatário alternativo** (link único + 2º fator, escopo de um caso) e onboarding com destinatário verificado e 2º fator enrolado; casos restritos e concessões; **identidade do denunciante por quebra de vidro**; testes "todos os ADMINs citados" e de acesso externo | §3, §5.2.4, 5.2.9, 5.2.10 |
| **3. Canal seguro do denunciante** | Chat protocolo + chave; token temporário de sessão do protocolo; upload de anônimo; rate limits específicos; mensagens automáticas de status | §5.2.1–5.2.2, 5.3.2, 5.4 |
| **4. Segurança de contas, arquivos e prova** | MFA (TOTP/passkeys), bloqueio por tentativas, cookies httpOnly, sessões ativas, antivírus, magic bytes, remoção de metadados, criptografia GCM de PII por tenant, **auditoria com hash por registro + selos Merkle + âncora externa obrigatória** | §5.1, 5.4, 5.10, §7 |
| **5. Processo e gestão da investigação** | Máquina de estados + `ESCALATED`, SLAs e alertas, **plano/tarefas/entrevistas/checklists e modelos por tipo**, conclusão estruturada, acompanhamento de retaliação, prioridade automática, roteamento, casos relacionados, relatórios gerenciais | §5.2.7, 5.2.10, 5.11, 5.12, 5.14, 5.16 |
| **6. Canais de volume: WhatsApp, 0800 e áudio** *(antecipado: é o que dá volume ao canal)* | WhatsApp, telefone/0800, áudio com transcrição, QR Code, e-mail dedicado; avisos de limite de anonimato por canal; extensão da suíte de anonimato | §5.15, §7 |
| **7. Retenção e LGPD** | Job de expurgo/anonimização, legal hold, DSAR (roteado ao controlador), RIPD, exportação de tenant, desativação em vez de exclusão de usuários | §5.7, 5.13 |
| **8. Enterprise e integrações** | **APIs e telas reais de empresas/assinaturas** (sem mock) e **limites de plano** (`maxUsers` bloqueante; denúncias excedentes cobráveis, nunca bloqueadas); SSO (SAML/OIDC) + SCIM, domínio próprio + TLS, API keys + webhooks, Slack/Teams/Jira/SIEM, cobrança integrada, PWA/push, i18n | §3, 5.1, 5.15, §9 (12) |
| **9. IA assistiva e workflow configurável** | IA com decisão humana (triagem, resumo, duplicidade, alerta de conteúdo identificador), workflow configurável, campanhas de divulgação | §5.15 |

**Critérios de pronto (transversais):** toda regra 🆕 tem teste automatizado; a **suíte de aceitação do anonimato** passa no CI antes de qualquer release; testes específicos: **"todos os ADMINs citados"** (não paralisa o comitê), **SUPER_ADMIN sem acesso a conteúdo**, **relato original imutável** e **vazamento entre tenants**; nenhuma rota nova sem RBAC e filtro de tenant; nenhum log com PII; toda ação sensível gera auditoria; migrations reversíveis; documentação atualizada; revisão de segurança (`/security-review`) ao final de cada fase.
