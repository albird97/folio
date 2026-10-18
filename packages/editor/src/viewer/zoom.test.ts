import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  fitZoom,
  formatZoom,
  MAX_AUTO_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  parseZoom,
  stepZoom,
} from './zoom';

describe('zoom', () => {
  it('steps through presets from any value', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.04, 1)).toBe(1.1);
    expect(stepZoom(1.04, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('clamps and rejects nonsense', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('fits width, page and automatic modes', () => {
    const letter = { width: 612, height: 792 };
    expect(fitZoom('fit-width', letter, { width: 1224, height: 500 })).toBe(2);
    expect(fitZoom('fit-page', letter, { width: 1224, height: 396 })).toBe(0.5);
    // Automatic: fit width, but never above 125%…
    expect(fitZoom('auto', letter, { width: 1224, height: 500 })).toBe(MAX_AUTO_ZOOM);
    expect(fitZoom('auto', letter, { width: 306, height: 500 })).toBe(0.5);
    // …and whole landscape pages.
    expect(fitZoom('auto', { width: 792, height: 612 }, { width: 792, height: 306 })).toBe(0.5);
    expect(fitZoom('fit-page', letter, { width: 0, height: 0 })).toBe(1);
  });

  it('formats and parses zoom levels', () => {
    expect(formatZoom(1.254)).toBe('125%');
    expect(parseZoom('150')).toBe(1.5);
    expect(parseZoom(' 75 % ')).toBe(0.75);
    expect(parseZoom('2x')).toBe(2);
    expect(parseZoom('12,5%')).toBe(0.125);
    expect(parseZoom('5000')).toBe(MAX_ZOOM);
    expect(parseZoom('abc')).toBeNull();
    expect(parseZoom('0')).toBeNull();
  });
});
