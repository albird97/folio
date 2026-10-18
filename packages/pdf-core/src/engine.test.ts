import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber } from '@cantoo/pdf-lib';
import { PermissionFlag } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createDocumentModel, primarySource } from '@folio/document-model';
import { FIXTURE_PASSWORD, nodeWorkerSrc, readFixture } from '../../../tests/setup/fixtures';
import { toSourceDescriptor } from './descriptor';
import { createPdfEngine, permissionsFrom } from './engine';
import { PdfError } from './errors';
import { sha256Hex } from './hash';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function expectPdfError(promise: Promise<unknown>, code: PdfError['code']) {
  await expect(promise).rejects.toBeInstanceOf(PdfError);
  await expect(promise).rejects.toMatchObject({ code });
}

/** Replaces one occurrence of `from` with `to`; equal lengths keep the xref valid. */
function patchBytes(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const latin1 = new TextDecoder('latin1').decode(bytes);
  const at = latin1.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(to).toHaveLength(from.length);
  const patched = bytes.slice();
  for (let i = 0; i < to.length; i += 1) patched[at + i] = to.charCodeAt(i);
  return patched;
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
    expect(
      info.pages.map((page) => [Math.round(page.size.width), Math.round(page.size.height)]),
    ).toEqual([
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
    await expectPdfError(
      engine.open(readFixture('encrypted-user-password.pdf')),
      'password-required',
    );
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

  it('decrypts legacy RC4-encrypted PDFs', async () => {
    await expectPdfError(engine.open(readFixture('encrypted-rc4.pdf')), 'password-required');
    const handle = await engine.open(readFixture('encrypted-rc4.pdf'), {
      password: FIXTURE_PASSWORD,
    });
    expect(handle.info.pageCount).toBe(3);
    expect(handle.info.metadata.title).toBe('Folio Basic Fixture');
    await handle.destroy();
  });

  it('opens owner-restricted PDFs and reports their permissions', async () => {
    const handle = await engine.open(readFixture('encrypted-owner-restricted.pdf'));
    expect(handle.info.encryption).toBe('owner-restricted');
    expect(handle.info.permissions).toMatchObject({ print: false, modify: false, copy: true });
    await handle.destroy();
  });

  it('does not allow printing when only the high-quality print bit is set', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.addPage([612, 792]);
    pdf.encrypt({
      ownerPassword: `${FIXTURE_PASSWORD}-owner`,
      permissions: {
        printing: 'highResolution',
        modifying: true,
        copying: true,
        annotating: true,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: true,
      },
    });
    const everything = await pdf.save({ useObjectStreams: false });
    const unrestricted = await engine.open(everything);
    expect(unrestricted.info.permissions?.print).toBe(true);
    await unrestricted.destroy();

    // pdf-lib cannot clear bit 3 while keeping bit 12 (other tools do, e.g.
    // PDFBox's setCanPrint(false)), so patch /P from -4 to -8. AES-256 does
    // not derive its key from /P.
    const handle = await engine.open(patchBytes(everything, '/P -4\n', '/P -8\n'));
    expect(handle.info.encryption).toBe('owner-restricted');
    expect(handle.info.permissions).toEqual({
      print: false,
      copy: true,
      modify: true,
      annotate: true,
      fillForms: true,
      assemble: true,
    });
    await handle.destroy();
  });

  it('maps raw permission bits', () => {
    expect(permissionsFrom(null)).toBeNull();
    expect(permissionsFrom(new Set([PermissionFlag.PRINT_HIGH_QUALITY]))?.print).toBe(false);
    expect(permissionsFrom(new Set([PermissionFlag.PRINT]))?.print).toBe(true);
    expect(
      permissionsFrom(new Set([PermissionFlag.PRINT, PermissionFlag.PRINT_HIGH_QUALITY]))?.print,
    ).toBe(true);
  });

  it('applies /UserUnit to page sizes', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.addPage([612, 792]).node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    pdf.addPage([612, 792]);
    const handle = await engine.open(await pdf.save());
    expect(handle.info.pages.map((page) => page.size)).toEqual([
      { width: 1224, height: 1584 },
      { width: 612, height: 792 },
    ]);
    expect(handle.info.pages.map((page) => page.userUnit)).toEqual([2, 1]);
    // The model keeps the factor so unscaled page geometry can be converted.
    const model = createDocumentModel(
      toSourceDescriptor(handle.info, {
        fileName: 'large-format.pdf',
        byteLength: 1,
        sha256: 'a'.repeat(64),
        origin: { kind: 'generated' },
      }),
    );
    expect(model.pages.map((page) => [page.size.width, page.userUnit])).toEqual([
      [1224, 2],
      [612, 1],
    ]);
    await handle.destroy();
  });

  it('falls back to XMP for the title and every author', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.addPage([612, 792]);
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP Title</rdf:li></rdf:Alt></dc:title>
      <dc:creator>
        <rdf:Seq><rdf:li>Jane Author</rdf:li><rdf:li>John Editor</rdf:li></rdf:Seq>
      </dc:creator>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    pdf.catalog.set(
      PDFName.of('Metadata'),
      pdf.context.register(pdf.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })),
    );
    const handle = await engine.open(await pdf.save());
    expect(handle.info.metadata).toMatchObject({
      title: 'XMP Title',
      author: 'Jane Author; John Editor',
    });
    await handle.destroy();
  });

  it('classifies files that are not PDFs', async () => {
    await expectPdfError(engine.open(readFixture('empty.pdf')), 'empty-file');
    await expectPdfError(engine.open(readFixture('not-a-pdf.pdf')), 'not-a-pdf');
    await expectPdfError(engine.open(readFixture('header-only.pdf')), 'invalid-pdf');
  });

  it('enforces the size limit before parsing', async () => {
    const small = createPdfEngine({
      workerSrc: nodeWorkerSrc(),
      assetBaseUrl: null,
      maxFileBytes: 100,
    });
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
