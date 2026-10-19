import {
  layoutRecognizedText,
  sourcePageKey,
  type PageModel,
  type RecognizedTextData,
} from '@folio/document-model';
import type { PageText, PageTextItem, PdfDocumentHandle } from '@folio/pdf-core';
import type { WorkspaceStore } from '../store/workspace';

const itemsByData = new WeakMap<RecognizedTextData, readonly PageTextItem[]>();

/**
 * Recognized text as text runs in page space, as the text layer draws them:
 * one per word and per space between words, in reading order, each line
 * ending with its last word. The same data always gives the same array.
 */
export function recognizedTextItems(data: RecognizedTextData): readonly PageTextItem[] {
  let items = itemsByData.get(data);
  if (!items) {
    items = layoutRecognizedText(data).map((run) => {
      const [a, b, c, d, e, f] = run.matrix;
      const size = run.fontSize;
      return {
        str: run.text,
        hasEOL: run.lineEnd,
        // Text space is scaled by the font size, as in PDF.js' text content.
        transform: [a * size, b * size, c * size, d * size, e, f],
        width: run.width,
        height: size,
      };
    });
    itemsByData.set(data, items);
  }
  return items;
}

/**
 * The text of a page as Folio shows, searches and copies it: the PDF's own
 * text runs, then the recognized ones (recognized words repeating the PDF's
 * text were left out when they were read). Positions are in user space, like
 * `getPageText`; the runs line up with the text layer's elements.
 */
export async function pageTextWithRecognized(
  handle: PdfDocumentHandle,
  pageIndex: number,
  recognized: RecognizedTextData | null,
): Promise<PageText> {
  const own = await handle.getPageText(pageIndex);
  const extra = recognized ? recognizedTextItems(recognized) : [];
  if (extra.length === 0) return own;
  const { origin } = await handle.getViewport(pageIndex, { scale: 1 });
  const last = own.items.length - 1;
  return {
    items: [
      // The recognized text starts on a line of its own.
      ...own.items.map((item, index) => (index === last ? { ...item, hasEOL: true } : item)),
      ...extra.map((item) => {
        const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
        return { ...item, transform: [a, b, c, d, e + origin.x, f + origin.y] };
      }),
    ],
  };
}

/**
 * The text of a document page, recognized or not: what search finds and the
 * text layer shows. For tools that work with a document's text (exporting
 * it, answering questions about it); turn it into plain text with
 * `pageTextToString`. Blank pages have none.
 */
export async function documentPageText(
  workspace: WorkspaceStore,
  key: string,
  page: PageModel,
): Promise<PageText> {
  if (page.source.kind !== 'source') return { items: [] };
  const { sourceId, pageIndex } = page.source;
  const handle = workspace.getSourceHandle(key, sourceId);
  if (!handle) return { items: [] };
  const model = workspace.getState().documents.find((doc) => doc.key === key)?.editor?.model;
  const layer = model?.textLayers[sourcePageKey(sourceId, pageIndex)];
  return pageTextWithRecognized(
    handle,
    pageIndex,
    layer ? workspace.getRecognizedText(key, layer.assetId) : null,
  );
}
