import { describe, expect, it } from 'vitest';
import { estimatePageInfo, pageInfoFrom } from './page-info';

const page = (width: number, height: number, rotate = 0) => ({
  view: [0, 0, width, height],
  rotate,
  userUnit: 1,
});

describe('page info', () => {
  it('reads sizes from the view box, scaled by the user unit', () => {
    expect(pageInfoFrom({ view: [10, 20, 110, 220], rotate: 90, userUnit: 2 })).toEqual({
      size: { width: 200, height: 400 },
      rotation: 90,
      userUnit: 2,
    });
    expect(pageInfoFrom(page(100, 100, 45)).rotation).toBe(0);
  });

  it('estimates unread pages from the most common page', () => {
    const cover = pageInfoFrom(page(792, 612));
    const body = pageInfoFrom(page(612, 792));
    expect(estimatePageInfo([cover, body, body])).toEqual(body);
    expect(estimatePageInfo([]).size).toEqual({ width: 612, height: 792 });
  });
});
