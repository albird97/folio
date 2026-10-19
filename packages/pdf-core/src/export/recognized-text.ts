import {
  layoutRecognizedText,
  parseRecognizedText,
  sourcePageKey,
  type AssetId,
  type DocumentModel,
  type PageModel,
  type RecognizedTextData,
} from '@folio/document-model';
import { PDFString, type PDFDocument, type PDFPage, type PDFRef } from '@cantoo/pdf-lib';
import { num } from './appearance';
import {
  ASCENT,
  DESCENT,
  GLYPH_ADVANCE,
  GLYPHLESS_FONT_NAME,
  glyphlessFont,
  UNITS_PER_EM,
} from './glyphless-font';
import { isolatePageEntries, pageOrigin } from './objects';

/**
 * Maps every character code to the same Unicode value. Codes are UTF-16
 * code units (two bytes each, Identity-H); the surrogate range is left out
 * because characters outside the Basic Multilingual Plane are never written.
 * Ranges stay within one high byte and sections hold at most 100 of them, as
 * the PDF specification requires.
 */
function toUnicodeCMap(): string {
  const ranges: string[] = [];
  for (let high = 0; high < 256; high += 1) {
    if (high >= 0xd8 && high <= 0xdf) continue;
    const prefix = high.toString(16).padStart(2, '0').toUpperCase();
    ranges.push(`<${prefix}00> <${prefix}FF> <${prefix}00>`);
  }
  const sections: string[] = [];
  for (let start = 0; start < ranges.length; start += 100) {
    const section = ranges.slice(start, start + 100);
    sections.push(`${section.length} beginbfrange`, ...section, 'endbfrange');
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...sections,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/**
 * The text as character codes (hex) and how many there are. Characters
 * outside the Basic Multilingual Plane would need two codes each and are
 * written as U+FFFD instead, like stray surrogates.
 */
function encodeText(text: string): { hex: string; count: number } {
  let hex = '';
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const unit = code > 0xffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code;
    hex += unit.toString(16).padStart(4, '0').toUpperCase();
    count += 1;
  }
  return { hex, count };
}

/** Horizontal scaling that keeps text readers' arithmetic sound (percent). */
const MIN_SCALE = 1;
const MAX_SCALE = 10_000;

/**
 * Writes recognized text (OCR) onto pages as invisible text: real page
 * content in text rendering mode 3, which paints nothing, so any viewer can
 * search, select and copy it where the words show on the page. It uses a
 * font without glyphs that maps character codes straight to Unicode, so
 * every script survives, and stretches each word to the width of its box.
 */
class RecognizedTextWriter {
  readonly #doc: PDFDocument;
  #font: PDFRef | null = null;

  constructor(doc: PDFDocument) {
    this.#doc = doc;
  }

  /** The Type0 font, created once per document and shared by every page. */
  #fontRef(): PDFRef {
    if (this.#font) return this.#font;
    const { context } = this.#doc;
    const program = glyphlessFont();
    const descriptor = context.register(
      context.obj({
        Type: 'FontDescriptor',
        FontName: GLYPHLESS_FONT_NAME,
        // Fixed pitch, symbolic.
        Flags: 5,
        FontBBox: [0, DESCENT, GLYPH_ADVANCE, ASCENT],
        ItalicAngle: 0,
        Ascent: ASCENT,
        Descent: DESCENT,
        CapHeight: ASCENT,
        StemV: 80,
        FontFile2: context.register(context.flateStream(program, { Length1: program.length })),
      }),
    );
    // Two bytes per character code, each naming glyph 1.
    const glyphMap = new Uint8Array(2 * 0x10000);
    for (let index = 1; index < glyphMap.length; index += 2) glyphMap[index] = 1;
    const descendant = context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: GLYPHLESS_FONT_NAME,
        CIDSystemInfo: {
          Registry: PDFString.of('Adobe'),
          Ordering: PDFString.of('Identity'),
          Supplement: 0,
        },
        FontDescriptor: descriptor,
        DW: GLYPH_ADVANCE,
        CIDToGIDMap: context.register(context.flateStream(glyphMap)),
      }),
    );
    this.#font = context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: GLYPHLESS_FONT_NAME,
        Encoding: 'Identity-H',
        DescendantFonts: [descendant],
        ToUnicode: context.register(context.flateStream(toUnicodeCMap())),
      }),
    );
    return this.#font;
  }

  /** Adds the text to a page. `dx`/`dy` move it from page space into PDF user space. */
  write(page: PDFPage, data: RecognizedTextData, offset: { dx: number; dy: number }): void {
    const runs = layoutRecognizedText(data);
    if (runs.length === 0) return;
    const { context } = this.#doc;
    // Wraps the existing content in q/Q so its graphics state cannot leak into ours.
    page.node.normalize();
    const font = page.node.newFontDictionary('FolioOcr', this.#fontRef()).asString();
    // q/Q too: the rendering mode and scaling must not reach content added later.
    const ops = ['q', 'BT', '3 Tr'];
    let size = Number.NaN;
    for (const run of runs) {
      const { hex, count } = encodeText(run.text);
      if (count === 0) continue;
      if (run.fontSize !== size) {
        size = run.fontSize;
        ops.push(`${font} ${num(size)} Tf`);
      }
      const natural = (count * GLYPH_ADVANCE * size) / UNITS_PER_EM;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (100 * run.width) / natural));
      const [a, b, c, d, e, f] = run.matrix;
      ops.push(
        `${num(scale)} Tz`,
        `${[a, b, c, d, e + offset.dx, f + offset.dy].map(num).join(' ')} Tm`,
        `<${hex}> Tj`,
      );
    }
    ops.push('ET', 'Q');
    page.node.addContentStream(context.register(context.flateStream(ops.join('\n'))));
  }
}

/** Stored text that is missing or damaged is left out rather than failing the save. */
function readData(bytes: Uint8Array | undefined): RecognizedTextData | null {
  if (!bytes) return null;
  try {
    return parseRecognizedText(bytes);
  } catch {
    return null;
  }
}

/**
 * Adds the recognized text of their source pages to the pages being written.
 * Copies of a page get it too: the text belongs to the page's image.
 */
export function addRecognizedText(
  doc: PDFDocument,
  model: DocumentModel,
  pages: ReadonlyArray<{ model: PageModel; page: PDFPage }>,
  assets: ReadonlyMap<AssetId, Uint8Array>,
): void {
  const writer = new RecognizedTextWriter(doc);
  const parsed = new Map<AssetId, RecognizedTextData | null>();
  for (const { model: pageModel, page } of pages) {
    if (pageModel.source.kind !== 'source') continue;
    const { sourceId, pageIndex } = pageModel.source;
    const layer = model.textLayers[sourcePageKey(sourceId, pageIndex)];
    if (!layer) continue;
    let data = parsed.get(layer.assetId);
    if (data === undefined) {
      data = readData(assets.get(layer.assetId));
      parsed.set(layer.assetId, data);
    }
    if (!data || data.words.length === 0) continue;
    isolatePageEntries(page);
    const origin = pageOrigin(page);
    writer.write(page, data, { dx: origin.x, dy: origin.y });
  }
}
