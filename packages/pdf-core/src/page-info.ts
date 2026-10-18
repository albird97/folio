import { normalizeRotation, type Rotation, type Size } from '@folio/document-model';

export interface PdfPageInfo {
  /**
   * Unrotated crop-box size in points, with /UserUnit applied: the size that
   * `renderPage` draws at scale 1.
   */
  size: Size;
  rotation: Rotation;
  /** Points per user-space unit (/UserUnit, usually 1). */
  userUnit: number;
}

export interface PageInfoUpdate {
  index: number;
  info: PdfPageInfo;
}

/** The parts of a PDF.js page proxy that page info is read from. */
export interface PageLike {
  view: number[];
  rotate: number;
  userUnit: number;
}

export function pageInfoFrom(page: PageLike): PdfPageInfo {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
  // Viewports are scaled by /UserUnit (large-format pages; PDF.js defaults it
  // to 1), so sizes must be as well.
  const unit = page.userUnit;
  let rotation: Rotation = 0;
  try {
    rotation = normalizeRotation(page.rotate);
  } catch {
    rotation = 0;
  }
  return {
    size: { width: Math.abs(x2 - x1) * unit, height: Math.abs(y2 - y1) * unit },
    rotation,
    userUnit: unit,
  };
}

const keyOf = (info: PdfPageInfo) =>
  `${info.size.width}x${info.size.height}r${info.rotation}u${info.userUnit}`;

/**
 * The best guess for pages that have not been read yet: the most common
 * page among those that have (so a landscape cover does not skew a portrait
 * document).
 */
export function estimatePageInfo(known: readonly PdfPageInfo[]): PdfPageInfo {
  const counts = new Map<string, { info: PdfPageInfo; count: number }>();
  let best: { info: PdfPageInfo; count: number } | null = null;
  for (const info of known) {
    const key = keyOf(info);
    const entry = counts.get(key) ?? { info, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.info ?? { size: { width: 612, height: 792 }, rotation: 0, userUnit: 1 };
}

export function samePageInfo(a: PdfPageInfo, b: PdfPageInfo): boolean {
  return keyOf(a) === keyOf(b);
}
