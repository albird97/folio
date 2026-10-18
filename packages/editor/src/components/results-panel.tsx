import { Button, cn, Kbd } from '@folio/shared-ui';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { COMMAND_SHORTCUTS } from '../commands';
import { useWorkspace, useWorkspaceContext } from '../context';
import { MAX_MATCHES } from '../search/match';
import type { WorkspaceDocument } from '../store/workspace';

const ROW = 60;
const OVERSCAN = 6;

export function searchSummary(doc: WorkspaceDocument): string {
  const { search } = doc;
  const count = search.matches.length;
  if (search.status === 'searching') {
    const total = doc.info?.pageCount ?? 0;
    const percent = total > 0 ? Math.round((search.pagesSearched / total) * 100) : 0;
    return `${count.toLocaleString()} found, searching… ${percent}%`;
  }
  if (count === 0) return 'No results';
  if (search.truncated) return `First ${MAX_MATCHES.toLocaleString()} results`;
  return count === 1 ? '1 result' : `${count.toLocaleString()} results`;
}

/** Every match with its context; selecting one shows it in the document. */
export function ResultsPanel({ doc, onFind }: { doc: WorkspaceDocument; onFind(): void }) {
  const { profile, shortcutPlatform } = useWorkspaceContext();
  const selectMatch = useWorkspace((state) => state.selectMatch);
  const listRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const focusTarget = useRef<number | null>(null);
  const { search } = doc;
  const matches = search.matches;
  const active = search.active;

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = () =>
      setViewport((previous) =>
        previous.top === element.scrollTop && previous.height === element.clientHeight
          ? previous
          : { top: element.scrollTop, height: element.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', measure);
    };
  }, [search.query]);

  // Keep the active result in view when it changes from the find bar.
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || active < 0) return;
    const top = active * ROW;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW - element.clientHeight;
    }
  }, [active]);

  useLayoutEffect(() => {
    const index = focusTarget.current;
    if (index === null) return;
    const button = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (button) {
      focusTarget.current = null;
      button.focus();
    }
  });

  if (!search.query.trim()) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-6 text-center text-xs text-ink-muted">
        <p>Search the text of this document.</p>
        <Button size="sm" onClick={onFind}>
          Find in document
          <Kbd
            shortcut={COMMAND_SHORTCUTS[profile].find[0]!}
            platform={shortcutPlatform}
            className="text-ink-subtle"
          />
        </Button>
      </div>
    );
  }

  const choose = (index: number, focus: boolean) => {
    if (index < 0 || index >= matches.length) return;
    if (focus) focusTarget.current = index;
    selectMatch(doc.key, index);
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const targets: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: matches.length - 1,
    };
    const target = targets[event.key];
    if (target === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const element = listRef.current;
    const clamped = Math.min(matches.length - 1, Math.max(0, target));
    if (element) {
      const top = clamped * ROW;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + ROW - element.clientHeight;
      }
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    }
    choose(clamped, true);
  };

  const first = Math.max(0, Math.floor(viewport.top / ROW) - OVERSCAN);
  const last = Math.min(
    matches.length - 1,
    Math.ceil((viewport.top + viewport.height) / ROW) + OVERSCAN,
  );
  const focusIndex = active >= 0 ? active : 0;
  const indices: number[] = [];
  for (let index = first; index <= last; index += 1) indices.push(index);
  if (matches.length > 0 && (focusIndex < first || focusIndex > last)) indices.push(focusIndex);

  return (
    <div className="flex h-full flex-col">
      <p className="shrink-0 px-4 pt-1 pb-2 text-2xs text-ink-muted tabular">
        {searchSummary(doc)}
      </p>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ol
          aria-label="Search results"
          className="relative"
          style={{ height: matches.length * ROW }}
        >
          {indices.map((index) => {
            const match = matches[index]!;
            const current = index === active;
            return (
              <li
                key={index}
                aria-posinset={index + 1}
                aria-setsize={matches.length}
                className="absolute inset-x-0"
                style={{ top: index * ROW, height: ROW - 4 }}
              >
                <button
                  type="button"
                  data-index={index}
                  aria-current={current ? 'true' : undefined}
                  tabIndex={index === focusIndex ? 0 : -1}
                  onClick={() => choose(index, false)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  className={cn(
                    'flex size-full flex-col justify-center gap-0.5 rounded-md px-2 text-left outline-none',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                    current ? 'bg-accent-soft text-accent-soft-ink' : 'hover:bg-hover',
                  )}
                >
                  <span
                    className={cn(
                      'text-2xs font-medium tabular',
                      current ? 'opacity-85' : 'text-ink-muted',
                    )}
                  >
                    Page {match.pageIndex + 1}
                  </span>
                  <span className="line-clamp-2 text-xs leading-4 break-words">
                    {match.excerpt.before}
                    <mark className="rounded-xs bg-[oklch(0.88_0.14_90)] px-px text-[oklch(0.24_0.03_80)]">
                      {match.excerpt.match}
                    </mark>
                    {match.excerpt.after}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
