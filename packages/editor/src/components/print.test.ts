import { describe, expect, it } from 'vitest';
import { printDpi } from '../hooks/use-print';
import { parsePageRange } from '../format';

describe('printing', () => {
  it('reads page ranges as sorted, distinct positions', () => {
    expect(parsePageRange('1-3, 5', 6)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange(' 4 – 2 ', 6)).toBeNull();
    expect(parsePageRange('2–4', 6)).toEqual([1, 2, 3]);
    expect(parsePageRange('3, 1, 3', 3)).toEqual([0, 2]);
    expect(parsePageRange('1,,2,', 3)).toEqual([0, 1]);
  });

  it('refuses pages outside the document and other text', () => {
    expect(parsePageRange('0', 3)).toBeNull();
    expect(parsePageRange('2-4', 3)).toBeNull();
    expect(parsePageRange('1-', 3)).toBeNull();
    expect(parsePageRange('first', 3)).toBeNull();
    expect(parsePageRange('1.5', 3)).toBeNull();
    expect(parsePageRange('', 3)).toBeNull();
    expect(parsePageRange(' , ', 3)).toBeNull();
  });

  it('lowers the print resolution for long documents', () => {
    expect(printDpi(1)).toBe(150);
    expect(printDpi(100)).toBe(150);
    expect(printDpi(101)).toBe(110);
    expect(printDpi(300)).toBe(110);
    expect(printDpi(301)).toBe(72);
  });
});
