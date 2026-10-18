/** One run of text on a page, in the order PDF.js extracts it. */
export interface PageTextItem {
  str: string;
  /** The run ends a line. */
  hasEOL: boolean;
  /** Text-space to PDF-user-space transform [a, b, c, d, e, f]. */
  transform: number[];
  /** Advance width and height in user space. */
  width: number;
  height: number;
}

export interface PageText {
  items: PageTextItem[];
}

/** The subset of PDF.js' TextContent that Folio reads. */
export interface TextContentLike {
  items: ReadonlyArray<
    | { str: string; hasEOL: boolean; transform: number[]; width: number; height: number }
    | { type: string }
  >;
}

/**
 * Keeps only text runs, in order. Text-layer elements are created one per
 * run in the same order, which lets search results map onto them.
 */
export function pageTextFrom(content: TextContentLike): PageText {
  const items: PageTextItem[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    items.push({
      str: item.str,
      hasEOL: item.hasEOL,
      transform: [...item.transform],
      width: item.width,
      height: item.height,
    });
  }
  return { items };
}

/** Applies an affine transform [a, b, c, d, e, f] to a point. */
export function applyTransform(m: readonly number[], x: number, y: number): [number, number] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  return [a * x + c * y + e, b * x + d * y + f];
}

/**
 * The plain text of a page: its runs in order, with a line break wherever
 * PDF.js ends a line. Trailing spaces on lines are dropped.
 */
export function pageTextToString(text: PageText): string {
  let out = '';
  for (const item of text.items) {
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out.replace(/[ \t]+$/gm, '').trimEnd();
}
