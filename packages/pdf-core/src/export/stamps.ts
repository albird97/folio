import type { FontFamily, PageStamp } from '@folio/document-model';
import { PDFName, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import { num, rgb } from './appearance';
import type { StandardFontSet } from './fonts';

/**
 * A number for a `cm` operator. Matrices keep more digits than drawing
 * coordinates: their scale is multiplied into everything the text covers.
 */
function precise(value: number): string {
  const rounded = Math.round(value * 1e5) / 1e5;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * How assistive technology and tagged-PDF tools should treat a stamp: as a
 * pagination artifact, not part of the document's text (ISO 32000-1,
 * 14.8.2.2). Page numbers at the top are headers and at the bottom footers.
 */
function artifactSubtype(stamp: PageStamp): string | null {
  if (stamp.kind === 'watermark') return 'Watermark';
  if (stamp.position.startsWith('top')) return 'Header';
  if (stamp.position.startsWith('bottom')) return 'Footer';
  return null;
}

/**
 * Draws page numbers and watermarks into the pages' content, as text in the
 * standard fonts: new content added to the pages, never an edit of their own
 * text. Watermarks under the content go before it, everything else after it.
 */
export class StampWriter {
  readonly #doc: PDFDocument;
  readonly #fonts: StandardFontSet;
  /** Some text had characters the standard fonts cannot show; they became "?". */
  lossyText = false;

  constructor(doc: PDFDocument, fonts: StandardFontSet) {
    this.#doc = doc;
    this.#fonts = fonts;
  }

  /**
   * Adds the stamps laid out for `page`. `offset` moves them from page space
   * (origin at the lower-left corner of the visible page area) into user
   * space. The page's entries must be its own (see `isolatePageEntries`).
   */
  draw(page: PDFPage, stamps: readonly PageStamp[], offset: { dx: number; dy: number }): void {
    if (stamps.length === 0) return;
    const { context } = this.#doc;
    // Wraps the existing content in q/Q so its graphics state cannot leak into ours.
    page.node.normalize();
    const fonts = new Map<FontFamily, PDFName>();
    const draw = (layer: PageStamp['layer']) =>
      stamps
        .filter((stamp) => stamp.layer === layer)
        .flatMap((stamp) => this.#ops(page, stamp, offset, fonts));
    // A page's streams are read as one: each ends with a line break, so its
    // last operator cannot run into the first one of the next stream.
    const stream = (ops: string[]) => context.register(context.flateStream(`${ops.join('\n')}\n`));
    const under = draw('under');
    const over = draw('over');
    if (under.length > 0) {
      const ref = stream(under);
      const { Contents } = page.node.normalizedEntries();
      if (Contents) Contents.insert(0, ref);
      else page.node.set(PDFName.of('Contents'), context.obj([ref]));
    }
    if (over.length > 0) page.node.addContentStream(stream(over));
  }

  /** One stamp, as a marked-content sequence that restores the graphics state it changes. */
  #ops(
    page: PDFPage,
    stamp: PageStamp,
    { dx, dy }: { dx: number; dy: number },
    fonts: Map<FontFamily, PDFName>,
  ): string[] {
    const { context } = this.#doc;
    this.lossyText ||= stamp.lossy;
    let font = fonts.get(stamp.fontFamily);
    if (!font) {
      font = page.node.newFontDictionary('FolioStamp', this.#fonts.font(stamp.fontFamily).ref);
      fonts.set(stamp.fontFamily, font);
    }
    const { x, y, width, height } = stamp.bounds;
    const box = [x + dx, y + dy, x + dx + width, y + dy + height].map(num).join(' ');
    const subtype = artifactSubtype(stamp);
    const [a, b, c, d, e, f] = stamp.matrix;
    const ops = [
      `/Artifact <</Type /Pagination${subtype ? ` /Subtype /${subtype}` : ''} /BBox [${box}]>> BDC`,
      'q',
    ];
    if (stamp.opacity < 1) {
      const opacity = Math.max(0, stamp.opacity);
      const state = page.node.newExtGState(
        'FolioStamp',
        context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }),
      );
      ops.push(`${state.asString()} gs`);
    }
    ops.push(
      `${[a, b, c, d, e + dx, f + dy].map(precise).join(' ')} cm`,
      'BT',
      `${font.asString()} ${precise(stamp.fontSize)} Tf`,
      `${rgb(stamp.color).map(num).join(' ')} rg`,
      `<${this.#fonts.encode(stamp.text, stamp.fontFamily)}> Tj`,
      'ET',
      'Q',
      'EMC',
    );
    return ops;
  }
}
