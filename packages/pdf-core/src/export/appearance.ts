import {
  annotationBounds,
  annotationFrame,
  arrowHeadSize,
  growRect,
  layoutAddedText,
  lineEnds,
  markupStroke,
  normalizeRect,
  NOTE_ICON_SIZE,
  translateRect,
  type Annotation,
  type FontFamily,
  type HexColor,
  type Point,
  type Rect,
} from '@folio/document-model';

/** Encodes text (already limited to what the font can show) for a `Tj` operator. */
export type EncodeText = (text: string, family: FontFamily) => string;

/**
 * Operators that draw one annotation in PDF user space, plus the resources
 * they use. The same drawing becomes an annotation's appearance stream or,
 * when flattening, part of the page content.
 */
export interface Drawing {
  ops: string[];
  /** Name → graphics state; `multiply` blends like a highlighter. */
  states: Map<string, { opacity: number; multiply: boolean }>;
  /** Name → standard font family. */
  fonts: Map<string, FontFamily>;
  /** Name → image (asset id). */
  images: Map<string, string>;
  /** Area the drawing covers, in user space. */
  bounds: Rect;
  /** Added text had characters the standard fonts cannot show. */
  lossyText: boolean;
}

export const num = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

export function rgb(color: HexColor): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return [0, 0, 0];
  return [
    Number.parseInt(match[1]!, 16) / 255,
    Number.parseInt(match[2]!, 16) / 255,
    Number.parseInt(match[3]!, 16) / 255,
  ];
}

const colorOps = (color: HexColor, op: 'rg' | 'RG') => `${rgb(color).map(num).join(' ')} ${op}`;

/** Approximates an ellipse with four Bézier curves. */
function ellipsePath(rect: Rect): string[] {
  const k = 0.5522847498;
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const cx = rect.x + rx;
  const cy = rect.y + ry;
  return [
    `${num(cx + rx)} ${num(cy)} m`,
    `${num(cx + rx)} ${num(cy + ry * k)} ${num(cx + rx * k)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx - rx * k)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ry * k)} ${num(cx - rx)} ${num(cy)} c`,
    `${num(cx - rx)} ${num(cy - ry * k)} ${num(cx - rx * k)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx + rx * k)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ry * k)} ${num(cx + rx)} ${num(cy)} c`,
  ];
}

function arrowHead(from: Point, to: Point, size: number): string[] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  const left = {
    x: to.x - size * Math.cos(angle - spread),
    y: to.y - size * Math.sin(angle - spread),
  };
  const right = {
    x: to.x - size * Math.cos(angle + spread),
    y: to.y - size * Math.sin(angle + spread),
  };
  return [
    `${num(left.x)} ${num(left.y)} m`,
    `${num(to.x)} ${num(to.y)} l`,
    `${num(right.x)} ${num(right.y)} l S`,
  ];
}

/**
 * Draws an annotation. `dx`/`dy` move it from page space (origin at the
 * lower-left corner of the visible page area) into PDF user space.
 */
export function drawAnnotation(
  annotation: Annotation,
  encodeText: EncodeText,
  offset: { dx: number; dy: number },
): Drawing {
  const { dx, dy } = offset;
  const drawing: Drawing = {
    ops: [],
    states: new Map(),
    fonts: new Map(),
    images: new Map(),
    bounds: translateRect(annotationBounds(annotation), dx, dy),
    lossyText: false,
  };
  const ops = drawing.ops;
  const state = (opacity: number, multiply = false) => {
    const name = `GS${drawing.states.size}`;
    drawing.states.set(name, { opacity: Math.min(1, Math.max(0, opacity)), multiply });
    ops.push(`/${name} gs`);
  };
  const at = (point: Point) => `${num(point.x + dx)} ${num(point.y + dy)}`;

  switch (annotation.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout': {
      const rects = annotation.rects.map((rect) => translateRect(normalizeRect(rect), dx, dy));
      ops.push('q');
      if (annotation.kind === 'highlight') {
        state(annotation.opacity, true);
        ops.push(colorOps(annotation.color, 'rg'));
        for (const rect of rects) {
          ops.push(`${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)} re f`);
        }
      } else {
        state(annotation.opacity);
        ops.push(colorOps(annotation.color, 'RG'));
        for (const rect of rects) {
          const { y, thickness } = markupStroke(rect, annotation.kind);
          ops.push(
            `${num(thickness)} w ${num(rect.x)} ${num(y)} m ${num(rect.x + rect.width)} ${num(y)} l S`,
          );
        }
      }
      ops.push('Q');
      break;
    }
    case 'note': {
      const box = drawing.bounds;
      const s = NOTE_ICON_SIZE;
      // A speech bubble: rounded body and a tail at the lower left.
      ops.push('q');
      state(annotation.opacity);
      ops.push(
        colorOps(annotation.color, 'rg'),
        '0.25 0.25 0.25 RG 0.8 w 1 j',
        `${num(box.x + 2)} ${num(box.y + 6)} m`,
        `${num(box.x + 2)} ${num(box.y + s - 2)} l`,
        `${num(box.x + s - 2)} ${num(box.y + s - 2)} l`,
        `${num(box.x + s - 2)} ${num(box.y + 6)} l`,
        `${num(box.x + 9)} ${num(box.y + 6)} l`,
        `${num(box.x + 4)} ${num(box.y + 1.5)} l`,
        `${num(box.x + 5)} ${num(box.y + 6)} l h B`,
        '0.25 0.25 0.25 RG 1 w',
        `${num(box.x + 5)} ${num(box.y + s - 6)} m ${num(box.x + s - 5)} ${num(box.y + s - 6)} l S`,
        `${num(box.x + 5)} ${num(box.y + s - 10)} m ${num(box.x + s - 5)} ${num(box.y + s - 10)} l S`,
        `${num(box.x + 5)} ${num(box.y + s - 14)} m ${num(box.x + s - 9)} ${num(box.y + s - 14)} l S`,
        'Q',
      );
      break;
    }
    case 'ink': {
      ops.push('q');
      state(annotation.opacity);
      ops.push(colorOps(annotation.color, 'RG'), `${num(annotation.strokeWidth)} w 1 J 1 j`);
      for (const path of annotation.paths) {
        if (path.length === 0) continue;
        const [first, ...rest] = path;
        ops.push(`${at(first!)} m`);
        // A single tap draws a dot.
        if (rest.length === 0) ops.push(`${at(first!)} l`);
        for (const point of rest) ops.push(`${at(point)} l`);
        ops.push('S');
      }
      ops.push('Q');
      break;
    }
    case 'shape': {
      const half = annotation.strokeWidth / 2;
      ops.push('q');
      state(annotation.opacity);
      ops.push(colorOps(annotation.color, 'RG'), `${num(annotation.strokeWidth)} w 1 j`);
      if (annotation.fill) ops.push(colorOps(annotation.fill, 'rg'));
      if (annotation.shape === 'line' || annotation.shape === 'arrow') {
        const [from, to] = lineEnds(translateRect(annotation.rect, dx, dy));
        ops.push('1 J', `${num(from.x)} ${num(from.y)} m ${num(to.x)} ${num(to.y)} l S`);
        if (annotation.shape === 'arrow') {
          ops.push(...arrowHead(from, to, arrowHeadSize(annotation.strokeWidth)));
        }
      } else {
        const rect = translateRect(annotationFrame(annotation), dx, dy);
        // Inset by half the stroke so the outline stays inside the box.
        const inner = growRect(rect, -half);
        const paint = annotation.fill ? (annotation.strokeWidth > 0 ? 'B' : 'f') : 'S';
        if (annotation.shape === 'rectangle') {
          ops.push(
            `${num(inner.x)} ${num(inner.y)} ${num(Math.max(0, inner.width))} ${num(Math.max(0, inner.height))} re ${paint}`,
          );
        } else {
          ops.push(...ellipsePath(inner), paint);
        }
      }
      ops.push('Q');
      break;
    }
    case 'added-text': {
      const rect = drawing.bounds;
      const family = annotation.fontFamily;
      const font = 'F0';
      drawing.fonts.set(font, family);
      const { lines, lossy } = layoutAddedText(annotation);
      drawing.lossyText = lossy;
      ops.push('q');
      state(annotation.opacity);
      // Clip to the box: text never spills over the page content around it.
      ops.push(
        `${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)} re W n`,
        'BT',
        `/${font} ${num(annotation.fontSize)} Tf`,
        colorOps(annotation.color, 'rg'),
      );
      for (const line of lines) {
        ops.push(`1 0 0 1 ${at(line)} Tm <${encodeText(line.text, family)}> Tj`);
      }
      ops.push('ET', 'Q');
      break;
    }
    case 'added-image':
    case 'signature': {
      const rect = drawing.bounds;
      drawing.images.set('Im0', annotation.assetId);
      ops.push('q');
      state(annotation.opacity);
      ops.push(
        `${num(rect.width)} 0 0 ${num(rect.height)} ${num(rect.x)} ${num(rect.y)} cm`,
        '/Im0 Do',
        'Q',
      );
      break;
    }
  }
  return drawing;
}
