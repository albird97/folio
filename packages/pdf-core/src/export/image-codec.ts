/** Pixels row by row, four bytes (red, green, blue, alpha) each. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * Decodes and encodes JPEG images for compression. Injected, so compression
 * runs in browsers (canvas), in a worker (OffscreenCanvas) and in Node tests
 * (a pure-JavaScript codec).
 */
export interface ImageCodec {
  /** The pixels of JPEG data, as they are stored (no color profile or EXIF rotation applied). */
  decodeJpeg(bytes: Uint8Array): Promise<RgbaImage>;
  /** Opaque pixels as a JPEG with three color components; quality from 0 to 1. */
  encodeJpeg(image: RgbaImage, quality: number): Promise<Uint8Array>;
}

type Canvas2D =
  | { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }
  | { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };

/** An OffscreenCanvas where there is one (also in workers), else a page's canvas. */
function canvas2d(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context) return { canvas, context };
  }
  // Workers without OffscreenCanvas have no canvas at all: images stay as they are.
  if (typeof document === 'undefined') throw new Error('No canvas is available to draw images.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas is available to draw images.');
  return { canvas, context };
}

function jpegBlob({ canvas }: Canvas2D, quality: number): Promise<Blob> {
  // Workers have no HTMLCanvasElement to test against.
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      'image/jpeg',
      quality,
    ),
  );
}

/** Frees a canvas' pixels at once instead of when it is collected. */
function release({ canvas }: Canvas2D): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** The browser's own JPEG decoder and encoder, through a canvas. */
export const browserImageCodec: ImageCodec = {
  async decodeJpeg(bytes) {
    const bitmap = await createImageBitmap(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
      // PDF readers ignore a JPEG's color profile and EXIF orientation.
      { colorSpaceConversion: 'none', imageOrientation: 'none', premultiplyAlpha: 'none' },
    );
    const target = canvas2d(bitmap.width, bitmap.height);
    try {
      target.context.drawImage(bitmap, 0, 0);
      const { data } = target.context.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: bitmap.width, height: bitmap.height, data };
    } finally {
      bitmap.close();
      release(target);
    }
  },
  async encodeJpeg(image, quality) {
    const target = canvas2d(image.width, image.height);
    try {
      const pixels = new Uint8ClampedArray(
        image.data.buffer as ArrayBuffer,
        image.data.byteOffset,
        image.data.byteLength,
      );
      target.context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
      return new Uint8Array(await (await jpegBlob(target, quality)).arrayBuffer());
    } finally {
      release(target);
    }
  },
};
