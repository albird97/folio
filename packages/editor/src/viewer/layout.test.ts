import { describe, expect, it } from 'vitest';
import {
  anchorAt,
  computeLayout,
  mostVisiblePage,
  PAGE_GAP,
  scrollForAnchor,
  VIEW_PADDING,
  visibleRange,
} from './layout';

const letter = { width: 612, height: 792 };

describe('page layout', () => {
  it('stacks centred pages with gaps and padding', () => {
    const layout = computeLayout([letter, { width: 792, height: 612 }], 0.5, 1000);
    expect(layout.boxes).toEqual([
      { top: VIEW_PADDING, left: 347, width: 306, height: 396 },
      { top: VIEW_PADDING + 396 + PAGE_GAP, left: 302, width: 396, height: 306 },
    ]);
    expect(layout.height).toBe(VIEW_PADDING * 2 + 396 + PAGE_GAP + 306);
    expect(layout.width).toBe(1000);
  });

  it('widens the content for pages wider than the window', () => {
    const layout = computeLayout([letter], 2, 800);
    expect(layout.width).toBe(1224 + VIEW_PADDING * 2);
    expect(layout.boxes[0]?.left).toBe(VIEW_PADDING);
  });

  it('finds visible pages with overscan, even for 10,000 pages', () => {
    const layout = computeLayout(
      Array.from({ length: 10_000 }, () => letter),
      1,
      1000,
    );
    const pitch = 792 + PAGE_GAP;
    const top = VIEW_PADDING + pitch * 5000 + 100;
    expect(visibleRange(layout, top, 600)).toEqual({ first: 5000, last: 5000 });
    expect(visibleRange(layout, top, 900)).toEqual({ first: 5000, last: 5001 });
    expect(visibleRange(layout, top, 600, 800)).toEqual({ first: 4999, last: 5001 });
    expect(visibleRange(layout, 0, 100)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(layout, layout.height + 500, 100)).toEqual({ first: 9999, last: 9999 });
  });

  it('picks the most visible page', () => {
    const layout = computeLayout([letter, letter, letter], 1, 1000);
    const second = layout.boxes[1]!;
    expect(mostVisiblePage(layout, second.top - 100, 600)).toBe(1);
    expect(mostVisiblePage(layout, second.top - 500, 600)).toBe(0);
    expect(mostVisiblePage(computeLayout([], 1, 100), 0, 100)).toBeNull();
  });

  it('keeps a document point fixed under the pointer across zoom changes', () => {
    const pages = [letter, letter, letter];
    const before = computeLayout(pages, 1, 1000);
    const anchor = anchorAt(before, 0, 900, 500, 300)!;
    expect(anchor.pageIndex).toBe(1);
    const after = computeLayout(pages, 2, 1000);
    const scroll = scrollForAnchor(after, anchor, 500, 300);
    const box = after.boxes[1]!;
    // The anchored point lands back under the pointer.
    expect(scroll.top + 300).toBeCloseTo(box.top + anchor.y * box.height, 5);
    expect(scroll.left + 500).toBeCloseTo(box.left + anchor.x * box.width, 5);
  });
});
