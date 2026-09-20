import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn (tailwind-merge com a escala do design system)', () => {
  it('tamanho de fonte customizado NÃO apaga a cor do texto (bug do botão grande)', () => {
    expect(cn('text-on-brand', 'text-h3')).toBe('text-on-brand text-h3');
    expect(cn('text-body', 'text-on-brand')).toBe('text-body text-on-brand');
    expect(cn('text-fg-2 text-body-sm')).toBe('text-fg-2 text-body-sm');
  });

  it('continua resolvendo conflitos reais: dois tamanhos ou duas cores', () => {
    expect(cn('text-body', 'text-h2')).toBe('text-h2');
    expect(cn('text-fg', 'text-danger')).toBe('text-danger');
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
