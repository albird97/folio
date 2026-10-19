import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures');
export const FIXTURE_PASSWORD = 'folio-test';

export type FixtureName =
  | 'basic-3-pages.pdf'
  | 'rotated-pages.pdf'
  | 'encrypted-user-password.pdf'
  | 'encrypted-owner-restricted.pdf'
  | 'encrypted-rc4.pdf'
  | 'outline-and-text.pdf'
  | 'filled-form.pdf'
  | 'form-fields.pdf'
  | 'xfa-form.pdf'
  | 'not-a-pdf.pdf'
  | 'empty.pdf'
  | 'header-only.pdf';

export function readFixture(name: FixtureName): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

/** PDF.js worker for Node tests (runs as a "fake worker" on the main thread). */
export function nodeWorkerSrc(): string {
  const require = createRequire(import.meta.url);
  return pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
}

/**
 * Generates a PDF with `pageCount` pages at test time (too large to commit).
 * Every page says "Page N of M" and carries the unique word `marker-N`;
 * `sizeOf` can vary page sizes.
 */
export async function makeLargePdf(
  pageCount: number,
  sizeOf: (index: number) => [number, number] = () => [612, 792],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const [width, height] = sizeOf(index);
    const page = pdf.addPage([width, height]);
    page.drawText(`Page ${index + 1} of ${pageCount}`, { x: 48, y: height - 72, size: 18, font });
    page.drawText(`marker-${index + 1}`, { x: 48, y: height - 100, size: 12, font });
  }
  return pdf.save({ useObjectStreams: true });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A solid-color RGBA PNG, for image tests. */
export async function makePng(
  width: number,
  height: number,
  [r, g, b, a]: [number, number, number, number] = [220, 40, 40, 255],
): Promise<Uint8Array> {
  const { deflateSync } = await import('node:zlib');
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // no filter
    for (let x = 0; x < width; x += 1) raw.set([r, g, b, a], row + 1 + x * 4);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** Runs `qpdf --check`; resolves null when qpdf is not installed. */
export async function qpdfCheck(
  bytes: Uint8Array,
): Promise<{ ok: boolean; output: string } | null> {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'folio-qpdf-'));
  try {
    const file = join(dir, 'check.pdf');
    writeFileSync(file, bytes);
    const result = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
    if (result.error) return null;
    // Exit code 3 means warnings only; 2 means errors.
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
