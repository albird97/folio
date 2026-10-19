import type { FontFamily } from '@folio/document-model';
import { StandardFonts, type PDFDocument, type PDFFont } from '@cantoo/pdf-lib';
import type { EncodeText } from './appearance';

const STANDARD_FONTS: Record<FontFamily, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  serif: StandardFonts.TimesRoman,
  mono: StandardFonts.Courier,
};

/**
 * The standard fonts Folio writes text in, each embedded in a document once
 * however many annotations, stamps and pages use it.
 */
export class StandardFontSet {
  readonly #doc: PDFDocument;
  readonly #fonts = new Map<FontFamily, PDFFont>();

  constructor(doc: PDFDocument) {
    this.#doc = doc;
  }

  font(family: FontFamily): PDFFont {
    let font = this.#fonts.get(family);
    if (!font) {
      font = this.#doc.embedStandardFont(STANDARD_FONTS[family]);
      this.#fonts.set(family, font);
    }
    return font;
  }

  readonly encode: EncodeText = (text, family) =>
    this.font(family).encodeText(text).toString().slice(1, -1);
}
