import type { DocumentViewState, PageModel } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import { cn } from '@folio/shared-ui';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useWorkspace } from '../context';
import { displaySize, sourcePageIndex, userRotation } from '../viewer/geometry';
import { PRIORITY } from '../viewer/resources';
import { ThumbnailView } from '../viewer/thumbnail-view';
import { useDevicePixelRatio } from '../viewer/use-device-pixel-ratio';

/** Every thumbnail occupies the same height, so the list virtualizes by arithmetic. */
export const THUMBNAIL_SLOT = 172;
const LIST_PADDING = 8;
const BOX = { width: 128, height: 136 };
const OVERSCAN = 3;

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

export function ThumbnailsPanel({
  docKey,
  pages,
  view,
  handle,
}: {
  docKey: string;
  pages: readonly PageModel[];
  view: DocumentViewState;
  handle: PdfDocumentHandle;
}) {
  const setCurrentPage = useWorkspace((state) => state.setCurrentPage);
  const listRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const ratio = useDevicePixelRatio();
  const focusTarget = useRef<number | null>(null);
  const revealed = useRef<number | null>(null);
  const currentIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === view.currentPageId),
  );

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
    const button = listRef.current?.querySelector<HTMLButtonElement>(`[data-index="${index}"]`);
    if (button) {
      focusTarget.current = null;
      button.focus();
    }
  });

  const select = (index: number, focus: boolean) => {
    const page = pages[index];
    const element = listRef.current;
    if (!page || !element) return;
    reveal(element, index, false);
    revealed.current = index;
    setViewport({ top: element.scrollTop, height: element.clientHeight });
    if (focus) focusTarget.current = index;
    setCurrentPage(docKey, page.id);
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
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
    if (target === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    select(Math.min(pages.length - 1, Math.max(0, target)), true);
  };

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
    <div ref={listRef} className="h-full overflow-y-auto">
      <ol
        aria-label="Pages"
        className="relative"
        style={{ height: slotTop(pages.length) + LIST_PADDING }}
      >
        {indices.map((index) => {
          const page = pages[index]!;
          const current = index === currentIndex;
          const rotation = userRotation(page, view.rotation);
          const size = displaySize(page, view.rotation);
          const scale = Math.min(BOX.width / size.width, BOX.height / size.height);
          const width = Math.max(1, Math.round(size.width * scale));
          const height = Math.max(1, Math.round(size.height * scale));
          return (
            <li
              key={page.id}
              aria-posinset={index + 1}
              aria-setsize={pages.length}
              className="absolute inset-x-2"
              style={{ top: slotTop(index), height: THUMBNAIL_SLOT }}
            >
              <button
                type="button"
                data-index={index}
                aria-label={`Page ${index + 1}`}
                aria-current={current ? 'page' : undefined}
                tabIndex={current ? 0 : -1}
                onClick={() => select(index, false)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  'flex size-full flex-col items-center justify-center gap-2 rounded-md outline-none',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                  current ? 'bg-accent-soft' : 'hover:bg-hover',
                )}
              >
                <span className="flex items-center justify-center" style={BOX}>
                  <span
                    className="relative block overflow-hidden bg-page shadow-page"
                    style={{ width, height }}
                  >
                    <ThumbnailView
                      docKey={docKey}
                      handle={handle}
                      sourceIndex={sourcePageIndex(page, index)}
                      rotation={rotation}
                      width={width}
                      height={height}
                      scale={scale}
                      ratio={ratio}
                      priority={PRIORITY.thumbnail + Math.min(999, Math.abs(index - currentIndex))}
                    />
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'text-2xs tabular',
                    current ? 'font-semibold text-accent-soft-ink' : 'text-ink-muted',
                  )}
                >
                  {index + 1}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
