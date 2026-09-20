/** Preset Tailwind do OuviON: mapeia os tokens (CSS variables) para utilitários. Escala de espaço: base 4. */
const v = (name) => `var(--${name})`;

module.exports = {
  theme: {
    extend: {
      colors: {
        canvas: v('bg-canvas'),
        surface: v('bg-surface'),
        sunken: v('bg-surface-sunken'),
        line: v('border-default'),
        'line-strong': v('border-strong'),
        fg: v('text-primary'),
        'fg-2': v('text-secondary'),
        'fg-3': v('text-tertiary'),
        brand: v('brand'),
        'on-brand': v('on-brand'),
        'brand-text': v('brand-text'),
        'brand-2': v('brand-2'),
        success: v('status-success'),
        danger: v('status-danger'),
        warning: v('status-warning'),
        info: v('status-info'),
        neutral: v('status-neutral'),
        critical: v('priority-critical'),
        'tint-success': v('tint-success'),
        'tint-danger': v('tint-danger'),
        'tint-warning': v('tint-warning'),
        'tint-info': v('tint-info'),
        'tint-neutral': v('tint-neutral'),
        'tint-critical': v('tint-critical'),
        ring: v('focus-ring'),
      },
      borderRadius: { sm: v('radius-sm'), md: v('radius-md'), lg: v('radius-lg') },
      boxShadow: { card: v('shadow-card'), modal: v('shadow-modal') },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      // Escala tipográfica (§3), multiplicada pela preferência de fonte do usuário (--font-scale).
      fontSize: {
        display: ['calc(2.25rem * var(--font-scale))', { lineHeight: '1.15', fontWeight: '600' }],
        h1: ['calc(1.5rem * var(--font-scale))', { lineHeight: '1.25', fontWeight: '600' }],
        h2: ['calc(1.25rem * var(--font-scale))', { lineHeight: '1.3', fontWeight: '600' }],
        h3: ['calc(1.0625rem * var(--font-scale))', { lineHeight: '1.35', fontWeight: '600' }],
        body: ['calc(0.9375rem * var(--font-scale))', { lineHeight: '1.5' }],
        'body-sm': ['calc(0.8125rem * var(--font-scale))', { lineHeight: '1.45' }],
        mono: ['calc(0.875rem * var(--font-scale))', { lineHeight: '1.4', fontWeight: '500' }],
      },
      maxWidth: { prose: '68ch' },
      minHeight: { touch: '44px' },
      minWidth: { touch: '44px' },
      transitionDuration: { DEFAULT: 'var(--duration)' },
      transitionTimingFunction: { DEFAULT: 'var(--ease)' },
    },
  },
};
