import { afterAll, describe, expect, it } from 'vitest';
import { createDocumentModel, primarySource } from '@folio/document-model';
import { FIXTURE_PASSWORD, nodeWorkerSrc, readFixture } from '../../../tests/setup/fixtures';
import { toSourceDescriptor } from './descriptor';
import { createPdfEngine } from './engine';
import { PdfError } from './errors';
import { sha256Hex } from './hash';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function expectPdfError(promise: Promise<unknown>, code: PdfError['code']) {
  await expect(promise).rejects.toBeInstanceOf(PdfError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('PDF engine', () => {
  it('inspects page sizes, metadata and version of a real PDF', async () => {
    const bytes = readFixture('basic-3-pages.pdf');
    const handle = await engine.open(bytes);
    const { info } = handle;
    expect(info.pageCount).toBe(3);
    expect(info.pdfVersion).toBe('1.7');
    expect(info.encryption).toBe('none');
    expect(info.permissions).toBeNull();
    expect(info.forms).toBe('none');
    expect(info.pages.map((page) => [Math.round(page.size.width), Math.round(page.size.height)])).toEqual([
      [612, 792],
      [595, 842],
      [792, 612],
    ]);
    expect(info.metadata).toMatchObject({
      title: 'Folio Basic Fixture',
      author: 'Folio Test Suite',
      subject: 'Three pages in mixed sizes',
      creator: 'Folio fixture generator',
      producer: '@cantoo/pdf-lib',
      creationDate: '2026-01-15T09:30:00.000Z',
      modificationDate: '2026-02-01T16:45:00.000Z',
    });
    // pdf-lib separates keywords with spaces; only "," and ";" are treated as
    // delimiters so that multi-word keywords survive.
    expect(info.metadata.keywords).toEqual(['folio fixture test']);
    await handle.destroy();
  });

  it('leaves the caller’s buffer intact', async () => {
    const bytes = readFixture('basic-3-pages.pdf');
    const before = await sha256Hex(bytes);
    const handle = await engine.open(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(await sha256Hex(bytes)).toBe(before);
    await handle.destroy();
  });

  it('reads stored page rotation', async () => {
    const handle = await engine.open(readFixture('rotated-pages.pdf'));
    expect(handle.info.pages.map((page) => page.rotation)).toEqual([0, 90, 180, 270]);
    await handle.destroy();
  });

  it('builds a document model from the inspection', async () => {
    const bytes = readFixture('rotated-pages.pdf');
    const handle = await engine.open(bytes);
    const model = createDocumentModel(
      toSourceDescriptor(handle.info, {
        fileName: 'rotated-pages.pdf',
        byteLength: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        origin: { kind: 'local-file', handle: null },
      }),
    );
    expect(model.pages.map((page) => page.sourceRotation)).toEqual([0, 90, 180, 270]);
    expect(model.pages.every((page) => page.rotation === 0)).toBe(true);
    expect(primarySource(model)?.pageCount).toBe(4);
    await handle.destroy();
  });

  it('requires a password for user-password PDFs', async () => {
    await expectPdfError(engine.open(readFixture('encrypted-user-password.pdf')), 'password-required');
    await expectPdfError(
      engine.open(readFixture('encrypted-user-password.pdf'), { password: 'wrong' }),
      'incorrect-password',
    );
    const handle = await engine.open(readFixture('encrypted-user-password.pdf'), {
      password: FIXTURE_PASSWORD,
    });
    expect(handle.info.pageCount).toBe(3);
    expect(handle.info.encryption).toBe('password-protected');
    expect(handle.info.metadata.title).toBe('Folio Basic Fixture');
    await handle.destroy();
  });

  it('opens owner-restricted PDFs and reports their permissions', async () => {
    const handle = await engine.open(readFixture('encrypted-owner-restricted.pdf'));
    expect(handle.info.encryption).toBe('owner-restricted');
    expect(handle.info.permissions).toMatchObject({ print: false, modify: false, copy: true });
    await handle.destroy();
  });

  it('classifies files that are not PDFs', async () => {
    await expectPdfError(engine.open(readFixture('empty.pdf')), 'empty-file');
    await expectPdfError(engine.open(readFixture('not-a-pdf.pdf')), 'not-a-pdf');
    await expectPdfError(engine.open(readFixture('header-only.pdf')), 'invalid-pdf');
  });

  it('enforces the size limit before parsing', async () => {
    const small = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null, maxFileBytes: 100 });
    await expectPdfError(small.open(readFixture('basic-3-pages.pdf')), 'too-large');
    small.destroy();
  });

  it('opens several documents concurrently on one worker', async () => {
    const handles = await Promise.all(
      Array.from({ length: 4 }, () => engine.open(readFixture('basic-3-pages.pdf'))),
    );
    expect(handles.map((handle) => handle.info.pageCount)).toEqual([3, 3, 3, 3]);
    await Promise.all(handles.map((handle) => handle.destroy()));
  });
});
