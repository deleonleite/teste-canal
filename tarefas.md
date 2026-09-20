PROMPT — OuviON · Painel Administrativo (SUPER_ADMIN)

Complementa os documentos de Regras de Negócio, Arquitetura Técnica e Design System. Descreve o painel interno usado exclusivamente pela equipe da OuviON (operador da plataforma) para gerir tenants, assinaturas, equipe interna, auditoria de plataforma e configurações globais.

Este painel é revisão de uma versão existente (majoritariamente com dados mock, conforme §9 item 12 do documento de negócio). A revisão corrigiu um conflito com a garantia central do §3 da Arquitetura — operador sem acesso a conteúdo de denúncia — e alinhou MFA, senha de seed e tokens visuais aos demais documentos. Onde este documento diverge da implementação atual, a implementação atual é a pendência, não o contrário.

0. Princípio que rege todo este painel

Este painel é usado por vocês, equipe da OuviON — e é exatamente por isso que ele é o lugar onde a garantia "o operador não acessa conteúdo de denúncia" (doc de negócio §3; Arquitetura §5.3/§6.3) é testada de verdade. Não é uma regra para proteger o cliente de um terceiro hipotético; é uma regra sobre o que a própria equipe interna pode e não pode ver por padrão. Nenhuma tela, perfil ou permissão deste painel pode conceder, por padrão, leitura ou escrita de Complaint, Attachment, ComplaintMessage, ComplaintComment, Dossier, Interview ou identidade de denunciante — em nenhum tenant. A única exceção é o fluxo de quebra de vidro (§5), sempre pontual, auditado e notificado ao tenant.

1. Acesso ao painel

URL de login: /loginadm — login completamente separado do login de tenants, nunca compartilha formulário, endpoint ou espaço de cookie com /{slug}/login.

Fluxo de autenticação (dois fatores, sem exceção):

E-mail + senha (Argon2id, mesma política de senha do §5.1 do doc de negócio).
Segundo fator obrigatório — TOTP ou passkey — antes de qualquer sessão ser emitida. Não existe toggle de configuração que desative isso (diferente do que a versão anterior sugeria com require2FA como opção da plataforma); para perfis internos (SUPER_ADMIN, SUPPORT, FINANCIAL) o segundo fator é regra fixa, no mesmo nível do que o doc de negócio já exige para ADMIN/INVESTIGATOR/AUDITOR de tenant.
Qualquer perfil que não seja interno da plataforma é rejeitado com "Acesso restrito à equipe OuviON", e a tentativa é auditada (loginType: PLATFORM).

Seed de demonstração (ambiente de staging/dev apenas, nunca produção): superadmin@ouvion.com / Demo123!@ — mesma senha padrão usada no seed dos demais perfis (doc de negócio §8), para não haver duas convenções de senha de demo no projeto. Em produção, o primeiro SUPER_ADMIN é criado por script operacional fora da aplicação, com senha forçada a ser trocada e MFA cadastrado no primeiro acesso.

2. Perfis internos e permissões

Três perfis, cada um com escopo estritamente necessário — nenhum deles inclui acesso a conteúdo de tenant:

Perfil	Quem é	Pode	Não pode
SUPER_ADMIN	Sócios/liderança técnica da OuviON	Tudo deste painel; acionar quebra de vidro (com segundo aprovador)	Ler conteúdo fora de uma sessão de quebra de vidro ativa
SUPPORT	Equipe de suporte ao cliente	Ver dados operacionais do tenant (plano, contagem de usuários, contagem de denúncias, status de conta, tickets de suporte); solicitar quebra de vidro (precisa de aprovação de um SUPER_ADMIN)	Ler ou editar denúncia, anexo, mensagem, comentário, dossiê ou identidade de denunciante de qualquer tenant, mesmo com o próprio pedido pendente de aprovação; resetar senha de usuário de tenant (isso é ação do ADMIN daquele tenant, §5.7 do doc de negócio)
FINANCIAL	Equipe financeira	Ver e gerenciar billing, planos, faturas, inadimplência	Tudo que envolva conteúdo de denúncia; não vê nem Empresas além do necessário para faturamento

Isso substitui a versão anterior, em que SUPPORT tinha VIEW_COMPLAINTS/MANAGE_COMPLAINTS diretamente — essas duas permissões saem do papel e viram, quando necessárias, uma solicitação de quebra de vidro (§5), nunca acesso de bandeja.

Alerta de segurança (mantido da versão anterior, texto ajustado): banner fixo em /admin/usuarios-internos — "Usuários internos têm acesso privilegiado à operação da plataforma. Nenhum perfil interno acessa conteúdo de denúncia por padrão — isso só ocorre por quebra de vidro auditada e notificada ao cliente."

3. AdminLayout
Sidebar fixa, 6 itens (mesma estrutura da versão anterior, mantida): Dashboard, Empresas, Assinaturas, Usuários Internos, Auditoria, Configurações Globais.
Segue os mesmos tokens do Design System (§2–§4 daquele documento) — sem gradiente em card, sem sombra colorida/glow. A versão anterior descrevia "cards com gradientes coloridos"; isso é substituído por cards planos com uma borda superior de 2px na cor semântica correspondente (ex.: borda âmbar em card de alerta de churn), consistente com o resto do produto.
Nenhuma cor fora da paleta definida. O badge de plano ENTERPRISE, descrito antes como "dourado", passa a usar um token novo e documentado: --plan-enterprise: #8A6D1F (dourado escurecido para contraste ≥ 4.5:1 em texto branco), adicionado à tabela de tokens do Design System como exceção explícita — não uma cor ad-hoc solta na implementação.
Header com identificação do operador logado e dropdown de logout; nenhuma informação de tenant específico aparece fora das telas que tratam de tenant.
4. Telas
4.1 Dashboard (/admin/dashboard)

Visão executiva consolidada — dados agregados e operacionais, nunca conteúdo de denúncia:

8 cards de métrica: MRR, ARR, total de empresas, novos clientes no mês, churn rate, LTV médio, total de usuários na plataforma, contagem de denúncias no mês (número, nunca detalhe).
Gráficos: MRR últimos 6 meses (linha), distribuição de planos (barra), status das empresas (pizza) — seguindo o estilo definido no Design System §5.5 (plano, sem gradiente, paleta semântica).
Tabela das 5 empresas mais recentes: nome, plano, status, MRR, data de criação — sem nenhuma coluna de denúncia além da contagem.
Fonte de dado: enquanto a API real (fase 1 do roadmap) não estiver pronta, a tela roda com dado mock identificado visualmente (ex.: rótulo discreto "dados de demonstração"), nunca apresentado como métrica real sem essa marcação.
4.2 Empresas / Tenants (/admin/empresas)
Cards de estatística (ativas/trial/suspensas/canceladas), filtros por status/plano, busca por nome/slug/e-mail — mantidos da versão anterior.
Tabela: Empresa, Slug, Plano, Status, Usuários, Denúncias (contagem), MRR, Criada em, Ações.
Modal "Nova Empresa": nome, slug, e-mail do ADMIN inicial, plano — dispara o fluxo de onboarding do §3 da Arquitetura (verificação de escalationRecipientEmail, MFA do primeiro ADMIN, DPO informado) antes do tenant poder ficar ACTIVE, não só a criação do registro.
4.2.1 Provisionamento de acesso do ADMIN do tenant

O modal "Nova Empresa" cria o registro do tenant e do primeiro usuário ADMIN, mas a forma como esse ADMIN recebe a credencial inicial precisa de uma decisão explícita — não é um detalhe implícito do formulário. Duas opções ficam disponíveis, com o convite por link como padrão:

Opção padrão — convite por link (recomendada para todo cadastro comercial normal):

Ao salvar o modal, o sistema não define senha nenhuma. Gera um token de convite de uso único, validade curta (72h), e envia ao adminEmail informado.
O ADMIN abre o link, define a própria senha (política do §5.1 do doc de negócio) e cadastra MFA — tudo nesse primeiro acesso, antes de qualquer outra tela ficar disponível.
Na sequência do mesmo fluxo (sem exigir uma segunda sessão), o sistema conduz o restante do onboarding já especificado na Arquitetura §3: verificação do escalationRecipientEmail e cadastro do DPO. Só depois desses três passos o tenant sai de TRIAL e vai para ACTIVE.
A OuviON nunca chega a conhecer a senha do ADMIN em nenhum momento deste fluxo — nem temporária, nem de qualquer forma. É a opção que sustenta, sem ressalva, a mesma garantia de "operador não acessa o que é do cliente" que rege o resto deste documento.
Se o token expirar sem uso, o SUPER_ADMIN reenvia o convite (novo token, mesmo e-mail) pela tela de detalhe da empresa — nunca reaproveitando o token antigo.

Opção alternativa — senha temporária definida pelo SUPER_ADMIN (uso excepcional: onboarding assistido por telefone, cliente sem acesso imediato ao e-mail cadastrado, migração de outro sistema):

O SUPER_ADMIN define uma senha temporária no próprio modal, marcada como mustChangePassword = true.
A senha é exibida uma única vez na tela (mesmo padrão da chave de acesso do denunciante, doc de negócio §5.2.1) — não fica salva em lugar nenhum em texto legível depois disso, nem no banco (hash desde o primeiro instante).
O primeiro login do ADMIN com essa senha força a troca imediata e o cadastro de MFA antes de liberar qualquer outra tela — sem esse passo, a sessão não avança.
Essa opção é registrada em PlatformAuditAction (TENANT_ADMIN_TEMP_PASSWORD_ISSUED) com o motivo da exceção, porque é o único ponto do sistema em que alguém da OuviON chega a ter contato, ainda que breve e não-persistido, com uma credencial de acesso do cliente — e isso deve ficar visível na trilha de auditoria de plataforma, para revisão periódica de uso.
Uma vez trocada pelo ADMIN, essa senha deixa de existir; nenhum SUPER_ADMIN consegue vê-la novamente nem recuperá-la.

A opção alternativa existe porque casos reais de venda/onboarding nem sempre cabem no fluxo ideal — mas ela é a exceção documentada e auditada, não o caminho padrão. A tela deve apresentar o convite por link como escolha pré-selecionada, exigindo um clique consciente para trocar para a senha temporária.

Botão "Solicitar acesso de suporte" na página de detalhe da empresa (novo, substitui o acesso implícito que SUPPORT tinha antes): abre o fluxo de quebra de vidro (§5) escopado àquele tenant. Visível para SUPER_ADMIN e SUPPORT; para SUPPORT, o botão só solicita, não concede.
Ação "Suspender/Reativar" aqui é suspensão comercial do tenant (TenantStatus), diferente da suspensão de usuário (§5.6 do doc de negócio) — o canal público do tenant suspenso continua recebendo denúncias, conforme §3 da Arquitetura.
4.3 Assinaturas (/admin/assinaturas)

Mantido como descrito na versão anterior (métricas de MRR/ARR/ticket médio/churn, abas Assinaturas/Transações, exportação CSV) — nenhuma mudança de acesso a conteúdo aqui, é dado puramente financeiro. Único ajuste: taxa de conversão e LTV são calculados sobre dados de billing, nunca cruzados com tipo ou volume de denúncia por categoria (evitar qualquer relatório interno que correlacione receita a tipo de denúncia de um cliente específico — não é vedação técnica, é vedação de propósito, e vale deixar escrita para quem for construir a query).

4.4 Usuários Internos (/admin/usuarios-internos)
Cards de estatística por perfil, tabela (usuário, perfil, status, último acesso, permissões, membro desde, ações) — mantidos.
Coluna "Permissões" reflete a tabela do §2 deste documento, não a lista antiga que incluía VIEW_COMPLAINTS/MANAGE_COMPLAINTS em SUPPORT.
Modal "Novo Usuário Interno": nome, e-mail corporativo, perfil, senha temporária — e cadastro de MFA obrigatório no primeiro login, não opcional.
Reset de senha de usuário interno (da OuviON) continua aqui; reset de senha de usuário de tenant não existe nesta tela — é responsabilidade do ADMIN daquele tenant.
4.5 Auditoria (/admin/auditoria)

Duas trilhas distintas, não uma só — a versão anterior misturava as duas:

Auditoria de plataforma (esta tela): eventos que acontecem no próprio painel administrativo — login de operador, criação/suspensão de tenant, mudança de plano, criação de usuário interno, mudança de configuração global, e toda concessão/uso de quebra de vidro. Usa um enum próprio, PlatformAuditAction (LOGIN, TENANT_CREATED, TENANT_SUSPENDED, PLAN_CHANGED, SUBSCRIPTION_PAYMENT, INTERNAL_USER_CREATED, SETTINGS_CHANGED, BREAK_GLASS_REQUESTED, BREAK_GLASS_APPROVED, BREAK_GLASS_USED), separado do AuditAction do tenant definido no documento de negócio — os dois nunca se confundem porque vivem em bancos/escopos diferentes (§6.3 da Arquitetura).
Auditoria do tenant: já especificada no doc de negócio (§5.10) e na Arquitetura (§10) — vive nas tabelas de cada tenant, com rowHash/selo/âncora, e não é visível nesta tela. Um SUPER_ADMIN não navega a auditoria de conteúdo de um tenant por aqui; se precisar (ex.: investigar um incidente reportado pelo próprio cliente), o acesso passa pelo mesmo fluxo de quebra de vidro, e mesmo assim só ao necessário para o incidente, nunca a uma listagem livre.
Severidade (LOW/MEDIUM/HIGH/CRITICAL), timeline expansível, detalhes técnicos (IP, user-agent, timestamp) e JSON de detalhes — mantidos como descrito antes.
Toda linha de BREAK_GLASS_* aparece já com destaque visual próprio (borda --status-warning), porque é a categoria de evento que mais precisa de revisão humana recorrente, não só existir na lista.
4.6 Configurações Globais (/admin/configuracoes)

Mantidas as 6 abas (Geral, Segurança, Trial, Limites & Quotas, E-mail/SMTP, Pagamento), com dois ajustes:

Aba Segurança: require2FA deixa de ser toggle — texto passa a ser informativo, não editável: "MFA é obrigatório para todos os perfis internos e para ADMIN/INVESTIGATOR/AUDITOR de qualquer tenant. Esta política não é configurável." O que continua configurável de verdade: tamanho mínimo de senha, tentativas de login, timeout de sessão, whitelist de IP para SUPER_ADMIN.
Aba Limites & Quotas: os valores aqui (maxUsers, maxComplaintsPerMonth, armazenamento, upload) são explicitamente rotulados como "padrões aplicados a tenants novos por plano", não um teto único da plataforma — cada tenant tem seus próprios maxUsers/maxComplaintsPerMonth (doc de negócio §3), editáveis individualmente na tela de detalhe da empresa (§4.2). Esta aba edita o default do plano, não sobrescreve tenant existente.
Banner de alerta ("Configurações Críticas — afetam toda a plataforma"), botão salvar com os três estados (normal/salvando/salvo) — mantidos como descrito antes.
Aba Pagamento (chaves Stripe mascaradas, moeda, taxa) — mantida sem alteração de acesso.
5. Quebra de vidro (break-glass) — fluxo completo

Este é o único caminho legítimo para qualquer pessoa da OuviON acessar conteúdo de um tenant, e existe precisamente para que o painel acima nunca precise conceder isso por padrão.

Solicitação: SUPPORT (ou SUPER_ADMIN agindo em nome de um chamado) abre o pedido a partir da tela de detalhe da empresa (§4.2), com: tenant, escopo exato (ex.: "um dossiê específico", "um anexo que não baixa"), motivo, e referência do chamado de suporte.
Aprovação: exige um segundo SUPER_ADMIN, diferente de quem solicitou, com MFA validado nos últimos minutos.
Janela: acesso concedido por no máximo 1 hora, escopado ao recurso pedido — nunca "acesso ao tenant", sempre ao item específico.
Notificação imediata ao ADMIN do tenant afetado, com o motivo e quem acessou.
Auditoria dupla: o evento fica em PlatformAuditAction (visível ao SUPER_ADMIN, §4.5) e em AuditAction do próprio tenant (BREAK_GLASS_PLATFORM, visível ao ADMIN/AUDITOR daquele tenant) — o cliente nunca fica sem saber que isso aconteceu no próprio ambiente dele.
Revogação automática ao fim da janela, sem exceção manual de prorrogação silenciosa — nova prorrogação exige novo pedido, com novo registro.

Esta é a mesma mecânica já descrita na Arquitetura §3/§7 — o painel administrativo é onde ela ganha interface, não onde a regra é reinventada.

6. Rótulo de pendência

Como no documento de negócio, cada tela acima que hoje roda sobre dado mock (Dashboard, Empresas, Assinaturas — conforme §9 item 12 do doc de negócio) deve exibir um indicador visual discreto de "dados de demonstração" até a API real (fase 1 do roadmap técnico) estar no ar, para que ninguém — interno ou em demonstração a um cliente — confunda mock com operação real.
