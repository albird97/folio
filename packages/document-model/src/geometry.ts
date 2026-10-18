/** Page rotation in degrees, clockwise, as defined by the PDF /Rotate key. */
export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

/**
 * A point in PDF user space of the unrotated page (origin at its bottom-left).
 * One unit is one point unless the page sets /UserUnit (see PageModel.userUnit).
 */
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** An axis-aligned rectangle in PDF user space of the unrotated page (see Point). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Normalizes any multiple of 90 (including negatives and values above 360)
 * to a canonical rotation. Throws for angles that are not multiples of 90,
 * because PDF page rotation cannot represent them.
 */
export function normalizeRotation(degrees: number): Rotation {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) {
    throw new RangeError(`Page rotation must be a multiple of 90, received ${degrees}.`);
  }
  return (((degrees % 360) + 360) % 360) as Rotation;
}

export function addRotation(a: Rotation, b: number): Rotation {
  return normalizeRotation(a + b);
}

/** Size of a page box once the given rotation is applied. */
export function rotatedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

export const POINTS_PER_INCH = 72;
export const MM_PER_INCH = 25.4;

export function pointsToMillimetres(points: number): number {
  return (points / POINTS_PER_INCH) * MM_PER_INCH;
}

const KNOWN_PAGE_SIZES: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'Letter', width: 612, height: 792 },
  { name: 'Legal', width: 612, height: 1008 },
  { name: 'Tabloid', width: 792, height: 1224 },
  { name: 'A3', width: 841.89, height: 1190.55 },
  { name: 'A4', width: 595.28, height: 841.89 },
  { name: 'A5', width: 419.53, height: 595.28 },
];

/** Returns a familiar paper-size name (e.g. "A4") when the size matches within 1pt. */
export function describePageSize(size: Size): string | null {
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  const match = KNOWN_PAGE_SIZES.find(
    (known) => Math.abs(known.width - short) <= 1 && Math.abs(known.height - long) <= 1,
  );
  return match?.name ?? null;
}
