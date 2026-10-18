import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { ICON } from '../icons';

const TONES = {
  info: { className: 'bg-accent-soft text-accent-soft-ink', Icon: Info },
  warning: { className: 'bg-warning-soft text-warning-ink', Icon: TriangleAlert },
  danger: { className: 'bg-danger-soft text-danger-ink', Icon: CircleAlert },
} as const;

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof TONES;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { className: toneClass, Icon } = TONES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-md px-3 py-2.5 text-sm',
        toneClass,
        className,
      )}
    >
      <Icon size={ICON.md} strokeWidth={ICON.stroke} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-0.5 opacity-90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
