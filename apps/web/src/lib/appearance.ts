/**
 * Aparência (tema, tamanho da fonte, contraste alto, movimento). Fica só neste aparelho (localStorage):
 * o backend ainda não guarda preferência visual por usuário. Tudo é opcional — sem armazenamento, vale o
 * padrão do sistema (prefers-color-scheme / prefers-contrast / prefers-reduced-motion).
 */

export interface Appearance {
  theme: 'system' | 'light' | 'dark';
  font: 'normal' | 'large' | 'xlarge';
  contrast: 'normal' | 'high';
  motion: 'system' | 'off';
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', font: 'normal', contrast: 'normal', motion: 'system' };
export const APPEARANCE_KEY = 'ouvion.appearance';

const FONT_PCT = { normal: '100%', large: '112.5%', xlarge: '125%' } as const;

export function readAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null') as Partial<Appearance> | null;
    return {
      theme: raw?.theme === 'light' || raw?.theme === 'dark' ? raw.theme : 'system',
      font: raw?.font === 'large' || raw?.font === 'xlarge' ? raw.font : 'normal',
      contrast: raw?.contrast === 'high' ? 'high' : 'normal',
      motion: raw?.motion === 'off' ? 'off' : 'system',
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  if (a.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', a.theme);
  if (a.contrast === 'high') root.setAttribute('data-contrast', 'high');
  else root.removeAttribute('data-contrast');
  if (a.motion === 'off') root.setAttribute('data-motion', 'off');
  else root.removeAttribute('data-motion');
  root.style.fontSize = FONT_PCT[a.font] === '100%' ? '' : FONT_PCT[a.font];
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  applyAppearance(a);
}

/** Script inline curto (antes da pintura) para não piscar o tema errado ao abrir. */
export const APPEARANCE_BOOT_SCRIPT = `try{var a=JSON.parse(localStorage.getItem('${APPEARANCE_KEY}')||'null');if(a){var r=document.documentElement;if(a.theme==='light'||a.theme==='dark')r.setAttribute('data-theme',a.theme);if(a.contrast==='high')r.setAttribute('data-contrast','high');if(a.motion==='off')r.setAttribute('data-motion','off');if(a.font==='large')r.style.fontSize='112.5%';if(a.font==='xlarge')r.style.fontSize='125%'}}catch(e){}`;
