/** Every thumbnail occupies the same height, so the list virtualizes by arithmetic. */
export const THUMBNAIL_SLOT = 172;
/** Space above the first and below the last thumbnail. */
export const LIST_PADDING = 8;

export function slotTop(index: number): number {
  return LIST_PADDING + index * THUMBNAIL_SLOT;
}

/**
 * The gap between thumbnails nearest to `y`, a distance from the top of the
 * list's content (not of its window): 0 is before the first page, `count`
 * after the last.
 */
export function dropSlotAt(y: number, count: number): number {
  return Math.min(count, Math.max(0, Math.round((y - LIST_PADDING) / THUMBNAIL_SLOT)));
}

/** The gap a drop at `clientY` lands in, in a scrolled list of `count` pages. */
export function dropSlot(list: HTMLElement, clientY: number, count: number): number {
  return dropSlotAt(clientY - list.getBoundingClientRect().top + list.scrollTop, count);
}

/**
 * What dragged pages are over: a document's pages panel (its scrolling list)
 * or its page view. Both carry the document's key, so pages can be dropped
 * on the other document of a split view.
 */
export type DropTarget =
  { kind: 'list'; docKey: string; list: HTMLElement } | { kind: 'view'; docKey: string };

export function dropTargetAt(element: Element | null): DropTarget | null {
  const list = element?.closest<HTMLElement>('[data-page-list]');
  if (list?.dataset.pageList) return { kind: 'list', docKey: list.dataset.pageList, list };
  const view = element?.closest<HTMLElement>('[data-page-view]');
  if (view?.dataset.pageView) return { kind: 'view', docKey: view.dataset.pageView };
  return null;
}
