import type { PageTextItem } from '@folio/pdf-core';
import { displayText, foldPageText, foldQuery } from './text-index';

export interface SearchOptions {
  matchCase: boolean;
  wholeWords: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { matchCase: false, wholeWords: false };

/** A position inside the text runs of one page. */
export interface TextPosition {
  item: number;
  offset: number;
}

export interface TextMatch {
  pageIndex: number;
  /** Inclusive start and exclusive end, in text-run coordinates. */
  start: TextPosition;
  end: TextPosition;
  excerpt: { before: string; match: string; after: string };
}

/** Results are capped so a one-letter query in a huge file stays responsive. */
export const MAX_MATCHES = 10_000;
const EXCERPT_CONTEXT = 36;
const WORD = /[\p{L}\p{N}_]/u;

function isBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  return !(WORD.test(text[index - 1]!) && WORD.test(text[index]!));
}

function excerpt(
  items: readonly Pick<PageTextItem, 'str' | 'hasEOL'>[],
  start: TextPosition,
  end: TextPosition,
): TextMatch['excerpt'] {
  const { text, runStart } = displayText(items);
  const from = (runStart[start.item] ?? 0) + start.offset;
  const to = (runStart[end.item] ?? 0) + end.offset;
  const tidy = (value: string) => value.replace(/\s+/g, ' ');
  const beforeStart = Math.max(0, from - EXCERPT_CONTEXT);
  const afterEnd = Math.min(text.length, to + EXCERPT_CONTEXT);
  return {
    before: `${beforeStart > 0 ? '…' : ''}${tidy(text.slice(beforeStart, from)).trimStart()}`,
    match: tidy(text.slice(from, to)),
    after: `${tidy(text.slice(to, afterEnd)).trimEnd()}${afterEnd < text.length ? '…' : ''}`,
  };
}

/** Finds non-overlapping matches of `query` on one page, in reading order. */
export function findInPage(
  pageIndex: number,
  items: readonly Pick<PageTextItem, 'str' | 'hasEOL'>[],
  query: string,
  options: SearchOptions,
  limit = MAX_MATCHES,
): TextMatch[] {
  const needle = foldQuery(query, options.matchCase);
  if (needle.length === 0 || limit <= 0) return [];
  const folded = foldPageText(items, options.matchCase);
  const matches: TextMatch[] = [];
  let from = 0;
  while (matches.length < limit) {
    const at = folded.text.indexOf(needle, from);
    if (at === -1) break;
    const last = at + needle.length - 1;
    if (options.wholeWords && !(isBoundary(folded.text, at) && isBoundary(folded.text, last + 1))) {
      from = at + 1;
      continue;
    }
    const start = { item: folded.item[at]!, offset: folded.start[at]! };
    const end = { item: folded.item[last]!, offset: folded.end[last]! };
    matches.push({ pageIndex, start, end, excerpt: excerpt(items, start, end) });
    from = at + needle.length;
  }
  return matches;
}

/**
 * Splits a match into per-run character ranges, for highlighting the
 * corresponding text-layer elements.
 */
export function matchRanges(
  match: Pick<TextMatch, 'start' | 'end'>,
  runLengths: readonly number[],
): Array<{ item: number; from: number; to: number }> {
  const ranges: Array<{ item: number; from: number; to: number }> = [];
  for (let item = match.start.item; item <= match.end.item; item += 1) {
    const length = runLengths[item] ?? 0;
    const from = item === match.start.item ? match.start.offset : 0;
    const to = item === match.end.item ? match.end.offset : length;
    if (to > from) ranges.push({ item, from: Math.min(from, length), to: Math.min(to, length) });
  }
  return ranges;
}
