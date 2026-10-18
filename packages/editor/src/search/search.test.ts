import { describe, expect, it } from 'vitest';
import { findInPage, matchRanges, MAX_MATCHES } from './match';
import { firstMatchFrom, searchDocument, type SearchProgress } from './run';
import { foldPageText, foldQuery } from './text-index';

const run = (str: string, hasEOL = false) => ({ str, hasEOL });
const insensitive = { matchCase: false, wholeWords: false };

describe('text folding', () => {
  it('ignores case, accents, ligatures and typographic punctuation', () => {
    expect(foldQuery('  Café   NAÏVE ', false)).toBe('cafe naive');
    expect(foldQuery('ﬁle', false)).toBe('file');
    expect(foldQuery('“quoted” – dash', false)).toBe('"quoted" - dash');
    expect(foldQuery('Café', true)).toBe('Cafe');
  });

  it('maps every folded character back to its run and offset', () => {
    const folded = foldPageText([run('ﬁne'), run(' dé', true), run('x')], false);
    expect(folded.text).toBe('fine de x');
    // Both letters of the expanded ligature point at the ligature itself.
    expect([folded.start[0], folded.end[0], folded.start[1], folded.end[1]]).toEqual([0, 1, 0, 1]);
    // The accented letter keeps its original position.
    expect([folded.item[6], folded.start[6], folded.end[6]]).toEqual([1, 2, 3]);
  });

  it('collapses whitespace and separates lines', () => {
    expect(foldPageText([run('  a  '), run('b', true), run('c', true)], false).text).toBe('a b c');
  });

  it('treats accents written as separate characters like precomposed ones', () => {
    // "café" with the accent as its own character (NFD), and the reverse.
    expect(foldQuery('cafe\u0301 au lait', false)).toBe('cafe au lait');
    expect(findInPage(0, [run('cafe\u0301 au lait')], 'café au', insensitive)).toHaveLength(1);
    expect(findInPage(0, [run('café au lait')], 'cafe\u0301 au', insensitive)).toHaveLength(1);
    // Hebrew points and Arabic harakat are optional too; Indic vowel signs are letters.
    expect(foldQuery('שָׁלוֹם', false)).toBe('שלום');
    expect(foldQuery('كَتَبَ', false)).toBe('كتب');
    expect(foldQuery('हिंदी', false)).toBe('हिंदी'.normalize('NFKD'));
  });
});

describe('page search', () => {
  it('finds matches across separately drawn runs', () => {
    const items = [run('photo'), run('synthesis'), run(' turns light into sugar.')];
    const [match] = findInPage(4, items, 'Photosynthesis', insensitive);
    expect(match).toMatchObject({
      pageIndex: 4,
      start: { item: 0, offset: 0 },
      end: { item: 1, offset: 9 },
      excerpt: { before: '', match: 'photosynthesis', after: ' turns light into sugar.' },
    });
  });

  it('honours match case and whole words', () => {
    const items = [run('A cat and another cat are not a category. Cat!')];
    expect(findInPage(0, items, 'cat', insensitive)).toHaveLength(4);
    expect(findInPage(0, items, 'cat', { matchCase: true, wholeWords: false })).toHaveLength(3);
    expect(findInPage(0, items, 'cat', { matchCase: false, wholeWords: true })).toHaveLength(3);
    expect(findInPage(0, items, 'cat', { matchCase: true, wholeWords: true })).toHaveLength(2);
  });

  it('matches phrases across line ends and keeps matches non-overlapping', () => {
    const items = [run('the field', true), run('guide is here')];
    expect(findInPage(0, items, 'field guide', insensitive)).toHaveLength(1);
    expect(findInPage(0, [run('aaaa')], 'aa', insensitive)).toHaveLength(2);
  });

  it('returns nothing for empty queries and respects the limit', () => {
    expect(findInPage(0, [run('text')], '   ', insensitive)).toEqual([]);
    expect(findInPage(0, [run('a a a a')], 'a', insensitive, 2)).toHaveLength(2);
  });

  it('shortens long excerpts around the match', () => {
    const long = `${'x'.repeat(100)} needle ${'y'.repeat(100)}`;
    const [match] = findInPage(0, [run(long)], 'needle', insensitive);
    expect(match?.excerpt.before.startsWith('…')).toBe(true);
    expect(match?.excerpt.after.endsWith('…')).toBe(true);
    expect(match?.excerpt.match).toBe('needle');
  });

  it('maps matches after characters outside the Basic Multilingual Plane', () => {
    const items = [run('😀 hello '), run('𠜎 world')];
    const [match] = findInPage(0, items, 'world', insensitive);
    expect(match).toMatchObject({
      start: { item: 1, offset: 3 },
      end: { item: 1, offset: 8 },
      excerpt: { match: 'world' },
    });
    const [hello] = findInPage(0, items, 'hello', insensitive);
    expect(hello?.start).toEqual({ item: 0, offset: 3 });
    // Whole-word boundaries treat a surrogate pair as one letter.
    expect(
      findInPage(0, [run('𠜎ab ab')], 'ab', { matchCase: false, wholeWords: true }),
    ).toHaveLength(1);
  });

  it('splits a match into per-run highlight ranges', () => {
    expect(
      matchRanges({ start: { item: 0, offset: 3 }, end: { item: 2, offset: 2 } }, [5, 4, 6]),
    ).toEqual([
      { item: 0, from: 3, to: 5 },
      { item: 1, from: 0, to: 4 },
      { item: 2, from: 0, to: 2 },
    ]);
  });
});

describe('document search', () => {
  const pages = [[run('fox one')], [run('nothing here')], [run('fox two fox three')], [run('end')]];
  const source = {
    pageCount: pages.length,
    getPageText: async (index: number) => ({
      items: pages[index]!.map((item) => ({
        ...item,
        transform: [1, 0, 0, 1, 0, 0],
        width: 1,
        height: 1,
      })),
    }),
  };

  it('reports progress and finds every match in order', async () => {
    const progress: SearchProgress[] = [];
    const result = await searchDocument(
      source,
      'fox',
      insensitive,
      (p) => progress.push(p),
      new AbortController().signal,
      2,
    );
    expect(result?.matches.map((match) => match.pageIndex)).toEqual([0, 2, 2]);
    expect(progress.map((p) => p.pagesSearched)).toEqual([2, 4, 4]);
    expect(progress.at(-1)).toMatchObject({ done: true, truncated: false });
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const seen: SearchProgress[] = [];
    const pending = searchDocument(
      source,
      'fox',
      insensitive,
      (p) => {
        seen.push(p);
        controller.abort();
      },
      controller.signal,
      1,
    );
    expect(await pending).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('caps the number of matches', async () => {
    const huge = {
      pageCount: 3,
      getPageText: async () => ({
        items: [
          { str: 'a '.repeat(MAX_MATCHES), hasEOL: false, transform: [], width: 1, height: 1 },
        ],
      }),
    };
    const result = await searchDocument(
      huge,
      'a',
      insensitive,
      () => undefined,
      new AbortController().signal,
    );
    expect(result?.matches).toHaveLength(MAX_MATCHES);
    expect(result?.truncated).toBe(true);
  });

  it('starts from the current page', () => {
    const matches = [0, 2, 2, 5].map((pageIndex) => ({ pageIndex }) as never);
    expect(firstMatchFrom(matches, 2)).toBe(1);
    expect(firstMatchFrom(matches, 6)).toBe(0);
    expect(firstMatchFrom([], 0)).toBe(-1);
  });
});
