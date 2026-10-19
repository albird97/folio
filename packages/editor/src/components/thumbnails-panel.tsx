import type { DocumentViewState, PageId, PageModel, SourceId } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import { incomingFromFile } from '@folio/platform-adapters';
import { cn } from '@folio/shared-ui';
import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useWorkspaceContext } from '../context';
import type { WorkspaceDocument } from '../store/workspace';
import { displaySize, pageSource, userRotation } from '../viewer/geometry';
import { pageFormRevision, PRIORITY, renderCacheKey } from '../viewer/resources';
import { ThumbnailView } from '../viewer/thumbnail-view';
import { useDevicePixelRatio } from '../viewer/use-device-pixel-ratio';
import { usePageCommands } from '../hooks/use-page-commands';
import { PagesToolbar } from './pages-toolbar';

/** Every thumbnail occupies the same height, so the list virtualizes by arithmetic. */
export const THUMBNAIL_SLOT = 172;
const LIST_PADDING = 8;
const BOX = { width: 128, height: 136 };
const OVERSCAN = 3;
/** Pointer travel that turns a press on a thumbnail into a drag. */
const DRAG_THRESHOLD = 5;
/** Distance from the list's edge at which a drag scrolls it. */
const AUTOSCROLL_EDGE = 40;

function slotTop(index: number): number {
  return LIST_PADDING + index * THUMBNAIL_SLOT;
}

/** Scrolls the list so the slot is visible; `center` puts it in the middle. */
function reveal(element: HTMLElement, index: number, center: boolean): void {
  const top = slotTop(index);
  if (center) {
    element.scrollTop = Math.max(0, top - (element.clientHeight - THUMBNAIL_SLOT) / 2);
  } else if (top < element.scrollTop) {
    element.scrollTop = top - LIST_PADDING;
  } else if (top + THUMBNAIL_SLOT > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + THUMBNAIL_SLOT + LIST_PADDING - element.clientHeight;
  }
}

/** The gap a drop at `clientY` lands in: 0 is before the first page. */
function dropSlot(list: HTMLElement, clientY: number, count: number): number {
  const y = clientY - list.getBoundingClientRect().top + list.scrollTop - LIST_PADDING;
  return Math.min(count, Math.max(0, Math.round(y / THUMBNAIL_SLOT)));
}

interface Drag {
  pointerId: number;
  startY: number;
  pageIds: PageId[];
  active: boolean;
}

/**
 * The pages panel: thumbnails to move around the document, and the place to
 * select pages and rearrange them (WAI-ARIA multi-select listbox). Pages are
 * reordered by dragging; PDFs dropped between pages are inserted there.
 */
export function ThumbnailsPanel({
  doc,
  pages,
  view,
  sourceHandle,
}: {
  doc: WorkspaceDocument;
  pages: readonly PageModel[];
  view: DocumentViewState;
  sourceHandle(sourceId: SourceId): PdfDocumentHandle | null;
}) {
  const { workspace, adapter } = useWorkspaceContext();
  const docKey = doc.key;
  const commands = usePageCommands(doc);
  const listRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const ratio = useDevicePixelRatio();
  const focusTarget = useRef<number | null>(null);
  const revealed = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  /** The click that ends a drag must not also select. */
  const suppressClick = useRef(false);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const autoscroll = useRef<{ frame: number; speed: number } | null>(null);
  const currentIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === view.currentPageId),
  );
  const selected = new Set(doc.selection.pages);
  const canArrange = doc.permissions.assemble;

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
  }, []);

  // Follow the document: centre the current page when the panel opens, then
  // keep it in view as the viewer moves through the document.
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || revealed.current === currentIndex) return;
    reveal(element, currentIndex, revealed.current === null);
    revealed.current = currentIndex;
  }, [currentIndex]);

  useLayoutEffect(() => {
    const index = focusTarget.current;
    if (index === null) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (option) {
      focusTarget.current = null;
      option.focus();
    }
  });

  const state = () => workspace.getState();

  /** Shows a page in the viewer and moves the panel's focus to it. */
  const go = (index: number, focus: boolean) => {
    const page = pages[index];
    const element = listRef.current;
    if (!page || !element) return;
    reveal(element, index, false);
    revealed.current = index;
    setViewport({ top: element.scrollTop, height: element.clientHeight });
    if (focus) focusTarget.current = index;
    state().setCurrentPage(docKey, page.id);
  };

  const range = (from: PageId | null, to: number) => {
    const anchorIndex = from ? pages.findIndex((page) => page.id === from) : -1;
    const start = anchorIndex === -1 ? to : anchorIndex;
    const [low, high] = start < to ? [start, to] : [to, start];
    return pages.slice(low, high + 1).map((page) => page.id);
  };

  const choose = (index: number, modifiers: { shift: boolean; toggle: boolean }) => {
    const page = pages[index];
    if (!page) return;
    if (modifiers.shift) {
      state().selectPages(docKey, range(doc.selection.anchor ?? view.currentPageId, index));
    } else if (modifiers.toggle) {
      const next = selected.has(page.id)
        ? doc.selection.pages.filter((id) => id !== page.id)
        : [...doc.selection.pages, page.id];
      state().selectPages(docKey, next, page.id);
    } else {
      state().selectPages(docKey, [page.id], page.id);
    }
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      state().selectPages(
        docKey,
        pages.map((page) => page.id),
      );
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !mod) {
      event.preventDefault();
      commands.deletePages();
      return;
    }
    if (event.key === ' ' || (event.key === 'Enter' && mod)) {
      event.preventDefault();
      choose(index, { shift: false, toggle: true });
      return;
    }
    const perScreen = Math.max(1, Math.floor(viewport.height / THUMBNAIL_SLOT));
    const targets: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      PageDown: index + perScreen,
      PageUp: index - perScreen,
      Home: 0,
      End: pages.length - 1,
    };
    const target = targets[event.key];
    if (target === undefined || event.altKey) return;
    event.preventDefault();
    const next = Math.min(pages.length - 1, Math.max(0, target));
    // Ctrl/⌘ moves without changing the selection; Shift extends it.
    if (!mod) choose(next, { shift: event.shiftKey, toggle: false });
    go(next, true);
  };

  // ── Dragging pages to reorder them ──
  const stopAutoscroll = () => {
    if (autoscroll.current) cancelAnimationFrame(autoscroll.current.frame);
    autoscroll.current = null;
  };
  const runAutoscroll = (speed: number) => {
    const element = listRef.current;
    if (!element) return;
    if (speed === 0) {
      stopAutoscroll();
      return;
    }
    if (autoscroll.current) {
      autoscroll.current.speed = speed;
      return;
    }
    const step = () => {
      if (!autoscroll.current) return;
      element.scrollTop += autoscroll.current.speed;
      autoscroll.current.frame = requestAnimationFrame(step);
    };
    autoscroll.current = { speed, frame: requestAnimationFrame(step) };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>, index: number) => {
    if (event.button !== 0 || !canArrange) return;
    const page = pages[index];
    if (!page) return;
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      // Dragging a selected page moves the whole selection.
      pageIds: selected.has(page.id) ? [...doc.selection.pages] : [page.id],
      active: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    const list = listRef.current;
    if (!current || !list || current.pointerId !== event.pointerId) return;
    if (!current.active) {
      if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return;
      current.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDropAt(dropSlot(list, event.clientY, pages.length));
    const bounds = list.getBoundingClientRect();
    const fromTop = event.clientY - bounds.top;
    const fromBottom = bounds.bottom - event.clientY;
    runAutoscroll(
      fromTop < AUTOSCROLL_EDGE
        ? -Math.ceil((AUTOSCROLL_EDGE - fromTop) / 4)
        : fromBottom < AUTOSCROLL_EDGE
          ? Math.ceil((AUTOSCROLL_EDGE - fromBottom) / 4)
          : 0,
    );
  };

  const endDrag = (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    stopAutoscroll();
    const slot = dropAt;
    setDropAt(null);
    if (current.active) suppressClick.current = true;
    if (!current.active || cancelled || slot === null || !listRef.current) return;
    const moving = new Set(current.pageIds);
    // Where the first moved page lands among the pages that stay.
    const before = pages.slice(0, slot).filter((page) => !moving.has(page.id)).length;
    state().movePages(docKey, current.pageIds, before);
    state().selectPages(docKey, current.pageIds, current.pageIds[0] ?? null);
  };

  // ── Dropping PDF files between pages (browsers; the desktop opens dropped files) ──
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const fileDrop =
    adapter.features.webDragAndDrop && canArrange
      ? {
          onDragOver(event: DragEvent<HTMLDivElement>) {
            if (!hasFiles(event) || !listRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            setDropAt(dropSlot(listRef.current, event.clientY, pages.length));
          },
          onDragLeave(event: DragEvent<HTMLDivElement>) {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
          },
          onDrop(event: DragEvent<HTMLDivElement>) {
            if (!hasFiles(event) || !listRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            const slot = dropSlot(listRef.current, event.clientY, pages.length);
            setDropAt(null);
            const files = Array.from(event.dataTransfer.files).filter(
              (file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf',
            );
            if (files.length === 0) {
              state().showNotice('Only PDF files can be inserted as pages.');
              return;
            }
            void commands.insertFiles(files.map(incomingFromFile), slot);
          },
        }
      : {};

  const first = Math.max(0, Math.floor((viewport.top - LIST_PADDING) / THUMBNAIL_SLOT) - OVERSCAN);
  const last = Math.min(
    pages.length - 1,
    Math.floor((viewport.top + viewport.height) / THUMBNAIL_SLOT) + OVERSCAN,
  );
  const indices: number[] = [];
  for (let index = first; index <= last; index += 1) indices.push(index);
  // The current page stays mounted so it keeps the list's single tab stop.
  if (currentIndex < first || currentIndex > last) indices.push(currentIndex);

  return (
    <div className="flex h-full flex-col">
      <PagesToolbar doc={doc} commands={commands} />
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" {...fileDrop}>
        <div
          role="listbox"
          aria-label="Pages"
          aria-multiselectable
          className="relative"
          style={{ height: slotTop(pages.length) + LIST_PADDING }}
        >
          {indices.map((index) => {
            const page = pages[index]!;
            const current = index === currentIndex;
            const isSelected = selected.has(page.id);
            const source = pageSource(page);
            const rotation = userRotation(page, view.rotation);
            const size = displaySize(page, view.rotation);
            const scale = Math.min(BOX.width / size.width, BOX.height / size.height);
            const width = Math.max(1, Math.round(size.width * scale));
            const height = Math.max(1, Math.round(size.height * scale));
            return (
              <div
                key={page.id}
                role="option"
                data-index={index}
                aria-label={`Page ${index + 1}`}
                aria-selected={isSelected}
                aria-current={current ? 'page' : undefined}
                aria-posinset={index + 1}
                aria-setsize={pages.length}
                tabIndex={current ? 0 : -1}
                onClick={(event) => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  choose(index, {
                    shift: event.shiftKey,
                    toggle: event.metaKey || event.ctrlKey,
                  });
                  go(index, false);
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
                onPointerDown={(event) => {
                  suppressClick.current = false;
                  onPointerDown(event, index);
                }}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => endDrag(event, false)}
                onPointerCancel={(event) => endDrag(event, true)}
                className={cn(
                  'absolute inset-x-2 flex flex-col items-center justify-center gap-2 rounded-md outline-none select-none',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                  isSelected ? 'bg-accent-soft' : current ? 'bg-hover' : 'hover:bg-hover',
                )}
                style={{ top: slotTop(index), height: THUMBNAIL_SLOT }}
              >
                <span className="flex items-center justify-center" style={BOX}>
                  <span
                    className={cn(
                      'relative block overflow-hidden bg-page shadow-page',
                      isSelected && 'outline-2 outline-offset-2 outline-accent',
                    )}
                    style={{ width, height }}
                  >
                    <ThumbnailView
                      cacheKey={renderCacheKey(docKey, source?.sourceId ?? 'blank')}
                      handle={source ? sourceHandle(source.sourceId) : null}
                      sourceIndex={source?.pageIndex ?? 0}
                      rotation={rotation}
                      width={width}
                      height={height}
                      scale={scale}
                      ratio={ratio}
                      priority={PRIORITY.thumbnail + Math.min(999, Math.abs(index - currentIndex))}
                      formRevision={pageFormRevision(doc, page)}
                    />
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'text-2xs tabular',
                    current || isSelected ? 'font-semibold text-accent-soft-ink' : 'text-ink-muted',
                  )}
                >
                  {index + 1}
                </span>
              </div>
            );
          })}
          {dropAt !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-3 h-0.5 rounded-full bg-accent"
              style={{ top: slotTop(dropAt) - 1 }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
