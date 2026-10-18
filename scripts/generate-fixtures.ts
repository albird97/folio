/**
 * Regenerates the PDF fixtures in tests/fixtures.
 *
 *   pnpm fixtures:generate
 *
 * Requires `qpdf` on PATH for the encrypted fixtures (brew install qpdf /
 * apt install qpdf / winget install qpdf). The generated files are committed
 * so that tests never need qpdf. qpdf cannot combine encryption with
 * deterministic IDs, so the encrypted fixtures differ byte-wise per run.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';

const OUT = join(import.meta.dirname, '..', 'tests', 'fixtures');
export const FIXTURE_PASSWORD = 'folio-test';

// Fixed dates keep the output byte-stable between runs.
const CREATED = new Date('2026-01-15T09:30:00.000Z');
const MODIFIED = new Date('2026-02-01T16:45:00.000Z');

async function basic(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sizes: Array<[number, number, string]> = [
    [612, 792, 'Letter portrait'],
    [595.28, 841.89, 'A4 portrait'],
    [792, 612, 'Letter landscape'],
  ];
  sizes.forEach(([width, height, label], index) => {
    const page = pdf.addPage([width, height]);
    page.drawRectangle({
      x: 36,
      y: height - 120,
      width: width - 72,
      height: 84,
      color: rgb(0.93, 0.95, 1),
    });
    page.drawText(`Folio fixture page ${index + 1}`, { x: 54, y: height - 80, size: 24, font });
    page.drawText(label, { x: 54, y: height - 106, size: 12, font, color: rgb(0.3, 0.3, 0.4) });
    page.drawText('The quick brown fox jumps over the lazy dog.', { x: 54, y: height - 160, size: 12, font });
  });
  pdf.setTitle('Folio Basic Fixture');
  pdf.setAuthor('Folio Test Suite');
  pdf.setSubject('Three pages in mixed sizes');
  pdf.setKeywords(['folio', 'fixture', 'test']);
  pdf.setCreator('Folio fixture generator');
  pdf.setProducer('@cantoo/pdf-lib');
  pdf.setCreationDate(CREATED);
  pdf.setModificationDate(MODIFIED);
  return pdf.save({ useObjectStreams: false });
}

async function rotated(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const rotation of [0, 90, 180, 270]) {
    const page = pdf.addPage([612, 792]);
    page.setRotation(degrees(rotation));
    page.drawText(`Stored rotation ${rotation}`, { x: 72, y: 700, size: 28, font });
  }
  pdf.setTitle('Folio Rotation Fixture');
  pdf.setCreationDate(CREATED);
  pdf.setModificationDate(MODIFIED);
  return pdf.save({ useObjectStreams: false });
}

function qpdf(args: string[]): void {
  execFileSync('qpdf', args, { stdio: 'inherit' });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const basicPath = join(OUT, 'basic-3-pages.pdf');
  writeFileSync(basicPath, await basic());
  writeFileSync(join(OUT, 'rotated-pages.pdf'), await rotated());

  // AES-256, user password required to open.
  qpdf([
    '--encrypt',
    `--user-password=${FIXTURE_PASSWORD}`,
    `--owner-password=${FIXTURE_PASSWORD}-owner`,
    '--bits=256',
    '--',
    basicPath,
    join(OUT, 'encrypted-user-password.pdf'),
  ]);
  // Opens without a password, but printing and modification are restricted.
  qpdf([
    '--encrypt',
    `--owner-password=${FIXTURE_PASSWORD}-owner`,
    '--bits=256',
    '--print=none',
    '--modify=none',
    '--',
    basicPath,
    join(OUT, 'encrypted-owner-restricted.pdf'),
  ]);

  writeFileSync(join(OUT, 'not-a-pdf.pdf'), 'This is plain text with a .pdf extension.\n');
  writeFileSync(join(OUT, 'empty.pdf'), new Uint8Array());
  // A header and nothing else: unrecoverable.
  writeFileSync(join(OUT, 'header-only.pdf'), '%PDF-1.7\n%âãÏÓ\n');
  console.log(`Fixtures written to ${OUT}`);
}

await main();
