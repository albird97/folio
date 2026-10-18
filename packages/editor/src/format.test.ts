import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatPageSize } from './format';

describe('format', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2973)).toBe('2.9 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });

  it('formats page sizes with familiar names and rotation', () => {
    const page = {
      size: { width: 612, height: 792 },
      sourceRotation: 0 as const,
      rotation: 0 as const,
    };
    expect(formatPageSize(page)).toBe('Letter · 8.5 × 11 in');
    expect(formatPageSize({ ...page, rotation: 90 })).toBe('Letter · 11 × 8.5 in');
    expect(formatPageSize({ ...page, size: { width: 595.28, height: 841.89 } })).toBe(
      'A4 · 210 × 297 mm',
    );
    expect(formatPageSize({ ...page, size: { width: 300, height: 300 } })).toBe('4.17 × 4.17 in');
  });

  it('formats dates and handles missing values', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
    expect(formatDate('2026-01-15T09:30:00.000Z', 'en-US')).toMatch(/Jan 15, 2026/);
  });
});
