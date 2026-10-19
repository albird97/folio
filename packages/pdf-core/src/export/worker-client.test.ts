import {
  applyOperation,
  createDocumentModel,
  newAssetId,
  type DocumentModel,
  type SourceId,
} from '@folio/document-model';
import { PDFDict, PDFDocument, PDFName, PDFNumber, type PDFRawStream } from '@cantoo/pdf-lib';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExportWorker as FakeWorker } from '../../../../tests/setup/export-worker';
import { FIXTURE_PASSWORD, nodeWorkerSrc, readFixture } from '../../../../tests/setup/fixtures';
import { toSourceDescriptor } from '../descriptor';
import { createPdfEngine } from '../engine';
import { sha256Hex } from '../hash';
import type { ExportSource } from './export';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const NOW = new Date('2026-03-01T12:00:00Z');

/** A fresh client each time: it remembers when workers failed to start. */
async function client() {
  const [{ exportInWorker }, exporter] = await Promise.all([
    import('./worker-client'),
    import('./export'),
  ]);
  return { exportInWorker, ...exporter };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('Worker', FakeWorker);
  FakeWorker.reset();
});
afterEach(() => vi.unstubAllGlobals());

async function opened(bytes: Uint8Array, password?: string) {
  const handle = await engine.open(bytes, password === undefined ? {} : { password });
  const model = createDocumentModel(
    toSourceDescriptor(handle.info, {
      fileName: 'test.pdf',
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      origin: { kind: 'generated' },
    }),
  );
  await handle.destroy();
  const id = Object.keys(model.sources)[0] as SourceId;
  const source: ExportSource = password === undefined ? { bytes } : { bytes, password };
  return { model, sources: new Map([[id, source]]) };
}

/** A watermark in characters the standard fonts lack, so the export warns. */
const withForeignWatermark = (model: DocumentModel) =>
  applyOperation(model, {
    type: 'stamps/set',
    stamps: {
      watermark: {
        text: '机密 draft',
        position: 'center',
        fontFamily: 'serif',
        fontSize: 48,
        color: '#e03131',
        opacity: 0.25,
        angle: 45,
        layer: 'under',
        margin: 36,
        pages: { from: 1, to: null },
      },
    },
  }).model;

/** Two pages, each with a large Flate image of noise (re-encodable, bigger than 8 KB). */
async function imagesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let index = 0; index < 2; index += 1) {
    const image = doc.context.register(
      doc.context.stream(deflateSync(randomBytes(120 * 80 * 3)), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 120,
        Height: 80,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
      }),
    );
    const page = doc.addPage([120, 80]);
    page.node.setXObject(PDFName.of('Im0'), image);
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('q 120 0 0 80 0 0 cm /Im0 Do Q\n')),
    );
  }
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

describe('exportInWorker', () => {
  it('writes the same file as exportPdf, with its warnings', async () => {
    const { exportInWorker, exportPdf } = await client();
    const { model, sources } = await opened(readFixture('outline-and-text.pdf'));
    const options = { model: withForeignWatermark(model), sources, assets: new Map(), now: NOW };
    const inWorker = await exportInWorker(options);
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0]!.options).toEqual({ type: 'module' });
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    const here = await exportPdf(options);
    expect(inWorker.warnings).toEqual(['unsupported-characters']);
    expect(inWorker.warnings).toEqual(here.warnings);
    expect(inWorker.bytes).toEqual(here.bytes);
  });

  it('copies the caller’s bytes and moves only those it gave up', async () => {
    const { exportInWorker } = await client();
    const { model, sources } = await opened(readFixture('basic-3-pages.pdf'));
    const [[id, kept]] = [...sources] as [[SourceId, ExportSource]];
    const before = kept.bytes.slice();
    const assetBytes = new Uint8Array([1, 2, 3]);
    const given = kept.bytes.slice();
    const { bytes } = await exportInWorker(
      { model, sources: new Map([[id, { bytes: given }]]), assets: new Map() },
      [given],
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
    // Given up: moved without a copy, so it is empty here now.
    expect(given.byteLength).toBe(0);
    // Not given up, or only a view of a larger buffer: copied first.
    const view = assetBytes.subarray(1);
    await exportInWorker({ model, sources, assets: new Map([[newAssetId(), view]]) }, [view]);
    expect(kept.bytes).toEqual(before);
    expect([...assetBytes]).toEqual([1, 2, 3]);
  });

  it('fails with the exporter’s error codes', async () => {
    const { exportInWorker, ExportError } = await client();
    const locked = await opened(readFixture('encrypted-user-password.pdf'), FIXTURE_PASSWORD);
    const [id] = [...locked.sources.keys()];
    const failure = exportInWorker({
      model: locked.model,
      sources: new Map([[id!, { bytes: readFixture('encrypted-user-password.pdf') }]]),
      assets: new Map(),
    });
    await expect(failure).rejects.toBeInstanceOf(ExportError);
    await expect(failure).rejects.toMatchObject({
      code: 'wrong-password',
      message: 'The password for a source document is missing or wrong.',
    });
    await expect(
      exportInWorker({ model: locked.model, sources: new Map(), assets: new Map(), pageIds: [] }),
    ).rejects.toMatchObject({ name: 'ExportError', code: 'no-pages' });
    // The protected copy still opens with its password.
    const { bytes } = await exportInWorker({
      ...locked,
      assets: new Map(),
      protection: { userPassword: FIXTURE_PASSWORD, permissions: null },
    });
    await expect(engine.open(bytes, { password: FIXTURE_PASSWORD })).resolves.toBeTruthy();
  });

  it('fails, rather than waiting, for options that cannot be sent', async () => {
    const { exportInWorker } = await client();
    const { model, sources } = await opened(readFixture('basic-3-pages.pdf'));
    const unsendable = { ...model, extra: () => undefined } as DocumentModel;
    await expect(
      exportInWorker({ model: unsendable, sources, assets: new Map() }),
    ).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(FakeWorker.created[0]!.terminated).toBe(true);
  });

  it('reports compression progress and keeps images it cannot re-encode', async () => {
    const { exportInWorker } = await client();
    const { model, sources } = await opened(await imagesPdf());
    const progress: Array<[number, number]> = [];
    // Node has no canvas, as a worker without OffscreenCanvas would not:
    // every image keeps its data.
    const { bytes } = await exportInWorker({
      model,
      sources,
      assets: new Map(),
      compression: {
        images: { maxSize: 60, quality: 0.8 },
        onProgress: (done, total) => progress.push([done, total]),
      },
    });
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    const pdf = await PDFDocument.load(bytes);
    const xobjects = pdf.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const image = pdf.context.lookup(xobjects.get(PDFName.of('Im0'))) as PDFRawStream;
    expect(image.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect(image.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(120);
  });

  it('stops the worker at once when cancelled', async () => {
    const { exportInWorker } = await client();
    const { model, sources } = await opened(await imagesPdf());
    const controller = new AbortController();
    const progress: number[] = [];
    const failure = exportInWorker({
      model,
      sources,
      assets: new Map(),
      compression: {
        images: { maxSize: 60, quality: 0.8 },
        signal: controller.signal,
        onProgress: (done) => {
          progress.push(done);
          controller.abort();
        },
      },
    });
    await expect(failure).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    expect(progress).toEqual([1]);
    // Already cancelled: no worker is started.
    await expect(
      exportInWorker({
        model,
        sources,
        assets: new Map(),
        compression: { images: null, signal: controller.signal },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.created).toHaveLength(1);
  });

  it('exports on this thread when a worker cannot start, and stops trying', async () => {
    const { exportInWorker } = await client();
    FakeWorker.failToLoad = true;
    const { model, sources } = await opened(readFixture('basic-3-pages.pdf'));
    const [[id, source]] = [...sources] as [[SourceId, ExportSource]];
    const given = source.bytes.slice();
    const { bytes } = await exportInWorker(
      { model, sources: new Map([[id, { bytes: given }]]), assets: new Map() },
      [given],
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
    // Nothing was sent to the worker that failed: the given bytes were used here.
    expect(given.byteLength).toBeGreaterThan(0);
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    await exportInWorker({ model, sources, assets: new Map() });
    expect(FakeWorker.created).toHaveLength(1);
  });

  it('exports on this thread with a custom image codec or without workers', async () => {
    const { exportInWorker } = await client();
    const { model, sources } = await opened(readFixture('basic-3-pages.pdf'));
    const codec = {
      decodeJpeg: () => Promise.reject(new Error('unused')),
      encodeJpeg: () => Promise.reject(new Error('unused')),
    };
    await exportInWorker({
      model,
      sources,
      assets: new Map(),
      compression: { images: null, codec },
    });
    vi.unstubAllGlobals();
    await exportInWorker({ model, sources, assets: new Map() });
    expect(FakeWorker.created).toHaveLength(0);
  });
});
