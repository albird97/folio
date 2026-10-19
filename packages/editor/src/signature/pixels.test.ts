import { describe, expect, it } from 'vitest';
import { contentBounds, paperLightness, removeBackground, type Pixels } from './pixels';

type Rgba = [number, number, number, number];

/** A `width` × `height` image of one colour, with some pixels painted over. */
function image(
  width: number,
  height: number,
  fill: Rgba,
  painted: Array<[x: number, y: number, color: Rgba]> = [],
): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set(fill, index * 4);
  for (const [x, y, color] of painted) data.set(color, (y * width + x) * 4);
  return { width, height, data };
}

const pixel = (pixels: Pixels, x: number, y: number) =>
  Array.from(pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4));

const CLEAR: Rgba = [0, 0, 0, 0];
const INK: Rgba = [20, 30, 90, 255];
const WHITE: Rgba = [255, 255, 255, 255];

describe('contentBounds', () => {
  it('finds the box around everything opaque', () => {
    const drawn = image(20, 10, CLEAR, [
      [3, 2, INK],
      [15, 2, INK],
      [8, 7, INK],
    ]);
    expect(contentBounds(drawn)).toEqual({ x: 3, y: 2, width: 13, height: 6 });
  });

  it('is null for an empty image', () => {
    expect(contentBounds(image(8, 8, CLEAR))).toBeNull();
    expect(contentBounds(image(0, 0, CLEAR))).toBeNull();
  });

  it('ignores faint specks', () => {
    const drawn = image(10, 10, CLEAR, [
      [1, 1, [0, 0, 0, 10]],
      [5, 5, INK],
    ]);
    expect(contentBounds(drawn)).toEqual({ x: 5, y: 5, width: 1, height: 1 });
    expect(contentBounds(drawn, { threshold: 0 })).toEqual({ x: 1, y: 1, width: 5, height: 5 });
  });

  it('keeps a margin around the ink, within the image', () => {
    const drawn = image(10, 10, CLEAR, [
      [1, 4, INK],
      [6, 5, INK],
    ]);
    expect(contentBounds(drawn, { margin: 2 })).toEqual({ x: 0, y: 2, width: 9, height: 6 });
    const full = image(4, 4, INK);
    expect(contentBounds(full, { margin: 3 })).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  });
});

describe('removeBackground', () => {
  it('makes white paper transparent and keeps dark ink as it is', () => {
    const scan = image(10, 10, WHITE, [
      [2, 2, INK],
      [3, 2, [0, 0, 0, 255]],
    ]);
    const result = removeBackground(scan);
    expect(pixel(result, 0, 0)[3]).toBe(0);
    expect(pixel(result, 9, 9)[3]).toBe(0);
    expect(pixel(result, 2, 2)).toEqual(INK);
    expect(pixel(result, 3, 2)).toEqual([0, 0, 0, 255]);
    // The picture it came from is left alone.
    expect(pixel(scan, 0, 0)).toEqual(WHITE);
  });

  it('finds the paper’s own shade: grey, tinted or unevenly lit paper goes too', () => {
    const photo = image(
      10,
      10,
      [200, 198, 190, 255],
      [
        // Shadow on the paper, a little darker.
        [0, 0, [178, 176, 170, 255]],
        [5, 5, INK],
      ],
    );
    expect(paperLightness(photo)).toBe(198);
    const result = removeBackground(photo);
    expect(pixel(result, 9, 9)[3]).toBe(0);
    expect(pixel(result, 0, 0)[3]).toBe(0);
    expect(pixel(result, 5, 5)).toEqual(INK);
  });

  it('keeps the soft edges of strokes, darker and partly transparent', () => {
    const edge: Rgba = [180, 180, 200, 255];
    const result = removeBackground(image(10, 10, WHITE, [[4, 4, edge]]));
    const [r, g, b, a] = pixel(result, 4, 4) as Rgba;
    expect(a).toBeGreaterThan(64);
    expect(a).toBeLessThan(255);
    // The paper's white is taken out of the colour: no light fringe.
    expect(r).toBeLessThan(edge[0]);
    expect(g).toBeLessThan(edge[1]);
    expect(b).toBeLessThan(edge[2]);
  });

  it('keeps the transparency pixels already had', () => {
    const result = removeBackground(
      image(10, 10, WHITE, [
        [0, 0, [0, 0, 0, 0]],
        [1, 0, [20, 30, 90, 128]],
      ]),
    );
    expect(pixel(result, 0, 0)[3]).toBe(0);
    expect(pixel(result, 1, 0)).toEqual([20, 30, 90, 128]);
  });

  it('does not wipe out a dark picture', () => {
    const dark = image(10, 10, [60, 60, 60, 255], [[3, 3, [10, 10, 10, 255]]]);
    expect(paperLightness(dark)).toBe(128);
    const result = removeBackground(dark);
    expect(pixel(result, 0, 0)[3]).toBeGreaterThan(0);
    expect(pixel(result, 3, 3)[3]).toBe(255);
  });

  it('takes an empty picture to be white paper', () => {
    expect(paperLightness(image(4, 4, CLEAR))).toBe(255);
  });
});
