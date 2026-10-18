/**
 * Keeps rendered page canvases for pages that scrolled away, up to a pixel
 * budget, so scrolling back does not re-render them. Canvases that are on
 * screen are pinned and never evicted. Evicted canvases are shrunk to 0×0,
 * which makes browsers (WebKit in particular) release their memory at once.
 */
export interface CacheEntry {
  canvas: HTMLCanvasElement;
  pageIndex: number;
  /** What the canvas shows; entries for the same page with other variants are fallbacks. */
  variant: string;
}

export const DEFAULT_PIXEL_BUDGET = 40_000_000;

export class CanvasCache {
  #entries = new Map<string, CacheEntry>();
  #pinned = new Map<string, number>();

  constructor(private readonly pixelBudget = DEFAULT_PIXEL_BUDGET) {}

  static key(pageIndex: number, variant: string): string {
    return `${pageIndex}|${variant}`;
  }

  get(pageIndex: number, variant: string): HTMLCanvasElement | null {
    const key = CanvasCache.key(pageIndex, variant);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    // Most recently used goes last.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.canvas;
  }

  /**
   * The most recently used rendering of the page whose variant starts with
   * `variantPrefix` (e.g. at the previous zoom), to show while re-rendering.
   */
  fallback(pageIndex: number, variantPrefix: string): CacheEntry | null {
    let found: CacheEntry | null = null;
    for (const entry of this.#entries.values()) {
      if (entry.pageIndex === pageIndex && entry.variant.startsWith(variantPrefix)) found = entry;
    }
    return found;
  }

  put(pageIndex: number, variant: string, canvas: HTMLCanvasElement): void {
    const key = CanvasCache.key(pageIndex, variant);
    const existing = this.#entries.get(key);
    // A pinned canvas may still be on screen; it is simply forgotten instead.
    if (existing && existing.canvas !== canvas && !this.#pinned.has(key)) release(existing.canvas);
    this.#entries.delete(key);
    this.#entries.set(key, { canvas, pageIndex, variant });
    this.#evict();
  }

  pin(pageIndex: number, variant: string): () => void {
    const key = CanvasCache.key(pageIndex, variant);
    this.#pinned.set(key, (this.#pinned.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.#pinned.get(key) ?? 1) - 1;
      if (count <= 0) this.#pinned.delete(key);
      else this.#pinned.set(key, count);
      this.#evict();
    };
  }

  get pixels(): number {
    let total = 0;
    for (const entry of this.#entries.values()) total += entry.canvas.width * entry.canvas.height;
    return total;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Forgets entries whose variant matches (pinned ones stay until unpinned). */
  removeWhere(predicate: (variant: string) => boolean): void {
    for (const [key, entry] of this.#entries) {
      if (!predicate(entry.variant)) continue;
      this.#entries.delete(key);
      if (!this.#pinned.has(key)) release(entry.canvas);
    }
  }

  clear(): void {
    for (const [key, entry] of this.#entries) {
      if (!this.#pinned.has(key)) release(entry.canvas);
    }
    this.#entries.clear();
  }

  #evict(): void {
    let total = this.pixels;
    if (total <= this.pixelBudget) return;
    for (const [key, entry] of this.#entries) {
      if (total <= this.pixelBudget) break;
      if (this.#pinned.has(key)) continue;
      total -= entry.canvas.width * entry.canvas.height;
      this.#entries.delete(key);
      release(entry.canvas);
    }
  }
}

function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}
