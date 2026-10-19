import { sourcePageKey, type DocumentModel, type PageModel } from '@folio/document-model';

/** Which pages to recognize text on. */
export type RecognitionScope = 'without-text' | 'current' | 'range' | 'all';

/**
 * The pages to read for a choice in the dialog, in document order. Blank
 * pages have nothing to read, and copies of a page share its text, so each
 * source page is read once (shown as its first copy is). Pages with text of
 * their own are left out unless asked for; "pages without text" also leaves
 * out pages whose text was recognized before.
 *
 * `hasOwnText` says whether a source page (by `sourcePageKey`) has text of
 * its own; undefined while that is not known yet.
 */
export function pagesToRecognize(
  model: DocumentModel,
  choice: {
    scope: RecognitionScope;
    /** Positions for "current" and "range". */
    positions: readonly number[];
    includePagesWithText: boolean;
  },
  hasOwnText: (key: string) => boolean | undefined,
): { pages: PageModel[]; unknown: boolean } {
  const inScope =
    choice.scope === 'current' || choice.scope === 'range'
      ? [...new Set(choice.positions)]
          .sort((a, b) => a - b)
          .map((position) => model.pages[position])
          .filter((page) => page !== undefined)
      : model.pages;
  const seen = new Set<string>();
  const pages: PageModel[] = [];
  let unknown = false;
  for (const page of inScope) {
    if (page.source.kind !== 'source') continue;
    const key = sourcePageKey(page.source.sourceId, page.source.pageIndex);
    if (seen.has(key)) continue;
    seen.add(key);
    if (choice.scope === 'without-text' && model.textLayers[key]) continue;
    if (choice.scope === 'without-text' || !choice.includePagesWithText) {
      const own = hasOwnText(key);
      if (own === undefined) unknown = true;
      if (own !== false) continue;
    }
    pages.push(page);
  }
  return { pages, unknown };
}
