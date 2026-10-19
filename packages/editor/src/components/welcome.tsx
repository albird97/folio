import type { RecentFile } from '@folio/platform-adapters';
import { Button, cn, FolioMark, ICON, IconButton, Kbd } from '@folio/shared-ui';
import { FileText, FolderOpen, Globe, ShieldCheck, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { COMMAND_SHORTCUTS } from '../commands';
import { useWorkspaceContext } from '../context';
import { formatDate } from '../format';

/** How many recent files the start screen lists. */
const RECENT_SHOWN = 8;

/** Files opened before, where the platform remembers them (desktop). Names only, no paths. */
function RecentFiles() {
  const { adapter, workspace } = useWorkspaceContext();
  const recent = adapter.recentFiles;
  const [files, setFiles] = useState<RecentFile[] | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (!recent) return;
    let active = true;
    const load = () =>
      void recent.list().then(
        (list) => {
          if (active) setFiles(list);
        },
        () => undefined,
      );
    load();
    const unsubscribe = recent.onChange(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [recent]);

  if (!recent || !files || files.length === 0) return null;
  const open = (file: RecentFile) =>
    void recent.open(file.id).then(
      (incoming) => workspace.getState().openFiles(incoming),
      () => workspace.getState().showNotice(`${file.name} could not be opened.`),
    );

  return (
    <section aria-labelledby={headingId} className="mt-8 w-full max-w-xl">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 id={headingId} className="text-sm font-semibold">
          Recent files
        </h2>
        <Button variant="link" size="sm" onClick={() => void recent.clear()}>
          Clear
        </Button>
      </div>
      <ul className="overflow-hidden rounded-lg border border-line bg-surface">
        {files.slice(0, RECENT_SHOWN).map((file) => (
          <li
            key={file.id}
            className="group flex items-center border-b border-line last:border-b-0"
          >
            <button
              type="button"
              onClick={() => open(file)}
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left outline-hidden hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-focus"
            >
              <FileText
                size={ICON.md}
                strokeWidth={ICON.stroke}
                aria-hidden
                className="shrink-0 text-ink-muted"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{file.name}</span>
                <span className="block text-2xs text-ink-muted">
                  Opened {formatDate(file.openedAt)}
                </span>
              </span>
            </button>
            <IconButton
              label={`Remove ${file.name} from recent files`}
              size="icon-sm"
              className="mr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              icon={<X size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />}
              onClick={() => void recent.remove(file.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Welcome({ onOpen, hovering }: { onOpen(): void; hovering: boolean }) {
  const { adapter, profile, shortcutPlatform, ui } = useWorkspaceContext();
  const fromWeb = adapter.features.openFromUrl && adapter.openUrl !== undefined;
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto p-8">
      <div
        className={cn(
          'flex w-full max-w-xl flex-col items-center rounded-xl border-2 border-dashed px-8 py-14 text-center',
          'transition-colors duration-200 ease-out-quart',
          hovering ? 'border-accent bg-accent-soft/60' : 'border-line-strong',
        )}
      >
        <FolioMark className="size-14" />
        <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em]">
          Open a PDF to get started
        </h1>
        <p className="mt-2 max-w-sm text-base text-ink-muted">
          Drop PDF files anywhere in this window, or choose them from your computer.
        </p>
        <Button variant="primary" size="lg" className="mt-7" onClick={onOpen} data-start-action>
          <FolderOpen size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
          Choose PDF…
          <Kbd
            shortcut={COMMAND_SHORTCUTS[profile].open[0]!}
            platform={shortcutPlatform}
            className="ml-1"
          />
        </Button>
        {fromWeb ? (
          <Button
            variant="link"
            size="sm"
            className="mt-3"
            onClick={() => ui.getState().openDialog({ kind: 'open-url' })}
          >
            <Globe size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
            Open from a web address…
          </Button>
        ) : null}
        <p className="mt-10 flex items-center gap-1.5 text-xs text-ink-muted">
          <ShieldCheck size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
          Documents are processed on this device and only leave it if you ask Claude.
        </p>
      </div>
      <RecentFiles />
    </div>
  );
}
