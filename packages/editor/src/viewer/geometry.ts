import {
  addRotation,
  rotatedSize,
  type PageModel,
  type Rotation,
  type Size,
} from '@folio/document-model';

/** The rotation the engine adds on top of the page's own /Rotate. */
export function userRotation(page: PageModel, viewRotation: Rotation): Rotation {
  return addRotation(page.rotation, viewRotation);
}

/** The page's size as shown, once its own, the user's and the view's rotations apply. */
export function displaySize(page: PageModel, viewRotation: Rotation): Size {
  return rotatedSize(page.size, addRotation(page.sourceRotation, userRotation(page, viewRotation)));
}

/**
 * The page of the engine document to render. Every page comes from the
 * opened file until merging and inserting pages arrive.
 */
export function sourcePageIndex(page: PageModel, position: number): number {
  return page.source.kind === 'source' ? page.source.pageIndex : position;
}

export function invertTransform(m: readonly number[]): number[] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const det = a * d - b * c;
  if (det === 0) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
