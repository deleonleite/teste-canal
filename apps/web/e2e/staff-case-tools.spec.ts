import { expect, test, type Page } from '@playwright/test';

import { createViaApi, expectAccessible, PNG, TENANT } from './helpers';

const PASSWORD = 'Senha-Forte-123!';

async function login(page: Page): Promise<void> {
  await page.goto(`/${TENANT}/entrar`);
  await page.getByTestId('login-email').fill('admin@demo.com');
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(`**/${TENANT}/painel`);
}

async function openCase(page: Page, protocol: string): Promise<void> {
  await page.getByRole('link', { name: `Abrir caso ${protocol}` }).click();
  await expect(page.getByRole('heading', { name: protocol })).toBeVisible();
}

test.describe('ferramentas do caso', () => {
  test('anexos: envia, mostra "em verificação", bloqueia download até a varredura e exclui com confirmação', async ({ page }) => {
    const c = await createViaApi({ title: 'Caso para anexar arquivos' });
    await login(page);
    await openCase(page, c.protocol);
    await page.getByRole('tab', { name: 'Anexos' }).click();
    await expect(page.getByText('Nenhum arquivo neste caso.')).toBeVisible();

    await page.getByTestId('attachment-input').setInputFiles({ name: 'evidencia.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByText('Arquivo enviado. Ele será verificado antes de ficar disponível.')).toBeVisible();
    const row = page.getByTestId('attachment-list').getByRole('listitem').filter({ hasText: 'evidencia.png' });
    await expect(row).toBeVisible();
    // Sem o worker rodando no e2e, o arquivo fica pendente: o download continua bloqueado.
    await expect(row.getByRole('button', { name: 'Baixar evidencia.png' })).toBeDisabled();
    await expectAccessible(page, 'anexos');

    await row.getByRole('button', { name: 'Excluir evidencia.png' }).click();
    await expectAccessible(page, 'diálogo de exclusão');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Arquivo excluído.')).toBeVisible();
    await expect(page.getByText('Nenhum arquivo neste caso.')).toBeVisible();
  });

  test('prazos: pausa exige motivo, mostra pausado e retoma; restrição liga e desliga', async ({ page }) => {
    const c = await createViaApi({ title: 'Caso para pausar prazos' });
    await login(page);
    await openCase(page, c.protocol);

    await page.getByTestId('sla-pause').click();
    await expect(page.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
    await page.getByTestId('sla-reason').fill('Aguardando documentos da área financeira.');
    await page.getByTestId('sla-pause').click();
    await expect(page.getByText('Prazos pausados.')).toBeVisible();
    await expect(page.getByText('Os prazos deste caso estão pausados.')).toBeVisible();
    await expect(page.getByText('Pausado').first()).toBeVisible();
    await page.getByTestId('sla-resume').click();
    await expect(page.getByText('Prazos retomados.')).toBeVisible();
    await expect(page.getByTestId('sla-pause')).toBeVisible();

    await expect(page.getByText('Este caso segue o acesso normal da equipe.')).toBeVisible();
    await page.getByTestId('restriction-toggle').click();
    await expect(page.getByText('Este caso é restrito: só quem tem acesso concedido enxerga.')).toBeVisible();
    await expect(page.getByText('Caso restrito').first()).toBeVisible();
    await page.getByTestId('restriction-toggle').click();
    await expect(page.getByText('Este caso segue o acesso normal da equipe.')).toBeVisible();
  });

  test('casos relacionados: sugere quem cita a mesma pessoa e vincula', async ({ page }) => {
    const person = `Fulano Repetido ${Date.now()}`;
    const a = await createViaApi({ title: 'Primeiro relato sobre a mesma pessoa', involvedPeople: [person] });
    const b = await createViaApi({ title: 'Segundo relato sobre a mesma pessoa', involvedPeople: [person] });
    await login(page);
    await openCase(page, a.protocol);
    await page.getByRole('tab', { name: 'Relacionados' }).click();
    const item = page.getByTestId('related-list').getByRole('listitem').filter({ hasText: b.protocol });
    await expect(item).toBeVisible();
    await expect(item).toContainText('1 pessoa em comum');
    await item.getByRole('button', { name: 'Vincular' }).click();
    await expect(page.getByText('Casos vinculados.')).toBeVisible();
    await expect(item).toHaveCount(0);
  });

  test('impedimento: exige motivo, registra e o caso deixa de aparecer para quem se declarou impedido', async ({ page }) => {
    const c = await createViaApi({ title: 'Caso para declarar impedimento' });
    await login(page);
    await openCase(page, c.protocol);
    await page.getByTestId('recuse-open').click();
    await expectAccessible(page, 'diálogo de impedimento');
    await page.getByTestId('recuse-reason').fill('curto');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByText('Explique com ao menos 10 caracteres.')).toBeVisible();
    await page.getByTestId('recuse-reason').fill('Tenho relação pessoal com uma das pessoas citadas.');
    await page.getByTestId('dialog-confirm').click();
    await page.waitForURL(`**/${TENANT}/painel`);
    await expect(page.getByRole('link', { name: `Abrir caso ${c.protocol}` })).toHaveCount(0);
  });

  test('notificações: contador na navegação, lista, marcar como lida e marcar todas', async ({ page }) => {
    await createViaApi({ title: 'Relato que gera aviso para o comitê' });
    await login(page);
    const badge = page.getByTestId('unread-badge');
    await expect(badge).toBeVisible();
    await page.getByRole('link', { name: /Notificações/ }).click();
    await expect(page.getByRole('heading', { name: 'Notificações' })).toBeVisible();
    await expect(page.getByTestId('notif-list').getByRole('listitem').first()).toBeVisible();
    await expectAccessible(page, 'notificações');

    await page.getByTestId('notif-list').getByRole('button', { name: 'Marcar como lida' }).first().click();
    await page.getByTestId('notif-read-all').click();
    await expect(page.getByText('Nenhuma não lida')).toBeVisible();
    await expect(badge).toHaveCount(0);
  });
});
