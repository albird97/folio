import { describe, expect, it } from 'vitest';
import { normalizeMetadata, splitKeywords } from './metadata';

const parseDate = (value: string) => (value === 'D:20260115' ? new Date('2026-01-15T00:00:00Z') : null);

describe('normalizeMetadata', () => {
  it('prefers the Info dictionary and falls back to XMP', () => {
    const xmp = { get: (key: string) => ({ 'dc:title': 'XMP title', 'dc:creator': 'XMP author' })[key] };
    const metadata = normalizeMetadata(
      { Title: '  Info title\u0000 ', Keywords: 'a, b;c', CreationDate: 'D:20260115', ModDate: 'junk' },
      xmp,
      parseDate,
    );
    expect(metadata.title).toBe('Info title');
    expect(metadata.author).toBe('XMP author');
    expect(metadata.keywords).toEqual(['a', 'b', 'c']);
    expect(metadata.creationDate).toBe('2026-01-15T00:00:00.000Z');
    expect(metadata.modificationDate).toBeNull();
  });

  it('ignores non-string values', () => {
    const metadata = normalizeMetadata({ Title: 42, Author: { name: 'x' } }, null, parseDate);
    expect(metadata.title).toBe('');
    expect(metadata.author).toBe('');
  });

  it('splits keywords', () => {
    expect(splitKeywords(' one ,two;; three ')).toEqual(['one', 'two', 'three']);
  });
});
