import { expect, test, type Page } from '@playwright/test';

import { createViaApi, expectAccessible, fillFacts, REPORT, TENANT } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

/** Mobile é superfície de primeira classe (§12.3): sem rolagem horizontal e com alvos de toque ≥ 44×44 px. */
async function expectMobileOk(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: rolagem horizontal`).toBeLessThanOrEqual(0);

  const small = await page.evaluate(() => {
    const out: string[] = [];
    const sel = 'button, a.no-underline, input:not([type=hidden]):not(.sr-only), select, textarea, [role=checkbox]';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || el.classList.contains('sr-only')) continue;
      // O alvo de toque do checkbox é a linha inteira (rótulo clicável), não o quadradinho visual.
      const target = el.getAttribute('role') === 'checkbox' ? (el.parentElement as HTMLElement) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  expect(small, `${label}: alvos de toque menores que 44px`).toEqual([]);
}

test('landing, formulário e acompanhamento no celular', async ({ page }) => {
  await page.goto(`/${TENANT}`);
  await expectMobileOk(page, 'landing');
  await expectAccessible(page, 'landing mobile');

  await page.getByRole('link', { name: 'Começar meu relato' }).click();
  await expectMobileOk(page, 'etapa 0');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expectMobileOk(page, 'etapa 1');
  await fillFacts(page);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expectMobileOk(page, 'etapa 2');
  await page.getByLabel('Pessoas citadas neste relato').fill(REPORT.involved);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expectMobileOk(page, 'etapa 3');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expectMobileOk(page, 'etapa 4 (revisão)');
  await expectAccessible(page, 'revisão mobile');

  // Barra fixa do rodapé respeita a área segura e não cobre o conteúdo final.
  const bar = page.locator('div.fixed.bottom-0');
  await expect(bar).toBeVisible();
  const c = await createViaApi();
  await page.goto(`/${TENANT}/acompanhar`);
  await page.getByTestId('lookup-protocol').fill(c.protocol);
  await page.getByTestId('lookup-key').fill(c.accessKey);
  await page.getByRole('button', { name: 'Consultar', exact: true }).click();
  await expect(page.getByTestId('tracking-protocol')).toBeVisible();
  await expectMobileOk(page, 'acompanhamento');
  await expectAccessible(page, 'acompanhamento mobile');
});

test('painel da equipe no celular: lista e detalhe sem rolagem horizontal e com alvos de toque grandes', async ({ page }) => {
  const c = await createViaApi({ title: 'Caso para o painel no celular' });
  await page.goto(`/${TENANT}/entrar`);
  await expectMobileOk(page, 'login');
  await page.getByTestId('login-email').fill('admin@demo.com');
  await page.getByTestId('login-password').fill('Senha-Forte-123!');
  await page.getByTestId('login-submit').click();
  await page.waitForURL(`**/${TENANT}/painel`);
  await expect(page.getByRole('link', { name: `Abrir caso ${c.protocol}` })).toBeVisible();
  await expectMobileOk(page, 'lista de casos');
  await expectAccessible(page, 'lista mobile');
  await page.getByRole('link', { name: `Abrir caso ${c.protocol}` }).click();
  await expect(page.getByRole('heading', { name: c.protocol })).toBeVisible();
  await expectMobileOk(page, 'detalhe do caso');
  await expectAccessible(page, 'detalhe mobile');
});
