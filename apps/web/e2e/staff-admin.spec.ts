import { expect, test, type Page } from '@playwright/test';

import { API, createViaApi, expectAccessible, REPORT, TENANT } from './helpers';

const PASSWORD = 'Senha-Forte-123!';

async function login(page: Page, email = 'admin@demo.com'): Promise<void> {
  await page.goto(`/${TENANT}/entrar`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(`**/${TENANT}/painel`);
}

/** Denúncia IDENTIFICADA: exige um REPORTER com conta (fluxo real da API). */
async function createIdentified(): Promise<{ protocol: string }> {
  const email = `rep-${Date.now()}-${Math.floor(Math.random() * 1e6)}@exemplo.com`;
  const h = { 'content-type': 'application/json', 'x-tenant-slug': TENANT };
  const reg = await fetch(`${API}/auth/register`, { method: 'POST', headers: h, body: JSON.stringify({ email, fullName: 'Pessoa Identificada', password: PASSWORD }) });
  const tokens = (await reg.json()) as { accessToken: string };
  const res = await fetch(`${API}/public/complaints`, {
    method: 'POST',
    headers: { ...h, authorization: `Bearer ${tokens.accessToken}` },
    body: JSON.stringify({ isAnonymous: false, type: 'FRAUD', title: 'Relato identificado para revelar', description: REPORT.description, involvedPeople: ['Alguém'], reporterName: 'Pessoa Identificada', reporterEmail: email }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as { protocol: string };
  return created;
}

test.describe('equipe', () => {
  test('lista todos, exige motivo para suspender, não deixa suspender a si mesmo e reativa', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: 'Equipe' }).click();
    await expect(page.getByRole('heading', { name: 'Equipe' })).toBeVisible();
    const inv = page.getByTestId('users-list').getByRole('listitem').filter({ hasText: 'Ivo Investigador' });
    await expect(inv).toBeVisible();
    await expectAccessible(page, 'equipe');

    // O próprio ADMIN não tem botão ativo para se suspender.
    const self = page.getByTestId('users-list').getByRole('listitem').filter({ hasText: '(você)' });
    await expect(self.getByRole('button', { name: 'Suspender' })).toBeDisabled();

    await inv.getByRole('button', { name: 'Suspender' }).click();
    await expect(page.getByRole('heading', { name: 'Suspender Ivo Investigador?' })).toBeVisible();
    await expectAccessible(page, 'diálogo de suspensão');
    await page.getByTestId('block-reason').fill('curto');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Suspender Ivo Investigador?' })).toBeHidden();
    await expect(inv.getByText('Suspenso')).toHaveCount(0);

    await inv.getByRole('button', { name: 'Suspender' }).click();
    await page.getByTestId('block-reason').fill('Medida cautelar decidida pelo comitê.');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Usuário suspenso.')).toBeVisible();
    await expect(inv.getByText('Suspenso')).toBeVisible();

    // O suspenso não entra mais (mensagem igual à de senha errada).
    const other = await page.context().newPage();
    await other.goto(`/${TENANT}/entrar`);
    await other.getByTestId('login-email').fill('investigador@demo.com');
    await other.getByTestId('login-password').fill(PASSWORD);
    await other.getByTestId('login-submit').click();
    await expect(other.getByRole('alert').filter({ hasText: /incorretos|não foi possível/i })).toBeVisible();
    await other.close();

    await inv.getByRole('button', { name: 'Reativar' }).click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Usuário reativado.')).toBeVisible();
    await expect(inv.getByText('Suspenso')).toHaveCount(0);
  });

  test('investigador não vê a gestão de equipe nem a atribuição', async ({ page }) => {
    await login(page, 'investigador@demo.com');
    await expect(page.getByRole('link', { name: 'Equipe' })).toHaveCount(0);
    await page.goto(`/${TENANT}/painel/usuarios`);
    await expect(page.getByText('Só administradores gerenciam a equipe.')).toBeVisible();
    // Rota de gestão nega no servidor também, não só na tela.
    const denied = await page.request.get(`/api/staff/${TENANT}/users/manage`);
    expect(denied.status()).toBe(403);
  });
});

test.describe('revelar identidade', () => {
  test('justificativa obrigatória, dado só na tela e volta a exigir justificativa; anônimo não tem o botão', async ({ page }) => {
    const anon = await createViaApi({ title: 'Caso anônimo sem identidade' });
    const c = await createIdentified();
    await login(page);

    await page.getByRole('link', { name: `Abrir caso ${anon.protocol}` }).click();
    await expect(page.getByRole('heading', { name: anon.protocol })).toBeVisible();
    await expect(page.getByTestId('reveal-open')).toHaveCount(0);

    await page.goto(`/${TENANT}/painel`);
    await page.getByRole('link', { name: `Abrir caso ${c.protocol}` }).click();
    await expect(page.getByText('Identificado — os dados de contato ficam protegidos e só se revelam com justificativa.')).toBeVisible();
    await page.getByTestId('reveal-open').click();
    await expectAccessible(page, 'diálogo de revelar identidade');
    await page.getByTestId('reveal-justification').fill('muito curta');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Explique com ao menos 20 caracteres.')).toBeVisible();

    await page.getByTestId('reveal-justification').fill('Preciso confirmar o vínculo do denunciante com o setor financeiro.');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('revealed-identity')).toContainText('Pessoa Identificada');
    // Nada da identidade fica em armazenamento do navegador.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('Pessoa Identificada');

    await page.getByRole('button', { name: 'Fechar e ocultar' }).click();
    await expect(page.getByTestId('revealed-identity')).toHaveCount(0);
    await page.getByTestId('reveal-open').click();
    await expect(page.getByTestId('reveal-justification')).toHaveValue('');
  });
});

test.describe('minha conta', () => {
  test('aparência persiste no aparelho (tema, texto grande, contraste alto) e continua acessível', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: 'Minha conta' }).click();
    await expect(page.getByRole('heading', { name: 'Minha conta' })).toBeVisible();

    await page.getByTestId('pref-theme').selectOption('dark');
    await page.getByTestId('pref-font').selectOption('large');
    await page.getByTestId('pref-contrast').click();
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-contrast', 'high');
    await expect(html).toHaveCSS('font-size', '18px');
    await expectAccessible(page, 'conta (escuro, contraste alto, texto grande)');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-contrast', 'high');

    // Volta ao padrão para não vazar para outros testes.
    await page.getByTestId('pref-theme').selectOption('system');
    await page.getByTestId('pref-font').selectOption('normal');
    await page.getByTestId('pref-contrast').click();
    await expect(html).not.toHaveAttribute('data-theme', /.+/);
    await expect(html).not.toHaveAttribute('data-contrast', /.+/);
  });

  test('sessões: mostra a atual; preferências de notificação salvam; sair de todos derruba a sessão', async ({ page, context }) => {
    await login(page);
    await page.goto(`/${TENANT}/painel/conta`);
    await expect(page.getByTestId('sessions-list')).toContainText('Esta sessão');
    await expectAccessible(page, 'conta');

    await page.getByRole('checkbox', { name: 'Resumo diário por e-mail' }).click();
    await page.getByTestId('prefs-save').click();
    await expect(page.getByText('Preferências salvas.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Resumo diário por e-mail' })).toBeChecked();
    await page.getByRole('checkbox', { name: 'Resumo diário por e-mail' }).click();
    await page.getByTestId('prefs-save').click();
    await expect(page.getByText('Preferências salvas.')).toBeVisible();

    await page.getByTestId('logout-all').click();
    await page.waitForURL(`**/${TENANT}/entrar`);
    expect((await context.cookies()).filter((c) => c.name.startsWith('ouvion_'))).toEqual([]);
  });
});
