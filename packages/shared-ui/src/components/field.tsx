import { Label as LabelPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';
import { cn } from '../lib/cn';

export function Input({ className, ...props }: ComponentPropsWithRef<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md bg-raised px-2.5 text-sm text-ink placeholder:text-ink-subtle',
        'shadow-[inset_0_0_0_1px_var(--folio-border-strong)] transition-shadow duration-150',
        'focus-visible:shadow-[inset_0_0_0_1px_var(--folio-focus)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-0 focus-visible:outline-focus/35',
        'aria-invalid:shadow-[inset_0_0_0_1px_var(--folio-danger)]',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentPropsWithRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-xs font-medium text-ink-muted', className)}
      {...props}
    />
  );
}
