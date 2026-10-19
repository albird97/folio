import { describe, expect, it } from 'vitest';
import type { Matrix } from './annotation-layout';
import { rotatedSize, type Point, type Rotation } from './geometry';
import {
  layoutStamp,
  pageNumberText,
  pageStamps,
  stampedRange,
  type StampedPage,
  type StampLayout,
} from './stamp-layout';
import { STANDARD_FONT_METRICS } from './standard-font-metrics';
import {
  NO_STAMPS,
  STAMP_POSITIONS,
  type PageNumberStamp,
  type StampPosition,
  type WatermarkStamp,
} from './types';

const NUMBERS: PageNumberStamp = {
  format: 'Page {page} of {total}',
  position: 'bottom-center',
  fontFamily: 'sans',
  fontSize: 10,
  color: '#1f2328',
  margin: 36,
  startNumber: 1,
  pages: { from: 1, to: null },
};

const WATERMARK: WatermarkStamp = {
  text: 'CONFIDENTIAL',
  position: 'center',
  fontFamily: 'sans',
  fontSize: 72,
  color: '#e03131',
  opacity: 0.25,
  angle: 45,
  layer: 'under',
  margin: 36,
  pages: { from: 1, to: null },
};

const a4 = (sourceRotation: Rotation = 0, rotation: Rotation = 0): StampedPage => ({
  size: { width: 595.28, height: 841.89 },
  userUnit: 1,
  sourceRotation,
  rotation,
});

const apply = ([a, b, c, d, e, f]: Matrix, x: number, y: number): Point => ({
  x: a * x + c * y + e,
  y: b * x + d * y + f,
});

/**
 * Page space → the page as shown with its saved rotation, in points (y up).
 * Written out per rotation, independently of the layout's own mapping: a page
 * turned 90° clockwise shows its right edge at the bottom and reads along +y.
 */
function toShown(page: StampedPage, point: Point): Point {
  const unit = page.userUnit;
  const width = page.size.width / unit;
  const height = page.size.height / unit;
  const turn = (page.sourceRotation + page.rotation) % 360;
  const [x, y] =
    turn === 90
      ? [point.y, width - point.x]
      : turn === 180
        ? [width - point.x, height - point.y]
        : turn === 270
          ? [height - point.y, point.x]
          : [point.x, point.y];
  return { x: x * unit, y: y * unit };
}

/** The text's box on the page as shown, and where its baseline and up directions point there. */
function shownBox(page: StampedPage, layout: StampLayout) {
  const { ascent, descent } = STANDARD_FONT_METRICS[layout.fontFamily];
  const top = (ascent * layout.fontSize) / 1000;
  const bottom = (descent * layout.fontSize) / 1000;
  const corners = [
    [0, bottom],
    [layout.width, bottom],
    [0, top],
    [layout.width, top],
  ].map(([x, y]) => toShown(page, apply(layout.matrix, x!, y!)));
  const origin = toShown(page, apply(layout.matrix, 0, 0));
  const along = toShown(page, apply(layout.matrix, 1, 0));
  const up = toShown(page, apply(layout.matrix, 0, 1));
  return {
    left: Math.min(...corners.map((corner) => corner.x)),
    right: Math.max(...corners.map((corner) => corner.x)),
    bottom: Math.min(...corners.map((corner) => corner.y)),
    top: Math.max(...corners.map((corner) => corner.y)),
    along: { x: along.x - origin.x, y: along.y - origin.y },
    up: { x: up.x - origin.x, y: up.y - origin.y },
  };
}

/** Checks the box keeps `margin` from the edges its position names, or is centred. */
function expectPlaced(
  box: ReturnType<typeof shownBox>,
  position: StampPosition,
  size: { width: number; height: number },
  margin: number,
) {
  if (position.endsWith('left')) expect(box.left).toBeCloseTo(margin, 6);
  else if (position.endsWith('right')) expect(box.right).toBeCloseTo(size.width - margin, 6);
  else expect((box.left + box.right) / 2).toBeCloseTo(size.width / 2, 6);
  if (position.startsWith('top')) expect(box.top).toBeCloseTo(size.height - margin, 6);
  else if (position.startsWith('bottom')) expect(box.bottom).toBeCloseTo(margin, 6);
  else expect((box.bottom + box.top) / 2).toBeCloseTo(size.height / 2, 6);
}

/** Every saved rotation, from the file's /Rotate, the user's rotation, or both. */
const TURNS: Array<[Rotation, Rotation]> = [
  [0, 0],
  [90, 0],
  [0, 180],
  [90, 180],
];

describe('stampedRange', () => {
  it('covers the pages of a range that exist', () => {
    expect(stampedRange({ from: 1, to: null }, 12)).toEqual({ first: 0, last: 11 });
    expect(stampedRange({ from: 3, to: 5 }, 12)).toEqual({ first: 2, last: 4 });
    // A range past the end (pages were deleted) stops at the last page.
    expect(stampedRange({ from: 2, to: 99 }, 3)).toEqual({ first: 1, last: 2 });
  });

  it('covers nothing when no page is in the range', () => {
    expect(stampedRange({ from: 5, to: null }, 3)).toBeNull();
    expect(stampedRange({ from: 4, to: 2 }, 12)).toBeNull();
  });
});

describe('pageNumberText', () => {
  it('fills in the page and the last stamped page', () => {
    expect(pageNumberText(NUMBERS, 0, 3)).toBe('Page 1 of 3');
    expect(pageNumberText(NUMBERS, 1, 3)).toBe('Page 2 of 3');
    expect(pageNumberText({ ...NUMBERS, format: '{page} / {total}' }, 2, 3)).toBe('3 / 3');
    expect(pageNumberText({ ...NUMBERS, format: '{page}{page}' }, 1, 3)).toBe('22');
  });

  it('counts from the first stamped page and its start number', () => {
    const fromTwo = { ...NUMBERS, pages: { from: 2, to: 11 } };
    expect(pageNumberText(fromTwo, 0, 12)).toBeNull();
    expect(pageNumberText(fromTwo, 1, 12)).toBe('Page 1 of 10');
    expect(pageNumberText(fromTwo, 10, 12)).toBe('Page 10 of 10');
    expect(pageNumberText(fromTwo, 11, 12)).toBeNull();
    expect(pageNumberText({ ...fromTwo, startNumber: 5 }, 1, 12)).toBe('Page 5 of 14');
    expect(pageNumberText({ ...NUMBERS, startNumber: 0 }, 0, 3)).toBe('Page 0 of 2');
  });

  it('keeps other text as it is', () => {
    expect(pageNumberText({ ...NUMBERS, format: '{pages} – {Page} {page' }, 0, 3)).toBe(
      '{pages} – {Page} {page',
    );
  });
});

describe('layoutStamp', () => {
  it('places page numbers at every position, level on pages shown at every rotation', () => {
    for (const [sourceRotation, rotation] of TURNS) {
      const page = a4(sourceRotation, rotation);
      const size = rotatedSize(page.size, ((sourceRotation + rotation) % 360) as Rotation);
      for (const position of STAMP_POSITIONS) {
        const layout = layoutStamp(page, { ...NUMBERS, position }, 'Page 12 of 99');
        expect(layout.fontSize).toBe(10);
        const box = shownBox(page, layout);
        expectPlaced(box, position, size, 36);
        // Reads left to right with upright glyphs, one point per point.
        expect(box.along.x).toBeCloseTo(1, 9);
        expect(box.along.y).toBeCloseTo(0, 9);
        expect(box.up.x).toBeCloseTo(0, 9);
        expect(box.up.y).toBeCloseTo(1, 9);
      }
    }
  });

  it('puts the bottom of a page turned clockwise at its right edge, reading up the page', () => {
    const page: StampedPage = {
      size: { width: 612, height: 792 },
      userUnit: 1,
      sourceRotation: 0,
      rotation: 90,
    };
    const layout = layoutStamp(page, NUMBERS, 'Page 1 of 3');
    expect(layout.bounds.x + layout.bounds.width).toBeCloseTo(612 - 36, 6);
    expect(layout.bounds.y + layout.bounds.height / 2).toBeCloseTo(396, 6);
    const [a, b, c, d] = layout.matrix;
    expect([a, b, c, d].map((value) => Math.round(value * 1e9) / 1e9)).toEqual([0, 1, -1, 0]);
  });

  it('places the box from the font’s descent to its ascent, a margin from the edge', () => {
    const page = a4();
    const { ascent, descent } = STANDARD_FONT_METRICS.sans;
    const bottom = layoutStamp(page, NUMBERS, '7');
    // The baseline sits above the margin by the depth of the font's descenders.
    expect(apply(bottom.matrix, 0, 0).y).toBeCloseTo(36 - (descent * 10) / 1000, 6);
    const top = apply(layoutStamp(page, { ...NUMBERS, position: 'top-left' }, '7').matrix, 0, 0);
    expect(top.x).toBeCloseTo(36, 6);
    expect(top.y).toBeCloseTo(841.89 - 36 - (ascent * 10) / 1000, 6);
  });

  it('turns watermarks counterclockwise as shown, centred on the page', () => {
    for (const [sourceRotation, rotation] of TURNS) {
      const page = a4(sourceRotation, rotation);
      const size = rotatedSize(page.size, ((sourceRotation + rotation) % 360) as Rotation);
      const layout = layoutStamp(page, WATERMARK, WATERMARK.text);
      expect(layout.fontSize).toBe(72);
      expect(layout.opacity).toBe(0.25);
      const box = shownBox(page, layout);
      expectPlaced(box, 'center', size, 36);
      expect(box.along.x).toBeCloseTo(Math.SQRT1_2, 9);
      expect(box.along.y).toBeCloseTo(Math.SQRT1_2, 9);
      expect(box.up.x).toBeCloseTo(-Math.SQRT1_2, 9);
      expect(box.up.y).toBeCloseTo(Math.SQRT1_2, 9);
    }
  });

  it('keeps turned watermarks at every position inside the margins', () => {
    for (const [sourceRotation, rotation] of TURNS) {
      const page = a4(sourceRotation, rotation);
      const size = rotatedSize(page.size, ((sourceRotation + rotation) % 360) as Rotation);
      for (const angle of [-90, -30, 0, 45, 90]) {
        for (const position of STAMP_POSITIONS) {
          const layout = layoutStamp(page, { ...WATERMARK, angle, position }, 'DRAFT');
          const box = shownBox(page, layout);
          expectPlaced(box, position, size, 36);
          expect(box.left).toBeGreaterThanOrEqual(36 - 1e-6);
          expect(box.right).toBeLessThanOrEqual(size.width - 36 + 1e-6);
          expect(box.bottom).toBeGreaterThanOrEqual(36 - 1e-6);
          expect(box.top).toBeLessThanOrEqual(size.height - 36 + 1e-6);
        }
      }
    }
  });

  it('shrinks text that would not fit rather than spilling off the page', () => {
    const page = a4();
    const wide = layoutStamp(page, { ...WATERMARK, angle: 0, fontSize: 300 }, 'CONFIDENTIAL');
    expect(wide.fontSize).toBeLessThan(300);
    // It fills the width between the margins exactly.
    expect(wide.bounds.width).toBeCloseTo(595.28 - 72, 6);
    const turned = layoutStamp(page, { ...WATERMARK, fontSize: 300 }, 'CONFIDENTIAL');
    expect(turned.fontSize).toBeLessThan(300);
    expect(turned.bounds.width).toBeCloseTo(595.28 - 72, 6);
    expect(turned.bounds.height).toBeLessThan(841.89 - 72);

    const long = 'Page 1 of 3, appendix, a format far longer than any page is wide '.repeat(4);
    const numbers = layoutStamp(page, { ...NUMBERS, position: 'bottom-right' }, long);
    expect(numbers.fontSize).toBeLessThan(10);
    expect(numbers.bounds.x).toBeCloseTo(36, 6);
    expect(numbers.bounds.x + numbers.bounds.width).toBeCloseTo(595.28 - 36, 6);
  });

  it('keeps sizes and margins in points on pages with a user unit', () => {
    // 1224 × 1584 points at /UserUnit 2: page space is 612 × 792 units.
    for (const rotation of [0, 90] as const) {
      const page: StampedPage = {
        size: { width: 1224, height: 1584 },
        userUnit: 2,
        sourceRotation: 0,
        rotation,
      };
      const layout = layoutStamp(page, NUMBERS, 'Page 1 of 3');
      expect(Math.hypot(layout.matrix[0], layout.matrix[1])).toBeCloseTo(0.5, 9);
      const box = shownBox(page, layout);
      const size = rotatedSize(page.size, rotation);
      expectPlaced(box, 'bottom-center', size, 36);
      expect(box.top - box.bottom).toBeCloseTo((10 * 925) / 1000, 6);
      // In page space, everything is half as large.
      expect(layout.bounds.height).toBeCloseTo(rotation === 0 ? 4.625 : layout.width / 2, 6);
    }
  });

  it('leaves room for the text on pages smaller than their margins', () => {
    const page: StampedPage = {
      size: { width: 100, height: 60 },
      userUnit: 1,
      sourceRotation: 0,
      rotation: 0,
    };
    const layout = layoutStamp(page, { ...NUMBERS, margin: 72 }, '1');
    // The margin is limited to a quarter of the shorter side.
    expect(layout.bounds.y).toBeCloseTo(15, 6);
    expect(layout.fontSize).toBe(10);
  });

  it('lays out empty text without failing', () => {
    const layout = layoutStamp(a4(90), { ...WATERMARK, angle: 90 }, '');
    expect(layout.width).toBe(0);
    expect(layout.matrix.every(Number.isFinite)).toBe(true);
    expect(Object.values(layout.bounds).every(Number.isFinite)).toBe(true);
  });

  it('shows characters the standard fonts lack as "?", on one line', () => {
    const layout = layoutStamp(a4(), WATERMARK, '机密\r\nDraft\nCafé');
    expect(layout).toMatchObject({ text: '?? Draft Café', lossy: true });
    expect(layoutStamp(a4(), WATERMARK, 'Café').lossy).toBe(false);
  });
});

describe('pageStamps', () => {
  const stamps = {
    pageNumbers: { ...NUMBERS, pages: { from: 2, to: null } },
    watermark: WATERMARK,
  };

  it('lays out the watermark, then the page number, on the pages they cover', () => {
    const second = pageStamps(a4(), stamps, 1, 3);
    expect(second.map((stamp) => [stamp.kind, stamp.layer, stamp.text])).toEqual([
      ['watermark', 'under', 'CONFIDENTIAL'],
      ['pageNumbers', 'over', 'Page 1 of 2'],
    ]);
    expect(pageStamps(a4(), stamps, 0, 3).map((stamp) => stamp.kind)).toEqual(['watermark']);
    expect(pageStamps(a4(), NO_STAMPS, 0, 3)).toEqual([]);
  });

  it('leaves out stamps without visible text', () => {
    const blank = {
      pageNumbers: { ...NUMBERS, format: '  ' },
      watermark: { ...WATERMARK, text: ' ' },
    };
    expect(pageStamps(a4(), blank, 0, 3)).toEqual([]);
  });
});
