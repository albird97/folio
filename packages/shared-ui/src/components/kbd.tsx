import { cn } from '../lib/cn';
import { formatShortcut, type ShortcutPlatform } from '../lib/shortcuts';

export function Kbd({
  shortcut,
  platform,
  className,
}: {
  shortcut: string;
  platform: ShortcutPlatform;
  className?: string;
}) {
  const parts = formatShortcut(shortcut, platform);
  return (
    <kbd className={cn('inline-flex items-center font-sans text-[0.9em]', className)}>
      {parts.map((part, index) => (
        <span key={index} className="min-w-[1ch] text-center">
          {platform === 'macos' || index === 0 ? part : `+${part}`}
        </span>
      ))}
    </kbd>
  );
}
