import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import type { ShortcutPlatform } from '../lib/shortcuts';
import { Button, type ButtonProps } from './button';
import { Kbd } from './kbd';
import { Tooltip } from './tooltip';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'size'> {
  /** Accessible name; also shown as the tooltip. Required: icon-only controls need one. */
  label: string;
  icon: ReactNode;
  shortcut?: { keys: string; platform: ShortcutPlatform };
  size?: 'icon-sm' | 'icon';
  pressed?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

export function IconButton({
  label,
  icon,
  shortcut,
  size = 'icon',
  pressed,
  tooltipSide,
  className,
  variant = 'ghost',
  ...props
}: IconButtonProps) {
  return (
    <Tooltip
      side={tooltipSide}
      content={
        <>
          <span>{label}</span>
          {shortcut ? <Kbd shortcut={shortcut.keys} platform={shortcut.platform} /> : null}
        </>
      }
    >
      <Button
        aria-label={label}
        aria-pressed={pressed}
        variant={variant}
        size={size}
        className={cn(pressed && 'bg-accent-soft text-accent-soft-ink hover:bg-accent-soft', className)}
        {...props}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}
