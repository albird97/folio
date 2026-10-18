import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFPage,
  PDFPageLeaf,
  PDFPageTree,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from '@cantoo/pdf-lib';

const INHERITABLE = ['MediaBox', 'CropBox', 'Rotate', 'Resources'] as const;

/** Entries of a page that tie it to its place in the document it came from. */
const NOT_COPIED = ['Parent', 'StructParents', 'B'] as const;

const name = (key: string) => PDFName.of(key);

/** Copies attributes a page inherits from its page-tree ancestors into the page itself. */
export function pushDownInheritedAttributes(node: PDFPageLeaf, from: PDFPageLeaf = node): void {
  for (const key of INHERITABLE) {
    if (node.get(name(key)) !== undefined) continue;
    const value = from.getInheritableAttribute(name(key));
    if (value !== undefined) node.set(name(key), value);
  }
}

/**
 * Replaces the document's page tree with a flat one listing `pages` in order.
 * Pages may come from anywhere in this document (moved, duplicated, copied in
 * or newly created); pages left out are no longer part of the document.
 */
export function replacePageTree(doc: PDFDocument, pages: readonly PDFPage[]): void {
  const { context } = doc;
  const tree = PDFPageTree.withContext(context);
  const treeRef = context.register(tree);
  for (const page of pages) {
    pushDownInheritedAttributes(page.node);
    tree.pushLeafNode(page.ref);
    page.node.setParent(treeRef);
  }
  doc.catalog.set(name('Pages'), treeRef);
  // pdf-lib caches its page list; the tree changed underneath it.
  const internals = doc as unknown as {
    pageCache: { invalidate(): void };
    pageCount: number | undefined;
  };
  internals.pageCache.invalidate();
  internals.pageCount = pages.length;
}

function isPageDict(value: PDFObject | undefined): value is PDFDict {
  return (
    value instanceof PDFDict &&
    !(value instanceof PDFPageTree) &&
    (value instanceof PDFPageLeaf || value.get(name('Type')) === name('Page'))
  );
}

function annotationRefs(context: PDFContext, page: PDFDict): PDFRef[] {
  const annots = context.lookup(page.get(name('Annots')));
  if (!(annots instanceof PDFArray)) return [];
  return annots.asArray().filter((item): item is PDFRef => item instanceof PDFRef);
}

/**
 * Copies pages into a document, like pdf-lib's `copyPages` but without
 * following references to other pages: links, bookmarks and annotations that
 * point at pages outside the copy get null instead of dragging the source's
 * whole page tree (and every page's content) into memory and the file. Links
 * between pages copied together keep working.
 *
 * Within one document (duplicating pages), what copies can share (content
 * streams, fonts, images) is shared; only what belongs to a single page (the
 * page dictionary, its content list and its annotations) is cloned.
 */
export class PageCopier {
  readonly #src: PDFDocument;
  readonly #dest: PDFDocument;
  /** Source object → its copy, so shared objects are copied once. */
  readonly #copies = new Map<string, PDFRef>();
  /** Source page → its first copy in this batch. */
  readonly #pageCopies = new Map<string, PDFRef>();
  /** Annotations of every source page, to tell which ones stay behind. */
  #annotationPages: Set<string> | null = null;

  constructor(src: PDFDocument, dest: PDFDocument) {
    this.#src = src;
    this.#dest = dest;
  }

  /** Copies the source pages at `indices` (repeats allowed), in that order. */
  copyPages(indices: readonly number[]): PDFPage[] {
    const sources = this.#src.getPages();
    const same = this.#src === this.#dest;
    const planned = indices.map((index) => {
      const source = sources[index];
      if (!source) throw new RangeError(`The source has no page ${index + 1}.`);
      const ref = this.#dest.context.nextRef();
      const first = !this.#pageCopies.has(source.ref.tag);
      if (first) this.#pageCopies.set(source.ref.tag, ref);
      return { source, ref, first };
    });
    if (!same) {
      // Annotations of the first copy of each page stand in for the source's
      // annotations wherever something else refers to them (form fields).
      for (const { source, first } of planned) {
        if (!first) continue;
        for (const annot of annotationRefs(this.#src.context, source.node)) {
          if (!this.#copies.has(annot.tag)) {
            this.#copies.set(annot.tag, this.#dest.context.nextRef());
          }
        }
      }
    }
    return planned.map(({ source, ref, first }) => {
      const node = same
        ? this.#duplicate(source.node, ref)
        : this.#copyPage(source.node, ref, first);
      this.#dest.context.assign(ref, node);
      return PDFPage.of(node, ref, this.#dest);
    });
  }

  /** A second page in the same document showing the same content. */
  #duplicate(source: PDFPageLeaf, ref: PDFRef): PDFPageLeaf {
    const { context } = this.#dest;
    const node = source.clone(context);
    pushDownInheritedAttributes(node, source);
    for (const key of NOT_COPIED) node.delete(name(key));
    const contents = context.lookup(node.get(name('Contents')));
    if (contents instanceof PDFArray) node.set(name('Contents'), context.obj(contents.asArray()));
    const annots = annotationRefs(context, source);
    if (annots.length > 0) {
      const local = new Map(annots.map((annot) => [annot.tag, context.nextRef()]));
      for (const annot of annots) {
        const dict = context.lookup(annot);
        if (!(dict instanceof PDFDict)) continue;
        const copy = dict.clone(context);
        copy.set(name('P'), ref);
        // Popups, their parents and replies point at annotations of this copy.
        for (const key of ['Popup', 'Parent', 'IRT']) {
          const target = copy.get(name(key));
          const mapped = target instanceof PDFRef ? local.get(target.tag) : undefined;
          if (mapped) copy.set(name(key), mapped);
        }
        context.assign(local.get(annot.tag)!, copy);
      }
      node.set(name('Annots'), context.obj([...local.values()]));
    } else {
      node.delete(name('Annots'));
    }
    return node;
  }

  /** A copy of a page from another document. */
  #copyPage(source: PDFPageLeaf, ref: PDFRef, first: boolean): PDFPageLeaf {
    const { context } = this.#dest;
    const node = PDFPageLeaf.fromMapWithContext(new Map(), context);
    const annots = annotationRefs(this.#src.context, source);
    // Later copies of the same page get annotations of their own.
    const local = first
      ? new Map<string, PDFRef>()
      : new Map(annots.map((annot) => [annot.tag, context.nextRef()]));
    for (const [key, value] of source.entries()) {
      if ((NOT_COPIED as readonly string[]).includes(key.decodeText()) || key === name('Annots')) {
        continue;
      }
      node.set(key, this.#copy(value, local));
    }
    for (const key of INHERITABLE) {
      if (node.get(name(key)) !== undefined) continue;
      const value = source.getInheritableAttribute(name(key));
      if (value !== undefined) node.set(name(key), this.#copy(value, local));
    }
    if (annots.length > 0) {
      const copies: PDFRef[] = [];
      for (const annot of annots) {
        const target = local.get(annot.tag) ?? this.#copies.get(annot.tag)!;
        const dict = this.#src.context.lookup(annot);
        if (!(dict instanceof PDFDict)) continue;
        const copy = this.#copy(dict, local) as PDFDict;
        copy.set(name('P'), ref);
        context.assign(target, copy);
        copies.push(target);
      }
      node.set(name('Annots'), context.obj(copies));
    }
    return node;
  }

  #isSourceAnnotation(tag: string): boolean {
    if (!this.#annotationPages) {
      this.#annotationPages = new Set();
      for (const page of this.#src.getPages()) {
        for (const annot of annotationRefs(this.#src.context, page.node)) {
          this.#annotationPages.add(annot.tag);
        }
      }
    }
    return this.#annotationPages.has(tag);
  }

  #copy(value: PDFObject, local: ReadonlyMap<string, PDFRef>): PDFObject {
    const { context } = this.#dest;
    if (value instanceof PDFRef) {
      const mapped =
        local.get(value.tag) ?? this.#copies.get(value.tag) ?? this.#pageCopies.get(value.tag);
      if (mapped) return mapped;
      const target = this.#src.context.lookup(value);
      // Pages left behind, and their annotations, are not copied.
      if (isPageDict(target) || this.#isSourceAnnotation(value.tag)) return PDFNull;
      const ref = context.nextRef();
      this.#copies.set(value.tag, ref);
      if (target !== undefined) context.assign(ref, this.#copy(target, local));
      return ref;
    }
    if (value instanceof PDFStream) {
      const dict = this.#copy(value.dict, local) as PDFDict;
      return PDFRawStream.of(dict, value.getContents());
    }
    if (value instanceof PDFDict) {
      const dict = context.obj({});
      for (const [key, entry] of value.entries()) dict.set(key, this.#copy(entry, local));
      return dict;
    }
    if (value instanceof PDFArray) {
      return context.obj(value.asArray().map((entry) => this.#copy(entry, local)));
    }
    // Names, numbers, strings, booleans and null are immutable.
    return value;
  }
}

/**
 * Gives a page its own content list, resources and annotation list, so that
 * content or annotations added to it cannot show up on pages it shared them
 * with (duplicates, or pages sharing one resource dictionary).
 */
export function isolatePageEntries(page: PDFPage): void {
  const { node } = page;
  const { context } = page.doc;
  const contents = context.lookup(node.get(name('Contents')));
  if (contents instanceof PDFArray) node.set(name('Contents'), context.obj(contents.asArray()));
  const resources = context.lookup(node.get(name('Resources')));
  if (resources instanceof PDFDict) {
    const own = resources.clone(context);
    for (const key of ['XObject', 'ExtGState', 'Font']) {
      const entry = context.lookup(own.get(name(key)));
      if (entry instanceof PDFDict) own.set(name(key), entry.clone(context));
    }
    node.set(name('Resources'), own);
  }
  const annots = context.lookup(node.get(name('Annots')));
  if (annots instanceof PDFArray) node.set(name('Annots'), context.obj(annots.asArray()));
}

function numbers(context: PDFContext, value: PDFObject | undefined): number[] | null {
  const array = context.lookup(value);
  if (!(array instanceof PDFArray) || array.size() !== 4) return null;
  const out = array.asArray().map((item) => {
    const number = context.lookup(item);
    return number instanceof PDFNumber ? number.asNumber() : Number.NaN;
  });
  return out.every(Number.isFinite) ? out : null;
}

function normalizeBox([x0, y0, x1, y1]: number[]): [number, number, number, number] {
  return [Math.min(x0!, x1!), Math.min(y0!, y1!), Math.max(x0!, x1!), Math.max(y0!, y1!)];
}

/**
 * Lower-left corner of the visible page area: the crop box clipped to the
 * media box, worked out the way PDF.js (and so Folio's page sizes) does.
 */
export function pageOrigin(page: PDFPage): { x: number; y: number } {
  const { node } = page;
  const { context } = page.doc;
  const mediaBox = numbers(context, node.getInheritableAttribute(name('MediaBox')));
  const media =
    mediaBox && mediaBox[2] !== mediaBox[0] && mediaBox[3] !== mediaBox[1]
      ? normalizeBox(mediaBox)
      : ([0, 0, 612, 792] as const);
  const cropBox = numbers(context, node.getInheritableAttribute(name('CropBox')));
  if (cropBox) {
    const crop = normalizeBox(cropBox);
    const x0 = Math.max(crop[0], media[0]);
    const y0 = Math.max(crop[1], media[1]);
    const x1 = Math.min(crop[2], media[2]);
    const y1 = Math.min(crop[3], media[3]);
    if (x1 > x0 && y1 > y0) return { x: x0, y: y0 };
  }
  return { x: media[0], y: media[1] };
}

/** Arrays under these keys are lists, from which removed entries are dropped. */
const LIST_KEYS = new Set(['Kids', 'Fields', 'Annots']);

/**
 * Removes every reference to a page that is not in the page tree, and to the
 * annotations of such pages: links, bookmarks, structure elements and form
 * fields pointing at deleted pages. Form fields left without widgets are
 * removed, so a deleted page's form values are not kept either. Without
 * this, removed pages and their content would stay in the file, unseen.
 */
export function pruneRemovedPages(doc: PDFDocument, kept: readonly PDFPage[]): void {
  const { context } = doc;
  const keptPages = new Set(kept.map((page) => page.ref.tag));
  const keptAnnots = new Set(
    kept.flatMap((page) => annotationRefs(context, page.node).map((ref) => ref.tag)),
  );
  const removed = new Set<string>();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (keptPages.has(ref.tag) || !isPageDict(object)) continue;
    removed.add(ref.tag);
    for (const annot of annotationRefs(context, object)) {
      if (!keptAnnots.has(annot.tag)) removed.add(annot.tag);
    }
  }
  if (removed.size === 0) return;

  const isRemoved = (value: PDFObject | undefined) =>
    value instanceof PDFRef && removed.has(value.tag);
  const lists = new Set<PDFArray>();
  const visit = (value: PDFObject) => {
    if (value instanceof PDFDict) {
      for (const [key, entry] of value.entries()) {
        if (isRemoved(entry)) value.set(key, PDFNull);
      }
    } else if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index += 1) {
        if (isRemoved(value.get(index))) value.set(index, PDFNull);
      }
    }
  };
  // Lists are found first, so their entries are dropped rather than nulled.
  const findLists = (value: PDFObject) => {
    if (!(value instanceof PDFDict)) return;
    for (const [key, entry] of value.entries()) {
      if (!LIST_KEYS.has(key.decodeText())) continue;
      const list = context.lookup(entry);
      if (list instanceof PDFArray) lists.add(list);
    }
  };
  const roots: PDFObject[] = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!removed.has(ref.tag)) roots.push(object);
  }
  for (const root of roots) walkDirect(root, findLists);
  for (const list of lists) {
    for (let index = list.size() - 1; index >= 0; index -= 1) {
      if (isRemoved(list.get(index))) list.remove(index);
    }
  }
  for (const root of roots) walkDirect(root, visit);
  removeEmptyFields(doc);
}

/** Drops form fields whose widgets were all removed (with the values they held). */
function removeEmptyFields(doc: PDFDocument): void {
  const { context } = doc;
  const acroForm = context.lookup(doc.catalog.get(name('AcroForm')));
  if (!(acroForm instanceof PDFDict)) return;
  const fields = context.lookup(acroForm.get(name('Fields')));
  if (!(fields instanceof PDFArray)) return;
  const visited = new Set<PDFObject>();
  const prune = (list: PDFArray, depth: number) => {
    for (let index = list.size() - 1; index >= 0; index -= 1) {
      const field = context.lookup(list.get(index));
      if (field === undefined || field === PDFNull) {
        list.remove(index);
        continue;
      }
      if (!(field instanceof PDFDict) || visited.has(field) || depth > 32) continue;
      visited.add(field);
      const kids = context.lookup(field.get(name('Kids')));
      if (!(kids instanceof PDFArray)) continue;
      prune(kids, depth + 1);
      if (kids.size() === 0 && field.get(name('Subtype')) !== name('Widget')) list.remove(index);
    }
  };
  prune(fields, 0);
}

/** Visits an object and every direct dictionary or array nested in it. */
function walkDirect(object: PDFObject, visit: (value: PDFObject) => void): void {
  const stack: PDFObject[] = [object instanceof PDFStream ? object.dict : object];
  while (stack.length > 0) {
    const value = stack.pop()!;
    visit(value);
    if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) {
        if (entry instanceof PDFDict || entry instanceof PDFArray) stack.push(entry);
      }
    } else if (value instanceof PDFArray) {
      for (const entry of value.asArray()) {
        if (entry instanceof PDFDict || entry instanceof PDFArray) stack.push(entry);
      }
    }
  }
}

/**
 * Page labels number pages by position, so they only stay right while the
 * original pages keep their positions (pages may be added after them).
 */
export function keepPageLabelsIfValid(
  doc: PDFDocument,
  originalPageTags: readonly string[],
  pages: readonly PDFPage[],
): void {
  const unchanged = originalPageTags.every((tag, index) => pages[index]?.ref.tag === tag);
  if (!unchanged) doc.catalog.delete(name('PageLabels'));
}

/**
 * Deletes every object that cannot be reached from the trailer, so content of
 * removed pages (and anything else no longer used) is not written. Objects
 * pdf-lib creates while saving (embedded fonts) are not affected.
 */
export function collectGarbage(context: PDFContext): number {
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const { Root, Info, ID } = context.trailerInfo;
  for (const root of [Root, Info, ID]) if (root) stack.push(root);
  while (stack.length > 0) {
    const value = stack.pop()!;
    if (value instanceof PDFRef) {
      if (reachable.has(value.tag)) continue;
      reachable.add(value.tag);
      const target = context.lookup(value);
      if (target) stack.push(target);
    } else if (value instanceof PDFStream) {
      stack.push(value.dict);
    } else if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) stack.push(entry);
    } else if (value instanceof PDFArray) {
      for (const entry of value.asArray()) stack.push(entry);
    }
  }
  let deleted = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) {
      context.delete(ref);
      deleted += 1;
    }
  }
  return deleted;
}
