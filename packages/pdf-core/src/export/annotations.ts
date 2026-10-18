import {
  lineEnds,
  normalizeRect,
  type Annotation,
  type AssetRef,
  type FontFamily,
} from '@folio/document-model';
import {
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type PDFRef,
} from '@cantoo/pdf-lib';
import { drawAnnotation, rgb, type Drawing, type EncodeText } from './appearance';

const STANDARD_FONTS: Record<FontFamily, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  serif: StandardFonts.TimesRoman,
  mono: StandardFonts.Courier,
};

const SUBTYPES: Record<Annotation['kind'], string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  note: 'Text',
  ink: 'Ink',
  shape: 'Square',
  'added-text': 'FreeText',
  'added-image': 'Stamp',
  signature: 'Stamp',
};

/** Print flag: annotations show up when the document is printed. */
const PRINT = 4;

export interface AssetData {
  ref: AssetRef;
  bytes: Uint8Array;
}

/**
 * Writes Folio annotations into a pdf-lib document, either as standard PDF
 * annotations with appearance streams (editable elsewhere) or flattened into
 * the page content.
 */
export class AnnotationWriter {
  readonly #doc: PDFDocument;
  readonly #assets: ReadonlyMap<string, AssetData>;
  readonly #fonts = new Map<FontFamily, PDFFont>();
  readonly #images = new Map<string, PDFImage>();
  lossyText = false;

  constructor(doc: PDFDocument, assets: ReadonlyMap<string, AssetData>) {
    this.#doc = doc;
    this.#assets = assets;
  }

  #font(family: FontFamily): PDFFont {
    let font = this.#fonts.get(family);
    if (!font) {
      font = this.#doc.embedStandardFont(STANDARD_FONTS[family]);
      this.#fonts.set(family, font);
    }
    return font;
  }

  readonly #encodeText: EncodeText = (text, family) =>
    this.#font(family).encodeText(text).toString().slice(1, -1);

  /** Embeds the images the annotations need (asynchronous in pdf-lib). */
  async prepare(annotations: readonly Annotation[]): Promise<void> {
    for (const annotation of annotations) {
      if (annotation.kind !== 'added-image' && annotation.kind !== 'signature') continue;
      if (this.#images.has(annotation.assetId)) continue;
      const asset = this.#assets.get(annotation.assetId);
      if (!asset) throw new Error(`Image ${annotation.assetId} is missing.`);
      const image =
        asset.ref.mimeType === 'image/png'
          ? await this.#doc.embedPng(asset.bytes)
          : await this.#doc.embedJpg(asset.bytes);
      this.#images.set(annotation.assetId, image);
    }
  }

  /** The annotation drawn as a form XObject. */
  #appearance(annotation: Annotation, offset: { dx: number; dy: number }) {
    const { context } = this.#doc;
    const drawing = drawAnnotation(annotation, this.#encodeText, offset);
    this.lossyText ||= drawing.lossyText;
    const bounds = nonEmpty(drawing);
    const resources = context.obj({});
    if (drawing.states.size > 0) {
      const states = context.obj({});
      for (const [name, state] of drawing.states) {
        states.set(
          PDFName.of(name),
          context.obj({
            Type: 'ExtGState',
            ca: state.opacity,
            CA: state.opacity,
            ...(state.multiply ? { BM: 'Multiply' } : {}),
          }),
        );
      }
      resources.set(PDFName.of('ExtGState'), states);
    }
    if (drawing.fonts.size > 0) {
      const fonts = context.obj({});
      for (const [name, family] of drawing.fonts) {
        fonts.set(PDFName.of(name), this.#font(family).ref);
      }
      resources.set(PDFName.of('Font'), fonts);
    }
    if (drawing.images.size > 0) {
      const images = context.obj({});
      for (const [name, assetId] of drawing.images) {
        const image = this.#images.get(assetId);
        if (!image) throw new Error(`Image ${assetId} was not prepared.`);
        images.set(PDFName.of(name), image.ref);
      }
      resources.set(PDFName.of('XObject'), images);
    }
    const stream = context.flateStream(drawing.ops.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height],
      Resources: resources,
    });
    return { ref: context.register(stream), bounds };
  }

  /** Adds the annotation to the page as a standard PDF annotation. */
  addEditable(
    page: PDFPage,
    annotation: Annotation,
    offset: { dx: number; dy: number },
    now: Date,
  ): PDFRef {
    const { context } = this.#doc;
    const { ref: appearance, bounds } = this.#appearance(annotation, offset);
    const { dx, dy } = offset;
    const subtype =
      annotation.kind === 'shape'
        ? annotation.shape === 'ellipse'
          ? 'Circle'
          : annotation.shape === 'rectangle'
            ? 'Square'
            : 'Line'
        : SUBTYPES[annotation.kind];
    const dict = context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height],
      P: page.ref,
      F: PRINT,
      C: rgb(annotation.color),
      CA: annotation.opacity,
      AP: { N: appearance },
    });
    // Folio's id lets a document saved by Folio be told apart and matched later.
    dict.set(PDFName.of('NM'), PDFString.of(annotation.id));
    dict.set(PDFName.of('M'), PDFString.fromDate(validDate(annotation.modifiedAt, now)));
    dict.set(PDFName.of('CreationDate'), PDFString.fromDate(validDate(annotation.createdAt, now)));
    if (annotation.author) dict.set(PDFName.of('T'), PDFHexString.fromText(annotation.author));

    switch (annotation.kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout': {
        const quads = annotation.rects.flatMap((raw) => {
          const rect = normalizeRect(raw);
          const left = rect.x + dx;
          const right = left + rect.width;
          const bottom = rect.y + dy;
          const top = bottom + rect.height;
          // Upper-left, upper-right, lower-left, lower-right, as Acrobat writes them.
          return [left, top, right, top, left, bottom, right, bottom];
        });
        dict.set(PDFName.of('QuadPoints'), context.obj(quads));
        break;
      }
      case 'note':
        dict.set(PDFName.of('Contents'), PDFHexString.fromText(annotation.contents));
        dict.set(PDFName.of('Name'), PDFName.of('Comment'));
        dict.set(PDFName.of('Open'), context.obj(false));
        break;
      case 'ink':
        dict.set(
          PDFName.of('InkList'),
          context.obj(
            annotation.paths.map((path) => path.flatMap((point) => [point.x + dx, point.y + dy])),
          ),
        );
        dict.set(PDFName.of('BS'), context.obj({ W: annotation.strokeWidth }));
        break;
      case 'shape': {
        dict.set(PDFName.of('BS'), context.obj({ W: annotation.strokeWidth }));
        if (annotation.shape === 'line' || annotation.shape === 'arrow') {
          const [from, to] = lineEnds(annotation.rect);
          dict.set(PDFName.of('L'), context.obj([from.x + dx, from.y + dy, to.x + dx, to.y + dy]));
          if (annotation.shape === 'arrow') {
            dict.set(PDFName.of('LE'), context.obj(['None', 'OpenArrow']));
          }
        } else if (annotation.fill) {
          dict.set(PDFName.of('IC'), context.obj(rgb(annotation.fill)));
        }
        break;
      }
      case 'added-text': {
        dict.set(PDFName.of('Contents'), PDFHexString.fromText(annotation.text));
        if (annotation.rotation !== 0)
          dict.set(PDFName.of('Rotate'), context.obj(annotation.rotation));
        const font = { sans: 'Helv', serif: 'TiRo', mono: 'Cour' }[annotation.fontFamily];
        const [r, g, b] = rgb(annotation.color);
        dict.set(
          PDFName.of('DA'),
          PDFString.of(`/${font} ${annotation.fontSize} Tf ${r} ${g} ${b} rg`),
        );
        break;
      }
      case 'added-image':
      case 'signature':
        if (annotation.rotation !== 0)
          dict.set(PDFName.of('Rotate'), context.obj(annotation.rotation));
        dict.set(
          PDFName.of('Name'),
          PDFName.of(annotation.kind === 'signature' ? 'FolioSignature' : 'FolioImage'),
        );
        break;
    }
    const ref = context.register(dict);
    page.node.addAnnot(ref);
    return ref;
  }

  /** Draws the annotations into the page content; they can no longer be edited as annotations. */
  flatten(page: PDFPage, annotations: readonly Annotation[], offset: { dx: number; dy: number }) {
    if (annotations.length === 0) return;
    const { context } = this.#doc;
    // Wraps the existing content in q/Q so its graphics state cannot leak into ours.
    page.node.normalize();
    const ops: string[] = [];
    for (const annotation of annotations) {
      const { ref } = this.#appearance(annotation, offset);
      const name = page.node.newXObject('FolioAnnot', ref);
      ops.push(`q ${name.asString()} Do Q`);
    }
    page.node.addContentStream(context.register(context.flateStream(ops.join('\n'))));
  }
}

function nonEmpty(drawing: Drawing) {
  const { bounds } = drawing;
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  };
}

function validDate(value: string, fallback: Date): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}
