import type { PageModel, Rect, Rotation } from '@folio/document-model';
import { displaySpaceSize, invertMatrix, mapRect, pageToDisplay } from './geometry';

export interface SelectedText {
  /** Position of the page in the document. */
  position: number;
  /** One rectangle per marked line, in page space. */
  rects: Rect[];
  text: string;
}

/** Rectangles on one line of text (as shown) merge; a wide gap starts a new piece. */
export function mergeLineRects(rects: readonly Rect[]): Rect[] {
  const sorted = rects
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .slice()
    .sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x);
  const lines: Rect[][] = [];
  for (const rect of sorted) {
    const line = lines.at(-1);
    const union = line ? bounds(line) : null;
    const overlap = union
      ? Math.min(union.y + union.height, rect.y + rect.height) - Math.max(union.y, rect.y)
      : 0;
    if (line && union && overlap >= Math.min(union.height, rect.height) * 0.5) line.push(rect);
    else lines.push([rect]);
  }
  const merged: Rect[] = [];
  for (const line of lines) {
    const pieces: Rect[][] = [];
    for (const rect of line.slice().sort((a, b) => a.x - b.x)) {
      const piece = pieces.at(-1);
      const last = piece ? bounds(piece) : null;
      if (
        piece &&
        last &&
        rect.x - (last.x + last.width) <= Math.max(last.height, rect.height) * 2
      ) {
        piece.push(rect);
      } else {
        pieces.push([rect]);
      }
    }
    merged.push(...pieces.map(bounds));
  }
  return merged;
}

function bounds(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The text selected in pages' text layers, per page: line rectangles in
 * page space (for highlights) and the selected text. Only text nodes count,
 * so line breaks and the layer's end marker add no stray rectangles.
 */
export function selectedText(
  root: HTMLElement,
  selection: Selection,
  pages: readonly PageModel[],
  viewRotation: Rotation,
): SelectedText[] {
  const found = new Map<number, { display: Rect[]; text: string[]; page: PageModel }>();
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.collapsed || !root.contains(range.commonAncestorContainer)) continue;
    const walker = root.ownerDocument.createTreeWalker(
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode!
        : range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue;
      const element = node.parentElement;
      const pageElement = element?.closest<HTMLElement>('.folio-page');
      if (!element?.closest('.textLayer') || !pageElement) continue;
      const position = Number(pageElement.dataset.page) - 1;
      const page = pages[position];
      if (!page) continue;
      const length = node.textContent?.length ?? 0;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : length;
      if (start >= end) continue;
      const part = root.ownerDocument.createRange();
      part.setStart(node, start);
      part.setEnd(node, end);
      const box = pageElement.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const size = displaySpaceSize(page, viewRotation);
      let entry = found.get(position);
      if (!entry) {
        entry = { display: [], text: [], page };
        found.set(position, entry);
      }
      for (const rect of Array.from(part.getClientRects())) {
        entry.display.push({
          x: ((rect.left - box.left) / box.width) * size.width,
          y: ((rect.top - box.top) / box.height) * size.height,
          width: (rect.width / box.width) * size.width,
          height: (rect.height / box.height) * size.height,
        });
      }
      entry.text.push((node.textContent ?? '').slice(start, end));
    }
  }
  return [...found]
    .sort(([a], [b]) => a - b)
    .map(([position, entry]) => {
      // Lines are merged as shown on screen, then mapped into page space.
      const toPage = invertMatrix(pageToDisplay(entry.page, viewRotation));
      return {
        position,
        rects: mergeLineRects(entry.display).map((rect) => mapRect(toPage, rect)),
        text: entry.text.join('').replace(/\s+/g, ' ').trim(),
      };
    })
    .filter((entry) => entry.rects.length > 0);
}
