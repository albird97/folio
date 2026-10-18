import type { Size } from '@folio/document-model';

/** Space around the page column and between pages, in CSS pixels. */
export const PAGE_GAP = 16;
export const VIEW_PADDING = 24;

export interface PageBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PageLayout {
  boxes: PageBox[];
  width: number;
  height: number;
  scale: number;
}

/**
 * Lays pages out in one centred column. `pages` are rotated sizes in points.
 * O(n): cheap enough to recompute for every zoom change, even for 10,000 pages.
 */
export function computeLayout(
  pages: readonly Size[],
  scale: number,
  viewportWidth: number,
): PageLayout {
  let widest = 0;
  const sizes = pages.map((page) => {
    const width = Math.max(1, Math.round(page.width * scale));
    const height = Math.max(1, Math.round(page.height * scale));
    widest = Math.max(widest, width);
    return { width, height };
  });
  const width = Math.max(viewportWidth, widest + VIEW_PADDING * 2);
  const boxes: PageBox[] = [];
  let top = VIEW_PADDING;
  for (const size of sizes) {
    boxes.push({
      top,
      left: Math.round((width - size.width) / 2),
      width: size.width,
      height: size.height,
    });
    top += size.height + PAGE_GAP;
  }
  const height = boxes.length > 0 ? top - PAGE_GAP + VIEW_PADDING : VIEW_PADDING * 2;
  return { boxes, width, height, scale };
}

/** Index of the first page whose bottom edge is below `y` (binary search). */
function firstPageEndingAfter(boxes: readonly PageBox[], y: number): number {
  let low = 0;
  let high = boxes.length - 1;
  let answer = boxes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const box = boxes[mid]!;
    if (box.top + box.height > y) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return Math.max(0, answer);
}

export interface PageRange {
  first: number;
  last: number;
}

/** Pages intersecting [top, top + height], widened by `overscan` pixels each way. */
export function visibleRange(
  layout: PageLayout,
  top: number,
  height: number,
  overscan = 0,
): PageRange | null {
  const { boxes } = layout;
  if (boxes.length === 0) return null;
  const from = top - overscan;
  const to = top + height + overscan;
  const first = firstPageEndingAfter(boxes, from);
  let last = first;
  while (last + 1 < boxes.length && boxes[last + 1]!.top < to) last += 1;
  return { first, last };
}

/** The page covering most of the window (the earlier page on ties). */
export function mostVisiblePage(layout: PageLayout, top: number, height: number): number | null {
  const range = visibleRange(layout, top, height);
  if (!range) return null;
  let best = range.first;
  let bestArea = -1;
  for (let index = range.first; index <= range.last; index += 1) {
    const box = layout.boxes[index]!;
    const visible = Math.min(box.top + box.height, top + height) - Math.max(box.top, top);
    if (visible > bestArea) {
      best = index;
      bestArea = visible;
    }
  }
  return best;
}

/** The scroll offset that shows a page from its top edge, with the gap above it. */
export function pageTop(layout: PageLayout, index: number): number {
  const box = layout.boxes[index];
  if (!box) return 0;
  return Math.max(0, box.top - (index === 0 ? VIEW_PADDING : PAGE_GAP));
}

/** A position in the document that survives zoom and rotation changes. */
export interface Anchor {
  pageIndex: number;
  /** 0–1 across the page box. */
  x: number;
  /** 0–1 down the page box. */
  y: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The document position at window point (x, y), given the scroll offsets. */
export function anchorAt(
  layout: PageLayout,
  scrollLeft: number,
  scrollTop: number,
  x: number,
  y: number,
): Anchor | null {
  if (layout.boxes.length === 0) return null;
  const contentY = scrollTop + y;
  const pageIndex = firstPageEndingAfter(layout.boxes, contentY);
  const box = layout.boxes[pageIndex]!;
  return {
    pageIndex,
    x: clamp01((scrollLeft + x - box.left) / box.width),
    y: clamp01((contentY - box.top) / box.height),
  };
}

/** Scroll offsets that put `anchor` at window point (x, y). */
export function scrollForAnchor(
  layout: PageLayout,
  anchor: Anchor,
  x: number,
  y: number,
): { left: number; top: number } {
  const box = layout.boxes[Math.min(anchor.pageIndex, layout.boxes.length - 1)];
  if (!box) return { left: 0, top: 0 };
  return {
    left: Math.max(0, box.left + anchor.x * box.width - x),
    top: Math.max(0, box.top + anchor.y * box.height - y),
  };
}
