import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const API = 'http://localhost:3001';
export const TENANT = 'demo';

/** Tira: PNG mínimo com metadado identificador (o servidor limpa em relato anônimo). */
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

export const REPORT = {
  type: 'Fraude',
  title: 'Suspeita de fraude em notas fiscais',
  description: 'Descrevo aqui, com o detalhamento mínimo exigido, a suspeita de fraude nas notas fiscais do setor financeiro.',
  involved: 'João da Silva\nMaria Souza',
};

/** Acessibilidade (WCAG 2.1 AA): nenhuma violação séria ou crítica. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  // Espera transições/animações terminarem: o axe mede o contraste com a opacidade do instante (toast entrando).
  await page.waitForFunction(() => document.getAnimations().every((an) => an.playState !== 'running'));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
    `axe em ${label}`,
  ).toEqual([]);
}

/** Cria um relato anônimo direto na API (para testes que não são do formulário). */
export async function createViaApi(over: Record<string, unknown> = {}) {
  const res = await fetch(`${API}/public/complaints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-slug': TENANT },
    body: JSON.stringify({
      isAnonymous: true, contentWarningAcknowledged: true, type: 'FRAUD', title: REPORT.title, description: REPORT.description,
      involvedPeople: ['Alguém de Teste'], ...over,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { protocol: string; accessKey: string; sessionToken: string };
}

export async function fillFacts(page: Page): Promise<void> {
  await page.getByLabel('Sobre o que é o seu relato?').selectOption({ label: REPORT.type });
  await page.getByLabel('Dê um título ao seu relato').fill(REPORT.title);
  await page.getByLabel('Conte com detalhes').fill(REPORT.description);
}

/** Percorre o formulário até a etapa de Revisão (sem enviar). */
export async function goToReview(page: Page, opts: { files?: Array<{ name: string; mimeType: string; buffer: Buffer }> } = {}): Promise<void> {
  await page.goto(`/${TENANT}/nova-denuncia`);
  await page.getByRole('button', { name: 'Continuar' }).click(); // etapa 0 → 1
  await fillFacts(page);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Pessoas citadas neste relato').fill(REPORT.involved);
  await page.getByRole('button', { name: 'Continuar' }).click();
  if (opts.files?.length) await page.locator('#arquivos').setInputFiles(opts.files);
  await page.getByRole('button', { name: 'Continuar' }).click();
}
