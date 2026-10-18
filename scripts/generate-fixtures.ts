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
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFObject,
  type PDFPage,
  type PDFRef,
} from '@cantoo/pdf-lib';

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
    page.drawText('The quick brown fox jumps over the lazy dog.', {
      x: 54,
      y: height - 160,
      size: 12,
      font,
    });
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

/** A filled-in form: a text field and a ticked checkbox with stored appearances. */
async function filledForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText('Folio form fixture', { x: 72, y: 720, size: 24, font });
  page.drawText('Name', { x: 72, y: 652, size: 12, font });
  page.drawText('I agree', { x: 104, y: 602, size: 12, font });
  const form = pdf.getForm();
  const name = form.createTextField('name');
  name.setText('Ada Lovelace');
  name.addToPage(page, { x: 72, y: 616, width: 260, height: 28, font });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 72, y: 596, width: 20, height: 20 });
  agree.check();
  form.updateFieldAppearances(font);
  pdf.setTitle('Folio Form Fixture');
  pdf.setCreationDate(CREATED);
  pdf.setModificationDate(MODIFIED);
  return pdf.save({ useObjectStreams: false });
}

interface OutlineNode {
  title: string;
  dest?: PDFObject;
  uri?: string;
  children?: OutlineNode[];
}

/** Writes a nested /Outlines tree (pdf-lib has no high-level API for it). */
function addOutline(pdf: PDFDocument, nodes: OutlineNode[]): void {
  const ctx = pdf.context;
  const outlinesRef = ctx.nextRef();
  let visible = 0;
  const build = (level: OutlineNode[], parent: PDFRef): PDFRef[] => {
    const refs = level.map(() => ctx.nextRef());
    level.forEach((node, index) => {
      visible += 1;
      const dict = ctx.obj({ Title: PDFHexString.fromText(node.title), Parent: parent });
      if (index > 0) dict.set(PDFName.of('Prev'), refs[index - 1]!);
      if (index < level.length - 1) dict.set(PDFName.of('Next'), refs[index + 1]!);
      if (node.dest) dict.set(PDFName.of('Dest'), node.dest);
      if (node.uri) dict.set(PDFName.of('A'), ctx.obj({ S: 'URI', URI: PDFString.of(node.uri) }));
      if (node.children?.length) {
        const children = build(node.children, refs[index]!);
        dict.set(PDFName.of('First'), children[0]!);
        dict.set(PDFName.of('Last'), children.at(-1)!);
        dict.set(PDFName.of('Count'), PDFNumber.of(node.children.length));
      }
      ctx.assign(refs[index]!, dict);
    });
    return refs;
  };
  const top = build(nodes, outlinesRef);
  ctx.assign(
    outlinesRef,
    ctx.obj({ Type: 'Outlines', First: top[0]!, Last: top.at(-1)!, Count: PDFNumber.of(visible) }),
  );
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
}

function paragraph(page: PDFPage, font: PDFFont, lines: string[], top: number): void {
  lines.forEach((line, index) => {
    page.drawText(line, { x: 72, y: top - index * 18, size: 12, font });
  });
}

/**
 * Six pages for search and outline tests. Known contents:
 * - "fox" 4× (pages 1, 2 and twice on 4); "Quick" capitalised once, "quick" twice.
 * - "Café" and "naïve" on page 3 (accent-insensitive search).
 * - "photo" + "synthesis" drawn as two runs on page 5 ("photosynthesis").
 * - "cat" twice as a word and once inside "category" on page 6.
 * - Outline: explicit /XYZ, nested, a named destination, /FitH and a web link.
 */
async function outlineAndText(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = Array.from({ length: 6 }, () => pdf.addPage([612, 792]));
  const heading = (page: PDFPage, text: string) =>
    page.drawText(text, { x: 72, y: 700, size: 22, font: bold });

  heading(pages[0]!, 'Introduction');
  paragraph(
    pages[0]!,
    font,
    ['The Quick brown fox opens this guide.', 'It is a field guide.'],
    660,
  );
  heading(pages[1]!, 'Chapter 1: Foxes');
  paragraph(pages[1]!, font, ['A quick fox is still a fox in the field.'], 660);
  heading(pages[2]!, 'Section 1.1: Habitat');
  paragraph(
    pages[2]!,
    font,
    ['Foxes visit the Café at dawn.', 'Only a naïve fox stays long.'],
    520,
  );
  heading(pages[3]!, 'Field notes');
  paragraph(pages[3]!, font, ['quick notes: fox tracks, then more fox tracks.'], 660);
  heading(pages[4]!, 'Chapter 2: Plants');
  pages[4]!.drawText('photo', { x: 72, y: 660, size: 12, font });
  pages[4]!.drawText('synthesis', {
    x: 72 + font.widthOfTextAtSize('photo', 12),
    y: 660,
    size: 12,
    font,
  });
  pages[4]!.drawText(' turns light into sugar.', {
    x: 72 + font.widthOfTextAtSize('photosynthesis', 12),
    y: 660,
    size: 12,
    font,
  });
  heading(pages[5]!, 'Appendix');
  paragraph(pages[5]!, font, ['A cat and another cat are not a category.'], 660);

  const ctx = pdf.context;
  pdf.catalog.set(
    PDFName.of('Names'),
    ctx.obj({
      Dests: ctx.obj({ Names: [PDFString.of('chap2'), ctx.obj([pages[4]!.ref, 'Fit'])] }),
    }),
  );
  addOutline(pdf, [
    { title: 'Introduction', dest: ctx.obj([pages[0]!.ref, 'XYZ', null, 792, null]) },
    {
      title: 'Chapter 1: Foxes',
      dest: ctx.obj([pages[1]!.ref, 'XYZ', null, 720, null]),
      children: [
        { title: 'Section 1.1: Habitat', dest: ctx.obj([pages[2]!.ref, 'XYZ', 72, 540, null]) },
      ],
    },
    { title: 'Chapter 2: Plants', dest: PDFString.of('chap2') },
    { title: 'Appendix', dest: ctx.obj([pages[5]!.ref, 'FitH', 400]) },
    { title: 'Folio on the web', uri: 'https://example.com/folio' },
  ]);
  pdf.setTitle('Folio Outline Fixture');
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
  writeFileSync(join(OUT, 'outline-and-text.pdf'), await outlineAndText());
  writeFileSync(join(OUT, 'filled-form.pdf'), await filledForm());

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
  // Legacy 128-bit RC4, still common in older PDFs.
  qpdf([
    '--allow-weak-crypto',
    '--encrypt',
    `--user-password=${FIXTURE_PASSWORD}`,
    `--owner-password=${FIXTURE_PASSWORD}-owner`,
    '--bits=128',
    '--use-aes=n',
    '--',
    basicPath,
    join(OUT, 'encrypted-rc4.pdf'),
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
