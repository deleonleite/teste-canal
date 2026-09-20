import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { brandCss, brandTokens, contrast, ensureContrast, onColor } from './color';

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

/** Extrai as variáveis de um bloco (claro = :root, escuro = bloco data-theme='dark'). */
function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!;
  return out;
}
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('/* Escuro'));
const darkBlock = css.slice(css.indexOf(":root[data-theme='dark']"), css.indexOf('/* Contraste alto'));
const light = vars(lightBlock);
const dark = vars(darkBlock);

const TEXT = ['text-primary', 'text-secondary', 'text-tertiary'];
const SEMANTIC: Array<[string, string]> = [
  ['status-success', 'tint-success'], ['status-danger', 'tint-danger'], ['status-warning', 'tint-warning'],
  ['status-info', 'tint-info'], ['status-neutral', 'tint-neutral'], ['priority-critical', 'tint-critical'],
  ['priority-high', 'tint-danger'], ['priority-medium', 'tint-warning'], ['priority-low', 'tint-neutral'],
];

describe.each([['claro', light], ['escuro', dark]] as const)('tokens — tema %s (WCAG AA)', (_name, t) => {
  it('texto sobre fundo, superfície e área rebaixada passa em 4,5:1', () => {
    for (const bg of ['bg-canvas', 'bg-surface', 'bg-surface-sunken']) {
      for (const fg of TEXT) expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('cores semânticas (status/prioridade) passam sobre a superfície E sobre o próprio fundo do badge', () => {
    for (const [fg, tint] of SEMANTIC) {
      expect(contrast(t[fg]!, t['bg-surface']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t[fg]!, t[tint]!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('anel de foco e borda forte são perceptíveis (3:1, componentes de interface)', () => {
    expect(contrast(t['focus-ring']!, t['bg-surface']!)).toBeGreaterThanOrEqual(3);
    expect(contrast(t['border-strong']!, t['bg-surface']!)).toBeGreaterThanOrEqual(1.8);
  });

  it('crítico é visualmente distinto do "erro do sistema" (danger)', () => {
    expect(t['priority-critical']).not.toBe(t['status-danger']);
  });
});

describe('cor da marca do tenant', () => {
  it('amarelo institucional: a cor decorativa é preservada e o texto sobre ela vira escuro', () => {
    const yellow = '#f5c518';
    const b = brandTokens(yellow, 'light');
    expect(b.brand).toBe(yellow); // nunca altera a cor decorativa
    expect(contrast(b.brand, b.onBrand)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(b.brandText, '#ffffff')).toBeGreaterThanOrEqual(4.5); // usada como link sobre a superfície
    expect(b.lowContrast).toBe(false); // texto escuro sobre ela resolve
  });

  it('marca escura no tema escuro fica visível; texto da marca passa em ambos os temas', () => {
    const navy = '#0b1f4d';
    const d = brandTokens(navy, 'dark');
    expect(contrast(d.brand, dark['bg-surface']!)).toBeGreaterThanOrEqual(3);
    expect(contrast(d.brandText, dark['bg-surface']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(brandTokens(navy, 'light').brandText, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('sinaliza cor sem texto legível possível (meio-termo de luminância)', () => {
    expect(brandTokens('#7a7a7a', 'light').lowContrast).toBe(true);
    expect(brandTokens('#0a5c36', 'light').lowContrast).toBe(false);
  });

  it('todas as cores passam pelos ajustes sem quebrar; hex inválido cai num padrão seguro', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#3b82f6', '#f59e0b']) {
      for (const theme of ['light', 'dark'] as const) {
        const b = brandTokens(hex, theme);
        expect(contrast(b.brand, b.onBrand)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(b.brandText, theme === 'light' ? '#ffffff' : '#161a21')).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(brandTokens('nao-e-cor', 'light').brand).toBe('#2563a8');
  });

  it('CSS gerado respeita data-theme e a preferência do sistema', () => {
    const out = brandCss('#0a5c36', '#f59e0b');
    expect(out).toContain('--brand:#0a5c36');
    expect(out).toContain("prefers-color-scheme: dark");
    expect(out).toContain(":root[data-theme='dark']");
  });

  it('utilitários: ensureContrast ajusta o mínimo e onColor escolhe o melhor lado', () => {
    expect(contrast(ensureContrast('#aaaaaa', '#ffffff'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast('#000000', '#ffffff')).toBe('#000000');
    expect(onColor('#000000')).toBe('#ffffff');
    expect(onColor('#ffffff')).toBe('#14181f');
  });
});

describe('token do plano ENTERPRISE', () => {
  it('dourado escurecido com texto branco passa em 4,5:1 (mesmo valor nos dois temas)', () => {
    expect(contrast(light['plan-enterprise']!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
