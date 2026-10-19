import { createDocumentModel, type SourceId } from '@folio/document-model';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  type PDFRef,
  type PDFContext,
} from '@cantoo/pdf-lib';
import * as jpeg from 'jpeg-js';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createNodeCanvas,
  FIXTURE_PASSWORD,
  nodeWorkerSrc,
  qpdfCheck,
  readFixture,
} from '../../../../tests/setup/fixtures';
import { toSourceDescriptor } from '../descriptor';
import { createPdfEngine } from '../engine';
import { sha256Hex } from '../hash';
import { COMPRESSION_PRESETS, type CompressionOptions } from './compress';
import { exportPdf, originalSourceId, type ExportSource } from './export';
import type { ImageCodec } from './image-codec';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

/** jpeg-js: a JPEG codec in plain JavaScript, as the browser's canvas is not available here. */
const codec: ImageCodec = {
  decodeJpeg: async (bytes) => {
    const { width, height, data } = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { width, height, data };
  },
  encodeJpeg: async (image, quality) =>
    new Uint8Array(jpeg.encode({ ...image, data: image.data }, Math.round(quality * 100)).data),
};

const name = (key: string) => PDFName.of(key);

/** Photo-like samples: smooth gradients with grain, which Flate compresses poorly. */
function photo(width: number, height: number, components: 1 | 3): Uint8Array {
  let seed = 7;
  const grain = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed >> 16) % 17) - 8;
  };
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  const out = new Uint8Array(width * height * components);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * components;
      const r = 40 + (160 * x) / width;
      const g = 60 + (120 * y) / height;
      const b = 200 - (100 * (x + y)) / (width + height);
      if (components === 1) out[at] = clamp((r + g + b) / 3 + grain());
      else [r, g, b].forEach((value, c) => (out[at + c] = clamp(value + grain())));
    }
  }
  return out;
}

const toRgba = (samples: Uint8Array, components: 1 | 3) => {
  const pixels = samples.length / components;
  const data = new Uint8Array(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    for (let c = 0; c < 3; c += 1)
      data[pixel * 4 + c] = samples[pixel * components + (components === 3 ? c : 0)]!;
    data[pixel * 4 + 3] = 255;
  }
  return data;
};

/** Rows with PNG predictors, a different filter type on each row (0–4, then again). */
function pngPredicted(samples: Uint8Array, width: number, height: number, bpp: number) {
  const rowBytes = width * bpp;
  const out = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const type = y % 5;
    out[y * (rowBytes + 1)] = type;
    for (let x = 0; x < rowBytes; x += 1) {
      const at = y * rowBytes + x;
      const left = x >= bpp ? samples[at - bpp]! : 0;
      const up = y > 0 ? samples[at - rowBytes]! : 0;
      const upLeft = y > 0 && x >= bpp ? samples[at - rowBytes - bpp]! : 0;
      const estimate = left + up - upLeft;
      const paeth =
        Math.abs(estimate - left) <= Math.abs(estimate - up) &&
        Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
          ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
            ? up
            : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][type]!;
      out[y * (rowBytes + 1) + 1 + x] = (samples[at]! - predicted) & 0xff;
    }
  }
  return out;
}

interface ImageSpec {
  width: number;
  height: number;
  contents: Uint8Array;
  entries: Record<string, unknown>;
  /** Drawn at this size, from the lower-left corner of the page. */
  box?: [number, number];
}

/**
 * A one-page document that draws each image (Im0, Im1, …) side by side,
 * with an unfiltered content stream.
 */
async function documentWith(
  images: Array<(context: PDFContext) => PDFRef>,
  extra?: (doc: PDFDocument) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([600, 400]);
  // Small squares along the bottom edge, away from the images.
  let content = `0.9 g\n${Array.from({ length: 20 }, (_, i) => `${i * 30} 0 20 20 re f\n`).join('')}`;
  images.forEach((register, index) => {
    page.node.setXObject(name(`Im${index}`), register(doc.context));
    content += `q 200 0 0 200 ${index * 200} 100 cm /Im${index} Do Q\n`;
  });
  page.node.set(name('Contents'), doc.context.register(doc.context.stream(content)));
  extra?.(doc);
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

const image =
  ({ width, height, contents, entries }: ImageSpec) =>
  (context: PDFContext) =>
    context.register(
      context.stream(contents, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        BitsPerComponent: 8,
        ...entries,
      }),
    );

function flateRgb(width: number, height: number, predictor = false): ImageSpec {
  const samples = photo(width, height, 3);
  return {
    width,
    height,
    contents: deflateSync(predictor ? pngPredicted(samples, width, height, 3) : samples),
    entries: {
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      ...(predictor
        ? { DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: width } }
        : {}),
    },
  };
}

function dctGray(width: number, height: number, quality: number): ImageSpec {
  const samples = photo(width, height, 1);
  return {
    width,
    height,
    contents: jpeg.encode({ width, height, data: toRgba(samples, 1) }, quality).data,
    entries: { ColorSpace: 'DeviceGray', Filter: 'DCTDecode' },
  };
}

async function compress(bytes: Uint8Array, compression: CompressionOptions, password?: string) {
  const handle = await engine.open(bytes, password === undefined ? {} : { password });
  const model = createDocumentModel(
    toSourceDescriptor(handle.info, {
      fileName: 'photos.pdf',
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      origin: { kind: 'generated' },
    }),
  );
  await handle.destroy();
  const sources = new Map<SourceId, ExportSource>([
    [originalSourceId(model)!, password === undefined ? { bytes } : { bytes, password }],
  ]);
  return exportPdf({ model, sources, assets: new Map(), compression });
}

/** The image XObjects of the first page, by name, as written. */
async function pageImages(bytes: Uint8Array, password?: string) {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ...(password === undefined ? {} : { password }),
  });
  const resources = doc.getPage(0).node.Resources()!;
  const xobjects = resources.lookup(name('XObject'), PDFDict);
  const images = new Map<string, { dict: PDFDict; contents: Uint8Array; mask?: PDFRawStream }>();
  for (const [key, ref] of xobjects.entries()) {
    const stream = doc.context.lookup(ref) as PDFRawStream;
    const mask = stream.dict.lookup(name('SMask'));
    images.set(key.decodeText(), {
      dict: stream.dict,
      contents: stream.contents,
      ...(mask instanceof PDFRawStream ? { mask } : {}),
    });
  }
  return { doc, images };
}

const numberIn = (dict: PDFDict, key: string) => dict.lookup(name(key), PDFNumber).asNumber();

/** The color PDF.js draws at a point of the first page (in PDF units from the lower left). */
async function colorAt(bytes: Uint8Array, points: Array<[number, number]>) {
  const handle = await engine.open(bytes);
  const canvas = createNodeCanvas();
  await handle.renderPage(0, canvas, { scale: 1, styleCanvas: false }).promise;
  const context = canvas.getContext('2d')!;
  const colors = points.map(([x, y]) => [
    ...context.getImageData(x, 400 - y, 1, 1).data.slice(0, 3),
  ]);
  await handle.destroy();
  return colors;
}

/** Close enough to the original after JPEG compression and downscaling. */
const near = (actual: number[], expected: number[], tolerance = 24) =>
  actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);

async function expectValidPdf(bytes: Uint8Array, password?: string) {
  const result = await qpdfCheck(bytes, password);
  if (!result) {
    expect(process.env.CI, 'qpdf must be installed on CI').toBeFalsy();
    return;
  }
  expect(result.ok, result.output).toBe(true);
}

describe('compressDocument', () => {
  it('re-encodes large Flate photos as smaller JPEGs, undoing PNG predictors', async () => {
    const spec = flateRgb(900, 600, true);
    const original = await documentWith([image(spec)]);
    const before = await colorAt(original, [[100, 200]]);
    const progress: Array<[number, number]> = [];
    const { bytes } = await compress(original, {
      images: { maxSize: 450, quality: 0.8 },
      codec,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(bytes.length).toBeLessThan(original.length / 3);
    expect(progress).toEqual([[1, 1]]);
    const { images } = await pageImages(bytes);
    const written = images.get('Im0')!;
    expect(written.dict.get(name('Filter'))).toBe(name('DCTDecode'));
    expect(written.dict.has(name('DecodeParms'))).toBe(false);
    expect([numberIn(written.dict, 'Width'), numberIn(written.dict, 'Height')]).toEqual([450, 300]);
    expect(written.dict.get(name('ColorSpace'))).toBe(name('DeviceRGB'));
    // Still the same picture where it was.
    expect(near((await colorAt(bytes, [[100, 200]]))[0]!, before[0]!)).toBe(true);
    await expectValidPdf(bytes);
  });

  it('caps the long side of images at the preset’s size', async () => {
    const original = await documentWith([image(flateRgb(2400, 500))]);
    const { bytes } = await compress(original, { images: COMPRESSION_PRESETS.balanced, codec });
    const written = (await pageImages(bytes)).images.get('Im0')!;
    expect([numberIn(written.dict, 'Width'), numberIn(written.dict, 'Height')]).toEqual([
      2000, 417,
    ]);
    expect(COMPRESSION_PRESETS.small).toEqual({ maxSize: 1400, quality: 0.65 });
    expect(COMPRESSION_PRESETS['high-quality']).toBeNull();
  });

  it('re-encodes gray JPEGs as RGB ones, smaller and at the same place', async () => {
    const original = await documentWith([image(dctGray(1200, 800, 95))]);
    const { bytes } = await compress(original, { images: { maxSize: 600, quality: 0.65 }, codec });
    expect(bytes.length).toBeLessThan(original.length / 2);
    const written = (await pageImages(bytes)).images.get('Im0')!;
    expect(written.dict.get(name('ColorSpace'))).toBe(name('DeviceRGB'));
    expect(numberIn(written.dict, 'Width')).toBe(600);
    expect(
      near((await colorAt(bytes, [[100, 200]]))[0]!, (await colorAt(original, [[100, 200]]))[0]!),
    ).toBe(true);
    await expectValidPdf(bytes);
  });

  it('downscales soft masks with their image and keeps them lossless', async () => {
    const spec = flateRgb(800, 800);
    // Transparent on the left half, opaque on the right.
    const mask = new Uint8Array(800 * 800).map((_, index) => (index % 800 < 400 ? 0 : 255));
    const original = await documentWith([
      (context) => {
        const maskRef = context.register(
          context.flateStream(mask, {
            Type: 'XObject',
            Subtype: 'Image',
            Width: 800,
            Height: 800,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: 8,
          }),
        );
        return image({ ...spec, entries: { ...spec.entries, SMask: maskRef } })(context);
      },
    ]);
    const { bytes } = await compress(original, { images: { maxSize: 200, quality: 0.8 }, codec });
    const written = (await pageImages(bytes)).images.get('Im0')!;
    expect(numberIn(written.dict, 'Width')).toBe(200);
    expect(written.mask!.dict.get(name('Filter'))).toBe(name('FlateDecode'));
    expect([numberIn(written.mask!.dict, 'Width'), numberIn(written.mask!.dict, 'Height')]).toEqual(
      [200, 200],
    );
    const [left, right] = await colorAt(bytes, [
      [40, 200],
      [160, 200],
    ]);
    expect(left).toEqual([255, 255, 255]);
    expect(near(right!, (await colorAt(original, [[160, 200]]))[0]!)).toBe(true);
    await expectValidPdf(bytes);
  });

  it('leaves images it cannot or need not re-encode exactly as they were', async () => {
    const cmyk = new Uint8Array(300 * 300 * 4).map((_, index) => (index * 37) % 251);
    const wide = new Uint8Array(300 * 300 * 6).map((_, index) => (index * 53) % 249);
    const indexed = new Uint8Array(300 * 300).map((_, index) => (index * 7) % 4);
    const specs: ImageSpec[] = [
      // CMYK.
      {
        width: 300,
        height: 300,
        contents: deflateSync(cmyk),
        entries: { ColorSpace: 'DeviceCMYK', Filter: 'FlateDecode' },
      },
      // 16 bits per component.
      {
        width: 300,
        height: 300,
        contents: deflateSync(wide),
        entries: { ColorSpace: 'DeviceRGB', Filter: 'FlateDecode', BitsPerComponent: 16 },
      },
      // Indexed colors.
      {
        width: 300,
        height: 300,
        contents: deflateSync(indexed),
        entries: {
          ColorSpace: ['Indexed', 'DeviceRGB', 3, PDFHexString.of('FF000000FF000000FFFFFF00')],
          Filter: 'FlateDecode',
        },
      },
      // A JPEG already smaller than it would be at the preset's quality.
      dctGray(1000, 800, 20),
      // Too small to matter.
      flateRgb(40, 40),
    ];
    const original = await documentWith(specs.map(image));
    const { bytes } = await compress(original, { images: { maxSize: 2000, quality: 0.8 }, codec });
    const { images } = await pageImages(bytes);
    specs.forEach((spec, index) => {
      expect([...images.get(`Im${index}`)!.contents], `Im${index}`).toEqual([...spec.contents]);
    });
    await expectValidPdf(bytes);
  });

  it('compresses without loss: unfiltered streams, no thumbnails or application data', async () => {
    const raw = photo(200, 150, 3);
    const original = await documentWith(
      [image({ width: 200, height: 150, contents: raw, entries: { ColorSpace: 'DeviceRGB' } })],
      (doc) => {
        const page = doc.getPage(0).node;
        const thumb = image(flateRgb(60, 40))(doc.context);
        page.set(name('Thumb'), thumb);
        page.set(name('PieceInfo'), doc.context.obj({ Folio: { Private: 'data' } }));
        doc.catalog.set(name('PieceInfo'), doc.context.obj({ Folio: { Private: 'data' } }));
      },
    );
    const { bytes } = await compress(original, {
      images: COMPRESSION_PRESETS['high-quality'],
      codec,
    });
    expect(bytes.length).toBeLessThan(original.length);
    const { doc, images } = await pageImages(bytes);
    const page = doc.getPage(0).node;
    expect(page.has(name('Thumb'))).toBe(false);
    expect(page.has(name('PieceInfo'))).toBe(false);
    expect(doc.catalog.has(name('PieceInfo'))).toBe(false);
    // Only the page's own image is left: the thumbnail's is gone from the file.
    const imageCount = [...doc.context.enumerateIndirectObjects()].filter(
      ([, object]) =>
        object instanceof PDFRawStream && object.dict.get(name('Subtype')) === name('Image'),
    ).length;
    expect(imageCount).toBe(1);
    // The image is the same, only Flate-compressed; the content stream too.
    const written = images.get('Im0')!;
    expect(written.dict.get(name('Filter'))).toBe(name('FlateDecode'));
    expect(numberIn(written.dict, 'Width')).toBe(200);
    const contents = page.lookup(name('Contents'));
    const stream = contents instanceof PDFArray ? contents.lookup(0) : contents;
    expect((stream as PDFRawStream).dict.get(name('Filter'))).toBe(name('FlateDecode'));
    expect(await colorAt(bytes, [[100, 200]])).toEqual(await colorAt(original, [[100, 200]]));
    await expectValidPdf(bytes);
  });

  it('keeps encrypted documents encrypted', async () => {
    const original = readFixture('encrypted-user-password.pdf');
    const handle = await engine.open(original, { password: FIXTURE_PASSWORD });
    const model = createDocumentModel(
      toSourceDescriptor(handle.info, {
        fileName: 'locked.pdf',
        byteLength: original.byteLength,
        sha256: await sha256Hex(original),
        origin: { kind: 'generated' },
      }),
    );
    const { permissions } = handle.info;
    await handle.destroy();
    const { bytes } = await exportPdf({
      model,
      sources: new Map([
        [originalSourceId(model)!, { bytes: original, password: FIXTURE_PASSWORD }],
      ]),
      assets: new Map(),
      compression: { images: COMPRESSION_PRESETS.small, codec },
      protection: { userPassword: FIXTURE_PASSWORD, permissions },
    });
    await expect(engine.open(bytes)).rejects.toThrow(/password/i);
    const reopened = await engine.open(bytes, { password: FIXTURE_PASSWORD });
    expect(reopened.info.pageCount).toBe(3);
    await reopened.destroy();
    await expectValidPdf(bytes, FIXTURE_PASSWORD);
  });

  it('stops when cancelled', async () => {
    const original = await documentWith([image(flateRgb(600, 400)), image(flateRgb(600, 400))]);
    const controller = new AbortController();
    await expect(
      compress(original, {
        images: { maxSize: 300, quality: 0.8 },
        codec,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow();
  });
});
