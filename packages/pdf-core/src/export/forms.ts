import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRef,
  PDFStream,
  PDFTextField,
  StandardFonts,
  type PDFContext,
  type PDFDocument,
  type PDFField,
  type PDFFont,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { num } from './appearance';
import { isolatePageEntries } from './objects';

/** Annotation flags (PDF 32000-1, 12.5.3) of widgets that are not shown. */
const HIDDEN = 1 << 1;
const NO_VIEW = 1 << 5;

const name = (key: string) => PDFName.of(key);

function numbers(context: PDFContext, value: PDFObject | undefined, count: number) {
  const array = context.lookup(value);
  if (!(array instanceof PDFArray) || array.size() !== count) return null;
  const out = array.asArray().map((item) => {
    const number = context.lookup(item);
    return number instanceof PDFNumber ? number.asNumber() : Number.NaN;
  });
  return out.every(Number.isFinite) ? out : null;
}

function isWidget(context: PDFContext, entry: PDFObject): entry is PDFRef | PDFDict {
  const dict = context.lookup(entry);
  return dict instanceof PDFDict && dict.get(name('Subtype')) === name('Widget');
}

/** The stream a widget shows: its normal appearance, in its current state for buttons. */
function normalAppearance(context: PDFContext, widget: PDFDict): PDFRef | null {
  const appearances = context.lookup(widget.get(name('AP')));
  if (!(appearances instanceof PDFDict)) return null;
  let normal = appearances.get(name('N'));
  const states = context.lookup(normal);
  if (states instanceof PDFDict) {
    const state = widget.get(name('AS'));
    normal = state instanceof PDFName ? states.get(state) : undefined;
  }
  return normal instanceof PDFRef && context.lookup(normal) instanceof PDFStream ? normal : null;
}

/**
 * Where an appearance is drawn on the page (PDF 32000-1, 12.5.5): its
 * bounding box, transformed by its matrix, is fitted onto the widget's
 * rectangle. Null when either is empty.
 */
function placement(rect: number[], box: number[], matrix: number[]): number[] | null {
  const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number];
  const [bx0, by0, bx1, by1] = box as [number, number, number, number];
  const corners = [
    [bx0, by0],
    [bx1, by0],
    [bx0, by1],
    [bx1, by1],
  ].map(([x, y]) => [a * x! + c * y! + e, b * x! + d * y! + f] as const);
  const x0 = Math.min(...corners.map(([x]) => x));
  const x1 = Math.max(...corners.map(([x]) => x));
  const y0 = Math.min(...corners.map(([, y]) => y));
  const y1 = Math.max(...corners.map(([, y]) => y));
  const [rx0, ry0, rx1, ry1] = [
    Math.min(rect[0]!, rect[2]!),
    Math.min(rect[1]!, rect[3]!),
    Math.max(rect[0]!, rect[2]!),
    Math.max(rect[1]!, rect[3]!),
  ];
  if (x1 - x0 <= 0 || y1 - y0 <= 0 || rx1 - rx0 <= 0 || ry1 - ry0 <= 0) return null;
  const sx = (rx1 - rx0) / (x1 - x0);
  const sy = (ry1 - ry0) / (y1 - y0);
  return [sx, 0, 0, sy, rx0 - x0 * sx, ry0 - y0 * sy];
}

/** A name for the optional content group `group` in the page's resources (its own copy). */
function propertiesName(page: PDFPage, group: PDFRef): PDFName {
  const { context } = page.doc;
  const resources = page.node.Resources()!;
  const shared = context.lookup(resources.get(name('Properties')));
  const properties = shared instanceof PDFDict ? shared.clone(context) : context.obj({});
  resources.set(name('Properties'), properties);
  for (const [key, value] of properties.entries()) {
    if (value instanceof PDFRef && value.tag === group.tag) return key;
  }
  const key = properties.uniqueKey('FlatOC');
  properties.set(key, group);
  return key;
}

/** Text a field draws: its value, or the options of a list. */
function drawnText(field: PDFField): string[] {
  if (field instanceof PDFTextField) return [field.getText() ?? ''];
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getOptions();
  return [];
}

/**
 * Draws the fields of a form that leaves drawing them to the reader
 * (NeedAppearances), as readers do. A copy without the form (flattened,
 * or pages copied out, as printing does) shows only what appearances draw.
 * Best effort, in a standard font: characters it cannot show are drawn as
 * "?" (returns true when that happened), and a field that cannot be drawn
 * stays as it is.
 */
export function drawMissingAppearances(doc: PDFDocument): boolean {
  const { context } = doc;
  const acroForm = context.lookup(doc.catalog.get(name('AcroForm')));
  // pdf-lib's form API would remove an XFA part, so such forms are left alone.
  if (!(acroForm instanceof PDFDict) || acroForm.get(name('XFA')) !== undefined) return false;
  const needed = context.lookup(acroForm.get(name('NeedAppearances')));
  if (!(needed instanceof PDFBool) || !needed.asBoolean()) return false;
  let fields: PDFField[];
  try {
    fields = doc.getForm().getFields();
  } catch {
    return false;
  }
  let font: PDFFont | null = null;
  let characters: ReadonlySet<number> = new Set();
  let lossy = false;
  for (const field of fields) {
    try {
      if (!field.needsAppearancesUpdate()) continue;
      if (!font) {
        font = doc.embedStandardFont(StandardFonts.Helvetica);
        characters = new Set(font.getCharacterSet());
      }
      field.defaultUpdateAppearances(font);
      lossy ||= drawnText(field).some((text) =>
        Array.from(text.replace(/[\r\n\t]/g, '')).some(
          (char) => !characters.has(char.codePointAt(0)!),
        ),
      );
    } catch {
      // Left to readers that draw fields themselves, as before.
    }
  }
  return lossy;
}

/**
 * Burns the form into the pages: every shown widget's appearance is drawn
 * into its page's content, where it stays as printed matter, and the
 * widgets and the document's form (with any XFA) are removed. It works
 * page by page, so copies of a page (whose widgets belong to the same
 * field) and pages from other files are flattened too. Hidden widgets, and
 * those not meant for the screen (NoView), disappear without being drawn;
 * widgets on an optional content layer stay on it.
 */
export function flattenFormFields(doc: PDFDocument, pages: readonly PDFPage[]): void {
  const { context } = doc;
  for (const page of pages) {
    const annots = context.lookup(page.node.get(name('Annots')));
    if (
      !(annots instanceof PDFArray) ||
      !annots.asArray().some((entry) => isWidget(context, entry))
    ) {
      continue;
    }
    // The page's own content list, resources and annotation list (copies share them).
    isolatePageEntries(page);
    // Wraps the existing content in q/Q so its graphics state cannot leak into the fields.
    page.node.normalize();
    const ops: string[] = [];
    const kept: PDFObject[] = [];
    for (const entry of page.node.Annots()!.asArray()) {
      if (!isWidget(context, entry)) {
        kept.push(entry);
        continue;
      }
      const widget = context.lookup(entry) as PDFDict;
      const flags = context.lookup(widget.get(name('F')));
      if (flags instanceof PDFNumber && flags.asNumber() & (HIDDEN | NO_VIEW)) continue;
      const appearance = normalAppearance(context, widget);
      const stream = appearance ? (context.lookup(appearance) as PDFStream) : null;
      const rect = numbers(context, widget.get(name('Rect')), 4);
      const box = stream ? numbers(context, stream.dict.get(name('BBox')), 4) : null;
      const matrix = (stream && numbers(context, stream.dict.get(name('Matrix')), 6)) ?? [
        1, 0, 0, 1, 0, 0,
      ];
      const transform = rect && box ? placement(rect, box, matrix) : null;
      if (!appearance || !stream || !transform) continue;
      // Appearance streams are form XObjects; some writers leave out the subtype.
      stream.dict.set(name('Subtype'), name('Form'));
      const xObject = page.node.newXObject('FlatField', appearance);
      const draw = `q ${transform.map(num).join(' ')} cm ${xObject.asString()} Do Q`;
      const group = widget.get(name('OC'));
      ops.push(
        group instanceof PDFRef
          ? `/OC ${propertiesName(page, group).asString()} BDC ${draw} EMC`
          : draw,
      );
    }
    if (ops.length > 0) {
      page.node.addContentStream(context.register(context.flateStream(ops.join('\n'))));
    }
    if (kept.length > 0) page.node.set(name('Annots'), context.obj(kept));
    else page.node.delete(name('Annots'));
  }
  // The fields are gone from every page, so the form goes too; XFA would
  // otherwise bring it back in readers that render XFA.
  doc.catalog.delete(name('AcroForm'));
  doc.catalog.delete(name('NeedsRendering'));
}
