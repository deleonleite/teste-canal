import type { HTMLAttributes } from 'react';

import { cn } from './cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-md border border-line bg-surface p-6 shadow-card', className)} {...props} />;
}

/** Bloco de texto longo (o relato): coluna limitada a 68ch e entrelinha maior — o texto mais importante do produto. */
export function Prose({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('max-w-prose text-body leading-[1.6] text-fg', className)} {...props} />;
}

/** Protocolo, chave de acesso e hashes: sempre monoespaçados, inconfundíveis com texto comum. */
export function Mono({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('font-mono text-mono tracking-wide', className)} {...props} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-sm bg-sunken', className)} {...props} />;
}
