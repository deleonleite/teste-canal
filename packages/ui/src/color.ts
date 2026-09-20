/**
 * Cor da marca do tenant (PROMPTFRONT §1.1, §13): a cor decorativa NUNCA é alterada; só se calculam
 * variantes seguras para TEXTO (sobre a marca e da marca sobre a superfície), por tema.
 */

export interface Rgb { r: number; g: number; b: number }

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Luminância relativa (WCAG 2.x). */
export function luminance({ r, g, b }: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mistura `from` em direção a `to` em `t` (0..1), no espaço RGB. */
function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return { r: from.r + (to.r - from.r) * t, g: from.g + (to.g - from.g) * t, b: from.b + (to.b - from.b) * t };
}

/** Escurece/clareia `fg` o mínimo necessário para atingir `min` de contraste contra `bg`. */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  const start = parseHex(fg);
  if (!start || contrast(fg, bg) >= min) return fg;
  const bgLum = luminance(parseHex(bg)!);
  const target: Rgb = bgLum > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const candidate = toHex(mix(start, target, t));
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return toHex(target);
}

/**
 * Texto para usar SOBRE a cor da marca (botão primário): o primeiro entre branco, quase-preto e preto
 * que atinja 4,5:1; se nenhum atingir (luminância média), o de maior contraste.
 */
export function onColor(brand: string): string {
  const options = ['#ffffff', '#14181f', '#000000'];
  return options.find((o) => contrast(brand, o) >= 4.5) ?? options.reduce((best, o) => (contrast(brand, o) > contrast(brand, best) ? o : best));
}

export interface BrandTokens {
  brand: string;
  onBrand: string;
  brandText: string;
  /** true se a cor original NÃO permite texto legível direto (avisar o ADMIN; a UI já se ajusta). */
  lowContrast: boolean;
}

const SURFACE = { light: '#ffffff', dark: '#161a21' } as const;

/**
 * Variantes por tema. `brand` (decorativa) é a cor do tenant; no escuro é clareada só se ficar
 * invisível contra o fundo. `brandText` é a cor da marca usada COMO TEXTO/link, ajustada a 4,5:1.
 */
export function brandTokens(hex: string, theme: 'light' | 'dark'): BrandTokens {
  const base = parseHex(hex) ? toHex(parseHex(hex)!) : '#2563a8';
  const surface = SURFACE[theme];
  const brand = theme === 'dark' && contrast(base, surface) < 3 ? ensureContrast(base, surface, 3) : base;
  const onBrand = onColor(brand);
  const brandText = ensureContrast(brand, surface, 4.5);
  return { brand, onBrand, brandText, lowContrast: contrast(base, '#ffffff') < 4.5 && contrast(base, '#14181f') < 4.5 };
}

/** CSS com as variáveis da marca para os dois temas (respeita data-theme e a preferência do sistema). */
export function brandCss(primary: string, secondary: string): string {
  const p = { light: brandTokens(primary, 'light'), dark: brandTokens(primary, 'dark') };
  const s = { light: brandTokens(secondary, 'light'), dark: brandTokens(secondary, 'dark') };
  const vars = (t: { p: BrandTokens; s: BrandTokens }) =>
    `--brand:${t.p.brand};--on-brand:${t.p.onBrand};--brand-text:${t.p.brandText};` +
    `--brand-2:${t.s.brand};--on-brand-2:${t.s.onBrand};--brand-2-text:${t.s.brandText};`;
  const light = vars({ p: p.light, s: s.light });
  const dark = vars({ p: p.dark, s: s.dark });
  return (
    `:root{${light}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme='light']){${dark}}}` +
    `:root[data-theme='dark']{${dark}}`
  );
}
