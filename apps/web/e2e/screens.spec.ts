import { test } from '@playwright/test';

import { createViaApi, fillFacts, goToReview, PNG, REPORT, TENANT } from './helpers';

/** Capturas para revisão visual (não afirmam nada). Rodar com SCREENS=1. */
test.skip(!process.env.SCREENS, 'somente com SCREENS=1');

const OUT = 'test-results/screens';

for (const scheme of ['light', 'dark'] as const) {
  test(`capturas (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/${TENANT}`);
    await page.screenshot({ path: `${OUT}/${scheme}-1-landing.png`, fullPage: true });

    await page.goto(`/${TENANT}/nova-denuncia`);
    await page.screenshot({ path: `${OUT}/${scheme}-2-etapa0.png` });
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.screenshot({ path: `${OUT}/${scheme}-3-etapa1-erros.png` });
    await fillFacts(page);
    await page.screenshot({ path: `${OUT}/${scheme}-4-etapa1.png`, fullPage: true });

    await goToReview(page, { files: [{ name: 'evidencia.png', mimeType: 'image/png', buffer: PNG }] });
    await page.screenshot({ path: `${OUT}/${scheme}-5-revisao.png`, fullPage: true });
    await page.getByRole('checkbox', { name: 'Revisei meu relato com essas orientações em mente.' }).click();
    await page.getByRole('button', { name: 'Enviar relato' }).click();
    await page.getByTestId('receipt-key').waitFor();
    await page.screenshot({ path: `${OUT}/${scheme}-6-confirmacao.png`, fullPage: true });
    await page.getByRole('checkbox', { name: 'Já guardei meu protocolo e minha chave de acesso.' }).click();
    await page.getByRole('button', { name: 'Acompanhar meu relato' }).click();
    await page.getByTestId('tracking-protocol').waitFor();
    await page.getByTestId('message-input').fill('Tenho mais um detalhe importante sobre o caso.');
    await page.getByTestId('message-send').click();
    await page.getByText('Mensagem enviada.').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${scheme}-7-acompanhar.png`, fullPage: true });

    const c = await createViaApi();
    void c;
    void REPORT;
  });
}

test('mobile', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'pt-BR' });
  const page = await ctx.newPage();
  await page.goto(`/${TENANT}`);
  await page.screenshot({ path: `${OUT}/mobile-1-landing.png`, fullPage: true });
  await page.goto(`/${TENANT}/nova-denuncia`);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.screenshot({ path: `${OUT}/mobile-2-etapa1.png` });
  await ctx.close();
});
