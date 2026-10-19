import { decodeImage } from '../viewer/images';
import { loadSignatureFont, SIGNATURE_FONT_STACK, SIGNATURE_FONT_WEIGHT } from './font';
import { contentBounds, MAX_SIGNATURE_SIDE, removeBackground } from './pixels';

/*
 * Making a signature: strokes drawn on the pad, a name typed in the
 * handwriting font or a picture are drawn on a canvas with a transparent
 * background, cropped to the ink and encoded as PNG.
 */

/** A finished signature: a PNG with a transparent background, cropped to the ink. */
export interface SignatureImage {
  bytes: Uint8Array;
  /** Pixel size. */
  width: number;
  height: number;
}

/** Ink colours offered for drawn and typed signatures. */
export const INK_COLORS = { black: '#000000', blue: '#1e3a8a' } as const;
export type Ink = keyof typeof INK_COLORS;

/** A sample of a stroke: where the pen was, in pad units, and how wide it drew there. */
export interface StrokePoint {
  x: number;
  y: number;
  width: number;
}
export type Stroke = readonly StrokePoint[];

/** The pad's own units: strokes are kept in these, whatever size the pad is shown at. */
export const PAD_SIZE = { width: 600, height: 200 } as const;

/** Room kept around the ink when cropping, in pixels: the soft edges of strokes. */
const CROP_MARGIN = 4;
/** Font size names are drawn at before they are cropped and scaled, in pixels. */
const TYPED_FONT_SIZE = 160;
/**
 * Pictures are read at up to this size (long side) before they are cropped:
 * a signature taking a third of a photo still keeps enough detail, and the
 * pixels worked on stay within 16 MB.
 */
const PICTURE_SIDE = 2000;

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas.');
  return context;
}

/** Gives a canvas's memory back at once (WebKit limits the memory all canvases may use). */
function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

/** The CSS font typed signatures are drawn in, at `size` pixels. */
const typedFont = (size: number) => `${SIGNATURE_FONT_WEIGHT} ${size}px ${SIGNATURE_FONT_STACK}`;

const midpoint = (a: StrokePoint, b: StrokePoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Draws strokes as smooth curves: each piece runs from one midpoint between
 * samples to the next and bends at the sample in between, so quick strokes
 * show no corners. Each piece has the width of its sample, and round ends
 * join them. `scale` maps pad units to canvas pixels.
 */
export function drawStrokes(
  context: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  color: string,
  scale: number,
): void {
  context.save();
  context.scale(scale, scale);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    const [first] = stroke;
    if (!first) continue;
    if (stroke.length === 1) {
      // A tap draws a dot.
      context.beginPath();
      context.arc(first.x, first.y, first.width / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    let from: { x: number; y: number } = first;
    for (let index = 1; index < stroke.length; index += 1) {
      const point = stroke[index]!;
      const next = stroke[index + 1];
      const to = next ? midpoint(point, next) : point;
      context.beginPath();
      context.lineWidth = point.width;
      context.moveTo(from.x, from.y);
      context.quadraticCurveTo(point.x, point.y, to.x, to.y);
      context.stroke();
      from = to;
    }
  }
  context.restore();
}

/**
 * Crops a drawing on a transparent canvas to its ink (with a little room),
 * scales it down to at most MAX_SIGNATURE_SIDE pixels and encodes it as PNG.
 * Null when the canvas has no ink.
 */
async function finishSignature(canvas: HTMLCanvasElement): Promise<SignatureImage | null> {
  const bounds = contentBounds(context2d(canvas).getImageData(0, 0, canvas.width, canvas.height), {
    margin: CROP_MARGIN,
  });
  if (!bounds) return null;
  const scale = Math.min(1, MAX_SIGNATURE_SIDE / Math.max(bounds.width, bounds.height));
  const out = newCanvas(bounds.width * scale, bounds.height * scale);
  try {
    const context = context2d(out);
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      canvas,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      out.width,
      out.height,
    );
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The signature could not be encoded.');
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: out.width,
      height: out.height,
    };
  } finally {
    release(out);
  }
}

/** The signature drawn on the pad, at full resolution. */
export async function signatureFromStrokes(
  strokes: readonly Stroke[],
  ink: Ink,
): Promise<SignatureImage | null> {
  const scale = MAX_SIGNATURE_SIDE / PAD_SIZE.width;
  const canvas = newCanvas(PAD_SIZE.width * scale, PAD_SIZE.height * scale);
  try {
    drawStrokes(context2d(canvas), strokes, INK_COLORS[ink], scale);
    return await finishSignature(canvas);
  } finally {
    release(canvas);
  }
}

/** A typed name in the handwriting font. */
export async function signatureFromText(text: string, ink: Ink): Promise<SignatureImage | null> {
  const name = text.trim();
  if (!name) return null;
  await loadSignatureFont(name);
  const font = typedFont(TYPED_FONT_SIZE);
  const probe = newCanvas(1, 1);
  const measure = context2d(probe);
  measure.font = font;
  const width = measure.measureText(name).width;
  release(probe);
  // Script capitals and flourishes reach well past the letters' advance and
  // the line: room on every side, cropped afterwards.
  const canvas = newCanvas(width + TYPED_FONT_SIZE * 2, TYPED_FONT_SIZE * 2.5);
  try {
    const context = context2d(canvas);
    context.font = font;
    context.fillStyle = INK_COLORS[ink];
    context.fillText(name, TYPED_FONT_SIZE, TYPED_FONT_SIZE * 1.6);
    return await finishSignature(canvas);
  } finally {
    release(canvas);
  }
}

/**
 * Draws a typed name as large as fits a preview canvas, centred, with its
 * baseline where the pad has its signing line.
 */
export function drawTypedPreview(canvas: HTMLCanvasElement, text: string, ink: Ink): void {
  const context = context2d(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  const name = text.trim();
  if (!name) return;
  context.font = typedFont(100);
  const fit = ((canvas.width * 0.86) / Math.max(1, context.measureText(name).width)) * 100;
  context.font = typedFont(Math.min(canvas.height * 0.45, fit));
  context.fillStyle = INK_COLORS[ink];
  context.textAlign = 'center';
  context.fillText(name, canvas.width / 2, canvas.height * 0.68);
}

/** The pixels of a picture (turned as it is shown), at most PICTURE_SIDE on its long side. */
export async function readPicture(file: Blob): Promise<ImageData> {
  const canvas = await decodeImage(file, PICTURE_SIDE);
  try {
    return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    release(canvas);
  }
}

/** A picture of a signature, its paper made transparent when asked, cropped to what is left. */
export async function signatureFromPicture(
  picture: ImageData,
  removePaper: boolean,
): Promise<SignatureImage | null> {
  const pixels = removePaper ? removeBackground(picture) : picture;
  const canvas = newCanvas(pixels.width, pixels.height);
  try {
    const context = context2d(canvas);
    const image = context.createImageData(pixels.width, pixels.height);
    image.data.set(pixels.data);
    context.putImageData(image, 0, 0);
    return await finishSignature(canvas);
  } finally {
    release(canvas);
  }
}

/**
 * A remembered signature, decoded and drawn again: what goes into a document
 * is always a PNG Folio encoded itself. Rejects when it cannot be decoded.
 */
export async function signatureFromPng(png: Uint8Array): Promise<SignatureImage | null> {
  const canvas = await decodeImage(
    new Blob([png as BlobPart], { type: 'image/png' }),
    MAX_SIGNATURE_SIDE,
  );
  try {
    return await finishSignature(canvas);
  } finally {
    release(canvas);
  }
}
