import { describe, expect, it } from 'vitest';
import { addRotation, describePageSize, normalizeRotation, rotatedSize } from './geometry';

describe('geometry', () => {
  it('normalizes rotations', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-720)).toBe(0);
    expect(addRotation(270, 180)).toBe(90);
  });

  it('rejects rotations a PDF cannot represent', () => {
    expect(() => normalizeRotation(45)).toThrow(RangeError);
    expect(() => normalizeRotation(Number.NaN)).toThrow(RangeError);
  });

  it('swaps dimensions for quarter turns', () => {
    expect(rotatedSize({ width: 612, height: 792 }, 90)).toEqual({ width: 792, height: 612 });
    expect(rotatedSize({ width: 612, height: 792 }, 180)).toEqual({ width: 612, height: 792 });
  });

  it('names common paper sizes in either orientation', () => {
    expect(describePageSize({ width: 612, height: 792 })).toBe('Letter');
    expect(describePageSize({ width: 842, height: 595 })).toBe('A4');
    expect(describePageSize({ width: 500, height: 500 })).toBeNull();
  });
});
