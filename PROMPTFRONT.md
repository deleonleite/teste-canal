PROMPT — OuviON · Design System e UX Writing

Complementa os documentos de Regras de Negócio e Arquitetura Técnica. Define identidade visual, tokens, componentes, navegação, densidade, estilo de gráficos e todo o texto de interface sensível (avisos, erros, vazios). Implementado sobre packages/ui (Tailwind + shadcn/ui + Radix), conforme §9.4 da Arquitetura.

0. Princípio central

O OuviON não é um produto que precisa "impressionar" — é um produto em que alguém, possivelmente assustado, decide se confia o suficiente para apertar "enviar". Toda decisão de design se subordina a um critério: reduzir a ansiedade de quem relata e transmitir seriedade a quem investiga, nessa ordem. Isso descarta, de saída, qualquer linguagem visual "SaaS animado" (gradientes vibrantes, ilustrações fofas, confete, micro-interações lúdicas) e qualquer linguagem "institucional fria" (formulário de cartório, jargão jurídico sem tradução). O tom-alvo é calmo, direto e humano, sem ser informal.

Isso vale tanto para a casca visual quanto para o texto: um aviso de erro que soa acusatório ("Requisição inválida") é tão ruim quanto uma cor ansiosa demais.

1. Identidade visual: shell neutro + branding do tenant

O produto vive em dois modos simultâneos, e o design system precisa dos dois desde o dia um:

Casca do produto (shell): navegação, tipografia estrutural, ícones, espaçamento, componentes de dado (tabelas, badges de status, gráficos) — não muda por tenant. É a identidade do OuviON.
Camada de marca (branding): cor primária/secundária, logo, favicon, plano de fundo do login, e opcionalmente customCss — muda por tenant, conforme §3 do documento de negócio.

A regra prática: cor de marca só aparece em elementos de ação e destaque (botão primário, link ativo, ícone de destaque no ícone do menu, barra de progresso da linha do tempo). Nunca em superfícies grandes (fundo de página, fundo de card, fundo de tabela) e nunca em cores semânticas (sucesso, erro, alerta, prioridade) — essas são fixas do shell e não são sobrescrevíveis pelo tenant, porque um primaryColor vermelho de marca não pode virar, sem querer, a cor de "prazo vencido".

1.1 Verificação automática de contraste do branding

Quando o ADMIN define primaryColor/secondaryColor, o backend calcula o contraste (WCAG) contra branco e contra o texto que será sobreposto (botão com texto branco, por exemplo). Se o contraste for insuficiente (< 4.5:1 para texto normal), a UI:

mostra um aviso não bloqueante ("Esta cor pode dificultar a leitura para algumas pessoas — sugerimos um tom mais escuro/claro");
aplica automaticamente uma variante ajustada só para textos sobre a cor (nunca altera a cor decorativa em si), preservando a marca do cliente sem quebrar acessibilidade.

Isso evita o cenário mais comum de SaaS white-label: cliente escolhe um amarelo institucional e o botão "Enviar denúncia" fica ilegível.

2. Paleta base (shell)

Neutros com leve tom frio (não é preto puro nem cinza morto — ajuda a diferenciar áreas sem parecer clínico demais):

Token	Light	Dark	Uso
--bg-canvas
#F7F8FA
#0E1116	fundo da página
--bg-surface
#FFFFFF
#161A21	cards, tabelas, modais
--bg-surface-sunken
#EEF0F3
#1D222B	áreas de destaque secundário (ex.: bloco de citação, nota interna)
--border-default
#E2E5EA
#262B35
--text-primary
#14181F
#F2F4F7
--text-secondary
#5B6474
#9AA3B2
--text-tertiary
#8B93A1
#6B7383	timestamps, metadados

Cores semânticas fixas, nunca sobrescritas pelo tenant:

Papel	Cor	Uso
--status-success
#1B8A5A verde	resolvida (procedente tratado), CLEAN de antivírus
--status-danger
#C2372B vermelho	prazo vencido, INFECTED, erro
--status-warning
#B7791F âmbar (nunca amarelo puro — falha de contraste comum)	prazo próximo do vencimento, PENDING de varredura
--status-info
#2563A8 azul	em investigação, informativo
--status-neutral	cinza --text-secondary	arquivada, descartada, cancelada
--priority-critical
#8B1E1E vermelho escuro	prioridade CRITICAL — deliberadamente mais escuro que danger para não confundir com "erro do sistema"
--priority-high
#C2372B
--priority-medium
#B7791F
--priority-low	--text-secondary cinza	prioridade baixa não compete visualmente por atenção

Paleta testada em simulador de daltonismo (protanopia/deuteranopia) — por isso status nunca depende só da cor: todo badge de status/prioridade/SLA leva também um ícone e/ou texto, nunca uma bolinha colorida sozinha (requisito direto do WCAG 2.1 AA do documento de negócio).

Modo escuro: suportado desde o início, não como adição posterior — parte relevante do público (investigador respondendo fora do horário, denunciante em ambiente que precisa de discrição) usa dispositivo com tema escuro por padrão do sistema, e obrigar o modo claro nesse contexto é uma fricção evitável.

3. Tipografia
Interface (shell): Inter (variável), via next/font, self-hosted (nunca CDN externo de fonte — consistente com a política de rede/segurança do documento de negócio e evita dependência externa desnecessária). É a fonte de UI mais testada em legibilidade de tabela densa e números, essencial aqui (protocolo, datas, contagens).
Conteúdo longo (relato, PDF do dossiê): mesma Inter, mas com line-height maior (1.6) e largura de coluna limitada (max-width: 68ch) — o relato de uma denúncia é o texto mais importante do produto e precisa ser lido com conforto, não espremido numa tabela.
Monoespaçada (JetBrains Mono ou ui-monospace do sistema): reservada a protocolo (DEN-2026-A1B2C3), chave de acesso, hashes SHA-256 na tela de verificação de integridade — números e códigos alinham melhor e ficam inconfundíveis com texto comum.

Escala tipográfica (rem, base 16px):

Nome	Tamanho	Peso	Uso
display	2.25rem / 36px	600	título da landing, "Denúncia registrada"
h1	1.5rem / 24px	600	título de página autenticada
h2	1.25rem / 20px	600	título de seção/card
h3	1.0625rem / 17px	600	título de subseção, cabeçalho de tabela agrupado
body	0.9375rem / 15px	400	texto padrão — não 16px: densidade de compliance pede um corpo levemente menor sem sacrificar legibilidade
body-sm	0.8125rem / 13px	400	metadados, legendas, texto auxiliar
mono	0.875rem / 14px	500	protocolo, chave, hash
4. Tokens de espaço, raio e elevação
Grid de espaço: escala em base 4 (4, 8, 12, 16, 24, 32, 48, 64) — nada fora da escala, para eliminar decisão ad-hoc de "esse padding fica 14px".
Raio: --radius-sm: 6px (badges, inputs), --radius-md: 10px (cards, botões), --radius-lg: 16px (modais, painel de destaque). Sem cantos totalmente retos (parece burocrático demais) nem excessivamente arredondados (parece consumer app demais) — o meio-termo é deliberado.
Elevação: sombras discretas (0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.08) para modal), nunca sombra colorida ou "glow" — o produto não usa efeito decorativo que possa parecer promocional.
Motion: transições de 120–180ms, ease-out; nenhuma animação de entrada em listas de denúncia ou notificação de novo caso — um card "pulando" na tela para avisar de um relato de assédio é tonalmente errado. Motion é usado só em affordance de interação (hover, abrir/fechar), nunca para chamar atenção a conteúdo sensível.
5. Componentes-chave
5.1 Badges de status, prioridade e SLA

Formato: pílula com ícone + texto, nunca só cor.

[●IconClock] Pendente        [●IconEye] Em investigação
[●IconCheck] Resolvida       [●IconArchive] Arquivada
[▲] Prioridade crítica       [–] Prioridade baixa
[⏱ 2 dias restantes]  [⚠ Vence hoje]  [⛔ Vencido há 3 dias]

Badge de SLA usa texto relativo ("vence em 2 dias"), não só data absoluta — reduz carga cognitiva de quem olha uma lista de 40 casos.

5.2 Timeline (linha do tempo do caso)

Componente vertical único, reutilizado em três contextos com densidade diferente:

/acompanhar (público): só marcos macro (Pendente → Investigação → Análise → Resolvida), linguagem simples, sem jargão interno, sem timestamps de segundo — dia e hora aproximada.
/denuncias/[id] (comitê): timeline unificada (status + tarefas + entrevistas + complementos + anexos + mensagens), densa, com filtro por tipo de evento.
Dossiê (PDF): timeline estática, só histórico de status com motivo — a mesma estrutura de dados, apresentação impressa.
5.3 Tabelas
Cabeçalho fixo (sticky) ao rolar.
Linha zebrada desligada por padrão (listras competem visualmente com os badges de status coloridos); usar separador de 1px entre linhas.
Coluna de protocolo sempre em fonte mono, sempre a primeira coluna, sempre clicável.
Ação em linha (menu de "⋯") em vez de botões múltiplos visíveis — reduz ruído em tabela de compliance, que já é densa em badges.
5.4 Formulário de nova denúncia

É o componente mais importante do produto e o único com layout de página inteira, sem sidebar, sem distração — só o formulário, um indicador de progresso por etapa (Anonimato → Dados do fato → Envolvidos → Anexos → Revisão) e uma barra fixa no rodapé com "Voltar / Continuar". Nada de navegação lateral competindo pela atenção de quem está prestes a relatar algo grave.

5.5 Gráficos

Decisão de estilo: minimalista, plano, sem 3D, sem gradiente, sem sombra em barra/fatia, paleta restrita às cores semânticas já definidas (nunca uma paleta "arco-íris" genérica de biblioteca de gráfico). Biblioteca: Recharts (mencionada como disponível na stack de artifacts/frontend), com tema custom aplicando os tokens acima.

Barra (volume por tipo/departamento): barras horizontais quando há mais de 5 categorias (nomes de tipo de denúncia são longos em português — rótulo horizontal não trunca).
Pizza/rosca (distribuição por prioridade): usada com parcimônia — só onde a pergunta é literalmente "qual fatia do todo", nunca para mais de 5 fatias (a partir daí, vira ilegível e devia ser barra).
Linha (evolução mensal): linha única ou até 3 séries, nunca área preenchida com gradiente — área preenchida em dado de compliance parece dashboard de marketing.
Sem tooltip decorativo excessivo: tooltip mostra número exato, sem animação de zoom.
Todo gráfico tem uma versão tabular alternativa (toggle "ver como tabela"), requisito de acessibilidade e também útil para quem quer copiar os números.
6. Navegação — decisão

Sidebar fixa e recolhível, não menu superior, para a área autenticada (/dashboard, /denuncias, etc.). Justificativa: o comitê passa horas dentro do produto navegando entre casos, filtros e configurações — navegação lateral persistente reduz o custo de "onde eu estava" a cada troca de tela, e o item ativo fica sempre visível como orientação espacial. Comportamento:

Expandida por padrão em telas ≥ 1280px, mostrando ícone + rótulo.
Recolhida a só-ícone (com tooltip no hover) em telas entre 1024–1280px, ou quando o usuário recolhe manualmente — preferência persiste por usuário (não por sessão).
Vira gaveta (drawer) sobreposta abaixo de 1024px, incluindo mobile/PWA do comitê.
Itens do menu são exatamente os grupos de perfil do §6 do documento de negócio (Usuários, Configurações, Integrações e SSO só aparecem para ADMIN — item que não pertence ao perfil não aparece riscado nem cinza, simplesmente não existe na lista, para não sugerir "isso existe mas eu não posso" numa ferramenta de compliance onde a própria existência de uma função pode ser informação sensível).

O canal público (/, /nova-denuncia, /acompanhar) usa uma barra superior minimalista (logo do tenant + link "Consultar protocolo" + seletor de idioma), sem sidebar — é conteúdo para visitante ocasional, não para uso recorrente.

7. Densidade de tabelas — decisão

Duas densidades, alternável pelo usuário (persistida em preferência, não em cookie de sessão):

Confortável (padrão): altura de linha 48px, usada por padrão porque a maioria das sessões do comitê é de leitura/triagem cuidadosa, não de scanning veloz — em compliance, ler errado uma linha tem custo maior que em outros produtos.
Compacta: altura de linha 36px, para AUDITOR/ADMIN fazendo triagem de volume alto ou exportação visual de muitos casos.

Não existe densidade "ultra compacta" — abaixo de 36px, badge com ícone + texto de status não cabe legível, e não vamos sacrificar clareza de status por densidade.

8. UX Writing — tom de voz e textos-padrão
8.1 Dois registros de voz, um produto
Voz para o denunciante (canal público, /acompanhar, mensagens automáticas): calma, protetora, sem jargão jurídico, frases curtas, sempre em segunda pessoa quando faz sentido acolher ("você"), nunca no imperativo seco. Evita qualquer palavra que soe como ameaça velada ou desconfiança ("alegação" tem tom mais neutro que "acusação"; "relato" é preferido a "queixa").
Voz para o comitê (área autenticada): direta, profissional, sem tentar ser "amigável" — quem investiga assédio às 22h não precisa de tom leve, precisa de clareza e agilidade.
8.2 Aviso de identificação por conteúdo (§5.2.1/§6 do doc de negócio)

Exibido antes do envio, em denúncia anônima, com checkbox de reconhecimento obrigatório:

Mesmo sem se identificar, seu relato pode revelar quem você é. Detalhes como um horário exato, um cargo pouco comum no seu setor ou uma informação que só você e a pessoa citada conheceriam podem ser suficientes para identificá-lo, mesmo que você não coloque seu nome.

Antes de enviar, revise seu texto: — Prefira períodos ("na semana do dia 10") a horários exatos. — Descreva o local de forma geral, se possível ("no setor de produção", não "na minha mesa, a terceira da fileira 2"). — Evite detalhes que só uma pessoa saberia contar daquele jeito. — Se for anexar um arquivo, verifique se ele não tem seu nome, e-mail ou outras marcas suas no conteúdo — nós removemos automaticamente alguns desses dados técnicos, mas o que está visível no próprio arquivo (uma assinatura, uma foto sua) não conseguimos remover.

☐ Revisei meu relato com essas orientações em mente.

Deliberadamente não usa a palavra "risco" isolada nem qualifica a denúncia como perigosa por si só — o aviso é sobre o mecanismo (identificação por conteúdo), não sobre o ato de denunciar.

8.3 Tela de confirmação — protocolo e chave

Sua denúncia foi registrada.

Guarde estas duas informações — elas são a única forma de acompanhar sua denúncia depois. Não pedimos seu contato, então não conseguimos enviá-las de volta para você.

Protocolo: DEN-2026-A1B2C3 Chave de acesso: XXXX-XXXX-XXXX-XXXX

[Copiar] [Imprimir]

☐ Já guardei meu protocolo e minha chave de acesso.

Se perder a chave, não conseguiremos recuperá-la. Você poderá abrir uma nova denúncia informando este protocolo como referência.

O botão "Continuar" só habilita depois do checkbox marcado — não é um obstáculo burocrático, é a única rede de segurança que existe para quem escolheu o anonimato total.

8.4 Mensagens de erro genéricas (segurança por obscuridade deliberada)
Situação	Texto exibido
Login: e-mail inexistente ou senha errada	"E-mail ou senha incorretos."
Login: conta bloqueada	"Acesso suspenso. Entre em contato com o administrador da sua empresa."
Consulta pública: protocolo ou chave errados	"Não encontramos uma denúncia com esse protocolo e chave. Verifique os dados e tente novamente."
Excesso de tentativas	"Muitas tentativas. Aguarde alguns minutos e tente novamente."
Acesso negado a recurso (403)	"Você não tem acesso a este conteúdo." — nunca "este caso é restrito" ou "você está impedido", que revelaria a existência/motivo a quem não deveria saber

Nenhuma dessas mensagens diferencia a causa real (evita enumeração de e-mail, evita confirmar a um citado que ele está sob suspeita de conflito de interesse) — a uniformidade do texto é a própria medida de segurança, não só estilo.

8.5 Estados vazios

Estado vazio nunca é tela em branco com um texto cinza pequeno — é uma oportunidade de orientar. Padrão: ícone simples de traço (não ilustração colorida grande, que destoa do tom sério do produto), uma frase do que está vazio, e — quando existe — a ação possível.

Tela	Texto	Ação
Lista de denúncias sem resultado de filtro	"Nenhuma denúncia encontrada com esses filtros."	"Limpar filtros"
Lista de denúncias, tenant novo, zero casos	"Nenhuma denúncia registrada ainda. Quando alguém relatar algo pelo canal público, o caso aparecerá aqui."	(sem ação — não existe "criar denúncia" para o comitê forçar volume)
Notificações	"Você está em dia. Nenhuma notificação pendente."	—
Mensagens com o denunciante, nenhuma ainda	"Nenhuma mensagem trocada ainda. Use este canal para pedir mais informações ao denunciante, mesmo que seja anônimo."	"Enviar mensagem"
Bloqueios/conflitos pendentes (/conflitos), nenhum	"Nenhuma suspeita de conflito de interesse pendente de revisão."	—
Anexos, nenhum	"Nenhum anexo enviado nesta denúncia."	"Adicionar anexo" (se permitido pelo perfil)
8.6 Estados de erro (não relacionados a auth)
Erro genérico de sistema: "Algo deu errado do nosso lado. Sua denúncia não foi perdida — tente novamente em instantes." (nunca expor stack trace, nunca dizer "erro 500", sempre reassegurar que o dado sensível não some).
Falha de upload: "Não foi possível enviar este arquivo. Verifique o tamanho (máx. 25 MB) e o formato (PDF, imagem, Word ou ZIP)." — a denúncia em si já foi salva, o texto deixa isso implícito ao não repetir aviso de perda de dado.
Varredura de antivírus pendente/reprovada (visão do comitê): "Este arquivo está em verificação de segurança." / "Este arquivo foi bloqueado por nossa verificação de segurança e não pode ser baixado." — nunca expor ao usuário comum o nome técnico do malware encontrado.
Sessão expirada: modal, não redirecionamento abrupto: "Sua sessão expirou por segurança. Faça login novamente — o que você estava digitando neste formulário foi mantido." (o formulário salva rascunho local antes de estourar o token, para não haver perda de um comentário de investigação de 10 minutos escrevendo).
8.7 Confirmações de ação sensível

Ações irreversíveis ou de alto impacto (arquivar denúncia, revelar identidade, suspender usuário, reabrir caso) usam modal de confirmação com o motivo obrigatório já embutido no mesmo passo (não "confirma?" seguido de outro formulário) e o verbo no botão descreve a ação real, nunca um "OK" genérico:

Revelar identidade do denunciante Esta ação é registrada e o administrador da empresa é notificado. Explique por que a identidade precisa ser revelada agora (mínimo 20 caracteres). [textarea] [Cancelar] [Revelar identidade]

O botão de confirmação nunca usa cor de perigo (--status-danger) para ações que são procedimento normal e auditado (revelar identidade, reabrir caso) — vermelho é reservado a ações destrutivas de fato (excluir anexo, excluir dossiê). Misturar os dois banaliza o vermelho e faz o comitê clicar rápido demais em ambos.

9. Acessibilidade — específicos além do WCAG genérico
Todo ícone semântico (status, prioridade, SLA) tem aria-label com o mesmo texto do badge, não redundante-decorativo.
Formulário de nova denúncia é 100% navegável por teclado e testado com leitor de tela antes de cada release (parte da suíte Playwright + axe-core, §12 da Arquitetura) — é o ponto de entrada de maior risco de exclusão se falhar.
Timers/alertas de SLA nunca usam só piscar ou só cor — sempre com texto e ícone estático (evita gatilho para fotossensibilidade e é mais acessível a daltonismo).
Todo modal tem foco preso (focus trap) e devolve o foco ao elemento que o abriu ao fechar.
10. O que fica para a fase de prototipação (não decidido aqui)

Este documento fixa tokens, tom e componentes-chave o suficiente para começar a construir com consistência — não substitui wireframes de tela por tela. Ficam para a próxima etapa: fluxo detalhado de cada tela do painel de investigação (§5.16 do doc de negócio), o layout exato do formulário multi-etapa de nova denúncia, e o protótipo navegável para validar com um comitê de compliance real antes de fechar o primeiro release visual.

11. Validações e formatação de campos

Toda regra abaixo é a mesma dos dois lados (schema Zod único, conforme §9.3 da Arquitetura) — o texto de erro nunca diverge entre o que o formulário mostra e o que a API retornaria se o cliente fosse contornado.

11.1 Momento da validação
Em tempo real (on blur): campos de formato fechado (e-mail, telefone, data, protocolo, chave de acesso) — o erro aparece assim que o usuário sai do campo, não a cada tecla (evita "piscar" erro enquanto ainda está digitando).
Ao enviar (on submit): campos de contagem mínima de caracteres (title, description, reason, justificativas) — mostrar erro de "faltam 23 caracteres" a cada tecla pune quem está pensando enquanto escreve. Em vez disso, um contador discreto (142/200) fica sempre visível, sem cor de alerta até passar do limite.
Nunca bloquear digitação: nenhum campo impede fisicamente o caractere errado (ex.: não travar teclado em campo numérico) — o input aceita, a validação avisa. Bloqueio de digitação frustra mais do que ajuda e quebra em teclados de celular/leitor de tela.
11.2 Campos e máscaras
Campo	Formato/máscara	Validação	Mensagem de erro
title	texto livre	10–200 caracteres	"O título precisa ter entre 10 e 200 caracteres."
description	texto livre, multilinha	mín. 50 caracteres	"Descreva com um pouco mais de detalhe (mínimo de 50 caracteres) para ajudar na investigação."
reporterEmail	nome@dominio.com	RFC 5322 simplificado	"Digite um e-mail válido."
reporterPhone	máscara BR dinâmica (00) 00000-0000 / (00) 0000-0000	10 ou 11 dígitos, DDD válido	"Digite um telefone válido com DDD."
incidentDate	DD/MM/AAAA, calendário nativo	não pode ser futura	"A data do fato não pode ser no futuro."
protocol	DEN-AAAA-XXXXXX, maiúsculas automáticas, cola normalizada	formato fixo	(ver §8.4 — erro genérico, não específico de formato, para não ajudar enumeração)
accessKey	agrupada em blocos de 4 (XXXX-XXXX-XXXX-XXXX), maiúsculas automáticas	16+ caracteres	idem acima
involvedPeople[] / witnesses[]	uma entrada por linha, normalizado de texto único para lista se necessário	pelo menos 1 item em involvedPeople no formulário público	"Informe ao menos uma pessoa envolvida."
Upload de anexo	jpg, jpeg, png, gif, pdf, doc, docx, zip	máx. 25 MB, magic bytes conferido no servidor	ver §8.6 (erro de upload)
justification (revelar identidade, impedimento)	texto livre	mín. 20 caracteres	contador visível, mesmo padrão do §11.1
reason (mudança de status, arquivamento)	texto livre	mín. 10 caracteres	idem
11.3 Comportamento de colar (paste) em campos de código

Protocolo e chave de acesso aceitam colar com espaços, hífens ou quebras de linha extras (comum quando a pessoa copia de um papel impresso ou de outro app) — o campo normaliza automaticamente antes de validar, em vez de rejeitar o formato colado.

11.4 Internacionalização da validação

Com next-intl (PT/EN/ES), toda mensagem de validação vem do mesmo dicionário de i18n usado no resto da UI — nunca uma lib de validação gera texto de erro em inglês "vazado" dentro de uma tela em português.

12. PWA e 100% mobile
12.1 Escopo do PWA

Dois manifestos distintos, alinhados à separação de navegação do §6:

App do comitê (/dashboard em diante): instalável, com push (WEB_PUSH, conforme §5.8 do doc de negócio), ícone e nome vindo do branding do tenant (manifest.json gerado dinamicamente por tenant, não estático).
Canal público: também instalável (alguém pode querer o atalho de "Fazer uma denúncia" na tela inicial do celular, inclusive por segurança — evita digitar a URL correta em rede pública), mas sem push e sem qualquer dado pré-carregado. Antes de instalar, avisamos: o ícone instalado leva o nome e o logo da empresa, e pode ficar visível na tela inicial para qualquer pessoa que use o mesmo aparelho. Se isso for um risco para você, prefira acessar pelo navegador sem instalar. Em dispositivos compartilhados, a instalação pode funcionar como evidência visual de que a pessoa acessou ou iniciou um canal de denúncia. O nome exibido no manifest pode ser customizado para algo neutro (ex.: "Canal de Ética") quando a plataforma permitir, mas o aviso textual é obrigatório mesmo sem essa customização.
12.2 O que fica offline e o que não fica — decisão deliberada

Cache offline é, por padrão, um risco de privacidade neste produto (dado sensível persistido no dispositivo). A regra:

Cacheável (App Shell only): HTML/CSS/JS da casca, ícones, fontes, o manifest.json do tenant — nada de dado de denúncia.
Nunca cacheável: qualquer resposta da API com conteúdo de denúncia, mensagem, anexo ou identidade — o Service Worker usa estratégia network-only para essas rotas, mesmo que isso signifique tela de "sem conexão" em vez de dado desatualizado. Preferir mostrar "você está offline" a mostrar um caso com um status que já mudou, ou pior, deixar aquele conteúdo persistido no cache do navegador de um dispositivo que pode ser compartilhado.
Rascunho local do formulário de nova denúncia: padrão seguro é manter o texto somente enquanto a aba estiver aberta. Ele fica em memória do navegador e é apagado ao fechar a aba ou o navegador, sem exceção. Persistência entre sessões (até 24h) é opt-in explícito e só deve ser usada em aparelho pessoal: "Quer manter este rascunho salvo neste aparelho caso você feche o navegador? Só faça isso se for o seu próprio dispositivo." Isso é anunciado ao usuário antes de salvar e o comportamento nunca é silencioso ou arriscado por padrão, porque em dispositivo compartilhado isso é exatamente o tipo de vestígio que o produto promete não deixar.
12.3 Mobile como superfície de primeira classe, não adaptação
Breakpoints: mobile-first em todo componente (packages/ui), não "desktop primeiro, encolhe depois". Base ≤ 640px, tablet 641–1024px, desktop ≥ 1025px (ponto em que a sidebar deixa de virar gaveta, §6).
Navegação mobile do comitê: sidebar vira gaveta lateral acionada por ícone de menu no topo — sem bottom tab bar fixa, porque o número de seções (Dashboard, Denúncias, Usuários, Relatórios, Configurações, Auditoria, LGPD) excede o que uma barra inferior comporta com clareza; forçar 5 ícones genéricos numa barra inferior obrigaria a esconder itens num "Mais", que é pior do que a gaveta.
Alvo de toque: mínimo 44×44px em qualquer elemento interativo (padrão iOS/Android de acessibilidade), inclusive em tabela densa — o modo compacto (§7) reduz altura de linha, mas a área de toque efetiva do botão de ação em linha nunca reduz junto.
Safe area: viewport-fit=cover com env(safe-area-inset-*) aplicado em qualquer elemento fixo ao topo/rodapé (barra de progresso do formulário, cabeçalho de tabela), para não colidir com notch/barra de gestos.
Formulário de nova denúncia no mobile: uma pergunta por tela em vez de rolagem longa (o padrão de etapas do §5.4 já é por natureza mobile-friendly), teclado numérico automático em telefone/data, upload de anexo com atalho direto para câmera/galeria.
Tabelas em mobile: abaixo de 640px, tabela vira lista de cards empilhados (cada linha = um card com protocolo, título, badges de status/prioridade/SLA), nunca tabela com scroll horizontal forçado — scroll horizontal em tabela é o erro mobile mais comum e mais evitável.
Teste de aceitação: Lighthouse PWA score e Core Web Vitals mobile entram como checagem do CI (mesmo pipeline de §12 da Arquitetura), não é validação manual eventual.
13. Cores personalizáveis — dois níveis, dono diferente

Dois níveis de personalização de cor coexistem sem conflito, porque cada um controla uma camada diferente (mesma lógica do §1: shell fixo, marca do tenant, agora com um terceiro nível):

Nível	Quem escolhe	O que controla	Escopo
0 — Shell semântico	Ninguém (fixo, §2)	Cores de status/prioridade/SLA	Produto inteiro
1 — Marca do tenant	ADMIN da empresa	primaryColor, secondaryColor, logo	Todos os usuários daquele tenant, inclusive o denunciante anônimo no canal público
2 — Preferência pessoal	Cada usuário logado (qualquer perfil)	Modo claro/escuro/sistema, tamanho de fonte, contraste alto	Só a própria sessão daquele usuário, em qualquer tenant que ele acesse
13.1 Nível 1 — ADMIN escolhe a marca (/configuracoes)
Seletor de cor com color picker (input nativo + campo hex) para primaryColor e secondaryColor, com pré-visualização ao vivo lado a lado: botão primário, badge de link ativo do menu, cabeçalho da landing pública — para o ADMIN ver o efeito real antes de salvar, não só o quadradinho da cor isolado.
Validação de contraste automática já descrita no §1.1 permanece: se a cor escolhida falhar WCAG, mostra aviso e sugere o ajuste, mas nunca bloqueia o ADMIN de salvar a cor que ele quer — a decisão final é dele, a orientação é nossa.
Paleta de presets sugeridos (6–8 combinações testadas e já aprovadas em contraste) para quem não quer escolher do zero, com botão "cor personalizada" para abrir o picker completo.
O que o ADMIN não controla aqui: cores de status/prioridade/SLA (nível 0) — mantém a leitura de "vermelho = vencido" idêntica em qualquer tenant do produto, o que importa para quem usa o OuviON em mais de uma empresa (ex.: consultor de compliance, auditor externo).
13.2 Nível 2 — cada usuário escolhe sua própria exibição (/minha-conta)

Independente do que o ADMIN definiu como marca, cada pessoa logada ajusta como ela enxerga o produto:

Tema: Claro / Escuro / Seguir sistema (padrão: seguir sistema) — usa os tokens de dark mode já definidos no §2, a cor de marca do tenant também tem sua variante escura calculada automaticamente — o contraste é recalculado no modo escuro, não é a mesma cor "jogada" num fundo escuro sem checagem.
Tamanho de fonte: Padrão / Grande / Extra grande (escala tipográfica do §3 multiplicada por 1.125 / 1.25) — acessibilidade, não estética.
Contraste alto: alterna para uma variante com bordas e textos mais fortes, pensada para baixa visão, independente do tema claro/escuro escolhido.
Redução de movimento: respeita prefers-reduced-motion do sistema por padrão, mas com opção manual de desligar toda transição/animação do produto (§4 já é discreto por padrão; aqui a pessoa pode zerar de vez).

Essa preferência é por conta, não por dispositivo — persiste em UserPreferences (mesma entidade do documento de negócio, com os novos campos theme, fontScale, highContrast, reducedMotion) e viaja com o usuário entre computador e celular.

13.3 Regra de composição entre os níveis

Para não haver ambiguidade de "qual cor vence": a cor de marca do tenant (nível 1) é sempre a cor de ação/destaque; a preferência do usuário (nível 2) decide claro/escuro/contraste, nunca substitui a cor de marca por outra cor de marca. Um investigador que atende dois tenants diferentes no mesmo dia vê a marca de cada empresa mudar normalmente ao trocar de tenant — só o modo claro/escuro/fonte dele é que permanece igual nos dois.
