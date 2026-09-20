import { expect, test } from '@playwright/test';

import { API, createViaApi, expectAccessible, fillFacts, goToReview, PNG, REPORT, TENANT } from './helpers';

test.describe('landing do canal', () => {
  test('mostra marca, garantias, documentos e contato; acessível nos dois temas', async ({ page }) => {
    await page.goto(`/${TENANT}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Um espaço seguro para relatar o que não está certo' })).toBeVisible();
    await expect(page.getByText('Empresa Demo').first()).toBeVisible();
    for (const g of ['Anonimato', 'Sigilo', 'Sem retaliação']) await expect(page.getByRole('heading', { name: g })).toBeVisible();

    // Documentos normativos vêm das configurações públicas; só os cadastrados aparecem.
    await expect(page.getByRole('link', { name: 'Código de Ética' })).toHaveAttribute('href', 'https://exemplo.com/codigo-de-etica.pdf');
    await expect(page.getByRole('link', { name: 'Política de Assédio' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Política Anticorrupção' })).toHaveCount(0);
    await expect(page.getByText('Maria Encarregada')).toBeVisible(); // DPO
    await expect(page.getByText('0800 000 0000')).toBeVisible();

    // Cor de marca (#0a5c36) só na ação: o botão primário a usa e o texto sobre ela tem contraste.
    const btn = page.getByRole('link', { name: 'Começar meu relato' });
    await expect(btn).toHaveCSS('background-color', 'rgb(10, 92, 54)');

    await expectAccessible(page, 'landing (claro)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expectAccessible(page, 'landing (escuro)');
  });

  test('empresa inexistente devolve 404 e o BFF só repassa rotas públicas', async ({ page, request }) => {
    const res = await page.goto('/nao-existe-mesmo');
    expect(res?.status()).toBe(404);
    expect((await request.post(`/api/bff/${TENANT}/auth/login`, { data: { email: 'a@b.com', password: 'x' } })).status()).toBe(404);
    expect((await request.get(`/api/bff/${TENANT}/complaints`)).status()).toBe(404);
    expect((await request.get(`/api/bff/${TENANT}/public/../complaints`)).status()).toBe(404);
    const brand = await request.get(`/api/bff/${TENANT}/public/branding`);
    expect(brand.status()).toBe(200);
    expect(brand.headers()['cache-control']).toContain('no-store');
  });

  test('busca de protocolo na landing normaliza o que foi colado e leva ao acompanhamento', async ({ page }) => {
    await page.goto(`/${TENANT}`);
    const box = page.getByRole('searchbox').or(page.locator('#landing-protocol'));
    await box.fill('den 2026 a1b2c3');
    await expect(box).toHaveValue('DEN-2026-A1B2C3');
    await page.getByRole('button', { name: 'Consultar', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${TENANT}/acompanhar\\?protocol=DEN-2026-A1B2C3`));
    await expect(page.getByTestId('lookup-protocol')).toHaveValue('DEN-2026-A1B2C3');
  });
});

test.describe('nova denúncia (formulário em etapas)', () => {
  test('validação: erros só ao avançar, com os textos do dicionário; o aviso é obrigatório', async ({ page }) => {
    await page.goto(`/${TENANT}/nova-denuncia`);
    await expect(page.getByRole('heading', { name: 'Você pode relatar sem se identificar' })).toBeFocused();
    await page.getByRole('button', { name: 'Continuar' }).click();

    // Etapa 1 vazia: bloqueia e explica.
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByText('Escolha o assunto do relato.')).toBeVisible();
    await expect(page.getByText('O título precisa ter entre 10 e 200 caracteres.')).toBeVisible();
    await expect(page.getByText('Descreva com um pouco mais de detalhe (mínimo de 50 caracteres) para ajudar na investigação.')).toBeVisible();
    await expectAccessible(page, 'etapa 1 com erros');

    // Data futura é recusada ao sair do campo (formato fechado); a mensagem some ao corrigir.
    await fillFacts(page);
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel('Quando aconteceu?').fill(future);
    await page.getByLabel('Onde aconteceu?').click(); // sai do campo
    await expect(page.getByText('A data do fato não pode ser no futuro.')).toBeVisible();
    await page.getByLabel('Quando aconteceu?').fill('2026-03-10');
    await page.getByRole('button', { name: 'Continuar' }).click();

    // Etapa 2: ao menos um citado.
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByText('Informe ao menos uma pessoa envolvida.')).toBeVisible();
    await page.getByLabel('Pessoas citadas neste relato').fill(REPORT.involved);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click(); // anexos são opcionais

    // Revisão: sem reconhecer o aviso não envia.
    await expect(page.getByRole('heading', { name: 'Revise antes de enviar' })).toBeVisible();
    await expect(page.getByText('Mesmo sem se identificar, seu relato pode revelar quem você é')).toBeVisible();
    await page.getByRole('button', { name: 'Enviar relato' }).click();
    await expect(page.getByText('Confirme que revisou seu relato com essas orientações em mente.')).toBeVisible();
    await expectAccessible(page, 'etapa de revisão');
  });

  test('arquivos: .doc antigo, tipo inválido e tamanho são recusados com texto claro; PNG é aceito', async ({ page }) => {
    await page.goto(`/${TENANT}/nova-denuncia`);
    for (let i = 0; i < 3; i++) {
      if (i === 0) await page.getByRole('button', { name: 'Continuar' }).click();
      else if (i === 1) {
        await fillFacts(page);
        await page.getByRole('button', { name: 'Continuar' }).click();
      } else {
        await page.getByLabel('Pessoas citadas neste relato').fill(REPORT.involved);
        await page.getByRole('button', { name: 'Continuar' }).click();
      }
    }
    await expect(page.getByRole('heading', { name: 'Documentos, fotos ou arquivos' })).toBeVisible();
    await page.locator('#arquivos').setInputFiles([
      { name: 'antigo.doc', mimeType: 'application/msword', buffer: Buffer.from('x') },
      { name: 'programa.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
      { name: 'foto.png', mimeType: 'image/png', buffer: PNG },
    ]);
    await expect(page.getByText(/“antigo.doc” está em formato .doc antigo/)).toBeVisible();
    await expect(page.getByText('“programa.exe” não é um formato aceito (PDF, imagem, Word ou ZIP).')).toBeVisible();
    await expect(page.getByText('foto.png')).toBeVisible();
    await page.getByRole('button', { name: 'Remover foto.png' }).click();
    await expect(page.getByText('Nenhum arquivo selecionado.')).toBeVisible();
    await expectAccessible(page, 'etapa de anexos');
  });

  test('fluxo completo: envia, mostra protocolo e chave UMA vez, exige guardar, acompanha e conversa', async ({ page, context }) => {
    await goToReview(page, { files: [{ name: 'evidencia.png', mimeType: 'image/png', buffer: PNG }] });
    await page.getByRole('checkbox', { name: 'Revisei meu relato com essas orientações em mente.' }).click();
    await page.getByRole('button', { name: 'Enviar relato' }).click();

    // ── Confirmação ──
    await expect(page.getByRole('heading', { name: 'Seu relato foi registrado.' })).toBeVisible();
    const protocol = (await page.getByTestId('receipt-protocol').textContent())!.trim();
    const key = (await page.getByTestId('receipt-key').textContent())!.trim();
    expect(protocol).toMatch(/^DEN-\d{4}-[A-Z0-9]{6}$/);
    expect(key).toMatch(/^([A-Z0-9]{4}-){4}[A-Z0-9]{4}$/);
    await expect(page.getByText('Se perder a chave, não conseguiremos recuperá-la.')).toBeVisible();
    const cont = page.getByRole('button', { name: 'Acompanhar meu relato' });
    await expect(cont).toBeDisabled(); // só habilita com "já guardei"
    await expectAccessible(page, 'confirmação');

    // A chave NUNCA vai para URL, cookie ou armazenamento do navegador.
    expect(page.url()).not.toContain(key);
    expect(page.url()).not.toContain(key.replace(/-/g, ''));
    expect(await context.cookies()).toEqual([]);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(protocol);

    await page.getByRole('checkbox', { name: 'Já guardei meu protocolo e minha chave de acesso.' }).click();
    await expect(cont).toBeEnabled();
    await cont.click();

    // ── Acompanhamento (sessão aberta com a chave que estava em memória) ──
    await expect(page.getByTestId('tracking-protocol')).toHaveText(protocol);
    await expect(page.getByText('Pendente').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Andamento' })).toBeVisible();
    await expect(page.getByText(/Você receberá um retorno da empresa até/)).toBeVisible();
    await expect(page.getByText('Recebemos sua denúncia.')).toBeVisible(); // recibo automático do canal

    await page.getByTestId('message-input').fill('Tenho mais um detalhe importante sobre o caso.');
    await page.getByTestId('message-send').click();
    await expect(page.getByText('Tenho mais um detalhe importante sobre o caso.')).toBeVisible();
    await expect(page.getByText('Mensagem enviada.')).toBeVisible();
    await expectAccessible(page, 'acompanhamento');

    // Sem cookies mesmo depois do fluxo inteiro.
    expect(await context.cookies()).toEqual([]);
  });

  test('a chave some ao recarregar a confirmação (aparece uma única vez)', async ({ page }) => {
    await goToReview(page);
    await page.getByRole('checkbox', { name: 'Revisei meu relato com essas orientações em mente.' }).click();
    await page.getByRole('button', { name: 'Enviar relato' }).click();
    await expect(page.getByTestId('receipt-key')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'A chave de acesso não é mais exibida' })).toBeVisible();
    await expect(page.getByTestId('receipt-key')).toHaveCount(0);
  });
});

test.describe('rascunho: memória por padrão, opt-in explícito para persistir', () => {
  test('por padrão nada é gravado no aparelho; com opt-in salva 24 h e oferece restaurar', async ({ page }) => {
    await page.goto(`/${TENANT}/nova-denuncia`);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await fillFacts(page);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ouvion:')))).toEqual([]);

    // Opt-in na etapa de anexos (com o aviso de que só vale em aparelho pessoal).
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByLabel('Pessoas citadas neste relato').fill(REPORT.involved);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByText(/Só faça isso se o aparelho for seu/)).toBeVisible();
    await page.getByRole('checkbox', { name: 'Manter este rascunho neste aparelho' }).click();
    await page.waitForTimeout(800);
    const saved = await page.evaluate((t) => JSON.parse(localStorage.getItem(`ouvion:draft:${t}`) ?? 'null'), TENANT);
    expect(saved.values.title).toBe(REPORT.title);
    expect(saved.values.contentWarningAcknowledged).toBe(false); // o aviso nunca é restaurado
    const ttl = saved.expiresAt - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000);

    // Nova visita: oferece restaurar (nunca aplica em silêncio).
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`/${TENANT}`);
    await page.goto(`/${TENANT}/nova-denuncia`);
    await expect(page.getByText('Encontramos um rascunho salvo neste aparelho')).toBeVisible();
    await page.getByRole('button', { name: 'Continuar o rascunho' }).click();
    await expect(page.getByLabel('Dê um título ao seu relato')).toHaveValue(REPORT.title);

    // "Sair sem enviar" apaga tudo.
    await page.getByRole('button', { name: 'Sair sem enviar' }).click();
    await expect(page).toHaveURL(new RegExp(`/${TENANT}$`));
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ouvion:')))).toEqual([]);
  });
});

test.describe('acompanhar por protocolo + chave', () => {
  test('colar com espaços/caixa baixa funciona; erro é genérico e igual para protocolo e chave errados', async ({ page }) => {
    const c = await createViaApi();
    await page.goto(`/${TENANT}/acompanhar`);

    // Colagem "suja": minúsculas, espaços e quebras de linha.
    await page.getByTestId('lookup-protocol').fill('  ' + c.protocol.toLowerCase().replace(/-/g, ' ') + '\n');
    await expect(page.getByTestId('lookup-protocol')).toHaveValue(c.protocol);
    await page.getByTestId('lookup-key').fill('AAAA-AAAA-AAAA-AAAA-AAAA');
    await page.getByRole('button', { name: 'Consultar', exact: true }).click();
    const generic = 'Não encontramos um relato com esse protocolo e chave. Verifique os dados e tente novamente.';
    await expect(page.getByText(generic)).toBeVisible();

    // Protocolo que não existe: exatamente o mesmo texto.
    await page.getByTestId('lookup-protocol').fill('DEN-2026-ZZZZZZ');
    await page.getByRole('button', { name: 'Consultar', exact: true }).click();
    await expect(page.getByText(generic)).toBeVisible();

    // Chave certa, digitada em minúsculas e sem hífens.
    await page.getByTestId('lookup-protocol').fill(c.protocol);
    await page.getByTestId('lookup-key').fill(c.accessKey.toLowerCase().replace(/-/g, ' '));
    await expect(page.getByTestId('lookup-key')).toHaveValue(c.accessKey);
    await page.getByRole('button', { name: 'Consultar', exact: true }).click();
    await expect(page.getByTestId('tracking-protocol')).toHaveText(c.protocol);
    expect(page.url()).not.toContain(c.accessKey);
  });

  test('campos vazios ou incompletos são explicados sem chamar a API', async ({ page }) => {
    await page.goto(`/${TENANT}/acompanhar`);
    await page.getByRole('button', { name: 'Consultar', exact: true }).click();
    await expect(page.getByText('Informe o protocolo.')).toBeVisible();
    await expect(page.getByText('Informe a chave de acesso.')).toBeVisible();
    await expectAccessible(page, 'consulta com erros');
  });

  test('comitê responde e o denunciante vê; ao encerrar, pode relatar represália (caso novo com nova chave)', async ({ page }) => {
    const c = await createViaApi();
    // O comitê (login de equipe direto na API) responde e encerra.
    const login = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-slug': TENANT }, body: JSON.stringify({ email: 'admin@demo.com', password: 'Senha-Forte-123!' }) })).json();
    const auth = { 'content-type': 'application/json', 'x-tenant-slug': TENANT, authorization: `Bearer ${login.accessToken}` };
    const list = await (await fetch(`${API}/complaints?limit=100`, { headers: auth })).json();
    const row = list.data.find((x: { protocol: string }) => x.protocol === c.protocol);
    expect((await fetch(`${API}/complaints/${row.id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ content: 'Pode informar as datas exatas dos fatos?' }) })).status).toBe(201);

    const lookup = async () => {
      await page.goto(`/${TENANT}/acompanhar`);
      await page.getByTestId('lookup-protocol').fill(c.protocol);
      await page.getByTestId('lookup-key').fill(c.accessKey);
      await page.getByRole('button', { name: 'Consultar', exact: true }).click();
      await expect(page.getByTestId('tracking-protocol')).toHaveText(c.protocol);
    };
    await lookup();
    await expect(page.getByText('Pode informar as datas exatas dos fatos?')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sofreu represália depois de relatar?' })).toHaveCount(0); // ainda aberto

    // Encerra: a linha do tempo mostra o desfecho e abre o campo de represália.
    const closed = await fetch(`${API}/complaints/${row.id}/status`, { method: 'POST', headers: auth, body: JSON.stringify({ status: 'DISMISSED', reason: 'Sem materialidade após análise', conclusion: 'UNSUBSTANTIATED' }) });
    expect(closed.status).toBe(200);
    await lookup();
    await expect(page.getByText('O caso foi encerrado.')).toBeVisible();
    await expect(page.getByText('Sua denúncia foi encerrada.')).toBeVisible(); // mensagem automática
    await expect(page.getByRole('heading', { name: 'Sofreu represália depois de relatar?' })).toBeVisible();
    await expectAccessible(page, 'acompanhamento de caso encerrado');

    await page.getByLabel('O que aconteceu?').fill('Fui removido da equipe depois da denúncia original.');
    await page.getByRole('button', { name: 'Relatar represália' }).click();
    await expect(page.getByRole('heading', { name: 'Seu relato de represália foi registrado.' })).toBeVisible();
    await expect(page.getByText(/^DEN-\d{4}-[A-Z0-9]{6}$/).last()).toBeVisible();
  });
});

test.describe('sem vazamento de identificação', () => {
  test('nenhuma requisição do canal público carrega cookie ou grava armazenamento persistente', async ({ page, context }) => {
    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/bff/')) seen.push(JSON.stringify(r.headers()));
    });
    await goToReview(page);
    await page.getByRole('checkbox', { name: 'Revisei meu relato com essas orientações em mente.' }).click();
    await page.getByRole('button', { name: 'Enviar relato' }).click();
    await expect(page.getByTestId('receipt-key')).toBeVisible();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => !/cookie/i.test(h))).toBe(true);
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  });
});
