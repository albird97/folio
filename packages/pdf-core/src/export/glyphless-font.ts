import { RECOGNIZED_DESCENT } from '@folio/document-model';

/*
 * A TrueType font without glyph outlines, for invisible text (OCR). It has
 * two empty glyphs (.notdef and glyph 1) half an em wide. The PDF maps every
 * character to glyph 1 (CIDToGIDMap) and every character code back to its
 * Unicode value (ToUnicode), so any script can be searched and copied while
 * nothing is ever drawn. This is the approach of Tesseract's searchable PDFs,
 * written from the TrueType specification rather than copied from its font.
 */

/** Font units per em. */
export const UNITS_PER_EM = 1000;
/** The advance of every glyph, in font units: half an em. */
export const GLYPH_ADVANCE = 500;
/**
 * Height above and (negative) depth below the baseline, in font units: the
 * baseline is where recognized text puts it (`RECOGNIZED_DESCENT`), so other
 * PDF viewers select the same box Folio does.
 */
export const ASCENT = Math.round(UNITS_PER_EM * (1 - RECOGNIZED_DESCENT));
export const DESCENT = -Math.round(UNITS_PER_EM * RECOGNIZED_DESCENT);

class Writer {
  readonly #bytes: number[] = [];
  u8(value: number) {
    this.#bytes.push(value & 0xff);
    return this;
  }
  u16(value: number) {
    return this.u8(value >> 8).u8(value);
  }
  i16(value: number) {
    return this.u16(value & 0xffff);
  }
  u32(value: number) {
    return this.u16(value >>> 16).u16(value & 0xffff);
  }
  /** A 64-bit LONGDATETIME (zero: no date, which keeps the font byte-stable). */
  zeroDate() {
    return this.u32(0).u32(0);
  }
  tag(value: string) {
    for (const char of value) this.u8(char.charCodeAt(0));
    return this;
  }
  bytes(values: ArrayLike<number>) {
    for (let index = 0; index < values.length; index += 1) this.u8(values[index]!);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

function checksum(table: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < table.length; index += 4) {
    const word =
      ((table[index] ?? 0) << 24) |
      ((table[index + 1] ?? 0) << 16) |
      ((table[index + 2] ?? 0) << 8) |
      (table[index + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** Name records (platform 3, Unicode BMP, US English). */
function nameTable(names: ReadonlyArray<[id: number, value: string]>): Uint8Array {
  const strings = new Writer();
  const records = new Writer();
  let offset = 0;
  for (const [id, value] of names) {
    const length = value.length * 2;
    records.u16(3).u16(1).u16(0x409).u16(id).u16(length).u16(offset);
    for (const char of value) strings.u16(char.charCodeAt(0));
    offset += length;
  }
  const head = new Writer()
    .u16(0)
    .u16(names.length)
    .u16(6 + names.length * 12);
  return new Writer().bytes(head.done()).bytes(records.done()).bytes(strings.done()).done();
}

function buildFont(name: string, ascent: number, descent: number): Uint8Array {
  const glyphs = 2;
  const tables = new Map<string, Uint8Array>();
  tables.set(
    'OS/2',
    new Writer()
      .u16(4) // version
      .i16(GLYPH_ADVANCE) // xAvgCharWidth
      .u16(400) // usWeightClass: regular
      .u16(5) // usWidthClass: medium
      .u16(0) // fsType: installable embedding
      .i16(650)
      .i16(600)
      .i16(0)
      .i16(75) // subscript size and offset
      .i16(650)
      .i16(600)
      .i16(0)
      .i16(350) // superscript size and offset
      .i16(50)
      .i16(300) // strikeout size and position
      .i16(0) // sFamilyClass
      .bytes(new Uint8Array(10)) // panose
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0) // ulUnicodeRange1–4
      .tag('NONE') // achVendID
      .u16(0x40) // fsSelection: regular
      .u16(0xffff)
      .u16(0xffff) // first and last character: none mapped
      .i16(ascent)
      .i16(descent)
      .i16(0) // typographic ascender, descender, line gap
      .u16(ascent)
      .u16(-descent) // usWinAscent, usWinDescent
      .u32(1)
      .u32(0) // code page ranges: Latin 1
      .i16(0)
      .i16(0) // sxHeight, sCapHeight
      .u16(0)
      .u16(0)
      .u16(0) // default char, break char, max context
      .done(),
  );
  // A Unicode cmap with nothing mapped but the required final segment: the
  // PDF reaches the glyph through the CIDToGIDMap instead.
  tables.set(
    'cmap',
    new Writer()
      .u16(0)
      .u16(1) // version, one encoding record
      .u16(3)
      .u16(1)
      .u32(12) // Windows Unicode BMP, at offset 12
      .u16(4)
      .u16(24)
      .u16(0) // format 4, length, language
      .u16(2)
      .u16(2)
      .u16(0)
      .u16(0) // segCountX2, searchRange, entrySelector, rangeShift
      .u16(0xffff) // endCode
      .u16(0) // reservedPad
      .u16(0xffff) // startCode
      .i16(1) // idDelta: 0xFFFF → glyph 0
      .u16(0) // idRangeOffset
      .done(),
  );
  // Every glyph is empty, so the glyph data is empty too.
  tables.set('glyf', new Uint8Array(0));
  tables.set(
    'head',
    new Writer()
      .u32(0x00010000) // version
      .u32(0x00010000) // fontRevision
      .u32(0) // checkSumAdjustment, filled in below
      .u32(0x5f0f3cf5) // magicNumber
      .u16(0x000b) // flags: baseline and left side bearing at 0, integer scaling
      .u16(UNITS_PER_EM)
      .zeroDate()
      .zeroDate()
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0) // bounding box of all glyphs: empty
      .u16(0) // macStyle
      .u16(3) // lowestRecPPEM
      .i16(2) // fontDirectionHint
      .i16(0) // indexToLocFormat: short offsets
      .i16(0) // glyphDataFormat
      .done(),
  );
  tables.set(
    'hhea',
    new Writer()
      .u32(0x00010000)
      .i16(ascent)
      .i16(descent)
      .i16(0) // ascender, descender, line gap
      .u16(GLYPH_ADVANCE) // advanceWidthMax
      .i16(0)
      .i16(0)
      .i16(0) // min left/right side bearing, xMaxExtent
      .i16(1)
      .i16(0)
      .i16(0) // caret slope rise and run, caret offset
      .i16(0)
      .i16(0)
      .i16(0)
      .i16(0) // reserved
      .i16(0) // metricDataFormat
      .u16(glyphs) // numberOfHMetrics
      .done(),
  );
  const metrics = new Writer();
  for (let glyph = 0; glyph < glyphs; glyph += 1) metrics.u16(GLYPH_ADVANCE).i16(0);
  tables.set('hmtx', metrics.done());
  const loca = new Writer();
  for (let glyph = 0; glyph <= glyphs; glyph += 1) loca.u16(0);
  tables.set('loca', loca.done());
  tables.set(
    'maxp',
    new Writer()
      .u32(0x00010000)
      .u16(glyphs)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0) // points and contours, simple and composite
      .u16(2) // maxZones
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0) // no instructions or components
      .done(),
  );
  tables.set(
    'name',
    nameTable([
      [1, name],
      [2, 'Regular'],
      [4, name],
      [6, name],
    ]),
  );
  tables.set(
    'post',
    new Writer()
      .u32(0x00030000) // version 3: no glyph names
      .u32(0) // italicAngle
      .i16(-100)
      .i16(50) // underline position and thickness
      .u32(1) // isFixedPitch: every glyph has the same advance
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0) // memory hints
      .done(),
  );

  // Table records are sorted by tag; the data follows, 4-byte aligned.
  const tags = [...tables.keys()].sort();
  const count = tags.length;
  const power = 2 ** Math.floor(Math.log2(count));
  const directory = new Writer()
    .u32(0x00010000)
    .u16(count)
    .u16(power * 16)
    .u16(Math.log2(power))
    .u16(count * 16 - power * 16);
  const headerLength = 12 + count * 16;
  let offset = headerLength;
  const placed = tags.map((tag) => {
    const data = tables.get(tag)!;
    const entry = { tag, data, offset };
    offset += Math.ceil(data.length / 4) * 4;
    return entry;
  });
  for (const { tag, data, offset: at } of placed) {
    directory.tag(tag).u32(checksum(data)).u32(at).u32(data.length);
  }
  const font = new Uint8Array(offset);
  font.set(directory.done(), 0);
  for (const { data, offset: at } of placed) font.set(data, at);
  // The whole font sums to 0xB1B0AFBA once the adjustment is in place.
  const head = placed.find((entry) => entry.tag === 'head')!;
  new DataView(font.buffer).setUint32(head.offset + 8, (0xb1b0afba - checksum(font)) >>> 0);
  return font;
}

export const GLYPHLESS_FONT_NAME = 'GlyphLessFont';

let cached: Uint8Array | null = null;

/**
 * The font program (FontFile2). It is named like Tesseract's, which tools
 * that redo OCR (such as OCRmyPDF) recognize as a text layer of earlier OCR.
 */
export function glyphlessFont(): Uint8Array {
  cached ??= buildFont(GLYPHLESS_FONT_NAME, ASCENT, DESCENT);
  return cached;
}
