import { newPageId, type PageModel, type Rotation } from '@folio/document-model';
import { describe, expect, it } from 'vitest';
import { splitParts } from '../components/dialogs';
import {
  applyMatrix,
  displayRotation,
  displaySpaceSize,
  invertMatrix,
  mapRect,
  pageToDisplay,
} from './geometry';
import { mergeLineRects } from './text-markup';

const page = (sourceRotation: Rotation = 0, rotation: Rotation = 0, userUnit = 1): PageModel => ({
  id: newPageId(),
  source: { kind: 'blank' },
  size: { width: 600 * userUnit, height: 800 * userUnit },
  userUnit,
  sourceRotation,
  rotation,
});

describe('page space to display space', () => {
  it('puts the page origin at the corner shown for each rotation', () => {
    // Page space origin is the lower-left corner; display space starts top-left.
    const corners: Record<Rotation, [number, number]> = {
      0: [0, 800],
      90: [0, 0],
      180: [600, 0],
      270: [800, 600],
    };
    for (const rotation of [0, 90, 180, 270] as const) {
      const matrix = pageToDisplay(page(), rotation);
      expect(applyMatrix(matrix, { x: 0, y: 0 })).toEqual({
        x: corners[rotation][0],
        y: corners[rotation][1],
      });
    }
  });

  it('adds the page’s own rotation, the user’s and the view’s', () => {
    expect(displayRotation(page(90, 180), 270)).toBe(180);
    expect(displaySpaceSize(page(90), 0)).toEqual({ width: 800, height: 600 });
    expect(displaySpaceSize(page(90, 90), 0)).toEqual({ width: 600, height: 800 });
  });

  it('measures in unscaled user space units', () => {
    expect(displaySpaceSize(page(0, 0, 2), 0)).toEqual({ width: 600, height: 800 });
  });

  it('round-trips points and keeps rectangles axis-aligned', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const matrix = pageToDisplay(page(), rotation);
      const back = applyMatrix(invertMatrix(matrix), applyMatrix(matrix, { x: 120, y: 340 }));
      expect(back.x).toBeCloseTo(120);
      expect(back.y).toBeCloseTo(340);
      const shown = mapRect(matrix, { x: 100, y: 200, width: 50, height: 20 });
      const turned = rotation % 180 !== 0;
      expect([shown.width, shown.height]).toEqual(turned ? [20, 50] : [50, 20]);
    }
  });
});

describe('mergeLineRects', () => {
  it('merges the runs of a line and keeps lines and distant columns apart', () => {
    const merged = mergeLineRects([
      { x: 10, y: 100, width: 40, height: 12 },
      { x: 52, y: 101, width: 30, height: 11 },
      { x: 10, y: 120, width: 60, height: 12 },
      // Another column on the same line, far to the right.
      { x: 300, y: 100, width: 40, height: 12 },
      // Nothing to mark.
      { x: 5, y: 5, width: 0, height: 12 },
    ]);
    expect(merged).toEqual([
      { x: 10, y: 100, width: 72, height: 12 },
      { x: 300, y: 100, width: 40, height: 12 },
      { x: 10, y: 120, width: 60, height: 12 },
    ]);
  });
});

describe('splitParts', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'] as never[];

  it('splits every n pages', () => {
    expect(splitParts(ids, { every: 2 })).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(splitParts(ids, { every: 9 })).toEqual([ids]);
  });

  it('splits before chosen pages', () => {
    expect(splitParts(ids, { before: new Set(['c', 'e'] as never[]) })).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });
});
