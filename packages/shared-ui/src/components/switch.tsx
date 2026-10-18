import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';
import { cn } from '../lib/cn';

export function Switch({ className, ...props }: ComponentPropsWithRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong transition-colors duration-150',
        'data-[state=checked]:bg-accent disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out-quart data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}
