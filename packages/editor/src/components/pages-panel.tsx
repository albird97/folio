import { cn } from '@folio/shared-ui';
import { useRef, type KeyboardEvent } from 'react';
import { useWorkspace } from '../context';
import { formatPageSize } from '../format';
import type { WorkspaceDocument } from '../store/workspace';

export function PagesPanel({ doc }: { doc: WorkspaceDocument }) {
  const setCurrentPage = useWorkspace((state) => state.setCurrentPage);
  const listRef = useRef<HTMLOListElement>(null);
  if (!doc.editor || !doc.view) return null;
  const pages = doc.editor.model.pages;
  const currentIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === doc.view?.currentPageId),
  );

  const select = (index: number) => {
    const page = pages[index];
    if (!page) return;
    setCurrentPage(doc.key, page.id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowDown: currentIndex + 1,
      ArrowUp: currentIndex - 1,
      Home: 0,
      End: pages.length - 1,
    };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(Math.min(pages.length - 1, Math.max(0, target)));
  };

  return (
    <aside
      aria-label="Pages"
      className="flex w-60 shrink-0 flex-col border-r border-line bg-surface"
    >
      <div className="flex h-10 shrink-0 items-center justify-between px-4">
        <h2 className="text-xs font-semibold">Pages</h2>
        <span className="text-xs text-ink-muted tabular">{pages.length}</span>
      </div>
      <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {pages.map((page, index) => {
          const current = index === currentIndex;
          const rotation = (page.sourceRotation + page.rotation) % 360;
          return (
            <li key={page.id}>
              <button
                type="button"
                aria-current={current ? 'page' : undefined}
                tabIndex={current ? 0 : -1}
                onClick={() => select(index)}
                onKeyDown={onKeyDown}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left',
                  current ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-hover',
                )}
              >
                <span aria-hidden className="flex w-9 shrink-0 justify-center">
                  <span
                    className={cn(
                      'flex h-9 w-7 items-center justify-center rounded-xs bg-page text-2xs font-medium text-[oklch(0.4_0.01_230)] shadow-page tabular',
                      rotation % 180 !== 0 && 'h-7 w-9',
                    )}
                  >
                    {index + 1}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium">Page {index + 1}</span>
                  <span
                    className={cn(
                      'block truncate text-2xs',
                      current ? 'opacity-85' : 'text-ink-muted',
                    )}
                  >
                    {formatPageSize(page)}
                    {rotation !== 0 ? ` · ${rotation}°` : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
