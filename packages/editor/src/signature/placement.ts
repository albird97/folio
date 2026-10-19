import {
  growRect,
  newAnnotationId,
  normalizeRect,
  type AssetId,
  type PageId,
  type PageModel,
  type Point,
  type Rect,
  type Rotation,
  type SignatureAnnotation,
} from '@folio/document-model';
import {
  displayRotation,
  displaySpaceSize,
  invertMatrix,
  mapRect,
  pageToDisplay,
  savedRotation,
} from '../viewer/geometry';

/**
 * Room a signature gets when it is placed with a click, in points: about the
 * size of a handwritten signature. It keeps its proportions within the box.
 */
export const SIGNATURE_ROOM = { width: 150, height: 75 } as const;
/** A signature placed with a click takes at most this share of the page as shown. */
const MAX_PAGE_SHARE = 0.9;
/** Room left around a signature in a signature field, as a share of the field's shorter side. */
const FIELD_INSET = 0.08;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The largest rect with the proportions `aspect` (width / height) that fits `box`, centred in it. */
export function fitRect(box: Rect, aspect: number): Rect {
  const { x, y, width, height } = normalizeRect(box);
  const fitted =
    width > height * aspect
      ? { width: height * aspect, height }
      : { width, height: width / aspect };
  return {
    x: x + (width - fitted.width) / 2,
    y: y + (height - fitted.height) / 2,
    width: fitted.width,
    height: fitted.height,
  };
}

/** Where a signature goes on its page. */
interface Placement {
  /** Its box in page space. */
  rect: Rect;
  /** The page rotation it reads upright at (see `SignatureAnnotation.rotation`). */
  rotation: Rotation;
}

/**
 * A signature placed with a click at `at` (display space: the page as shown,
 * in user space units): at its usual size (smaller on small pages), centred
 * on the point but kept on the page, and upright as the page is shown, like
 * pictures added with a click. `shown` is its box in display space, for the
 * preview that follows the pointer.
 */
export function clickPlacement(
  page: PageModel,
  viewRotation: Rotation,
  at: Point,
  aspect: number,
): Placement & { shown: Rect } {
  const display = displaySpaceSize(page, viewRotation);
  const { width, height } = fitRect(
    {
      x: 0,
      y: 0,
      // Points to user space units (pages with a /UserUnit have larger units).
      width: Math.min(SIGNATURE_ROOM.width / page.userUnit, display.width * MAX_PAGE_SHARE),
      height: Math.min(SIGNATURE_ROOM.height / page.userUnit, display.height * MAX_PAGE_SHARE),
    },
    aspect,
  );
  const shown = {
    x: clamp(at.x - width / 2, 0, display.width - width),
    y: clamp(at.y - height / 2, 0, display.height - height),
    width,
    height,
  };
  return {
    shown,
    rect: mapRect(invertMatrix(pageToDisplay(page, viewRotation)), shown),
    rotation: displayRotation(page, viewRotation),
  };
}

/**
 * A signature in a signature field (`field` in page space): as large as fits
 * with a little room around it, centred, and upright as the page is saved,
 * which is how the form's author laid the field out.
 */
export function fieldPlacement(page: PageModel, field: Rect, aspect: number): Placement {
  const rotation = savedRotation(page);
  const box = normalizeRect(field);
  const inner = growRect(box, -Math.min(box.width, box.height) * FIELD_INSET);
  // On a turned page, the signature's width runs along the page's height.
  return { rect: fitRect(inner, rotation % 180 === 0 ? aspect : 1 / aspect), rotation };
}

/** A new signature annotation showing the image `assetId`. */
export function newSignature({
  pageId,
  placement,
  assetId,
  author,
}: {
  pageId: PageId;
  placement: Placement;
  assetId: AssetId;
  author: string;
}): SignatureAnnotation {
  const now = new Date().toISOString();
  return {
    id: newAnnotationId(),
    pageId,
    author,
    createdAt: now,
    modifiedAt: now,
    color: '#000000',
    opacity: 1,
    kind: 'signature',
    rect: placement.rect,
    assetId,
    rotation: placement.rotation,
  };
}
