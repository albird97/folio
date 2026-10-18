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
