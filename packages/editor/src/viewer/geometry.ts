import {
  addRotation,
  normalizeRotation,
  rotatedSize,
  type Matrix,
  type PageModel,
  type Point,
  type Rect,
  type Rotation,
  type Size,
  type SourceId,
} from '@folio/document-model';

/** The rotation the engine adds on top of the page's own /Rotate. */
export function userRotation(page: PageModel, viewRotation: Rotation): Rotation {
  return addRotation(page.rotation, viewRotation);
}

/** How far the page is turned on screen: its own, the user's and the view's rotation. */
export function displayRotation(page: PageModel, viewRotation: Rotation): Rotation {
  return normalizeRotation(page.sourceRotation + page.rotation + viewRotation);
}

/** The rotation a page is saved with (what other viewers show). */
export function savedRotation(page: PageModel): Rotation {
  return normalizeRotation(page.sourceRotation + page.rotation);
}

/** The page's size as shown, once its own, the user's and the view's rotations apply. */
export function displaySize(page: PageModel, viewRotation: Rotation): Size {
  return rotatedSize(page.size, addRotation(page.sourceRotation, userRotation(page, viewRotation)));
}

/** Where a page's content comes from in the engine, or null for a blank page. */
export function pageSource(page: PageModel): { sourceId: SourceId; pageIndex: number } | null {
  return page.source.kind === 'source'
    ? { sourceId: page.source.sourceId, pageIndex: page.source.pageIndex }
    : null;
}

/** The page's size in its own (unscaled) user space units. */
export function pageSpaceSize(page: PageModel): Size {
  return { width: page.size.width / page.userUnit, height: page.size.height / page.userUnit };
}

/**
 * Maps page space (user space from the lower-left corner of the visible area,
 * y up) to display space: the page as shown, from its top-left corner, y
 * down, in the same units.
 */
export function pageToDisplay(page: PageModel, viewRotation: Rotation): Matrix {
  const { width, height } = pageSpaceSize(page);
  switch (displayRotation(page, viewRotation)) {
    case 90:
      return [0, 1, 1, 0, 0, 0];
    case 180:
      return [-1, 0, 0, 1, width, 0];
    case 270:
      return [0, -1, -1, 0, height, width];
    default:
      return [1, 0, 0, -1, 0, height];
  }
}

/** Size of display space (the page as shown) in user space units. */
export function displaySpaceSize(page: PageModel, viewRotation: Rotation): Size {
  const size = pageSpaceSize(page);
  const turned = displayRotation(page, viewRotation) % 180 !== 0;
  return turned ? { width: size.height, height: size.width } : size;
}

export function applyMatrix([a, b, c, d, e, f]: Matrix, point: Point): Point {
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

export function invertMatrix(m: Matrix): Matrix {
  return invertTransform(m) as Matrix;
}

/** A rectangle mapped through a matrix (axis-aligned for quarter-turn rotations). */
export function mapRect(matrix: Matrix, rect: Rect): Rect {
  const a = applyMatrix(matrix, { x: rect.x, y: rect.y });
  const b = applyMatrix(matrix, { x: rect.x + rect.width, y: rect.y + rect.height });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function invertTransform(m: readonly number[]): number[] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const det = a * d - b * c;
  if (det === 0) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** SVG `matrix(…)` for a transform. */
export const svgMatrix = (m: Matrix) => `matrix(${m.map((value) => +value.toFixed(6)).join(' ')})`;
