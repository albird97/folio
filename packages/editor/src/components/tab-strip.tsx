import { isDirty } from '@folio/document-model';
import { cn, FolioWordmark, ICON, IconButton, Spinner } from '@folio/shared-ui';
import { CircleAlert, LockKeyhole, Plus, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { COMMAND_SHORTCUTS } from '../commands';
import { useWorkspace, useWorkspaceContext } from '../context';
import type { WorkspaceDocument } from '../store/workspace';

function StatusGlyph({ doc }: { doc: WorkspaceDocument }) {
  if (doc.status === 'loading') return <Spinner label={`Opening ${doc.fileName}`} className="text-ink-muted" />;
  if (doc.status === 'needs-password')
    return <LockKeyhole size={ICON.sm} strokeWidth={ICON.stroke} className="text-ink-muted" aria-label="Password required" />;
  if (doc.status === 'error')
    return <CircleAlert size={ICON.sm} strokeWidth={ICON.stroke} className="text-danger" aria-label="Could not open" />;
  return null;
}

export interface TabStripProps {
  onOpen(): void;
  /** Left inset for macOS window controls drawn over the web content. */
  insetStart?: number;
  dragRegion?: boolean;
  brand?: boolean;
}

export function TabStrip({ onOpen, insetStart = 0, dragRegion = false, brand = false }: TabStripProps) {
  const { profile, shortcutPlatform } = useWorkspaceContext();
  const { documents, activeKey, activate, close } = useWorkspace(
    useShallow((state) => ({
      documents: state.documents,
      activeKey: state.activeKey,
      activate: state.activate,
      close: state.close,
    })),
  );
  const drag = dragRegion ? { 'data-tauri-drag-region': '' } : {};

  return (
    <nav
      aria-label="Open documents"
      className="flex h-10 shrink-0 items-end gap-2 bg-bg pr-2"
      style={{ paddingInlineStart: Math.max(insetStart, 8) }}
      {...drag}
    >
      {brand ? <FolioWordmark className="mb-2.5 mr-2 ml-1" /> : null}
      <ul className="flex min-w-0 items-end gap-px" {...drag}>
        {documents.map((doc) => {
          const active = doc.key === activeKey;
          const dirty = doc.editor ? isDirty(doc.editor) : false;
          return (
            <li
              key={doc.key}
              className={cn(
                'group relative flex h-8 min-w-0 max-w-56 items-center rounded-t-md',
                active ? 'bg-surface shadow-[0_0_0_1px_var(--folio-border)] [clip-path:inset(-1px_-1px_0_-1px)]' : 'hover:bg-hover',
              )}
            >
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => activate(doc.key)}
                title={doc.fileName}
                className={cn(
                  'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-t-md pr-7 pl-3 text-left text-xs',
                  active ? 'font-medium text-ink' : 'text-ink-muted',
                )}
              >
                <StatusGlyph doc={doc} />
                <span className="truncate">{doc.fileName}</span>
                {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unsaved changes" /> : null}
              </button>
              <button
                type="button"
                aria-label={`Close ${doc.fileName}`}
                onClick={() => void close(doc.key)}
                className={cn(
                  'absolute right-1 flex size-5 items-center justify-center rounded-xs text-ink-muted',
                  'opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-pressed hover:text-ink',
                  active && 'opacity-100',
                )}
              >
                <X size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      <IconButton
        label="Open PDF"
        icon={<Plus size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
        size="icon-sm"
        className="mb-1"
        onClick={onOpen}
        shortcut={{ keys: COMMAND_SHORTCUTS[profile].open[0]!, platform: shortcutPlatform }}
      />
      <div className="h-full flex-1" {...drag} />
    </nav>
  );
}
