import type { PageModel, SourceId } from '@folio/document-model';
import type { OutlineItem, PdfDocumentHandle } from '@folio/pdf-core';
import { cn, ICON, Spinner } from '@folio/shared-ui';
import { ChevronRight, Globe } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useWorkspace } from '../context';

const outlines = new WeakMap<PdfDocumentHandle, Promise<OutlineItem[]>>();

/** Outlines are read once per open document. */
function loadOutline(handle: PdfDocumentHandle): Promise<OutlineItem[]> {
  let outline = outlines.get(handle);
  if (!outline) {
    outline = handle.getOutline().catch(() => []);
    outlines.set(handle, outline);
  }
  return outline;
}

interface Row {
  id: string;
  item: OutlineItem;
  level: number;
  posInSet: number;
  setSize: number;
  parent: string | null;
}

/** The visible rows of the tree, depth first. */
function visibleRows(items: readonly OutlineItem[], expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (children: readonly OutlineItem[], level: number, parent: string | null) => {
    children.forEach((item, index) => {
      const id = parent === null ? `${index}` : `${parent}.${index}`;
      rows.push({ id, item, level, posInSet: index + 1, setSize: children.length, parent });
      if (item.children.length > 0 && expanded.has(id)) walk(item.children, level + 1, id);
    });
  };
  walk(items, 1, null);
  return rows;
}

function linkHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Where each page of the opened file is now: bookmarks point at the file's
 * pages, which may have moved, been duplicated (the first copy counts) or
 * been deleted (null).
 */
function usePagePositions(pages: readonly PageModel[], sourceId: SourceId | null) {
  return useMemo(() => {
    const positions = new Map<number, number>();
    pages.forEach((page, position) => {
      if (page.source.kind !== 'source' || page.source.sourceId !== sourceId) return;
      if (!positions.has(page.source.pageIndex)) positions.set(page.source.pageIndex, position);
    });
    return (pageIndex: number | null) =>
      pageIndex === null ? null : (positions.get(pageIndex) ?? null);
  }, [pages, sourceId]);
}

/** The document's bookmarks, as a tree (WAI-ARIA tree view pattern). */
export function OutlinePanel({
  docKey,
  handle,
  pages,
  sourceId,
}: {
  docKey: string;
  /** The opened file, whose bookmarks these are. */
  handle: PdfDocumentHandle;
  pages: readonly PageModel[];
  sourceId: SourceId | null;
}) {
  const navigate = useWorkspace((state) => state.navigate);
  const positionOf = usePagePositions(pages, sourceId);
  const [loaded, setLoaded] = useState<{ handle: PdfDocumentHandle; items: OutlineItem[] } | null>(
    null,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(false);

  useEffect(() => {
    let active = true;
    void loadOutline(handle).then((items) => {
      if (active) setLoaded({ handle, items });
    });
    return () => {
      active = false;
    };
  }, [handle]);

  const items = loaded?.handle === handle ? loaded.items : null;
  const rows = useMemo(() => (items ? visibleRows(items, expanded) : []), [items, expanded]);
  const focused = rows.find((row) => row.id === focusedId) ?? rows[0];

  useLayoutEffect(() => {
    if (!shouldFocus.current || !focused) return;
    shouldFocus.current = false;
    treeRef.current?.querySelector<HTMLElement>(`[data-id="${focused.id}"]`)?.focus();
  });

  if (!items) {
    return (
      <div className="flex h-full items-center justify-center text-ink-muted">
        <Spinner label="Loading bookmarks" />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-ink-muted">This PDF has no bookmarks.</p>
    );
  }

  const toggle = (id: string, open: boolean) =>
    setExpanded((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const activate = (row: Row) => {
    const pageIndex = positionOf(row.item.pageIndex);
    if (pageIndex === null) return;
    navigate(docKey, {
      pageIndex,
      point: { x: row.item.left, y: row.item.top },
      align: 'top',
    });
  };

  const moveTo = (row: Row | undefined) => {
    if (!row) return;
    shouldFocus.current = true;
    setFocusedId(row.id);
  };

  const onKeyDown = (event: KeyboardEvent, row: Row) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = rows.indexOf(row);
    const hasChildren = row.item.children.length > 0;
    const open = expanded.has(row.id);
    switch (event.key) {
      case 'ArrowDown':
        moveTo(rows[index + 1]);
        break;
      case 'ArrowUp':
        moveTo(rows[index - 1]);
        break;
      case 'Home':
        moveTo(rows[0]);
        break;
      case 'End':
        moveTo(rows.at(-1));
        break;
      case 'ArrowRight':
        if (hasChildren && !open) toggle(row.id, true);
        else if (hasChildren) moveTo(rows[index + 1]);
        break;
      case 'ArrowLeft':
        if (hasChildren && open) toggle(row.id, false);
        else moveTo(rows.find((candidate) => candidate.id === row.parent));
        break;
      case 'Enter':
      case ' ':
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Bookmarks"
      className="h-full overflow-y-auto px-2 py-2"
    >
      {rows.map((row) => {
        const { item } = row;
        const hasChildren = item.children.length > 0;
        const open = expanded.has(row.id);
        const position = positionOf(item.pageIndex);
        const disabled = position === null;
        return (
          <div
            key={row.id}
            data-id={row.id}
            role="treeitem"
            aria-level={row.level}
            aria-posinset={row.posInSet}
            aria-setsize={row.setSize}
            aria-expanded={hasChildren ? open : undefined}
            aria-selected={false}
            aria-disabled={disabled || undefined}
            tabIndex={row === focused ? 0 : -1}
            onClick={() => {
              setFocusedId(row.id);
              activate(row);
            }}
            onKeyDown={(event) => onKeyDown(event, row)}
            title={item.url ?? undefined}
            className={cn(
              'flex min-h-7 cursor-default items-center gap-1 rounded-sm py-1 pr-2 text-xs outline-none',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
              disabled ? 'text-ink-muted' : 'hover:bg-hover',
            )}
            style={{ paddingLeft: 4 + (row.level - 1) * 14 }}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-xs text-ink-muted',
                hasChildren ? 'hover:bg-pressed' : 'invisible',
              )}
              onClick={(event) => {
                event.stopPropagation();
                setFocusedId(row.id);
                toggle(row.id, !open);
              }}
            >
              <ChevronRight
                size={ICON.sm}
                strokeWidth={ICON.stroke}
                className={cn('transition-transform duration-150', open && 'rotate-90')}
              />
            </span>
            {item.url ? (
              <Globe size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden className="shrink-0" />
            ) : null}
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                item.bold && 'font-semibold',
                item.italic && 'italic',
              )}
            >
              {item.title || 'Untitled'}
              {item.url ? <span className="sr-only">, link to {linkHost(item.url)}</span> : null}
            </span>
            {position !== null ? (
              <span aria-hidden className="shrink-0 text-2xs text-ink-muted tabular">
                {position + 1}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
