import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from '@cantoo/pdf-lib';
import { browserImageCodec, type ImageCodec, type RgbaImage } from './image-codec';
import { collectGarbage } from './objects';

/** Images re-encoded as JPEG at `quality` (0–1), at most `maxSize` pixels on their long side. */
export interface ImageRecompression {
  maxSize: number;
  quality: number;
}

export interface CompressionOptions {
  /** Null keeps every image as it is (lossless compression only). */
  images: ImageRecompression | null;
  /** Default: the browser's, through a canvas. */
  codec?: ImageCodec;
  /** Called after each image that could be re-encoded, with how many there are. */
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

export type CompressionPreset = 'high-quality' | 'balanced' | 'small';

/**
 * High quality changes nothing that shows; Balanced and Small re-encode
 * large images, Small more strongly.
 */
export const COMPRESSION_PRESETS: Readonly<Record<CompressionPreset, ImageRecompression | null>> = {
  'high-quality': null,
  balanced: { maxSize: 2000, quality: 0.8 },
  small: { maxSize: 1400, quality: 0.65 },
};

/** Images smaller than this (as stored) are left alone: little to gain, and logos stay crisp. */
const MIN_IMAGE_BYTES = 8 * 1024;
/** Unfiltered streams shorter than this would not get meaningfully smaller. */
const MIN_STREAM_BYTES = 64;

const name = (key: string) => PDFName.of(key);
const FLATE = name('FlateDecode');
const DCT = name('DCTDecode');

/** An image Folio can re-encode, and how to read its pixels. */
interface ImageInfo {
  width: number;
  height: number;
  /** 1 (gray) or 3 (RGB). */
  components: 1 | 3;
  filter: 'dct' | 'flate';
  /** Flate images: the PNG (10–15) or TIFF (2) predictor their rows use, or 1 for none. */
  predictor: number;
  /** The image's soft mask (transparency), when it has one. */
  softMask: PDFRef | null;
}

/**
 * Makes a document smaller before it is saved (after unused objects were
 * dropped, before encryption): drops page thumbnails and private
 * application data (`/Thumb`, `/PieceInfo`), Flate-compresses streams that
 * have no filter and, unless `images` is null, re-encodes large photos as
 * JPEG, downscaled to the preset's size. Every change is kept only where it
 * makes the file smaller.
 */
export async function compressDocument(
  doc: PDFDocument,
  options: CompressionOptions,
): Promise<void> {
  const { context } = doc;
  dropUnneededData(doc);
  // Thumbnails and application data dropped above take their objects with them.
  collectGarbage(context);
  if (options.images) await recompressImages(context, options.images, options);
  compressUnfilteredStreams(context);
}

function dropUnneededData(doc: PDFDocument): void {
  for (const page of doc.getPages()) {
    page.node.delete(name('Thumb'));
    page.node.delete(name('PieceInfo'));
  }
  doc.catalog.delete(name('PieceInfo'));
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(name('Subtype')) === name('Form')) {
      object.dict.delete(name('PieceInfo'));
    }
  }
}

/** Flate-compresses streams without a filter (except XMP metadata, which stays readable). */
function compressUnfilteredStreams(context: PDFContext): void {
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.has(name('Filter'))) continue;
    if (object.dict.get(name('Type')) === name('Metadata')) continue;
    if (object.contents.length < MIN_STREAM_BYTES) continue;
    const compressed = context.flateStream(object.contents);
    if (compressed.contents.length >= object.contents.length) continue;
    copyEntries(object.dict, compressed.dict, ['Filter', 'DecodeParms', 'Length', 'DL']);
    context.assign(ref, compressed);
  }
}

/** Copies `from`'s entries into `to`, except the keys given. */
function copyEntries(from: PDFDict, to: PDFDict, except: readonly string[]): void {
  const skipped = new Set(except.map(name));
  for (const [key, value] of from.entries()) if (!skipped.has(key)) to.set(key, value);
}

const numberOf = (value: PDFObject | undefined) =>
  value instanceof PDFNumber ? value.asNumber() : null;

/** The one filter of a stream, or null when it has none or several. */
function singleFilter(dict: PDFDict): PDFName | null {
  const filter = dict.lookup(name('Filter'));
  if (filter instanceof PDFName) return filter;
  if (filter instanceof PDFArray && filter.size() === 1) {
    const only = filter.lookup(0);
    return only instanceof PDFName ? only : null;
  }
  return null;
}

/** The parameters of a stream's one filter. */
function singleParams(dict: PDFDict): PDFDict | null {
  const params = dict.lookup(name('DecodeParms'));
  if (params instanceof PDFDict) return params;
  if (params instanceof PDFArray && params.size() === 1) {
    const only = params.lookup(0);
    return only instanceof PDFDict ? only : null;
  }
  return null;
}

/** Gray and RGB color spaces: device ones, and ICC-based ones with 1 or 3 components. */
function colorComponents(context: PDFContext, value: PDFObject | undefined): 1 | 3 | null {
  const space = value instanceof PDFRef ? context.lookup(value) : value;
  if (space === name('DeviceGray')) return 1;
  if (space === name('DeviceRGB')) return 3;
  if (space instanceof PDFArray && space.size() === 2 && space.lookup(0) === name('ICCBased')) {
    const profile = space.lookup(1);
    const count = profile instanceof PDFRawStream ? numberOf(profile.dict.lookup(name('N'))) : null;
    return count === 1 || count === 3 ? count : null;
  }
  return null;
}

/**
 * What Folio can re-encode: 8-bit gray or RGB images stored as JPEG
 * (DCTDecode) or Flate (with or without a predictor), with or without a soft
 * mask. Not CMYK, indexed or 16-bit images, JBIG2 or JPEG 2000, image masks,
 * color-key masks or images with a custom decode range. Inline images are
 * part of content streams and never seen here.
 */
function imageInfo(context: PDFContext, stream: PDFRawStream): ImageInfo | null {
  const { dict } = stream;
  if (dict.get(name('Subtype')) !== name('Image')) return null;
  if (dict.lookup(name('ImageMask')) === PDFBool.True) return null;
  if (dict.has(name('Decode')) || dict.has(name('SMaskInData'))) return null;
  if (dict.lookup(name('Mask')) instanceof PDFArray) return null;
  const width = numberOf(dict.lookup(name('Width')));
  const height = numberOf(dict.lookup(name('Height')));
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (numberOf(dict.lookup(name('BitsPerComponent'))) !== 8) return null;
  const components = colorComponents(context, dict.get(name('ColorSpace')));
  if (!components) return null;
  const softMask = dict.get(name('SMask'));
  if (softMask !== undefined && !(softMask instanceof PDFRef)) return null;
  const filter = singleFilter(dict);
  const params = singleParams(dict);
  let predictor = 1;
  if (filter === DCT) {
    // A color transform of its own may differ from what decoders assume.
    if (dict.has(name('DecodeParms'))) return null;
  } else if (filter === FLATE) {
    if (params) {
      predictor = numberOf(params.lookup(name('Predictor'))) ?? 1;
      const colors = numberOf(params.lookup(name('Colors'))) ?? 1;
      const bits = numberOf(params.lookup(name('BitsPerComponent'))) ?? 8;
      const columns = numberOf(params.lookup(name('Columns'))) ?? 1;
      const known = predictor === 1 || predictor === 2 || (predictor >= 10 && predictor <= 15);
      if (predictor !== 1 && (!known || colors !== components || bits !== 8 || columns !== width)) {
        return null;
      }
    }
  } else {
    return null;
  }
  return {
    width,
    height,
    components,
    filter: filter === DCT ? 'dct' : 'flate',
    predictor,
    softMask: softMask ?? null,
  };
}

/** Undoes a PNG (10–15) or TIFF (2) predictor on 8-bit rows of `bpp` bytes per pixel. */
function unpredict(
  data: Uint8Array,
  predictor: number,
  bpp: number,
  rowBytes: number,
  rows: number,
): Uint8Array | null {
  if (predictor === 1) return data;
  if (predictor === 2) {
    if (data.length < rowBytes * rows) return null;
    const out = data.slice(0, rowBytes * rows);
    for (let y = 0; y < rows; y += 1) {
      const row = y * rowBytes;
      for (let x = bpp; x < rowBytes; x += 1)
        out[row + x] = (out[row + x]! + out[row + x - bpp]!) & 0xff;
    }
    return out;
  }
  // PNG: each row starts with its own filter type.
  if (data.length < (rowBytes + 1) * rows) return null;
  const out = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y += 1) {
    const type = data[y * (rowBytes + 1)]!;
    const input = y * (rowBytes + 1) + 1;
    const row = y * rowBytes;
    const above = row - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = data[input + x]!;
      const left = x >= bpp ? out[row + x - bpp]! : 0;
      const up = y > 0 ? out[above + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? out[above + x - bpp]! : 0;
      let value: number;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const toLeft = Math.abs(estimate - left);
          const toUp = Math.abs(estimate - up);
          const toUpLeft = Math.abs(estimate - upLeft);
          value =
            raw + (toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft);
          break;
        }
        default:
          return null;
      }
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

/** The samples of a Flate image, `components` bytes per pixel, row by row. */
function flateSamples(
  stream: PDFRawStream,
  width: number,
  height: number,
  components: number,
  predictor: number,
): Uint8Array | null {
  const data = unpredict(
    decodePDFRawStream(stream).decode(),
    predictor,
    components,
    width * components,
    height,
  );
  return data && data.length >= width * height * components ? data : null;
}

function toRgba(samples: Uint8Array, width: number, height: number, components: 1 | 3): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const from = pixel * components;
    const to = pixel * 4;
    data[to] = samples[from]!;
    data[to + 1] = samples[from + (components === 3 ? 1 : 0)]!;
    data[to + 2] = samples[from + (components === 3 ? 2 : 0)]!;
    data[to + 3] = 255;
  }
  return { width, height, data };
}

/** The pixels of an image `imageInfo` accepted, or null when they cannot be read. */
async function readPixels(
  stream: PDFRawStream,
  info: ImageInfo,
  codec: ImageCodec,
): Promise<RgbaImage | null> {
  if (info.filter === 'dct') {
    const image = await codec.decodeJpeg(stream.contents);
    return image.width === info.width && image.height === info.height ? image : null;
  }
  const samples = flateSamples(stream, info.width, info.height, info.components, info.predictor);
  return samples ? toRgba(samples, info.width, info.height, info.components) : null;
}

/**
 * Averages the source pixels each target pixel covers (a box filter), for
 * images with `channels` bytes per pixel.
 */
function downscale(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const out = new Uint8Array(targetWidth * targetHeight * channels);
  const sums = new Float64Array(channels);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor((ty * height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor((tx * width) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / targetWidth));
      sums.fill(0);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * width + x) * channels;
          for (let c = 0; c < channels; c += 1) sums[c]! += source[at + c]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (ty * targetWidth + tx) * channels;
      for (let c = 0; c < channels; c += 1) out[to + c] = Math.round(sums[c]! / count);
    }
  }
  return out;
}

/** The gray samples of a soft mask that can be downscaled with its image, or null. */
async function readMask(
  context: PDFContext,
  ref: PDFRef,
  codec: ImageCodec,
): Promise<{ stream: PDFRawStream; samples: Uint8Array; width: number; height: number } | null> {
  const stream = context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return null;
  const { dict } = stream;
  // A matte color is premultiplied into the image's pixels.
  if (dict.has(name('Matte')) || dict.has(name('Decode'))) return null;
  if (colorComponents(context, dict.get(name('ColorSpace'))) !== 1) return null;
  const info = imageInfo(context, stream);
  if (!info || info.softMask) return null;
  const pixels = await readPixels(stream, info, codec);
  if (!pixels) return null;
  const samples = new Uint8Array(info.width * info.height);
  for (let pixel = 0; pixel < samples.length; pixel += 1) samples[pixel] = pixels.data[pixel * 4]!;
  return { stream, samples, width: info.width, height: info.height };
}

/** Image streams by reference, and how often each is used as another image's mask. */
function findImages(context: PDFContext) {
  const images: Array<{ ref: PDFRef; stream: PDFRawStream }> = [];
  const maskUses = new Map<string, number>();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(name('Subtype')) !== name('Image')) continue;
    images.push({ ref, stream: object });
    for (const key of ['SMask', 'Mask']) {
      const mask = object.dict.get(name(key));
      if (mask instanceof PDFRef) maskUses.set(mask.tag, (maskUses.get(mask.tag) ?? 0) + 1);
    }
  }
  return { images, maskUses };
}

async function recompressImages(
  context: PDFContext,
  settings: ImageRecompression,
  options: CompressionOptions,
): Promise<void> {
  const codec = options.codec ?? browserImageCodec;
  const { images, maskUses } = findImages(context);
  const candidates = images.flatMap(({ ref, stream }) => {
    // Masks change with their image; a mask shared by several images is left alone.
    if (maskUses.has(ref.tag) || stream.contents.length < MIN_IMAGE_BYTES) return [];
    const info = imageInfo(context, stream);
    if (!info || (info.softMask && maskUses.get(info.softMask.tag) !== 1)) return [];
    return [{ ref, stream, info }];
  });
  for (const [done, { ref, stream, info }] of candidates.entries()) {
    options.signal?.throwIfAborted();
    try {
      await recompressImage(context, ref, stream, info, settings, codec);
    } catch {
      // An image that cannot be read or encoded keeps its original data.
    }
    options.onProgress?.(done + 1, candidates.length);
  }
}

async function recompressImage(
  context: PDFContext,
  ref: PDFRef,
  stream: PDFRawStream,
  info: ImageInfo,
  { maxSize, quality }: ImageRecompression,
  codec: ImageCodec,
): Promise<void> {
  const scale = Math.min(1, maxSize / Math.max(info.width, info.height));
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const resized = width !== info.width || height !== info.height;
  // A mask must keep its image's size when the image shrinks.
  const mask = resized && info.softMask ? await readMask(context, info.softMask, codec) : null;
  if (resized && info.softMask && !mask) return;

  const pixels = await readPixels(stream, info, codec);
  if (!pixels) return;
  const image: RgbaImage = resized
    ? { width, height, data: downscale(pixels.data, info.width, info.height, 4, width, height) }
    : pixels;
  const jpeg = await codec.encodeJpeg(image, quality);
  const newMask = mask
    ? context.flateStream(downscale(mask.samples, mask.width, mask.height, 1, width, height))
    : null;
  const before = stream.contents.length + (mask ? mask.stream.contents.length : 0);
  const after = jpeg.length + (newMask ? newMask.contents.length : 0);
  if (after >= before) return;

  const replacement = context.stream(jpeg);
  copyEntries(stream.dict, replacement.dict, [
    'Filter',
    'DecodeParms',
    'Length',
    'DL',
    'Width',
    'Height',
    'BitsPerComponent',
    'ColorSpace',
  ]);
  replacement.dict.set(name('Width'), PDFNumber.of(width));
  replacement.dict.set(name('Height'), PDFNumber.of(height));
  replacement.dict.set(name('BitsPerComponent'), PDFNumber.of(8));
  // JPEG encoders write three components; gray images become RGB ones.
  replacement.dict.set(
    name('ColorSpace'),
    info.components === 3 ? stream.dict.get(name('ColorSpace'))! : name('DeviceRGB'),
  );
  replacement.dict.set(name('Filter'), DCT);
  if (mask && newMask && info.softMask) {
    copyEntries(mask.stream.dict, newMask.dict, [
      'Filter',
      'DecodeParms',
      'Length',
      'DL',
      'Width',
      'Height',
      'BitsPerComponent',
    ]);
    newMask.dict.set(name('Width'), PDFNumber.of(width));
    newMask.dict.set(name('Height'), PDFNumber.of(height));
    newMask.dict.set(name('BitsPerComponent'), PDFNumber.of(8));
    context.assign(info.softMask, newMask);
  }
  context.assign(ref, replacement);
}
