import {
  contentFrame,
  textWidth,
  toStandardFontText,
  type FontFamily,
  type Matrix,
} from './annotation-layout';
import { normalizeRotation, type Rect } from './geometry';
import { STANDARD_FONT_METRICS } from './standard-font-metrics';
import type {
  DocumentStamps,
  HexColor,
  PageModel,
  PageNumberStamp,
  StampPageRange,
  StampPosition,
  WatermarkStamp,
} from './types';

/*
 * Where page numbers and watermarks go on a page, shared by the editor (which
 * shows them over the pages) and the exporter (which draws them into the
 * pages' content), so both agree to the point. Stamps are placed on the page
 * as it is shown with its saved rotation, and their sizes and margins are in
 * points whatever the page's /UserUnit. Results are in page space: PDF user
 * space from the lower-left corner of the visible page area, like annotation
 * geometry.
 */

/** What a stamp's layout needs to know about the page it is on. */
export type StampedPage = Pick<PageModel, 'size' | 'userUnit' | 'sourceRotation' | 'rotation'>;

/** The pages a stamp goes on, as 0-based positions (both inclusive). */
export interface StampedRange {
  first: number;
  last: number;
}

/** The positions a stamp's page range covers in a document of `pageCount` pages; null for none. */
export function stampedRange(pages: StampPageRange, pageCount: number): StampedRange | null {
  const first = Math.max(1, pages.from) - 1;
  const last = Math.min(pageCount, pages.to ?? pageCount) - 1;
  return first <= last ? { first, last } : null;
}

/**
 * The page number shown on the page at `position` (0-based): `{page}` becomes
 * the page's number and `{total}` the number of the last stamped page. Null
 * for pages the stamp's range leaves out.
 */
export function pageNumberText(
  stamp: Pick<PageNumberStamp, 'format' | 'startNumber' | 'pages'>,
  position: number,
  pageCount: number,
): string | null {
  const range = stampedRange(stamp.pages, pageCount);
  if (!range || position < range.first || position > range.last) return null;
  const numberAt = (at: number) => String(stamp.startNumber + at - range.first);
  return stamp.format.replace(/\{(page|total)\}/g, (_, key: string) =>
    numberAt(key === 'page' ? position : range.last),
  );
}

export interface StampLayout {
  /** The text as drawn: one line, with "?" for characters the standard fonts lack. */
  text: string;
  /** Some characters became "?". */
  lossy: boolean;
  fontFamily: FontFamily;
  /** In points; smaller than the stamp asks for when the text had to shrink to fit the page. */
  fontSize: number;
  color: HexColor;
  /** 0–1 */
  opacity: number;
  /** Advance width of the text at `fontSize`, in points. */
  width: number;
  /**
   * Maps text space into page space. Text space is in points, y up, with
   * the origin at the start of the text's baseline.
   */
  matrix: Matrix;
  /** What the text covers (its advance, from the font's descent to its ascent), in page space. */
  bounds: Rect;
}

/** Where each position puts a stamp across (0 left, 1 right) and up (0 bottom, 1 top) the page. */
const ANCHORS: Record<StampPosition, { x: number; y: number }> = {
  'top-left': { x: 0, y: 1 },
  'top-center': { x: 0.5, y: 1 },
  'top-right': { x: 1, y: 1 },
  'middle-left': { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  'middle-right': { x: 1, y: 0.5 },
  'bottom-left': { x: 0, y: 0 },
  'bottom-center': { x: 0.5, y: 0 },
  'bottom-right': { x: 1, y: 0 },
};

/** `outer` after `inner`: maps what `inner` maps, then through `outer`. */
function multiply(outer: Matrix, inner: Matrix): Matrix {
  const [a, b, c, d, e, f] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

/**
 * How a stamp's text sits on a page. The text's box (its advance, from the
 * font's descent to its ascent) is turned by the stamp's angle
 * counterclockwise as the page is shown (page numbers read level) and placed
 * so the turned box keeps the margin from the page's edges at its position,
 * or is centred on the page. Text too large for the space within the margins
 * shrinks to fit rather than spilling off the page.
 */
export function layoutStamp(
  page: StampedPage,
  stamp: PageNumberStamp | WatermarkStamp,
  text: string,
): StampLayout {
  const family = stamp.fontFamily;
  const { ascent, descent } = STANDARD_FONT_METRICS[family];
  // Stamps are one line: line breaks become spaces.
  const safe = toStandardFontText(text.replace(/\r\n|\r|\n/g, ' '));
  const angle = 'angle' in stamp ? stamp.angle : 0;

  // The page as shown: its size in points, and how it maps into page space.
  const unit = page.userUnit;
  const shown = contentFrame(
    { x: 0, y: 0, width: page.size.width / unit, height: page.size.height / unit },
    normalizeRotation(page.sourceRotation + page.rotation),
  );
  const pageWidth = shown.width * unit;
  const pageHeight = shown.height * unit;

  // The box per point of font size, and the space the turned box takes.
  const advance = textWidth(safe.text, family, 1);
  const boxHeight = (ascent - descent) / 1000;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const spanX = Math.abs(advance * cos) + Math.abs(boxHeight * sin);
  const spanY = Math.abs(advance * sin) + Math.abs(boxHeight * cos);
  // A margin takes at most a quarter of the shorter side, so a small page keeps room for text.
  const margin = Math.min(Math.max(0, stamp.margin), Math.min(pageWidth, pageHeight) / 4);
  const roomX = pageWidth - margin * 2;
  const roomY = pageHeight - margin * 2;
  const fontSize = Math.min(stamp.fontSize, roomX / spanX, roomY / spanY);

  // The middle of the turned box, on the page as shown.
  const anchor = ANCHORS[stamp.position];
  const halfX = (spanX * fontSize) / 2;
  const halfY = (spanY * fontSize) / 2;
  const centerX = margin + halfX + anchor.x * (roomX - halfX * 2);
  const centerY = margin + halfY + anchor.y * (roomY - halfY * 2);
  // Text space → the page as shown: turned about the middle of the box.
  const along = (advance * fontSize) / 2;
  const up = (((ascent + descent) / 2) * fontSize) / 1000;
  const inShown: Matrix = [
    cos,
    sin,
    -sin,
    cos,
    centerX - (cos * along - sin * up),
    centerY - (sin * along + cos * up),
  ];
  const [a, b, c, d, e, f] = shown.matrix;
  const matrix = multiply([a / unit, b / unit, c / unit, d / unit, e, f], inShown);

  const width = advance * fontSize;
  const low = (descent * fontSize) / 1000;
  const high = (ascent * fontSize) / 1000;
  const corners: Array<[number, number]> = [
    [0, low],
    [width, low],
    [0, high],
    [width, high],
  ];
  const xs = corners.map(([x, y]) => matrix[0] * x + matrix[2] * y + matrix[4]);
  const ys = corners.map(([x, y]) => matrix[1] * x + matrix[3] * y + matrix[5]);
  const left = Math.min(...xs);
  const bottom = Math.min(...ys);
  return {
    text: safe.text,
    lossy: safe.lossy,
    fontFamily: family,
    fontSize,
    color: stamp.color,
    opacity: 'opacity' in stamp ? stamp.opacity : 1,
    width,
    matrix,
    bounds: {
      x: left,
      y: bottom,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - bottom,
    },
  };
}

/** A stamp laid out on one page. */
export interface PageStamp extends StampLayout {
  kind: keyof DocumentStamps;
  position: StampPosition;
  /** Drawn behind the page's content or over it (page numbers are always over it). */
  layer: WatermarkStamp['layer'];
}

/**
 * The stamps on the page at `position` (0-based) of a document of
 * `pageCount` pages, in drawing order: the watermark, then the page number
 * (over the watermark when both are over the content). Stamps without
 * visible text are left out.
 */
export function pageStamps(
  page: StampedPage,
  stamps: DocumentStamps,
  position: number,
  pageCount: number,
): PageStamp[] {
  const out: PageStamp[] = [];
  const { watermark, pageNumbers } = stamps;
  const range = watermark ? stampedRange(watermark.pages, pageCount) : null;
  if (
    watermark &&
    range &&
    position >= range.first &&
    position <= range.last &&
    watermark.text.trim() !== ''
  ) {
    out.push({
      ...layoutStamp(page, watermark, watermark.text),
      kind: 'watermark',
      position: watermark.position,
      layer: watermark.layer,
    });
  }
  const number = pageNumbers ? pageNumberText(pageNumbers, position, pageCount) : null;
  if (pageNumbers && number !== null && number.trim() !== '') {
    out.push({
      ...layoutStamp(page, pageNumbers, number),
      kind: 'pageNumbers',
      position: pageNumbers.position,
      layer: 'over',
    });
  }
  return out;
}
