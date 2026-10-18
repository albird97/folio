import { Button, cn, FolioMark, ICON, Kbd } from '@folio/shared-ui';
import { FolderOpen, ShieldCheck } from 'lucide-react';
import { COMMAND_SHORTCUTS } from '../commands';
import { useWorkspaceContext } from '../context';

export function Welcome({ onOpen, hovering }: { onOpen(): void; hovering: boolean }) {
  const { profile, shortcutPlatform } = useWorkspaceContext();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div
        className={cn(
          'flex w-full max-w-xl flex-col items-center rounded-xl border-2 border-dashed px-8 py-14 text-center',
          'transition-colors duration-200 ease-out-quart',
          hovering ? 'border-accent bg-accent-soft/60' : 'border-line-strong',
        )}
      >
        <FolioMark className="size-14" />
        <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em]">Open a PDF to get started</h1>
        <p className="mt-2 max-w-sm text-base text-ink-muted">
          Drop PDF files anywhere in this window, or choose them from your computer.
        </p>
        <Button variant="primary" size="lg" className="mt-7" onClick={onOpen}>
          <FolderOpen size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
          Choose PDF…
          <Kbd shortcut={COMMAND_SHORTCUTS[profile].open[0]!} platform={shortcutPlatform} className="ml-1" />
        </Button>
        <p className="mt-10 flex items-center gap-1.5 text-xs text-ink-muted">
          <ShieldCheck size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
          Documents are processed on this device and never uploaded.
        </p>
      </div>
    </div>
  );
}
