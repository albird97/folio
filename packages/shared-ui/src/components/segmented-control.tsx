import { ToggleGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      className={cn('inline-flex rounded-md bg-hover p-0.5', className)}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium text-ink-muted',
            'transition-colors duration-150 hover:text-ink',
            'data-[state=on]:bg-raised data-[state=on]:text-ink data-[state=on]:shadow-pop',
          )}
        >
          {option.icon}
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
