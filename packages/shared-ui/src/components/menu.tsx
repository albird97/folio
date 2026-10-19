import { Check } from 'lucide-react';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';
import { ICON } from '../icons';
import { cn } from '../lib/cn';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          'z-(--z-dropdown) min-w-44 rounded-md bg-raised p-1 text-sm text-ink shadow-pop animate-pop-in',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

const ITEM = cn(
  'relative flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-hidden select-none',
  'data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-45',
);

export function DropdownMenuItem({
  className,
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Item>) {
  return <MenuPrimitive.Item className={cn(ITEM, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(ITEM, 'pl-7', className)} {...props}>
      <MenuPrimitive.ItemIndicator className="absolute left-2 inline-flex">
        <Check size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
      </MenuPrimitive.ItemIndicator>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-line', className)} {...props} />;
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn('px-2 pt-1.5 pb-1 text-2xs font-medium text-ink-muted', className)}
      {...props}
    />
  );
}
