import { describe, expect, it } from 'vitest';
import {
  dropSlot,
  dropSlotAt,
  dropTargetAt,
  LIST_PADDING,
  slotTop,
  THUMBNAIL_SLOT,
} from './page-drag';

describe('dropping dragged pages', () => {
  it('picks the gap between thumbnails nearest to the pointer', () => {
    expect(dropSlotAt(0, 3)).toBe(0);
    expect(dropSlotAt(slotTop(1) - THUMBNAIL_SLOT / 2 + 1, 3)).toBe(1);
    expect(dropSlotAt(slotTop(1) - THUMBNAIL_SLOT / 2 - 1, 3)).toBe(0);
    expect(dropSlotAt(slotTop(2), 3)).toBe(2);
    // Past the last page, or above the first, stays within the list.
    expect(dropSlotAt(slotTop(40), 3)).toBe(3);
    expect(dropSlotAt(-500, 3)).toBe(0);
    expect(dropSlotAt(LIST_PADDING, 0)).toBe(0);
  });

  it('measures from the list’s content, wherever it is scrolled', () => {
    const list = document.createElement('div');
    list.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    list.scrollTop = 0;
    expect(dropSlot(list, 100 + slotTop(1), 5)).toBe(1);
    Object.defineProperty(list, 'scrollTop', { value: THUMBNAIL_SLOT * 2 });
    expect(dropSlot(list, 100 + slotTop(1), 5)).toBe(3);
  });

  it('finds the pages panel or page view of a document under the pointer', () => {
    document.body.innerHTML = `
      <section>
        <div data-page-list="tab-1"><div role="option"><span id="thumb">1</span></div></div>
        <div data-page-view="tab-2"><div class="folio-page"><canvas id="canvas"></canvas></div></div>
        <p id="elsewhere">Toolbar</p>
      </section>`;
    const thumb = document.getElementById('thumb');
    expect(dropTargetAt(thumb)).toEqual({
      kind: 'list',
      docKey: 'tab-1',
      list: document.querySelector('[data-page-list]'),
    });
    expect(dropTargetAt(document.getElementById('canvas'))).toEqual({
      kind: 'view',
      docKey: 'tab-2',
    });
    expect(dropTargetAt(document.getElementById('elsewhere'))).toBeNull();
    expect(dropTargetAt(null)).toBeNull();
  });
});
