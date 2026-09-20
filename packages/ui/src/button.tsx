import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref } from 'react';

import { cn } from './cn';

/**
 * Cor de marca só em ação/destaque (PROMPTFRONT §1): `primary` usa --brand/--on-brand (contraste já
 * garantido). Vermelho (`danger`) é reservado a ações destrutivas de fato (excluir anexo/dossiê); revelar
 * identidade e reabrir caso são procedimentos normais e usam `primary`/`secondary`.
 */
const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50 min-h-touch min-w-touch text-body',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-on-brand hover:brightness-95 active:brightness-90',
        secondary: 'border border-line-strong bg-surface text-fg hover:bg-sunken',
        ghost: 'text-fg hover:bg-sunken',
        danger: 'border border-danger bg-surface text-danger hover:bg-tint-danger',
        link: 'min-h-0 min-w-0 rounded-sm p-0 text-brand-text underline-offset-4 hover:underline',
      },
      size: { md: 'px-4 py-2', lg: 'px-6 py-3 text-h3', icon: 'p-2' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ className, variant, size, asChild, loading, disabled, children, ref, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(button({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {children}
        </>
      )}
    </Comp>
  );
}
