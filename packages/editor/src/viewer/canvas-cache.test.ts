import { describe, expect, it } from 'vitest';
import { CanvasCache } from './canvas-cache';

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

describe('canvas cache', () => {
  it('evicts least recently used canvases beyond the pixel budget', () => {
    const cache = new CanvasCache(300);
    const a = canvas(10, 10);
    const b = canvas(10, 10);
    const c = canvas(10, 10);
    cache.put(0, 's1', a);
    cache.put(1, 's1', b);
    cache.get(0, 's1');
    cache.put(2, 's1', c);
    expect(cache.size).toBe(3);
    cache.put(3, 's1', canvas(10, 10));
    // Page 1 was least recently used: dropped and shrunk to free memory.
    expect(cache.get(1, 's1')).toBeNull();
    expect([b.width, b.height]).toEqual([0, 0]);
    expect(cache.get(0, 's1')).toBe(a);
    expect(cache.pixels).toBeLessThanOrEqual(300);
  });

  it('never evicts pinned canvases', () => {
    const cache = new CanvasCache(100);
    const pinned = canvas(10, 10);
    cache.put(0, 's1', pinned);
    const unpin = cache.pin(0, 's1');
    cache.put(1, 's1', canvas(10, 10));
    expect(cache.get(0, 's1')).toBe(pinned);
    expect(pinned.width).toBe(10);
    unpin();
    unpin();
    cache.put(2, 's1', canvas(10, 10));
    expect(cache.get(0, 's1')).toBeNull();
  });

  it('offers renderings at other scales as fallbacks', () => {
    const cache = new CanvasCache(1_000_000);
    const old = canvas(10, 10);
    cache.put(4, 'r0@1.00', old);
    expect(cache.fallback(4, 'r0@')).toEqual({ canvas: old, pageIndex: 4, variant: 'r0@1.00' });
    expect(cache.fallback(4, 'r90@')).toBeNull();
    expect(cache.fallback(5, 'r0@')).toBeNull();
    cache.clear();
    expect(cache.size).toBe(0);
    expect(old.width).toBe(0);
  });

  it('removes the entries of closed documents, keeping pinned canvases intact', () => {
    const cache = new CanvasCache(1_000_000);
    const open = canvas(10, 10);
    const closed = canvas(10, 10);
    const shown = canvas(10, 10);
    cache.put(0, 'a|r0@1', open);
    cache.put(0, 'b|r0@1', closed);
    cache.put(1, 'b|r0@1', shown);
    const unpin = cache.pin(1, 'b|r0@1');
    cache.removeWhere((variant) => variant.startsWith('b|'));
    expect(cache.size).toBe(1);
    expect(closed.width).toBe(0);
    expect(shown.width).toBe(10);
    expect(open.width).toBe(10);
    unpin();
    expect(shown.width).toBe(10);
  });
});
