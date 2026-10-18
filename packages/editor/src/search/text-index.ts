import type { PageTextItem } from '@folio/pdf-core';

/**
 * Search runs over "folded" text: accents removed, compatibility characters
 * expanded (ligatures such as "ﬁ"), typographic quotes and dashes simplified,
 * whitespace collapsed and, unless matching case, lower-cased. Every folded
 * character remembers which text run and offset it came from, so a match can
 * be mapped back onto the text layer for highlighting.
 */
export interface FoldedText {
  text: string;
  /** Per folded character: index of the text run it came from. */
  item: Int32Array;
  /** Per folded character: UTF-16 range [start, end) within that run's string. */
  start: Int32Array;
  end: Int32Array;
}

const SIMPLIFY: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '−': '-',
  ' ': ' ',
};

const COMBINING = /\p{M}/gu;
const WHITESPACE = /\s/u;

/** Folds one character (code point); may return several characters or none. */
export function foldChar(char: string, matchCase: boolean): string {
  const simple = SIMPLIFY[char] ?? char;
  const decomposed = simple.normalize('NFKD').replace(COMBINING, '');
  const folded = decomposed.length > 0 ? decomposed : simple;
  return matchCase ? folded : folded.toLowerCase();
}

/** Folds a query the same way page text is folded. */
export function foldQuery(query: string, matchCase: boolean): string {
  let out = '';
  for (const char of query) {
    const folded = foldChar(char, matchCase);
    out += WHITESPACE.test(folded) ? ' ' : folded;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

export function foldPageText(
  items: readonly Pick<PageTextItem, 'str' | 'hasEOL'>[],
  matchCase: boolean,
): FoldedText {
  const chars: string[] = [];
  const item: number[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let lastWasSpace = true;
  const push = (text: string, itemIndex: number, from: number, to: number) => {
    for (const unit of text) {
      const space = WHITESPACE.test(unit);
      if (space && lastWasSpace) continue;
      lastWasSpace = space;
      chars.push(space ? ' ' : unit);
      item.push(itemIndex);
      start.push(from);
      end.push(to);
    }
  };
  items.forEach((run, itemIndex) => {
    let offset = 0;
    for (const char of run.str) {
      push(foldChar(char, matchCase), itemIndex, offset, offset + char.length);
      offset += char.length;
    }
    // Line ends separate words even when no space character was extracted.
    if (run.hasEOL) push(' ', itemIndex, run.str.length, run.str.length);
  });
  // Drop a trailing space so it cannot be part of a match.
  if (chars.at(-1) === ' ') {
    chars.pop();
    item.pop();
    start.pop();
    end.pop();
  }
  return {
    text: chars.join(''),
    item: Int32Array.from(item),
    start: Int32Array.from(start),
    end: Int32Array.from(end),
  };
}

/** The readable page text used for result excerpts (runs joined, whitespace collapsed). */
export function displayText(items: readonly Pick<PageTextItem, 'str' | 'hasEOL'>[]): {
  text: string;
  /** Start of each run within `text`. */
  runStart: Int32Array;
} {
  let text = '';
  const runStart: number[] = [];
  for (const run of items) {
    runStart.push(text.length);
    text += run.str;
    if (run.hasEOL) text += ' ';
  }
  return { text, runStart: Int32Array.from(runStart) };
}
