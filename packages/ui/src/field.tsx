'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as LabelPrimitive from '@radix-ui/react-label';
import { Check } from 'lucide-react';
import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import { cn } from './cn';

const control =
  'w-full rounded-sm border border-line-strong bg-surface px-3 text-body text-fg placeholder:text-fg-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-danger disabled:opacity-60';

export function Label({ className, ...props }: LabelPrimitive.LabelProps) {
  return <LabelPrimitive.Root className={cn('text-body font-medium text-fg', className)} {...props} />;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  optional?: string;
  /** Renderiza o controle recebendo os ids/aria corretos (o rótulo e o erro ficam sempre associados). */
  children: (a: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': true | undefined }) => ReactNode;
  className?: string;
}

/** Rótulo + controle + dica + erro. Erro com role="alert" e ligado ao campo por aria-describedby. */
export function Field({ label, hint, error, optional, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const described = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={id}>
        {label}
        {optional && <span className="ml-2 text-body-sm font-normal text-fg-3">{optional}</span>}
      </Label>
      {hint && (
        <p id={hintId} className="text-body-sm text-fg-2">
          {hint}
        </p>
      )}
      {children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined })}
      {error && (
        <p id={errId} role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(control, 'min-h-touch py-2', className)} {...props} />;
}

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(control, 'min-h-[7.5rem] py-3 leading-relaxed', className)} {...props} />;
}

/** Seletor nativo estilizado: acessível por teclado e leitor de tela em qualquer aparelho, com o seletor do próprio sistema no celular. */
export function Select({ className, ref, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <select ref={ref} className={cn(control, 'min-h-touch py-2', className)} {...props}>
      {children}
    </select>
  );
}

/**
 * Contador discreto (142/200). Sem cor de alerta até passar do limite: mostrar "faltam N caracteres" a cada
 * tecla pune quem está pensando enquanto escreve (PROMPTFRONT §11.1).
 */
export function CharCounter({ value, max, label }: { value: number; max: number; label?: string }) {
  const over = value > max;
  return (
    <p className={cn('text-right text-body-sm', over ? 'text-danger' : 'text-fg-3')} aria-live="polite">
      <span className="sr-only">{label}</span>
      {value}/{max}
    </p>
  );
}

export function Checkbox({
  label,
  description,
  className,
  checked,
  onCheckedChange,
  ...props
}: CheckboxPrimitive.CheckboxProps & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex min-h-touch items-start gap-3', className)}>
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-line-strong bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:border-brand data-[state=checked]:bg-brand"
        {...props}
      >
        <CheckboxPrimitive.Indicator>
          <Check className="h-4 w-4 text-on-brand" aria-hidden="true" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <div className="flex flex-col gap-1 pt-0.5">
        <Label htmlFor={id} className="cursor-pointer font-normal">
          {label}
        </Label>
        {description && <p className="text-body-sm text-fg-2">{description}</p>}
      </div>
    </div>
  );
}
