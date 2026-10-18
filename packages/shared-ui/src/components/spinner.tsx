import { cn } from '../lib/cn';

/** `label` makes it a live status; omit it when surrounding text already says what is happening. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('inline-flex', className)}
    >
      <svg viewBox="0 0 16 16" className="size-4 animate-spin" aria-hidden>
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2"
        />
        <path
          d="M14 8a6 6 0 0 0-6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
