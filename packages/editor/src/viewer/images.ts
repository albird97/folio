import type { AssetRef } from '@folio/document-model';

/** Images larger than this (on the long side) are scaled down when added. */
const MAX_IMAGE_SIDE = 4096;

/**
 * Opens the system's file chooser for one image. Must be called while
 * handling a user gesture. Resolves null when nothing was chosen.
 */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
    input.style.display = 'none';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

export interface PreparedImage {
  bytes: Uint8Array;
  mimeType: AssetRef['mimeType'];
  /** Pixel size after orientation and scaling. */
  width: number;
  height: number;
}

/**
 * Decodes an image the way the browser shows it (EXIF orientation applied)
 * onto a canvas, scaled down to at most `maxSide` pixels on its long side.
 */
export async function decodeImage(file: Blob, maxSide: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No canvas.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/**
 * Decodes an image the way the browser shows it and re-encodes it as PNG or
 * JPEG for the PDF. Re-encoding also drops metadata such as the location a
 * photo was taken at.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const canvas = await decodeImage(file, MAX_IMAGE_SIDE);
  const { width, height } = canvas;
  // Photos stay JPEG; anything that may be transparent becomes PNG.
  const mimeType: AssetRef['mimeType'] = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mimeType, mimeType === 'image/jpeg' ? 0.92 : undefined),
  );
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('The image could not be encoded.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType, width, height };
}
