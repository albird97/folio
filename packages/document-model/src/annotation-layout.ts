import type { Point, Rect, Rotation } from './geometry';
import { STANDARD_FONT_METRICS } from './standard-font-metrics';
import type { AddedTextAnnotation, Annotation } from './types';

/*
 * How annotations are laid out on the page, shared by the editor (which
 * draws them on screen) and the exporter (which writes them into the PDF), so
 * both agree to the point. Coordinates are in page space: PDF user space
 * with the origin at the lower-left corner of the visible page area.
 */

/** Side of a note's icon, in points. */
export const NOTE_ICON_SIZE = 20;
/** Inner padding of added text boxes, in points. */
export const TEXT_PADDING = 2;
/** Distance between baselines, as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;

export type FontFamily = AddedTextAnnotation['fontFamily'];

/** A rectangle with non-negative width and height. */
export function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let bottom = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  for (const rect of rects.map(normalizeRect)) {
    left = Math.min(left, rect.x);
    bottom = Math.min(bottom, rect.y);
    right = Math.max(right, rect.x + rect.width);
    top = Math.max(top, rect.y + rect.height);
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

export const growRect = (rect: Rect, by: number): Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + by * 2,
  height: rect.height + by * 2,
});

export const translateRect = (rect: Rect, dx: number, dy: number): Rect => ({
  ...rect,
  x: rect.x + dx,
  y: rect.y + dy,
});

/**
 * Endpoints of a line or arrow shape: from the rect's origin to its far
 * corner, so negative width or height give the direction.
 */
export function lineEnds(rect: Rect): [Point, Point] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ];
}

/** Where an underline or strikeout runs within one marked line of text. */
export function markupStroke(
  rect: Rect,
  kind: 'underline' | 'strikeout',
): { y: number; thickness: number } {
  const box = normalizeRect(rect);
  const thickness = Math.max(0.5, box.height * 0.07);
  return {
    thickness,
    y: kind === 'underline' ? box.y + thickness * 1.5 : box.y + box.height * 0.45,
  };
}

/** Length of an arrow's head for a stroke width. */
export const arrowHeadSize = (strokeWidth: number) => Math.max(6, strokeWidth * 4);

/** The open arrow head at `to`: its two barbs and the tip, as a polyline. */
export function arrowHeadPoints(from: Point, to: Point, size: number): [Point, Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    to,
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}

/**
 * The note icon (a speech bubble) in page space, as a closed outline and the
 * three text lines inside it. The icon's top-left corner is at `position`.
 */
export function noteIconGeometry(position: Point): {
  outline: Point[];
  lines: Array<[Point, Point]>;
} {
  const s = NOTE_ICON_SIZE;
  const x = position.x;
  const y = position.y - s;
  return {
    outline: [
      { x: x + 2, y: y + 6 },
      { x: x + 2, y: y + s - 2 },
      { x: x + s - 2, y: y + s - 2 },
      { x: x + s - 2, y: y + 6 },
      { x: x + 9, y: y + 6 },
      { x: x + 4, y: y + 1.5 },
      { x: x + 5, y: y + 6 },
    ],
    lines: [
      [
        { x: x + 5, y: y + s - 6 },
        { x: x + s - 5, y: y + s - 6 },
      ],
      [
        { x: x + 5, y: y + s - 10 },
        { x: x + s - 5, y: y + s - 10 },
      ],
      [
        { x: x + 5, y: y + s - 14 },
        { x: x + s - 9, y: y + s - 14 },
      ],
    ],
  };
}

// ── Text ────────────────────────────────────────────────────────────────────

const widthTables = new Map<FontFamily, ReadonlyMap<number, number>>();

function widths(family: FontFamily): ReadonlyMap<number, number> {
  let table = widthTables.get(family);
  if (!table) {
    const pairs = STANDARD_FONT_METRICS[family].widths;
    const map = new Map<number, number>();
    for (let index = 0; index + 1 < pairs.length; index += 2)
      map.set(pairs[index]!, pairs[index + 1]!);
    table = map;
    widthTables.set(family, table);
  }
  return table;
}

/** Whether the standard PDF fonts can show `char` (Windows-1252 characters). */
export function canShowCharacter(char: string): boolean {
  return widths('sans').has(char.codePointAt(0)!);
}

/**
 * The text as the standard fonts will show it: tabs become spaces and
 * characters outside their character set become "?". `lossy` reports such
 * replacements so the user can be told.
 */
export function toStandardFontText(text: string): { text: string; lossy: boolean } {
  let out = '';
  let lossy = false;
  for (const raw of text) {
    if (raw === '\n' || raw === '\r') out += raw;
    else if (raw === '\t') out += ' ';
    else if (canShowCharacter(raw)) out += raw;
    else {
      out += '?';
      lossy = true;
    }
  }
  return { text: out, lossy };
}

/** Advance width of `text` in points (characters the font lacks count as "?"). */
export function textWidth(text: string, family: FontFamily, size: number): number {
  const table = widths(family);
  const fallback = table.get(0x3f) ?? 500;
  let total = 0;
  for (const char of text) total += table.get(char.codePointAt(0)!) ?? fallback;
  return (total * size) / 1000;
}

/** Height of the font's ascenders above the baseline, in points. */
export const fontAscent = (family: FontFamily, size: number) =>
  (STANDARD_FONT_METRICS[family].ascent * size) / 1000;

/** Splits text into lines that fit `width`, breaking at spaces where possible. */
export function wrapText(text: string, width: number, measure: (line: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue;
      const candidate = line + word;
      if (line.trim() === '' || measure(candidate.trimEnd()) <= width) {
        line = candidate;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
      // A word wider than the box is broken between characters.
      let chars = Array.from(line);
      while (chars.length > 1 && measure(line.trimEnd()) > width) {
        // The longest prefix that fits (at least one character).
        let low = 1;
        let high = chars.length - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (measure(chars.slice(0, mid).join('')) <= width) low = mid;
          else high = mid - 1;
        }
        lines.push(chars.slice(0, low).join(''));
        chars = chars.slice(low);
        line = chars.join('');
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** An affine transform [a b c d e f], as in PDF: x' = ax + cy + e, y' = bx + dy + f. */
export type Matrix = [number, number, number, number, number, number];

/** A box as its content sees it: upright, with `matrix` placing it on the page. */
export interface ContentFrame {
  width: number;
  height: number;
  /** Maps the content's coordinates (origin at its lower-left corner) into page space. */
  matrix: Matrix;
}

/**
 * The box of added text or an image, upright for the page rotation it was
 * added at: on a page turned 90°, content runs along the page's long edge so
 * it reads level when the page is shown turned.
 */
export function contentFrame(rect: Rect, rotation: Rotation): ContentFrame {
  const { x, y, width, height } = normalizeRect(rect);
  switch (rotation) {
    case 90:
      return { width: height, height: width, matrix: [0, 1, -1, 0, x + width, y] };
    case 180:
      return { width, height, matrix: [-1, 0, 0, -1, x + width, y + height] };
    case 270:
      return { width: height, height: width, matrix: [0, -1, 1, 0, x, y + height] };
    default:
      return { width, height, matrix: [1, 0, 0, 1, x, y] };
  }
}

export interface TextLine {
  text: string;
  /** Start of the baseline, in the content frame's coordinates. */
  x: number;
  y: number;
}

/**
 * The lines of an added text box as Folio draws them: wrapped to the box with
 * the standard font's widths, baselines from the top, and lines that would
 * start below the box left out (the rest is clipped to the box). Positions
 * are in the box's content frame.
 */
export function layoutAddedText(
  annotation: Pick<AddedTextAnnotation, 'rect' | 'text' | 'fontSize' | 'fontFamily' | 'rotation'>,
): { lines: TextLine[]; lossy: boolean; frame: ContentFrame } {
  const frame = contentFrame(annotation.rect, annotation.rotation);
  const { fontFamily: family, fontSize: size } = annotation;
  const safe = toStandardFontText(annotation.text);
  const wrapped = wrapText(safe.text, Math.max(1, frame.width - TEXT_PADDING * 2), (line) =>
    textWidth(line, family, size),
  );
  const top = frame.height - TEXT_PADDING - fontAscent(family, size);
  const lines: TextLine[] = [];
  for (const [index, text] of wrapped.entries()) {
    const y = top - index * size * LINE_HEIGHT;
    if (y < -size) break;
    lines.push({ text, x: TEXT_PADDING, y });
  }
  return { lines, lossy: safe.lossy, frame };
}

// ── Bounds, moving and resizing ─────────────────────────────────────────────

function pointBounds(points: readonly Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let bottom = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    bottom = Math.min(bottom, point.y);
    right = Math.max(right, point.x);
    top = Math.max(top, point.y);
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

/**
 * The geometry an annotation is moved and resized by: its box, or the
 * bounds of its points, without stroke widths.
 */
export function annotationFrame(annotation: Annotation): Rect {
  switch (annotation.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return unionRects(annotation.rects);
    case 'note':
      return {
        x: annotation.position.x,
        y: annotation.position.y - NOTE_ICON_SIZE,
        width: NOTE_ICON_SIZE,
        height: NOTE_ICON_SIZE,
      };
    case 'ink':
      return pointBounds(annotation.paths.flat());
    case 'shape':
    case 'added-text':
    case 'added-image':
    case 'signature':
      return normalizeRect(annotation.rect);
  }
}

/** Everything the annotation paints, including strokes and arrow heads. */
export function annotationBounds(annotation: Annotation): Rect {
  const frame = annotationFrame(annotation);
  switch (annotation.kind) {
    case 'ink':
      return annotation.paths.some((path) => path.length > 0)
        ? growRect(frame, annotation.strokeWidth / 2 + 1)
        : frame;
    case 'shape': {
      const half = annotation.strokeWidth / 2;
      return annotation.shape === 'line' || annotation.shape === 'arrow'
        ? growRect(frame, half + arrowHeadSize(annotation.strokeWidth))
        : growRect(frame, half);
    }
    default:
      return frame;
  }
}

/** Whether the annotation's size can change (text markup and notes only move). */
export function isResizable(annotation: Annotation): boolean {
  return (
    annotation.kind === 'ink' ||
    annotation.kind === 'shape' ||
    annotation.kind === 'added-text' ||
    annotation.kind === 'added-image' ||
    annotation.kind === 'signature'
  );
}

/** Whether the annotation can be moved; text markup stays on its text. */
export function isMovable(annotation: Annotation): boolean {
  return (
    annotation.kind !== 'highlight' &&
    annotation.kind !== 'underline' &&
    annotation.kind !== 'strikeout'
  );
}

/**
 * The annotation with its frame (see {@link annotationFrame}) moved or
 * stretched to `frame`. Annotations that cannot be resized only move.
 */
export function withFrame<T extends Annotation>(annotation: T, frame: Rect): T {
  const from = annotationFrame(annotation);
  const to = isResizable(annotation) ? normalizeRect(frame) : { ...from, x: frame.x, y: frame.y };
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  const map = (point: Point): Point => ({
    x: to.x + (point.x - from.x) * sx,
    y: to.y + (point.y - from.y) * sy,
  });
  const mapRect = (rect: Rect): Rect => {
    const [start, end] = lineEnds(rect).map(map) as [Point, Point];
    return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
  };
  const a = annotation as Annotation;
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return { ...a, rects: a.rects.map(mapRect) } as T;
    case 'note':
      return { ...a, position: map(a.position) } as T;
    case 'ink':
      return { ...a, paths: a.paths.map((path) => path.map(map)) } as T;
    case 'shape':
    case 'added-text':
    case 'added-image':
    case 'signature':
      return { ...a, rect: mapRect(a.rect) } as T;
  }
}

/** The annotation moved by (dx, dy) points. */
export function moveAnnotation<T extends Annotation>(annotation: T, dx: number, dy: number): T {
  return withFrame(annotation, translateRect(annotationFrame(annotation), dx, dy));
}
