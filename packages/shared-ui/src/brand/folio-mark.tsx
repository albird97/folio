import { useId } from 'react';
import { cn } from '../lib/cn';

/**
 * The Folio mark: a single leaf with a folded corner, set in petrol ink.
 * Original artwork; also used to generate the app and extension icons.
 */
export function FolioMark({ className, title }: { className?: string; title?: string }) {
  const id = useId();
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('size-6 shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? `${id}-title` : undefined}
    >
      {title ? <title id={`${id}-title`}>{title}</title> : null}
      <rect width="64" height="64" rx="15" fill="var(--folio-mark-bg, oklch(0.5 0.092 210))" />
      <path d="M19 13h18l10 10v28a2 2 0 0 1-2 2H19a2 2 0 0 1-2-2V15a2 2 0 0 1 2-2Z" fill="#fff" />
      <path d="M37 13v8a2 2 0 0 0 2 2h8Z" fill="oklch(0.83 0.06 205)" />
      <rect x="23" y="31" width="18" height="3.5" rx="1.75" fill="oklch(0.5 0.092 210)" />
      <rect x="23" y="39" width="12" height="3.5" rx="1.75" fill="oklch(0.72 0.05 210)" />
    </svg>
  );
}

export function FolioWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <FolioMark className="size-5" />
      <span className="text-sm font-semibold tracking-[-0.01em]">Folio</span>
    </span>
  );
}
