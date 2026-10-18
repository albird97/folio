import type { PageTextItem } from '@folio/pdf-core';
import { findInPage, MAX_MATCHES, type SearchOptions, type TextMatch } from './match';

export type SearchableRun = Pick<PageTextItem, 'str' | 'hasEOL'>;

export interface SearchSource {
  pageCount: number;
  getPageText(pageIndex: number): Promise<{ items: readonly SearchableRun[] }>;
}

export interface SearchProgress {
  matches: TextMatch[];
  pagesSearched: number;
  done: boolean;
  /** True when MAX_MATCHES was reached before the end of the document. */
  truncated: boolean;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Searches page by page (text is extracted in the PDF.js worker), reporting
 * progress after each batch so results appear while long documents are
 * still being searched. Stops when `signal` aborts.
 */
export async function searchDocument(
  source: SearchSource,
  query: string,
  options: SearchOptions,
  onProgress: (progress: SearchProgress) => void,
  signal: AbortSignal,
  batchSize = 8,
): Promise<SearchProgress | null> {
  const matches: TextMatch[] = [];
  let pagesSearched = 0;
  for (let start = 0; start < source.pageCount; start += batchSize) {
    if (signal.aborted) return null;
    const end = Math.min(source.pageCount, start + batchSize);
    const texts = await Promise.all(
      Array.from({ length: end - start }, (_, offset) =>
        source.getPageText(start + offset).catch(() => ({ items: [] as SearchableRun[] })),
      ),
    );
    if (signal.aborted) return null;
    for (const [offset, text] of texts.entries()) {
      matches.push(
        ...findInPage(start + offset, text.items, query, options, MAX_MATCHES - matches.length),
      );
      pagesSearched += 1;
      if (matches.length >= MAX_MATCHES) {
        const progress = { matches: [...matches], pagesSearched, done: true, truncated: true };
        onProgress(progress);
        return progress;
      }
    }
    onProgress({ matches: [...matches], pagesSearched, done: false, truncated: false });
    await yieldToUi();
  }
  const finished = { matches, pagesSearched, done: true, truncated: false };
  if (!signal.aborted) onProgress(finished);
  return signal.aborted ? null : finished;
}

/** The match to show first: the first one on or after the current page. */
export function firstMatchFrom(matches: readonly TextMatch[], pageIndex: number): number {
  const index = matches.findIndex((match) => match.pageIndex >= pageIndex);
  return index === -1 ? (matches.length > 0 ? 0 : -1) : index;
}
