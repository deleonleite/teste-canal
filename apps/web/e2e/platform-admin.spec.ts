import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

import { API, createViaApi, expectAccessible } from './helpers';
import { PLATFORM_PASSWORD, PLATFORM_TOTP_SECRET, platformState } from './global-setup';

const SUSP = 'e2e-suspensao';

/** Login pela tela (senha + código do app) — usado só onde o teste é sobre o próprio login. */
async function uiLogin(page: Page, email: string, password = PLATFORM_PASSWORD): Promise<void> {
  await page.goto('/loginadm');
  await page.getByTestId('padm-email').fill(email);
  await page.getByTestId('padm-password').fill(password);
  await page.getByTestId('padm-submit').click();
}

test.describe('login da plataforma', () => {
  test('exige sessão; falha genérica; 2º fator obrigatório; cookies próprios e httpOnly', async ({ page, context }) => {
    await page.goto('/admin/dashboard');
    await expect(page).toHaveURL(/\/loginadm$/);
    await expectAccessible(page, 'loginadm');

    await page.getByTestId('padm-submit').click();
    await expect(page.getByText('Preencha este campo.')).toHaveCount(2);

    await uiLogin(page, 'e2e-login@ouvion.com', 'senha-errada');
    const generic = page.getByText('Acesso restrito à equipe OuviON. Confira e-mail e senha.');
    await expect(generic).toBeVisible();
    await page.getByTestId('padm-email').fill('ninguem@ouvion.com');
    await page.getByTestId('padm-submit').click();
    await expect(generic).toBeVisible(); // igual para e-mail inexistente

    await uiLogin(page, 'e2e-login@ouvion.com');
    await expect(page.getByRole('heading', { name: 'Confirme que é você' })).toBeFocused();
    await expectAccessible(page, 'mfa da plataforma');
    // Sem o código não há sessão: /admin continua fechado.
    await page.goto('/admin/dashboard');
    await expect(page).toHaveURL(/\/loginadm$/);

    await uiLogin(page, 'e2e-login@ouvion.com');
    await page.getByTestId('padm-mfa-code').fill('000000');
    await page.getByTestId('padm-mfa-submit').click();
    await expect(page.getByText('Código incorreto ou vencido. Confira e tente de novo.')).toBeVisible();
    await page.getByTestId('padm-mfa-code').fill(authenticator.generate(PLATFORM_TOTP_SECRET));
    await page.getByTestId('padm-mfa-submit').click();
    await page.waitForURL('**/admin/dashboard');
    await expect(page.getByTestId('operator-role')).toHaveText('Super administrador');

    const cookies = (await context.cookies()).filter((c) => c.name.startsWith('ouvion_'));
    expect(cookies.map((c) => c.name).sort()).toEqual(['ouvion_pat', 'ouvion_prt']); // espaço próprio: nada de ouvion_at_<empresa>
    for (const c of cookies) {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Strict');
    }
    const visible = await page.evaluate(() => document.cookie + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(visible).not.toMatch(/ouvion_p|eyJ|token/i);
  });

  test('troca da senha temporária e cadastro do 2º fator com QR (API simulada)', async ({ page }) => {
    await page.route('**/api/platform/auth/login', (r) => r.fulfill({ json: { passwordChangeRequired: true, token: 'tok-de-troca-1234567890' } }));
    let sent: Record<string, unknown> = {};
    await page.route('**/api/platform/auth/change-password', async (r) => {
      sent = r.request().postDataJSON();
      await r.fulfill({ json: { mfaEnrollmentRequired: true, enrollToken: 'enroll-de-teste-123456' } });
    });
    await page.route('**/api/platform/auth/mfa/enroll', (r) =>
      r.fulfill({ json: { otpauthUri: 'otpauth://totp/OuviON:x%40ouvion.com?secret=JBSWY3DPEHPK3PXP&issuer=OuviON' } }),
    );
    await page.route('**/api/platform/auth/mfa/activate', (r) => r.fulfill({ json: { recoveryCodes: ['AAAA-1111', 'BBBB-2222'], session: { authenticated: true } } }));

    await uiLogin(page, 'novo@ouvion.com', 'Temporaria-123!');
    await expect(page.getByRole('heading', { name: 'Defina sua senha' })).toBeFocused();
    await expectAccessible(page, 'troca de senha');
    await page.getByTestId('padm-new-password').fill('Definitiva-456!');
    await page.getByTestId('padm-change-submit').click();
    expect(sent).toEqual({ token: 'tok-de-troca-1234567890', newPassword: 'Definitiva-456!' });

    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expect(page.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
    await expectAccessible(page, 'cadastro do 2º fator');
    await page.getByTestId('padm-enroll-code').fill('123456');
    await page.getByTestId('padm-enroll-submit').click();
    await expect(page.getByTestId('padm-recovery-codes')).toContainText('AAAA-1111');
    await expect(page.getByTestId('padm-recovery-continue')).toBeDisabled();
    await page.getByRole('checkbox').click();
    await expect(page.getByTestId('padm-recovery-continue')).toBeEnabled();
  });

  test('sair encerra a sessão e o painel volta a exigir login', async ({ page, context }) => {
    await uiLogin(page, 'e2e-logout@ouvion.com');
    await page.getByTestId('padm-mfa-code').fill(authenticator.generate(PLATFORM_TOTP_SECRET));
    await page.getByTestId('padm-mfa-submit').click();
    await page.waitForURL('**/admin/dashboard');
    await page.getByTestId('padm-logout').click();
    await page.waitForURL('**/loginadm');
    expect((await context.cookies()).filter((c) => c.name.startsWith('ouvion_p'))).toEqual([]);
    await page.goto('/admin/dashboard');
    await expect(page).toHaveURL(/\/loginadm$/);
  });

  test('chamadas sem o cabeçalho anti-CSRF são recusadas e não há rota de conteúdo de denúncia', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: platformState('superadmin') });
    const req = ctx.request;
    expect((await req.post('/api/platform/auth/logout')).status()).toBe(403);
    expect((await req.post('/api/platform/auth/logout', { headers: { 'x-ouvion-csrf': '1', origin: 'https://evil.example' } })).status()).toBe(403);
    // A lista de rotas da plataforma não inclui NADA de denúncia, anexo, mensagem ou identidade.
    for (const path of ['complaints', 'attachments', 'messages', 'reveal-identity', 'complaints/00000000-0000-0000-0000-000000000000']) {
      expect((await req.get(`/api/platform/${path}`)).status(), path).toBe(404);
    }
    await ctx.close();
  });
});

test.describe('perfis internos', () => {
  test.describe('SUPER_ADMIN', () => {
    test.use({ storageState: platformState('superadmin') });

    test('vê os 6 itens; dashboard rotula o que é demonstração e traz empresas reais', async ({ page }) => {
      await page.goto('/admin/dashboard');
      const nav = page.getByRole('navigation', { name: 'Navegação da plataforma' });
      for (const name of ['Dashboard', 'Empresas', 'Assinaturas', 'Usuários internos', 'Auditoria', 'Configurações']) {
        await expect(nav.getByRole('link', { name })).toBeVisible();
      }
      await expect(page.getByTestId('mock-notice')).toContainText('Dados de demonstração');
      await expect(page.getByTestId('dashboard-cards').getByText('Dados de demonstração').first()).toBeVisible();
      await expect(page.getByTestId('recent-tenants')).toContainText('Empresa Demo');
      await expectAccessible(page, 'dashboard');

      await page.getByRole('link', { name: 'Assinaturas' }).click();
      await expect(page.getByTestId('mock-notice')).toBeVisible();
      await expect(page.getByTestId('mock-subscriptions')).toContainText('Enterprise');
      await expectAccessible(page, 'assinaturas (demonstração)');
    });

    test('empresas: filtros e busca; detalhe com só números e a garantia de privacidade', async ({ page }) => {
      await createViaApi({ title: 'Relato para contar nas estatísticas' });
      await page.goto('/admin/empresas');
      await expect(page.getByTestId('tenant-list')).toContainText('Empresa Demo');
      await expectAccessible(page, 'empresas');

      await page.getByLabel('Buscar por nome ou identificador').fill('nao-existe-mesmo');
      await expect(page.getByText('Nenhuma empresa encontrada.')).toBeVisible();
      await page.getByLabel('Buscar por nome ou identificador').fill('demo');
      await page.getByRole('link', { name: 'Abrir Empresa Demo' }).click();
      await expect(page.getByRole('heading', { name: 'Empresa Demo' })).toBeVisible();
      await expect(page.getByText('Garantia de privacidade: este painel não lê denúncias')).toBeVisible();
      const body = await page.locator('main').innerText();
      expect(body).not.toMatch(/Relato para contar nas estatísticas|Suspeita de fraude/); // nunca conteúdo
      await expect(page.getByRole('button', { name: 'Solicitar acesso de suporte' })).toBeDisabled();
      await expectAccessible(page, 'detalhe da empresa');
    });

    test('suspensão comercial: motivo obrigatório, equipe perde o login, canal público segue recebendo, reativa e audita', async ({ page }) => {
      await page.goto('/admin/empresas');
      await page.getByRole('link', { name: 'Abrir Empresa Suspensão E2E' }).click();
      await page.getByTestId('tenant-toggle').click();
      await expectAccessible(page, 'diálogo de suspensão');
      await page.getByTestId('tenant-reason').fill('curto');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
      await page.getByTestId('tenant-reason').fill('Inadimplência há mais de 60 dias (teste).');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByText('Empresa suspensa.')).toBeVisible();
      await expect(page.getByText('Suspensa').first()).toBeVisible();

      try {
        // A equipe da empresa suspensa não entra...
        const staff = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-slug': SUSP }, body: JSON.stringify({ email: `admin@${SUSP}.com`, password: 'Senha-Forte-123!' }) });
        expect(staff.status).not.toBe(201);
        // ...mas o canal público continua recebendo denúncias.
        const pub = await fetch(`${API}/public/complaints`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tenant-slug': SUSP },
          body: JSON.stringify({
            isAnonymous: true, contentWarningAcknowledged: true, type: 'FRAUD', title: 'Relato em empresa suspensa',
            description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas fiscais.', involvedPeople: ['Alguém'],
          }),
        });
        expect(pub.status).toBe(201);
      } finally {
        await page.getByTestId('tenant-toggle').click();
        await page.getByTestId('tenant-reason').fill('Pagamento regularizado (teste).');
        await page.getByTestId('dialog-confirm').click();
        await expect(page.getByText('Empresa reativada.')).toBeVisible();
      }

      await page.getByRole('link', { name: 'Auditoria' }).click();
      const row = page.getByTestId('paudit-list').getByRole('listitem').filter({ hasText: 'Empresa suspensa' }).first();
      await expect(row).toBeVisible();
      await expect(row).toContainText('Alta');
      await row.getByRole('button', { name: 'Detalhes técnicos' }).click();
      await expect(row).toContainText('Inadimplência há mais de 60 dias (teste).');
    });

    test('usuários internos: banner, criação com senha temporária (troca + 2º fator reais no primeiro acesso) e desativação', async ({ page, browser }) => {
      await page.goto('/admin/usuarios-internos');
      await expect(page.getByTestId('iu-banner')).toContainText('Nenhum perfil interno acessa conteúdo de denúncia por padrão');
      await expectAccessible(page, 'usuários internos');

      const email = `novo-${Date.now()}@ouvion.com`;
      await page.getByTestId('iu-new').click();
      await page.getByTestId('iu-name').fill('Pessoa Nova de Teste');
      await page.getByTestId('iu-email').fill(email);
      await page.getByTestId('iu-password').fill('fraca');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByText('Senha fraca:')).toBeVisible();
      await page.getByTestId('iu-password').fill('Temporaria-123!');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByText('Usuário criado.')).toBeVisible();
      const item = page.getByTestId('iu-list').getByRole('listitem').filter({ hasText: email });
      await expect(item).toContainText('Troca de senha pendente');

      // Primeiro acesso REAL da pessoa nova: troca a senha, cadastra o 2º fator e só então entra.
      const ctx = await browser.newContext();
      const np = await ctx.newPage();
      await uiLogin(np, email, 'Temporaria-123!');
      await np.getByTestId('padm-new-password').fill('Temporaria-123!');
      await np.getByTestId('padm-change-submit').click();
      await expect(np.getByText('Não foi possível trocar a senha.')).toBeVisible();
      await np.getByTestId('padm-new-password').fill('Definitiva-456!');
      await np.getByTestId('padm-change-submit').click();
      await expect(np.getByRole('img', { name: /QR code/ })).toBeVisible();
      const secret = (await np.getByText('Digite esta chave').innerText()).split(':').pop()!.trim();
      await np.getByTestId('padm-enroll-code').fill(authenticator.generate(secret));
      await np.getByTestId('padm-enroll-submit').click();
      await expect(np.getByTestId('padm-recovery-codes')).toBeVisible();
      await np.getByRole('checkbox').click();
      await np.getByTestId('padm-recovery-continue').click();
      await np.waitForURL('**/admin/dashboard');
      await expect(np.getByTestId('operator-role')).toHaveText('Suporte');
      await expect(np.getByRole('link', { name: 'Usuários internos' })).toHaveCount(0);

      // Desativar derruba a sessão dela na hora.
      await page.reload();
      await item.getByRole('button', { name: 'Desativar' }).click();
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByText('Usuário atualizado.')).toBeVisible();
      await np.goto('/admin/empresas');
      await expect(np).toHaveURL(/\/loginadm/);
      await ctx.close();

      // O próprio operador não tem como se desativar nem trocar o próprio perfil.
      const self = page.getByTestId('iu-list').getByRole('listitem').filter({ hasText: 'Super Admin Demo' });
      await expect(self.getByRole('button', { name: 'Desativar' })).toBeDisabled();
    });

    test('auditoria: eventos da plataforma com gravidade, filtro e detalhes técnicos; configurações sem toggle de MFA', async ({ page }) => {
      await page.goto('/admin/auditoria');
      await expect(page.getByTestId('paudit-list').getByRole('listitem').first()).toBeVisible();
      await expectAccessible(page, 'auditoria da plataforma');
      await page.getByLabel('Gravidade').selectOption('HIGH');
      const rows = page.getByTestId('paudit-list').getByRole('listitem');
      await expect(rows.first()).toContainText('Alta');
      const first = rows.first();
      await first.getByRole('button', { name: 'Detalhes técnicos' }).click();
      await expect(first).toContainText('IP');

      await page.goto('/admin/configuracoes');
      await expect(page.getByTestId('mfa-policy')).toContainText('Esta política não é configurável.');
      await expect(page.getByRole('checkbox')).toHaveCount(0); // sem toggle de MFA
      await expectAccessible(page, 'configurações da plataforma');
    });
  });

  test.describe('SUPPORT', () => {
    test.use({ storageState: platformState('suporte') });

    test('vê Dashboard e Empresas (sem suspender); não vê o resto; a API nega o que a tela esconde', async ({ page }) => {
      await page.goto('/admin/dashboard');
      const nav = page.getByRole('navigation', { name: 'Navegação da plataforma' });
      await expect(nav.getByRole('link', { name: 'Empresas' })).toBeVisible();
      for (const name of ['Assinaturas', 'Usuários internos', 'Auditoria', 'Configurações']) await expect(nav.getByRole('link', { name })).toHaveCount(0);

      await page.getByRole('link', { name: 'Empresas' }).click();
      await page.getByRole('link', { name: 'Abrir Empresa Demo' }).click();
      await expect(page.getByRole('heading', { name: 'Empresa Demo' })).toBeVisible();
      await expect(page.getByTestId('tenant-toggle')).toHaveCount(0);

      for (const path of ['users', 'audit']) expect((await page.request.get(`/api/platform/${path}`)).status(), path).toBe(403);
      await page.goto('/admin/usuarios-internos');
      await expect(page.getByText('Seu perfil não tem acesso a esta área.')).toBeVisible();
    });
  });

  test.describe('FINANCIAL', () => {
    test.use({ storageState: platformState('financeiro') });

    test('vê Dashboard e Assinaturas; não vê Empresas nem lista empresas pela API', async ({ page }) => {
      await page.goto('/admin/dashboard');
      const nav = page.getByRole('navigation', { name: 'Navegação da plataforma' });
      await expect(nav.getByRole('link', { name: 'Assinaturas' })).toBeVisible();
      for (const name of ['Empresas', 'Usuários internos', 'Auditoria', 'Configurações']) await expect(nav.getByRole('link', { name })).toHaveCount(0);
      await expect(page.getByTestId('recent-tenants')).toHaveCount(0); // sem lista de empresas
      expect((await page.request.get('/api/platform/tenants')).status()).toBe(403);
      await page.goto('/admin/empresas');
      await expect(page.getByText('Seu perfil não tem acesso a esta área.')).toBeVisible();
    });
  });
});
