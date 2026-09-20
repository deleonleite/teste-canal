import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `tailwind-merge` precisa conhecer a escala tipográfica do design system (`text-h3`, `text-body`…);
 * sem isso ele a trata como COR e descarta, por exemplo, `text-on-brand` quando vem junto de `text-h3`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'h1', 'h2', 'h3', 'body', 'body-sm', 'mono'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
