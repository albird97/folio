/**
 * Regenerates the PDF fixtures in tests/fixtures.
 *
 *   pnpm fixtures:generate
 *
 * Requires `qpdf` on PATH for the encrypted fixtures (brew install qpdf /
 * apt install qpdf / winget install qpdf). The generated files are committed
 * so that tests never need qpdf. qpdf cannot combine encryption with
 * deterministic IDs, so the encrypted fixtures differ byte-wise per run.
 *
 * The scanned-page fixture also needs poppler's `pdftoppm` (brew install
 * poppler / apt install poppler-utils); without it that file is left as it
 * is (see `scannedPages`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * An empty form over two pages with one field of every kind Folio fills in.
 * Page 1: "name" (text, described as "Full name"), "notes" (multi-line),
 * "code" (five comb cells), "pin" (password), "agree" (check box) and "size"
 * (radio buttons S, M and L). Page 2: "country" (drop-down: Indonesia,
 * Japan, Netherlands), "colors" (list box taking several of Red, Green,
 * Blue and Yellow), "id" (read-only text "A-17") and "signature" (an
 * unsigned signature field).
 */
async function formFields(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const [one, two] = [pdf.addPage([612, 792]), pdf.addPage([612, 792])] as [PDFPage, PDFPage];
  const label = (page: PDFPage, text: string, y: number) =>
    page.drawText(text, { x: 72, y, size: 11, font });
  one.drawText('Folio form fields, page 1', { x: 72, y: 720, size: 22, font });
  two.drawText('Folio form fields, page 2', { x: 72, y: 720, size: 22, font });
  const form = pdf.getForm();

  label(one, 'Full name', 672);
  const name = form.createTextField('name');
  name.addToPage(one, { x: 72, y: 640, width: 260, height: 24, font });
  // The field's description, also on its widget, where PDF.js reads it.
  for (const dict of [name.acroField.dict, name.acroField.getWidgets()[0]!.dict]) {
    dict.set(PDFName.of('TU'), PDFHexString.fromText('Full name'));
  }
  name.setFontSize(12);
  label(one, 'Notes', 616);
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(one, { x: 72, y: 520, width: 260, height: 88, font });
  notes.setFontSize(11);
  label(one, 'Code (five characters)', 496);
  const code = form.createTextField('code');
  code.setMaxLength(5);
  code.enableCombing();
  code.addToPage(one, { x: 72, y: 464, width: 150, height: 24, font });
  code.setFontSize(14);
  label(one, 'PIN', 440);
  const pin = form.createTextField('pin');
  pin.enablePassword();
  pin.addToPage(one, { x: 72, y: 408, width: 100, height: 24, font });
  pin.setFontSize(12);
  const agree = form.createCheckBox('agree');
  agree.addToPage(one, { x: 72, y: 368, width: 18, height: 18 });
  one.drawText('I agree', { x: 98, y: 372, size: 11, font });
  label(one, 'Size', 332);
  const size = form.createRadioGroup('size');
  ['S', 'M', 'L'].forEach((option, index) => {
    size.addOptionToPage(option, one, { x: 72 + index * 48, y: 300, width: 18, height: 18 });
    one.drawText(option, { x: 96 + index * 48, y: 304, size: 11, font });
  });

  label(two, 'Country', 672);
  const country = form.createDropdown('country');
  country.addOptions(['Indonesia', 'Japan', 'Netherlands']);
  country.addToPage(two, { x: 72, y: 640, width: 200, height: 24, font });
  country.setFontSize(12);
  label(two, 'Colours', 616);
  const colors = form.createOptionList('colors');
  colors.addOptions(['Red', 'Green', 'Blue', 'Yellow']);
  colors.enableMultiselect();
  colors.addToPage(two, { x: 72, y: 528, width: 200, height: 80, font });
  colors.setFontSize(12);
  label(two, 'Reference', 504);
  const id = form.createTextField('id');
  id.setText('A-17');
  id.enableReadOnly();
  id.addToPage(two, { x: 72, y: 472, width: 150, height: 24, font });
  id.setFontSize(12);
  form.updateFieldAppearances(font);

  // pdf-lib does not create signature fields: this one is a plain widget
  // without an appearance, over a box drawn on the page.
  label(two, 'Signature', 448);
  two.drawRectangle({
    x: 72,
    y: 376,
    width: 220,
    height: 64,
    borderColor: rgb(0.6, 0.6, 0.6),
    borderWidth: 1,
  });
  const { context } = pdf;
  const signature = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of('signature'),
      Rect: [72, 376, 292, 440],
      F: 4,
      P: two.ref,
    }),
  );
  two.node.addAnnot(signature);
  form.acroForm.addField(signature);

  pdf.setTitle('Folio Form Fields Fixture');
  pdf.setCreationDate(CREATED);
  pdf.setModificationDate(MODIFIED);
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/**
 * A form with an XFA part (as Adobe LiveCycle Designer writes them) and an
 * AcroForm field with a stored appearance standing in for it, so PDF.js
 * reports XFA and the page shows the field's value as it was saved.
 */
async function xfaForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText('Folio XFA form fixture', { x: 72, y: 720, size: 22, font });
  page.drawText('Name', { x: 72, y: 672, size: 11, font });
  const form = pdf.getForm();
  const name = form.createTextField('form1[0].name[0]');
  name.setText('Grace Hopper');
  name.addToPage(page, { x: 72, y: 640, width: 260, height: 24, font });
  name.setFontSize(12);
  form.updateFieldAppearances(font);
  const { context } = pdf;
  const packet = (xml: string) => context.register(context.stream(xml));
  form.acroForm.dict.set(
    PDFName.of('XFA'),
    context.obj([
      PDFString.of('preamble'),
      packet('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'),
      PDFString.of('template'),
      packet(
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
          '<subform name="form1"><field name="name"/></subform></template>',
      ),
      PDFString.of('datasets'),
      packet(
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">' +
          '<xfa:data><form1><name>Grace Hopper</name></form1></xfa:data></xfa:datasets>',
      ),
      PDFString.of('postamble'),
      packet('</xdp:xdp>'),
    ]),
  );
  pdf.setTitle('Folio XFA Form Fixture');
  pdf.setCreationDate(CREATED);
  pdf.setModificationDate(MODIFIED);
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
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

/** Whether poppler's pdftoppm can be run. */
function hasPdftoppm(): boolean {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Two scanned pages for OCR: images of text, without any text of their own.
 * Known contents (16 pt body text, 24 pt headings):
 * - Page 1, English: "Folio scanned page" / "The lighthouse keeper counts the
 *   ships at dawn." / "Recognized words become searchable."
 * - Page 2, Indonesian: "Halaman pindaian kedua" / "Kucing tidur di bawah
 *   pohon mangga." / "Teks ini dibaca tanpa internet." It is stored turned
 *   (/Rotate 90) with its image drawn sideways, like a page scanned in
 *   landscape and turned upright, so it only reads upright as shown.
 *
 * The text is drawn as vector pages first, rasterized by pdftoppm at 150 dpi
 * in grey and placed as one image per page. pdftoppm is not on CI: without
 * it, the committed file is kept and null is returned.
 */
async function scannedPages(): Promise<Uint8Array | null> {
  if (!hasPdftoppm()) return null;
  const source = await PDFDocument.create({ updateMetadata: false });
  const font = await source.embedFont(StandardFonts.Helvetica);
  const bold = await source.embedFont(StandardFonts.HelveticaBold);
  const texts = [
    [
      'Folio scanned page',
      'The lighthouse keeper counts the ships at dawn.',
      'Recognized words become searchable.',
    ],
    [
      'Halaman pindaian kedua',
      'Kucing tidur di bawah pohon mangga.',
      'Teks ini dibaca tanpa internet.',
    ],
  ];
  for (const [heading, ...lines] of texts) {
    const page = source.addPage([612, 792]);
    page.drawText(heading!, { x: 72, y: 690, size: 24, font: bold });
    lines.forEach((line, index) => {
      page.drawText(line, { x: 72, y: 640 - index * 30, size: 16, font });
    });
  }
  const dir = mkdtempSync(join(tmpdir(), 'folio-scan-'));
  let images: Uint8Array[];
  try {
    writeFileSync(join(dir, 'source.pdf'), await source.save());
    execFileSync('pdftoppm', [
      '-r',
      '150',
      '-gray',
      '-png',
      join(dir, 'source.pdf'),
      join(dir, 'page'),
    ]);
    images = [1, 2].map((number) => new Uint8Array(readFileSync(join(dir, `page-${number}.png`))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const pdf = await PDFDocument.create({ updateMetadata: false });
  const upright = pdf.addPage([612, 792]);
  upright.drawImage(await pdf.embedPng(images[0]!), { x: 0, y: 0, width: 612, height: 792 });
  // Drawn a quarter turn counterclockwise on a landscape page, which /Rotate
  // 90 turns clockwise again when the page is shown.
  const turned = pdf.addPage([792, 612]);
  turned.drawImage(await pdf.embedPng(images[1]!), {
    x: 792,
    y: 0,
    width: 612,
    height: 792,
    rotate: degrees(90),
  });
  turned.setRotation(degrees(90));
  pdf.setTitle('Folio Scanned Fixture');
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
  writeFileSync(join(OUT, 'form-fields.pdf'), await formFields());
  writeFileSync(join(OUT, 'xfa-form.pdf'), await xfaForm());
  const scanned = await scannedPages();
  if (scanned) writeFileSync(join(OUT, 'scanned-pages.pdf'), scanned);
  else console.warn('pdftoppm (poppler) was not found: scanned-pages.pdf was left unchanged.');

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
