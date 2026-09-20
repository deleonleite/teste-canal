import { expect, test, type Browser, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

import { createViaApi, expectAccessible, TENANT } from './helpers';
import { PLATFORM_TOTP_SECRET, platformState } from './global-setup';

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const REASON = 'Cliente relatou que o relato não abre no painel e pediu ajuda (chamado aberto).';
/** Código do PRÓXIMO passo: o do login já foi gasto, e a aprovação exige um código novo (MFA recente). */
const freshCode = () => authenticator.clone({ epoch: Date.now() + 30_000 }).generate(PLATFORM_TOTP_SECRET);

async function ctxFor(browser: Browser, state: string): Promise<Page> {
  return (await browser.newContext({ storageState: platformState(state) })).newPage();
}

/** SUPPORT pede acesso a uma denúncia da empresa demo, pela tela. Devolve o protocolo e o título (sigiloso). */
async function requestAsSupport(support: Page) {
  const title = `Título sigiloso E2E ${uniq()}`;
  const c = await createViaApi({ title });
  await support.goto('/admin/empresas');
  await support.getByRole('link', { name: 'Abrir Empresa Demo' }).click();
  await support.getByTestId('bg-request').click();
  await support.getByTestId('bg-protocol').fill(c.protocol);
  await support.getByTestId('bg-reason').fill(REASON);
  await support.getByTestId('bg-ticket').fill(`CHAM-${uniq()}`);
  await support.getByTestId('dialog-confirm').click();
  await support.waitForURL('**/admin/quebra-de-vidro');
  return { protocol: c.protocol, title };
}

const pendingItem = (page: Page, protocol: string) => page.getByTestId('bg-pending').getByRole('listitem').filter({ hasText: protocol });

test.describe('quebra de vidro', () => {
  test('pedido do suporte: validações, item inexistente e fila de aprovação sem botão de aprovar para ele', async ({ browser }) => {
    const support = await ctxFor(browser, 'suporte');
    await support.goto('/admin/empresas');
    await support.getByRole('link', { name: 'Abrir Empresa Demo' }).click();
    await support.getByTestId('bg-request').click();
    await expectAccessible(support, 'pedido de quebra de vidro');

    await support.getByTestId('dialog-confirm').click();
    await expect(support.getByText('Preencha este campo.').first()).toBeVisible();
    await support.getByTestId('bg-protocol').fill('DEN-2026-NAOEXISTE');
    await support.getByTestId('bg-reason').fill('curto');
    await support.getByTestId('bg-ticket').fill('CHAM-1');
    await support.getByTestId('dialog-confirm').click();
    await expect(support.getByText('Explique com ao menos 20 caracteres.')).toBeVisible();
    await support.getByTestId('bg-reason').fill(REASON);
    await support.getByTestId('dialog-confirm').click();
    await expect(support.getByText('Não encontramos esse item nesta empresa.')).toBeVisible(); // o painel não lista denúncias

    // Anexo: pede o nome do arquivo.
    await support.getByTestId('bg-scope').selectOption('ATTACHMENT');
    await support.getByTestId('dialog-confirm').click();
    await expect(support.getByTestId('bg-filename')).toBeVisible();
    await support.context().close();
  });

  test('jornada: pedido → aprovação por OUTRO super admin com código novo → uso com contagem regressiva → cliente avisado → revogação', async ({ browser }) => {
    const support = await ctxFor(browser, 'suporte');
    const { protocol, title } = await requestAsSupport(support);

    await expect(pendingItem(support, protocol)).toBeVisible();
    await expect(pendingItem(support, protocol).getByRole('button', { name: 'Aprovar' })).toHaveCount(0); // suporte não decide
    await expect(support.getByTestId('bg-rules')).toContainText('no máximo 1 hora');
    await expectAccessible(support, 'pedidos (suporte)');

    // ── Aprovação ──
    const approver = await ctxFor(browser, 'approver-a');
    await approver.goto('/admin/quebra-de-vidro');
    const item = pendingItem(approver, protocol);
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: 'Aprovar' }).click();
    await expectAccessible(approver, 'diálogo de aprovação');
    await approver.getByTestId('bg-minutes').fill('70');
    await approver.getByTestId('bg-code').fill('123456');
    await approver.getByTestId('dialog-confirm').click();
    await expect(approver.getByText('Informe de 5 a 60 minutos.')).toBeVisible();
    await approver.getByTestId('bg-minutes').fill('20');
    await approver.getByTestId('bg-code').fill('000000');
    await approver.getByTestId('dialog-confirm').click();
    await expect(approver.getByText('Código incorreto ou já utilizado.')).toBeVisible();
    await approver.getByTestId('bg-code').fill(freshCode());
    await approver.getByTestId('dialog-confirm').click();
    await expect(approver.getByText('Acesso aprovado. A empresa foi avisada.')).toBeVisible();
    const active = approver.getByTestId('bg-active').getByRole('listitem').filter({ hasText: protocol });
    await expect(active).toBeVisible();
    await expect(active).toContainText('Aprovado por E2E Aprovador A');

    // ── Uso pelo suporte ──
    await support.reload();
    await support.getByRole('link', { name: `Abrir pedido de ${protocol}` }).click();
    await expect(support.getByTestId('bg-view-banner')).toContainText('Acesso excepcional');
    await expect(support.getByTestId('bg-countdown')).toContainText(/Tempo restante: (19|20):\d\d/);
    await expect(support.getByTestId('bg-content')).toHaveCount(0); // nada é carregado sem o clique (cada abertura é um uso)
    await support.getByTestId('bg-open').click();
    await expect(support.getByTestId('bg-content')).toContainText(title);
    await expect(support.getByTestId('bg-content')).toContainText('A identidade do denunciante nunca é exibida aqui.');
    await expectAccessible(support, 'conteúdo em quebra de vidro');
    // Só quem pediu abre: o aprovador vê a página, mas não o botão.
    await approver.goto(`/admin/quebra-de-vidro`);
    await approver.getByTestId('bg-active').getByRole('listitem').filter({ hasText: protocol }).getByRole('button', { name: 'Revogar agora' }).waitFor();
    await expect(approver.getByTestId('bg-active').getByRole('listitem').filter({ hasText: protocol }).getByRole('link', { name: 'Abrir' })).toHaveCount(0);

    // ── O cliente é avisado e vê o registro na PRÓPRIA auditoria ──
    const tenantAdmin = await (await browser.newContext()).newPage();
    await tenantAdmin.goto(`/${TENANT}/entrar`);
    await tenantAdmin.getByTestId('login-email').fill('admin@demo.com');
    await tenantAdmin.getByTestId('login-password').fill('Senha-Forte-123!');
    await tenantAdmin.getByTestId('login-submit').click();
    await tenantAdmin.waitForURL(`**/${TENANT}/painel`);
    await tenantAdmin.goto(`/${TENANT}/painel/notificacoes`);
    const note = tenantAdmin.getByTestId('notif-list').getByRole('listitem').filter({ hasText: protocol }).first();
    await expect(note).toContainText('Acesso excepcional da plataforma ao seu ambiente');
    await expect(note).toContainText('Importante'); // crítica: ignora silenciamento
    await expect(note).toContainText('E2E Aprovador A');
    await expect(note).toContainText(REASON);
    await tenantAdmin.goto(`/${TENANT}/painel/auditoria`);
    await tenantAdmin.getByLabel('Ação', { exact: true }).selectOption('BREAK_GLASS_PLATFORM');
    const line = tenantAdmin.getByTestId('bg-audit-line').filter({ hasText: protocol });
    await expect(line.filter({ hasText: 'Conteúdo aberto' })).toBeVisible();
    await expect(line.filter({ hasText: 'Acesso aprovado' })).toContainText(REASON);
    await expectAccessible(tenantAdmin, 'auditoria da empresa com quebra de vidro');
    await tenantAdmin.context().close();

    // ── Revogação antecipada: o acesso termina e o conteúdo some ──
    await approver.getByTestId('bg-active').getByRole('listitem').filter({ hasText: protocol }).getByRole('button', { name: 'Revogar agora' }).click();
    await approver.getByTestId('bg-note').fill('Problema resolvido, acesso não é mais necessário.');
    await approver.getByTestId('dialog-confirm').click();
    await expect(approver.getByText('Acesso revogado.')).toBeVisible();
    await support.reload();
    await expect(support.getByTestId('bg-not-active')).toBeVisible();
    await expect(support.getByTestId('bg-open')).toHaveCount(0);
    await expect(support.getByTestId('bg-content')).toHaveCount(0);

    await support.context().close();
    await approver.context().close();

    // ── Auditoria da plataforma: pedido, aprovação e uso, com gravidade e destaque próprio ──
    const admin = await ctxFor(browser, 'superadmin');
    await admin.goto('/admin/auditoria');
    await admin.getByLabel('Gravidade').selectOption('CRITICAL');
    const crit = admin.getByTestId('paudit-list').getByRole('listitem').filter({ hasText: 'Quebra de vidro utilizada' }).first();
    await expect(crit).toBeVisible();
    await expect(crit).toHaveAttribute('data-break-glass', 'true');
    await expect(crit).toContainText('Crítica');
    await admin.context().close();
  });

  test('recusa exige justificativa e fecha o pedido; dashboard mostra o atalho', async ({ browser }) => {
    const support = await ctxFor(browser, 'suporte');
    const { protocol } = await requestAsSupport(support);
    await support.context().close();

    const approver = await ctxFor(browser, 'approver-b');
    await approver.goto('/admin/dashboard');
    await expect(approver.getByTestId('bg-card')).toContainText('aguardando decisão');
    await approver.getByTestId('bg-card').getByRole('link', { name: 'Ver pedidos' }).click();
    const item = pendingItem(approver, protocol);
    await item.getByRole('button', { name: 'Recusar' }).click();
    await approver.getByTestId('bg-note').fill('curta');
    await approver.getByTestId('dialog-confirm').click();
    await expect(approver.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
    await approver.getByTestId('bg-note').fill('Chamado sem justificativa suficiente para o acesso.');
    await approver.getByTestId('dialog-confirm').click();
    await expect(approver.getByText('Pedido recusado.')).toBeVisible();
    await expect(approver.getByTestId('bg-history').getByRole('listitem').filter({ hasText: protocol })).toContainText('Recusado');
    await approver.context().close();
  });

  test('quem pediu não aprova o próprio pedido (mensagem clara); financeiro não vê a tela', async ({ browser }) => {
    // SUPER_ADMIN que pede e tenta aprovar o próprio pedido.
    const own = await ctxFor(browser, 'approver-c');
    const c = await createViaApi({ title: `Título E2E ${uniq()}` });
    await own.goto('/admin/empresas');
    await own.getByRole('link', { name: 'Abrir Empresa Demo' }).click();
    await own.getByTestId('bg-request').click();
    await own.getByTestId('bg-protocol').fill(c.protocol);
    await own.getByTestId('bg-reason').fill(REASON);
    await own.getByTestId('bg-ticket').fill('CHAM-PROPRIO');
    await own.getByTestId('dialog-confirm').click();
    await own.waitForURL('**/admin/quebra-de-vidro');
    await pendingItem(own, c.protocol).getByRole('button', { name: 'Aprovar' }).click();
    await own.getByTestId('bg-code').fill(freshCode());
    await own.getByTestId('dialog-confirm').click();
    await expect(own.getByText('Você não pode aprovar o seu próprio pedido.')).toBeVisible();
    await own.context().close();

    const fin = await ctxFor(browser, 'financeiro');
    await fin.goto('/admin/quebra-de-vidro');
    await expect(fin.getByText('Seu perfil não tem acesso a esta área.')).toBeVisible();
    expect((await fin.request.get('/api/platform/break-glass')).status()).toBe(403);
    await fin.context().close();
  });
});
