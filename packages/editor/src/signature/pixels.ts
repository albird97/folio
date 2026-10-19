/*
 * Pixel work for signatures: finding where the ink is, and making the paper
 * of a photographed or scanned signature transparent. It works on RGBA
 * pixels laid out like canvas ImageData, so it runs (and is tested) without
 * a canvas.
 */

/** RGBA pixels, 8 bits per channel, row by row from the top (as in ImageData). */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

/** A rectangle of whole pixels. */
interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Longest side of a finished signature, in pixels. Signatures are placed
 * about 150 pt wide, so this prints sharply at several hundred dots per inch.
 */
export const MAX_SIGNATURE_SIDE = 1200;

/** Pixels at most this opaque (0–255) are not ink: cropping ignores faint specks. */
const FAINT_ALPHA = 16;

/**
 * The smallest box around every pixel more opaque than `threshold`, grown by
 * `margin` pixels on each side as far as the image allows (so the soft edges
 * of strokes are kept). Null when there is no such pixel.
 */
export function contentBounds(
  image: Pixels,
  { threshold = FAINT_ALPHA, margin = 0 }: { threshold?: number; margin?: number } = {},
): PixelBox | null {
  const { width, height, data } = image;
  let left = width;
  let right = -1;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3]! > threshold) {
        if (first === -1) first = x;
        last = x;
      }
    }
    if (first === -1) continue;
    if (top === -1) top = y;
    bottom = y;
    left = Math.min(left, first);
    right = Math.max(right, last);
  }
  if (top === -1) return null;
  const x = Math.max(0, left - margin);
  const y = Math.max(0, top - margin);
  return {
    x,
    y,
    width: Math.min(width, right + 1 + margin) - x,
    height: Math.min(height, bottom + 1 + margin) - y,
  };
}

/** Lighting is rarely even: paper up to this many levels darker than usual still goes. */
const PAPER_TOLERANCE = 32;
/**
 * Levels over which ink fades in, from transparent to opaque: the soft edges
 * of strokes and faint (pencil) lines stay partly visible.
 */
const INK_RAMP = 64;
/** A picture darker than this overall is not ink on paper; paper is never taken to be darker. */
const DARKEST_PAPER = 128;

/** Perceived lightness, 0–255 (Rec. 601 weights). */
const lightness = (r: number, g: number, b: number) => (r * 299 + g * 587 + b * 114) / 1000;

/**
 * How light the paper is: the median lightness of the picture's opaque
 * pixels. Ink covers far less than half of a picture of a signature, so the
 * median is paper, whatever its shade.
 */
export function paperLightness(image: Pixels): number {
  const histogram = new Uint32Array(256);
  let count = 0;
  const { data } = image;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! < 128) continue;
    const level = Math.round(lightness(data[index]!, data[index + 1]!, data[index + 2]!));
    histogram[level] = histogram[level]! + 1;
    count += 1;
  }
  let seen = 0;
  for (let level = 0; level < 256 && count > 0; level += 1) {
    seen += histogram[level]!;
    if (seen * 2 >= count) return Math.max(DARKEST_PAPER, level);
  }
  return 255;
}

/**
 * A copy of `image` with its paper made transparent: pixels about as light
 * as the paper (or lighter) disappear and dark ones stay. Those in between,
 * the soft edges of strokes, become partly transparent with the paper taken
 * out of their colour, so no light fringe is left around the ink.
 */
export function removeBackground(image: Pixels): Pixels {
  const paper = paperLightness(image);
  const clear = paper - PAPER_TOLERANCE;
  const solid = clear - INK_RAMP;
  const data = new Uint8ClampedArray(image.data);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]!;
    if (alpha === 0) continue;
    const level = lightness(data[index]!, data[index + 1]!, data[index + 2]!);
    if (level >= clear) {
      data[index + 3] = 0;
      continue;
    }
    if (level <= solid) continue;
    // The pixel shows this much ink over the paper (0–1).
    const ink = (clear - level) / INK_RAMP;
    // Its colour was ink × colour + (1 − ink) × paper; keep the ink's part.
    // (Uint8ClampedArray rounds and clamps what is written.)
    for (let channel = 0; channel < 3; channel += 1) {
      data[index + channel] = (data[index + channel]! - (1 - ink) * paper) / ink;
    }
    data[index + 3] = alpha * ink;
  }
  return { width: image.width, height: image.height, data };
}
