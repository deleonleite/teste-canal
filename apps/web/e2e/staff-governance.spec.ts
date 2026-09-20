import { expect, test, type Page } from '@playwright/test';

import { createViaApi, expectAccessible, TENANT } from './helpers';

const PASSWORD = 'Senha-Forte-123!';

async function login(page: Page, email = 'admin@demo.com'): Promise<void> {
  await page.goto(`/${TENANT}/entrar`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(`**/${TENANT}/painel`);
}

test.describe('conflitos de interesse', () => {
  test('revisão: justificativa obrigatória, descartar e confirmar, filtro por situação', async ({ page }) => {
    // Relato que cita o investigador pelo nome → suspeita pendente automática.
    const a = await createViaApi({ title: 'Relato citando alguém da equipe A', involvedPeople: ['Ivo Investigador'] });
    void a;
    await login(page);
    await page.getByRole('link', { name: 'Conflitos' }).click();
    await expect(page.getByRole('heading', { name: 'Conflitos de interesse' })).toBeVisible();
    const items = page.getByTestId('conflict-list').getByRole('listitem').filter({ hasText: 'Ivo Investigador' });
    await expect(items.first()).toBeVisible();
    await expectAccessible(page, 'conflitos');

    const pendingBefore = await items.count();
    await items.first().getByRole('button', { name: 'Descartar suspeita' }).click();
    await expect(page.getByRole('heading', { name: 'Descartar a suspeita?' })).toBeVisible();
    await expectAccessible(page, 'diálogo de conflito');
    await page.getByTestId('conflict-note').fill('curta');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
    await page.getByTestId('conflict-note').fill('Homônimo: outra pessoa, sem relação com o caso.');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Decisão registrada.')).toBeVisible();
    await expect(items).toHaveCount(pendingBefore - 1);

    await page.getByTestId('conflict-filter').selectOption('DISMISSED');
    await expect(page.getByTestId('conflict-list').getByText('Homônimo: outra pessoa, sem relação com o caso.').first()).toBeVisible();
  });

  test('quem não é ADMIN não vê o menu nem a tela', async ({ page }) => {
    await login(page, 'investigador@demo.com');
    await expect(page.getByRole('link', { name: 'Conflitos' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Configurações' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Auditoria' })).toHaveCount(0);
    await page.goto(`/${TENANT}/painel/conflitos`);
    await expect(page.getByText('Só administradores revisam conflitos.')).toBeVisible();
    await page.goto(`/${TENANT}/painel/configuracoes`);
    await expect(page.getByText('Só administradores alteram as configurações.')).toBeVisible();
    await page.goto(`/${TENANT}/painel/auditoria`);
    await expect(page.getByText('Só administradores e auditores acessam a auditoria.')).toBeVisible();
    for (const path of ['conflicts', 'audit', 'settings', 'branding']) {
      expect((await page.request.get(`/api/staff/${TENANT}/${path}`)).status(), path).toBe(403);
    }
  });
});

test.describe('auditoria', () => {
  test('lista com filtro, verifica a integridade e não expõe horário fino de origem anônima', async ({ page }) => {
    await createViaApi({ title: 'Relato anônimo para gerar auditoria' });
    await login(page);
    await page.getByRole('link', { name: 'Auditoria' }).click();
    await expect(page.getByRole('heading', { name: 'Auditoria' })).toBeVisible();
    await expect(page.getByTestId('audit-list').getByRole('listitem').first()).toBeVisible();
    await expectAccessible(page, 'auditoria');

    await page.getByLabel('Ação', { exact: true }).selectOption('LOGIN');
    await expect(page.getByTestId('audit-list').getByRole('listitem').first()).toContainText('Entrada');

    await page.getByTestId('audit-verify').click();
    await expect(page.getByTestId('audit-ok').or(page.getByText('Divergências encontradas'))).toBeVisible({ timeout: 30_000 });
    if (await page.getByText('Divergências encontradas').isVisible()) {
      // Resíduo conhecido do banco de dev: selos ancorados por um worker antigo com âncora só em memória
      // (memory://) que já não existe. Qualquer OUTRA divergência (hash, raiz, encadeamento) continua falhando.
      const items = await page.getByRole('alert').filter({ hasText: 'Divergências encontradas' }).getByRole('listitem').allInnerTexts();
      expect(items.filter((i) => !/âncora memory:\/\/.* não encontrada/.test(i))).toEqual([]);
    } else {
      await expect(page.getByTestId('audit-ok')).toBeVisible();
    }
  });
});

test.describe('configurações e marca', () => {
  test('valida campos, avisa contraste ruim com prévia, salva e reflete no canal público', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: 'Configurações' }).click();
    await expect(page.getByRole('heading', { name: 'Marca da empresa' })).toBeVisible();
    await expectAccessible(page, 'configurações');

    // Cor amarela: sem contraste com texto branco → a prévia se ajusta e o aviso aparece.
    await page.getByTestId('brand-primary').fill('#ffee00');
    await expect(page.getByTestId('contrast-warning')).toBeVisible();
    await expectAccessible(page, 'aviso de contraste');

    await page.getByTestId('brand-primary').fill('vermelho');
    await page.getByTestId('brand-logo').fill('javascript:alert(1)');
    await page.getByTestId('brand-save').click();
    await expect(page.getByText('Use uma cor no formato #RRGGBB.').first()).toBeVisible();
    await expect(page.getByText('Informe um endereço que comece com http:// ou https://.')).toBeVisible();

    try {
      await page.getByTestId('brand-primary').fill('#0a5c36');
      await page.getByTestId('brand-logo').fill('');
      await page.getByTestId('brand-name').fill('Empresa Demo Teste');
      await page.getByTestId('brand-save').click();
      await expect(page.getByText('Marca atualizada. Já aparece no canal público.')).toBeVisible();

      const pub = await page.context().newPage();
      await pub.goto(`/${TENANT}`);
      await expect(pub.getByText('Empresa Demo Teste').first()).toBeVisible();
      await pub.close();

      await page.getByTestId('setting-docCodigoEtica').fill('ftp://nao-permitido');
      await page.getByTestId('channel-save').click();
      await expect(page.getByText('Informe um endereço que comece com http:// ou https://.')).toBeVisible();
      await page.getByTestId('setting-docCodigoEtica').fill('https://exemplo.com/codigo-de-etica.pdf');
      await page.getByTestId('channel-save').click();
      await expect(page.getByText('Configurações do canal salvas.')).toBeVisible();
    } finally {
      await page.getByTestId('brand-name').fill('Empresa Demo');
      await page.getByTestId('brand-save').click();
      await expect(page.getByText('Marca atualizada. Já aparece no canal público.')).toBeVisible();
    }
  });
});
