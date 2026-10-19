import {
  contentFrame,
  newAssetId,
  newPageId,
  type PageModel,
  type Rect,
  type Rotation,
} from '@folio/document-model';
import { describe, expect, it } from 'vitest';
import { mapRect, pageToDisplay } from '../viewer/geometry';
import { clickPlacement, fieldPlacement, fitRect, newSignature, SIGNATURE_ROOM } from './placement';

const page = ({
  width = 600,
  height = 800,
  sourceRotation = 0,
  rotation = 0,
  userUnit = 1,
}: Partial<{
  width: number;
  height: number;
  sourceRotation: Rotation;
  rotation: Rotation;
  userUnit: number;
}> = {}): PageModel => ({
  id: newPageId(),
  source: { kind: 'blank' },
  size: { width: width * userUnit, height: height * userUnit },
  userUnit,
  sourceRotation,
  rotation,
});

/** The proportions the image is drawn at (upright in its content frame). */
const drawnAspect = ({ rect, rotation }: { rect: Rect; rotation: Rotation }) => {
  const frame = contentFrame(rect, rotation);
  return frame.width / frame.height;
};

const expectRect = (actual: Rect, expected: Rect) => {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(actual[key], key).toBeCloseTo(expected[key], 6);
  }
};

describe('fitRect', () => {
  it('fits a wide or a tall picture, centred, keeping its proportions', () => {
    expectRect(fitRect({ x: 10, y: 20, width: 200, height: 100 }, 4), {
      x: 10,
      y: 45,
      width: 200,
      height: 50,
    });
    expectRect(fitRect({ x: 10, y: 20, width: 200, height: 100 }, 1), {
      x: 60,
      y: 20,
      width: 100,
      height: 100,
    });
    // Boxes given from any corner.
    expectRect(fitRect({ x: 210, y: 120, width: -200, height: -100 }, 1), {
      x: 60,
      y: 20,
      width: 100,
      height: 100,
    });
  });
});

describe('placing a signature with a click', () => {
  it('centres it on the point at the usual size, upright', () => {
    const placed = clickPlacement(page(), 0, { x: 300, y: 400 }, 3);
    expectRect(placed.shown, { x: 225, y: 375, width: 150, height: 50 });
    // Display space runs down from the top; page space up from the bottom.
    expectRect(placed.rect, { x: 225, y: 375, width: 150, height: 50 });
    expect(placed.rotation).toBe(0);
  });

  it('keeps tall signatures within the usual room', () => {
    const placed = clickPlacement(page(), 0, { x: 300, y: 400 }, 1);
    expect(placed.shown.width).toBeCloseTo(SIGNATURE_ROOM.height);
    expect(placed.shown.height).toBeCloseTo(SIGNATURE_ROOM.height);
  });

  it('keeps it on the page near the edges', () => {
    const corner = clickPlacement(page(), 0, { x: 590, y: 5 }, 3).shown;
    expectRect(corner, { x: 450, y: 0, width: 150, height: 50 });
    const other = clickPlacement(page(), 0, { x: 0, y: 800 }, 3).shown;
    expectRect(other, { x: 0, y: 750, width: 150, height: 50 });
  });

  it('makes it smaller on a small page', () => {
    const label = page({ width: 100, height: 40 });
    const placed = clickPlacement(label, 0, { x: 50, y: 20 }, 3);
    expect(placed.shown.width).toBeCloseTo(90);
    expect(placed.shown.height).toBeCloseTo(30);
    expect(placed.shown.x).toBeGreaterThanOrEqual(0);
    expect(placed.shown.x + placed.shown.width).toBeLessThanOrEqual(100);
  });

  it('measures the usual size in points on pages with large user units', () => {
    const placed = clickPlacement(page({ userUnit: 2 }), 0, { x: 300, y: 400 }, 3);
    // 150 points are 75 units of 2 points.
    expect(placed.shown.width).toBeCloseTo(75);
  });

  it('reads level on turned pages and in a turned view', () => {
    const turned = page({ sourceRotation: 90 });
    for (const [subject, view] of [
      [turned, 0],
      [page({ rotation: 270 }), 0],
      [page(), 90],
      [turned, 180],
    ] as const) {
      const placed = clickPlacement(subject, view, { x: 300, y: 300 }, 3);
      expect(placed.rotation).toBe((subject.sourceRotation + subject.rotation + view) % 360);
      // Wide on screen, and drawn upright at its own proportions.
      expect(placed.shown.width).toBeCloseTo(150);
      expect(drawnAspect(placed)).toBeCloseTo(3);
      // The page-space box is where the preview showed it.
      expectRect(mapRect(pageToDisplay(subject, view), placed.rect), placed.shown);
    }
  });
});

describe('signing a signature field', () => {
  it('fits the field with a little room, centred', () => {
    const field = { x: 100, y: 100, width: 200, height: 50 };
    const placed = fieldPlacement(page(), field, 3);
    expect(placed.rotation).toBe(0);
    expect(placed.rect.width / placed.rect.height).toBeCloseTo(3);
    expect(placed.rect.height).toBeCloseTo(50 - 2 * 4);
    expect(placed.rect.x + placed.rect.width / 2).toBeCloseTo(200);
    expect(placed.rect.y + placed.rect.height / 2).toBeCloseTo(125);
    // A signature wider than the field fits its width instead.
    const wide = fieldPlacement(page(), field, 10);
    expect(wide.rect.width).toBeCloseTo(200 - 2 * 4);
    expect(wide.rect.x).toBeCloseTo(104);
  });

  it('reads level on a turned page, as the form was laid out', () => {
    // On a page saved turned by 90°, a field that looks wide is tall in page space.
    const field = { x: 100, y: 100, width: 50, height: 200 };
    const placed = fieldPlacement(page({ sourceRotation: 90 }), field, 3);
    expect(placed.rotation).toBe(90);
    expect(drawnAspect(placed)).toBeCloseTo(3);
    expect(placed.rect.width).toBeCloseTo(42);
    expect(placed.rect.height).toBeCloseTo(126);
    // The rotation the page is saved with counts, the user's included.
    expect(fieldPlacement(page({ sourceRotation: 90, rotation: 90 }), field, 3).rotation).toBe(180);
  });
});

describe('newSignature', () => {
  it('is a signature annotation of the image, placed', () => {
    const pageId = newPageId();
    const assetId = newAssetId();
    const signature = newSignature({
      pageId,
      placement: { rect: { x: 1, y: 2, width: 30, height: 10 }, rotation: 90 },
      assetId,
      author: 'Ada',
    });
    expect(signature).toMatchObject({
      kind: 'signature',
      pageId,
      assetId,
      author: 'Ada',
      opacity: 1,
      rect: { x: 1, y: 2, width: 30, height: 10 },
      rotation: 90,
    });
    expect(signature.createdAt).toBe(signature.modifiedAt);
  });
});
