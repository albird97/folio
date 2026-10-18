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
  /** Per UTF-16 unit of `text`: index of the text run it came from. */
  item: Int32Array;
  /** Per UTF-16 unit of `text`: UTF-16 range [start, end) within that run's string. */
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

/**
 * Marks that are accents rather than letters: Latin/Greek/Cyrillic combining
 * diacritics, Hebrew points and Arabic harakat. Other combining marks (such as
 * Indic vowel signs) are part of the word and kept.
 */
const DIACRITICS: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

function withoutDiacritics(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (!DIACRITICS.some(([from, to]) => code >= from && code <= to)) out += char;
  }
  return out;
}

const WHITESPACE = /\s/u;

/**
 * Folds one character (code point); may return several characters (a
 * ligature) or none (an accent written as a separate character).
 */
export function foldChar(char: string, matchCase: boolean): string {
  const simple = SIMPLIFY[char] ?? char;
  const folded = withoutDiacritics(simple.normalize('NFKD'));
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
    for (const char of text) {
      const space = WHITESPACE.test(char);
      if (space && lastWasSpace) continue;
      lastWasSpace = space;
      const out = space ? ' ' : char;
      chars.push(out);
      // One entry per UTF-16 unit: matches are found with string offsets.
      for (let unit = 0; unit < out.length; unit += 1) {
        item.push(itemIndex);
        start.push(from);
        end.push(to);
      }
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
