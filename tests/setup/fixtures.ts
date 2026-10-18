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
