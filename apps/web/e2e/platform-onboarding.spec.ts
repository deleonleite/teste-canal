import { expect, test, type Browser, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

import { expectAccessible } from './helpers';
import { platformState } from './global-setup';

const NEW_PASSWORD = 'Definitiva-456!';
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

interface Made {
  slug: string;
  name: string;
  email: string;
  devLink: string;
}

/** Cria uma empresa pelo painel da plataforma (convite) e devolve o link de desenvolvimento. */
async function createByInvite(page: Page): Promise<Made> {
  const slug = `e2e-${uniq()}`;
  const name = `Empresa E2E ${slug}`;
  const email = `admin@${slug}.com`;
  await page.goto('/admin/empresas');
  await page.getByTestId('new-tenant').click();
  await page.getByTestId('nt-name').fill(name);
  await page.getByTestId('nt-slug').fill(slug);
  await page.getByTestId('nt-admin-name').fill('Ana Administradora');
  await page.getByTestId('nt-admin-email').fill(email);
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('invite-result')).toContainText(email);
  const devLink = (await page.getByTestId('dev-invite-link').innerText()).trim();
  return { slug, name, email, devLink };
}

/** Conta nova, sem nenhuma sessão: é como a pessoa convidada chega. */
async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

test.describe('Nova Empresa (SUPER_ADMIN)', () => {
  test.use({ storageState: platformState('superadmin') });

  test('convite por link é o padrão; valida os campos; identificador repetido é recusado', async ({ page }) => {
    await page.goto('/admin/empresas');
    await page.getByTestId('new-tenant').click();
    await expect(page.getByTestId('nt-mode-invite')).toBeChecked();
    await expectAccessible(page, 'nova empresa');

    await page.getByTestId('nt-name').fill('Empresa Ótima S.A.');
    await expect(page.getByTestId('nt-slug')).toHaveValue('empresa-otima-s-a'); // sugestão a partir do nome
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Preencha este campo.').first()).toBeVisible();
    await page.getByTestId('nt-slug').fill('Slug Inválido');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Use de 3 a 40 letras minúsculas, números e hífens (sem espaços).')).toBeVisible();

    // Identificador que já existe (a empresa demo).
    await page.getByTestId('nt-slug').fill('demo');
    await page.getByTestId('nt-admin-name').fill('Alguém');
    await page.getByTestId('nt-admin-email').fill(`alguem-${uniq()}@exemplo.com`);
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Este identificador já está em uso.')).toBeVisible();
  });

  test('jornada completa: convite → senha própria → ativação (destinatário alternativo + DPO) → empresa ATIVA', async ({ page, browser }) => {
    const made = await createByInvite(page);
    await page.getByRole('button', { name: 'Abrir a empresa' }).click();
    await expect(page.getByRole('heading', { name: made.name })).toBeVisible();
    await expect(page.getByText('Em teste').first()).toBeVisible();
    await expect(page.getByTestId('invite-state')).toContainText(`Enviado a ${made.email}; aguardando aceite`);

    // ── A pessoa convidada abre o link ──
    const admin = await freshPage(browser);
    await admin.goto(made.devLink);
    await expectAccessible(admin, 'convite');
    await admin.getByTestId('invite-password').fill(NEW_PASSWORD);
    await admin.getByTestId('invite-confirm').fill('Outra-Senha-789!');
    await admin.getByTestId('invite-submit').click();
    await expect(admin.getByText('As senhas não são iguais.')).toBeVisible();
    await admin.getByTestId('invite-password').fill('fraca');
    await admin.getByTestId('invite-confirm').fill('fraca');
    await admin.getByTestId('invite-submit').click();
    await expect(admin.getByText('A senha não atende às regras.')).toBeVisible();
    await admin.getByTestId('invite-password').fill(NEW_PASSWORD);
    await admin.getByTestId('invite-confirm').fill(NEW_PASSWORD);
    await admin.getByTestId('invite-submit').click();
    await admin.waitForURL(`**/${made.slug}/painel/ativacao`);

    // Link de uso único: a segunda tentativa recebe a mesma mensagem genérica.
    const again = await freshPage(browser);
    await again.goto(made.devLink);
    await again.getByTestId('invite-password').fill(NEW_PASSWORD);
    await again.getByTestId('invite-confirm').fill(NEW_PASSWORD);
    await again.getByTestId('invite-submit').click();
    await expect(again.getByText('Convite inválido ou vencido. Peça um novo convite à equipe OuviON.')).toBeVisible();
    await again.context().close();

    // ── Ativação ──
    await expect(admin.getByRole('heading', { name: 'Ativação da empresa' })).toBeVisible();
    await expect(admin.getByTestId('activate')).toBeDisabled();
    await expectAccessible(admin, 'ativação');
    await admin.getByTestId('recipient-email').fill('destinatario@externo.com');
    await admin.getByTestId('recipient-save').click();
    await expect(admin.getByTestId('recipient-note')).toContainText('Aguardando a pessoa abrir o link do e-mail.');
    const recipientLink = (await admin.getByTestId('recipient-dev-link').innerText()).trim();

    // O destinatário alternativo (sem conta) confirma o e-mail e cadastra o próprio 2º fator, com TOTP real.
    const rec = await freshPage(browser);
    await rec.goto(recipientLink);
    await expectAccessible(rec, 'destinatário alternativo');
    await rec.getByTestId('recipient-confirm').click();
    await expect(rec.getByRole('img', { name: /QR code/ })).toBeVisible();
    const secret = (await rec.getByText('Digite esta chave').innerText()).split(':').pop()!.trim();
    await rec.getByTestId('recipient-code').fill('000000');
    await rec.getByTestId('recipient-submit').click();
    await expect(rec.getByText('Código incorreto ou vencido.')).toBeVisible();
    await rec.getByTestId('recipient-code').fill(authenticator.generate(secret));
    await rec.getByTestId('recipient-submit').click();
    await expect(rec.getByTestId('recipient-done')).toBeVisible();
    await rec.context().close();

    await admin.reload();
    await expect(admin.getByTestId('recipient-note')).toContainText('Destinatário alternativo pronto: destinatario@externo.com.');
    await expect(admin.getByTestId('activate')).toBeDisabled(); // ainda falta o DPO
    await admin.getByTestId('dpo-name').fill('Maria Encarregada');
    await admin.getByTestId('dpo-email').fill('dpo@empresa.com');
    await admin.getByTestId('dpo-save').click();
    await expect(admin.getByTestId('dpo-note')).toContainText('Maria Encarregada');
    await expect(admin.getByTestId('activate')).toBeEnabled();
    await admin.getByTestId('activate').click();
    await expect(admin.getByTestId('activation-active')).toBeVisible();
    await admin.goto(`/${made.slug}/painel`);
    await expect(admin.getByTestId('trial-banner')).toHaveCount(0);
    await expect(admin.getByRole('link', { name: 'Ativação' })).toHaveCount(0);
    // O DPO agora aparece no canal público.
    await admin.goto(`/${made.slug}`);
    await expect(admin.getByText('Maria Encarregada').first()).toBeVisible();
    await admin.context().close();

    await page.reload();
    await expect(page.getByText('Ativa').first()).toBeVisible();
    await expect(page.getByTestId('invite-state')).toContainText(`Aceito por ${made.email}`);
    await expect(page.getByTestId('resend-invite')).toHaveCount(0); // depois de aceito, sem reenvio
  });

  test('reenvio: o convite antigo deixa de valer e o novo funciona', async ({ page, browser }) => {
    const made = await createByInvite(page);
    await page.getByRole('button', { name: 'Abrir a empresa' }).click();
    await page.getByTestId('resend-invite').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Convite reenviado.')).toBeVisible();
    const fresh = (await page.getByTestId('dev-invite-link').innerText()).trim();
    expect(fresh).not.toBe(made.devLink);

    const p = await freshPage(browser);
    const tryLink = async (link: string) => {
      await p.goto(link);
      await p.getByTestId('invite-password').fill(NEW_PASSWORD);
      await p.getByTestId('invite-confirm').fill(NEW_PASSWORD);
      await p.getByTestId('invite-submit').click();
    };
    await tryLink(made.devLink);
    await expect(p.getByText('Convite inválido ou vencido. Peça um novo convite à equipe OuviON.')).toBeVisible();
    await tryLink(fresh);
    await p.waitForURL(`**/${made.slug}/painel/ativacao`);
    await p.context().close();
  });

  test('senha temporária (exceção): exige motivo, mostra a senha UMA vez, troca obrigatória e auditoria alta', async ({ page, browser }) => {
    const slug = `e2e-${uniq()}`;
    const email = `admin@${slug}.com`;
    await page.goto('/admin/empresas');
    await page.getByTestId('new-tenant').click();
    await page.getByTestId('nt-name').fill(`Empresa E2E ${slug}`);
    await page.getByTestId('nt-slug').fill(slug);
    await page.getByTestId('nt-admin-name').fill('Ana Temporária');
    await page.getByTestId('nt-admin-email').fill(email);
    await page.getByTestId('nt-mode-temp').check(); // exige clique consciente
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
    await page.getByTestId('nt-reason').fill('Onboarding assistido por telefone (teste).');
    await page.getByTestId('dialog-confirm').click();
    const temp = (await page.getByTestId('temp-password').innerText()).trim();
    expect(temp.length).toBeGreaterThanOrEqual(8);
    await expect(page.getByText('Esta senha aparece só agora')).toBeVisible();
    await expectAccessible(page, 'senha temporária mostrada uma vez');
    await page.getByRole('button', { name: 'Fechar' }).click();

    // Primeiro login: só a troca, sem painel.
    const t = await freshPage(browser);
    await t.goto(`/${slug}/entrar`);
    await t.getByTestId('login-email').fill(email);
    await t.getByTestId('login-password').fill(temp);
    await t.getByTestId('login-submit').click();
    await expect(t.getByRole('heading', { name: 'Defina sua senha' })).toBeFocused();
    await t.goto(`/${slug}/painel`);
    await expect(t).toHaveURL(new RegExp(`/${slug}/entrar$`)); // sem sessão, o painel segue fechado
    await t.getByTestId('login-email').fill(email);
    await t.getByTestId('login-password').fill(temp);
    await t.getByTestId('login-submit').click();
    await t.getByTestId('change-password').fill('fraca');
    await t.getByTestId('change-submit').click();
    await expect(t.getByText('Não foi possível trocar a senha.')).toBeVisible();
    await t.getByTestId('change-password').fill(temp);
    await t.getByTestId('change-submit').click();
    await expect(t.getByText('Não foi possível trocar a senha.')).toBeVisible(); // igual à temporária
    await t.getByTestId('change-password').fill(NEW_PASSWORD);
    await t.getByTestId('change-submit').click();
    await t.waitForURL(`**/${slug}/painel`);
    await expect(t.getByTestId('trial-banner')).toBeVisible(); // empresa em teste: convida a concluir a ativação
    await t.context().close();

    // Auditoria da plataforma: emissão registrada com o motivo e SEM a senha.
    await page.goto('/admin/auditoria');
    const row = page.getByTestId('paudit-list').getByRole('listitem').filter({ hasText: 'Senha temporária emitida a administrador de empresa' }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Alta');
    await row.getByRole('button', { name: 'Detalhes técnicos' }).click();
    await expect(row).toContainText('Onboarding assistido por telefone (teste).');
    expect(await row.innerText()).not.toContain(temp);
  });
});

test.describe('permissões e telas com 2º fator', () => {
  test.describe('SUPPORT', () => {
    test.use({ storageState: platformState('suporte') });
    test('suporte não vê o botão Nova empresa nem consegue criar pela API', async ({ page }) => {
      await page.goto('/admin/empresas');
      await expect(page.getByRole('heading', { name: 'Empresas' })).toBeVisible();
      await expect(page.getByTestId('new-tenant')).toHaveCount(0);
      const res = await page.request.post('/api/platform/tenants', { headers: { 'x-ouvion-csrf': '1' }, data: { companyName: 'Não Pode', slug: `nao-${uniq()}`, adminEmail: 'x@y.com', adminFullName: 'Não Pode' } });
      expect(res.status()).toBe(403);
    });
  });

  test('convite com 2º fator obrigatório mostra o cadastro do segundo fator antes do painel (API simulada)', async ({ page }) => {
    await page.route('**/api/bff/demo/public/onboarding/admin-invite', (r) => r.fulfill({ json: { email: 'admin@exemplo.com' } }));
    await page.route('**/api/staff/demo/auth/login', (r) => r.fulfill({ json: { mfaEnrollmentRequired: true, enrollToken: 'enroll-de-teste-123456' } }));
    await page.route('**/api/staff/demo/auth/mfa/enroll', (r) => r.fulfill({ json: { otpauthUri: 'otpauth://totp/OuviON:x%40y.com?secret=JBSWY3DPEHPK3PXP&issuer=OuviON' } }));
    await page.route('**/api/staff/demo/auth/mfa/activate', (r) => r.fulfill({ json: { recoveryCodes: ['AAAA-1111', 'BBBB-2222'], session: { authenticated: true } } }));

    await page.goto(`/demo/convite?token=${'a'.repeat(43)}`);
    await page.getByTestId('invite-password').fill(NEW_PASSWORD);
    await page.getByTestId('invite-confirm').fill(NEW_PASSWORD);
    await page.getByTestId('invite-submit').click();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await page.getByTestId('enroll-code').fill('123456');
    await page.getByTestId('enroll-submit').click();
    await expect(page.getByTestId('recovery-codes')).toContainText('AAAA-1111');
    await expect(page.getByTestId('recovery-continue')).toBeDisabled();
    await page.getByRole('checkbox').click();
    await expect(page.getByTestId('recovery-continue')).toBeEnabled();
  });

  test('convite sem token e destinatário sem token explicam o que fazer', async ({ page }) => {
    await page.goto('/demo/convite');
    await expect(page.getByText('Este link está incompleto. Abra o link do e-mail de convite.')).toBeVisible();
    await page.goto('/demo/destinatario');
    await expect(page.getByText('Este link está incompleto. Abra o link do e-mail que você recebeu.')).toBeVisible();
    await expectAccessible(page, 'link incompleto');
  });
});
