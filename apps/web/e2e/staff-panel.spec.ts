import { expect, test, type Page } from '@playwright/test';

import { createViaApi, expectAccessible, TENANT } from './helpers';

const ADMIN = { email: 'admin@demo.com', password: 'Senha-Forte-123!' };

async function login(page: Page): Promise<void> {
  await page.goto(`/${TENANT}/entrar`);
  await page.getByTestId('login-email').fill(ADMIN.email);
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(`**/${TENANT}/painel`);
  await expect(page.getByRole('heading', { name: 'Casos' })).toBeVisible();
}

test.describe('login da equipe', () => {
  test('painel exige sessão; login errado não revela qual dado falhou', async ({ page }) => {
    await page.goto(`/${TENANT}/painel`);
    await expect(page).toHaveURL(new RegExp(`/${TENANT}/entrar$`));
    await expectAccessible(page, 'login');

    await page.getByTestId('login-submit').click();
    await expect(page.getByText('Preencha este campo.')).toHaveCount(2);

    await page.getByTestId('login-email').fill(ADMIN.email);
    await page.getByTestId('login-password').fill('senha-errada');
    await page.getByTestId('login-submit').click();
    await expect(page.getByText('E-mail ou senha incorretos. Confira e tente de novo.')).toBeVisible();

    await page.getByTestId('login-email').fill('ninguem@demo.com');
    await page.getByTestId('login-submit').click();
    // Mesma mensagem para e-mail inexistente e senha errada.
    await expect(page.getByText('E-mail ou senha incorretos. Confira e tente de novo.')).toBeVisible();
  });

  test('sessão vai em cookie httpOnly; nada de token no JavaScript, storage ou corpo da resposta', async ({ page, context }) => {
    let loginBody = '';
    page.on('response', async (r) => {
      if (r.url().includes('/auth/login')) loginBody = await r.text();
    });
    await login(page);

    expect(loginBody).toContain('authenticated');
    expect(loginBody).not.toMatch(/accessToken|refreshToken|eyJ/);

    const cookies = (await context.cookies()).filter((c) => c.name.startsWith('ouvion_'));
    expect(cookies.map((c) => c.name).sort()).toEqual([`ouvion_at_${TENANT}`, `ouvion_rt_${TENANT}`]);
    for (const c of cookies) {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Strict');
    }
    const visible = await page.evaluate(() => ({ cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }));
    expect(visible.cookie).not.toContain('ouvion_');
    expect(visible.local + visible.session).not.toMatch(/eyJ|token/i);
  });

  test('chamadas que mudam estado sem o cabeçalho anti-CSRF são recusadas; rota fora da lista não existe', async ({ page }) => {
    await login(page);
    const noHeader = await page.request.post(`/api/staff/${TENANT}/auth/logout`);
    expect(noHeader.status()).toBe(403);
    const crossOrigin = await page.request.post(`/api/staff/${TENANT}/auth/logout`, { headers: { 'x-ouvion-csrf': '1', origin: 'https://evil.example' } });
    expect(crossOrigin.status()).toBe(403);
    const hidden = await page.request.get(`/api/staff/${TENANT}/audit/../../users/x`);
    expect([404, 400]).toContain(hidden.status());
    const notListed = await page.request.get(`/api/staff/${TENANT}/complaints/00000000-0000-0000-0000-000000000000/external-access`);
    expect(notListed.status()).toBe(404);
    // Ainda logado: as recusas não derrubam a sessão.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Casos' })).toBeVisible();
  });

  test('sair encerra a sessão e o painel volta a exigir login', async ({ page, context }) => {
    await login(page);
    await page.getByTestId('logout').click();
    await page.waitForURL(`**/${TENANT}/entrar`);
    expect((await context.cookies()).filter((c) => c.name.startsWith('ouvion_'))).toEqual([]);
    await page.goto(`/${TENANT}/painel`);
    await expect(page).toHaveURL(new RegExp(`/${TENANT}/entrar$`));
  });

  test('2º fator: código do app, código de recuperação e cadastro com QR (API simulada)', async ({ page }) => {
    await page.route('**/api/staff/demo/auth/login', (r) => r.fulfill({ json: { mfaRequired: true, mfaToken: 'tok-de-teste-1234567890' } }));
    await page.goto(`/${TENANT}/entrar`);
    await page.getByTestId('login-email').fill(ADMIN.email);
    await page.getByTestId('login-password').fill(ADMIN.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('heading', { name: 'Confirme que é você' })).toBeFocused();
    await expectAccessible(page, 'mfa');

    let sent: Record<string, unknown> = {};
    await page.route('**/api/staff/demo/auth/mfa/verify', async (r) => {
      sent = r.request().postDataJSON();
      await r.fulfill({ status: 401, json: { message: 'Código inválido' } });
    });
    await page.getByTestId('mfa-code').fill('123456');
    await page.getByTestId('mfa-submit').click();
    await expect(page.getByText('Código incorreto ou vencido. Confira e tente de novo.')).toBeVisible();
    expect(sent).toEqual({ mfaToken: 'tok-de-teste-1234567890', code: '123456' });

    await page.getByRole('button', { name: 'Usar um código de recuperação' }).click();
    await page.getByTestId('mfa-code').fill('ABCD-EFGH');
    await page.getByTestId('mfa-submit').click();
    await expect.poll(() => sent).toEqual({ mfaToken: 'tok-de-teste-1234567890', recoveryCode: 'ABCD-EFGH' });
  });

  test('cadastro do 2º fator: QR gerado no navegador e códigos de recuperação mostrados com confirmação', async ({ page }) => {
    await page.route('**/api/staff/demo/auth/login', (r) => r.fulfill({ json: { mfaEnrollmentRequired: true, enrollToken: 'enroll-de-teste-123456' } }));
    let scoped = '';
    await page.route('**/api/staff/demo/auth/mfa/enroll', async (r) => {
      scoped = r.request().headers()['x-ouvion-scoped'] ?? '';
      await r.fulfill({ json: { otpauthUri: 'otpauth://totp/OuviON:admin%40demo.com?secret=JBSWY3DPEHPK3PXP&issuer=OuviON' } });
    });
    await page.route('**/api/staff/demo/auth/mfa/activate', (r) => r.fulfill({ json: { recoveryCodes: ['AAAA-1111', 'BBBB-2222'], session: { authenticated: true } } }));

    await page.goto(`/${TENANT}/entrar`);
    await page.getByTestId('login-email').fill(ADMIN.email);
    await page.getByTestId('login-password').fill(ADMIN.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expect(page.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
    expect(scoped).toBe('enroll-de-teste-123456');
    await expectAccessible(page, 'cadastro mfa');

    await page.getByTestId('enroll-code').fill('123456');
    await page.getByTestId('enroll-submit').click();
    await expect(page.getByTestId('recovery-codes')).toContainText('AAAA-1111');
    await expect(page.getByTestId('recovery-continue')).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Guardei meus códigos de recuperação em um lugar seguro.' }).click();
    await expect(page.getByTestId('recovery-continue')).toBeEnabled();
  });
});

test.describe('painel de casos', () => {
  test('lista, filtros e detalhe (acessível nos dois temas)', async ({ page }) => {
    const c = await createViaApi({ title: 'Caso do painel para listar' });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await login(page);
      const row = page.getByRole('link', { name: `Abrir caso ${c.protocol}` });
      await expect(row).toBeVisible();
      await expectAccessible(page, `lista (${scheme})`);

      await page.getByLabel('Situação').selectOption('RESOLVED');
      await expect(row).toHaveCount(0);
      await page.getByRole('button', { name: 'Limpar filtros' }).click();
      await expect(row).toBeVisible();

      await row.click();
      await expect(page.getByRole('heading', { name: c.protocol })).toBeVisible();
      await expect(page.getByText('Anônimo — a identidade não é conhecida nem guardada.')).toBeVisible();
      await expect(page.getByText('Caso do painel para listar').first()).toBeVisible();
      await expectAccessible(page, `detalhe (${scheme})`);
      await page.getByTestId('logout').click();
      await page.waitForURL(`**/${TENANT}/entrar`);
    }
  });

  test('atribuir, mudar situação com motivo, escrever ao denunciante e anotar', async ({ page }) => {
    const c = await createViaApi({ title: 'Caso para conduzir no painel' });
    await login(page);
    await page.getByRole('link', { name: `Abrir caso ${c.protocol}` }).click();
    await expect(page.getByRole('heading', { name: c.protocol })).toBeVisible();

    // Atribuição (ADMIN) leva o caso a "Em investigação".
    await page.getByTestId('assign-select').selectOption({ label: 'Ivo Investigador' });
    await page.getByTestId('assign-submit').click();
    await expect(page.getByText('Investigador atribuído.')).toBeVisible();
    await expect(page.getByText('Em investigação').first()).toBeVisible();

    // Motivo curto é recusado no navegador, com mensagem no campo.
    await page.getByTestId('status-select').selectOption('UNDER_REVIEW');
    await page.getByTestId('status-reason').fill('curto');
    await page.getByTestId('status-apply').click();
    await expect(page.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
    await page.getByTestId('status-reason').fill('Documentos recebidos, seguindo para análise.');
    await page.getByTestId('status-apply').click();
    await expect(page.getByText('Situação atualizada.')).toBeVisible();
    await expect(page.getByText('Em análise').first()).toBeVisible();

    // Encerrar exige a conclusão.
    await page.getByTestId('status-select').selectOption('RESOLVED');
    await page.getByTestId('status-reason').fill('Caso apurado e concluído pela equipe.');
    await page.getByTestId('status-apply').click();
    await expect(page.getByText('Ao encerrar, informe a conclusão do caso.')).toBeVisible();
    await page.getByTestId('conclusion-select').selectOption('SUBSTANTIATED');
    await page.getByTestId('status-apply').click();
    await expect(page.getByText('Situação atualizada.')).toBeVisible();
    await expect(page.getByText('Este caso está encerrado.')).toHaveCount(0); // ADMIN pode reabrir
    await expect(page.getByRole('heading', { name: 'Reabrir caso' })).toBeVisible();

    // Conversa e nota interna.
    await page.getByRole('tab', { name: 'Conversa' }).click();
    await page.getByTestId('staff-message-input').fill('Pode nos passar mais detalhes sobre as datas?');
    await page.getByTestId('staff-message-send').click();
    await expect(page.getByTestId('staff-messages')).toContainText('Pode nos passar mais detalhes sobre as datas?');
    await page.getByRole('tab', { name: 'Notas internas' }).click();
    await page.getByTestId('note-input').fill('Conferir notas fiscais de março.');
    await page.getByTestId('note-submit').click();
    await expect(page.getByTestId('notes-list')).toContainText('Conferir notas fiscais de março.');

    await page.getByRole('tab', { name: 'Histórico' }).click();
    await expect(page.getByTestId('history-list')).toContainText('Em análise → Resolvida');
    await expectAccessible(page, 'detalhe após ações');
  });

  test('sessão vencida no meio do uso leva ao login', async ({ page, context }) => {
    await login(page);
    await context.clearCookies();
    await page.getByRole('link', { name: 'Casos' }).click();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/${TENANT}/entrar$`));
  });
});
