/** A bookmark from the document outline, with its destination resolved. */
export interface OutlineItem {
  title: string;
  /** Destination page, or null when the item has none (or it is broken). */
  pageIndex: number | null;
  /** Destination position in PDF user space, when the destination gives it. */
  left: number | null;
  top: number | null;
  /** External link for items that point to a web address. */
  url: string | null;
  bold: boolean;
  italic: boolean;
  children: OutlineItem[];
}

export interface RawOutlineNode {
  title: string;
  bold?: boolean;
  italic?: boolean;
  dest: string | unknown[] | null;
  url: string | null;
  items: RawOutlineNode[];
}

export interface DestinationResolver {
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
  pageCount: number;
}

/** Outlines are user-visible menus; cap them so a hostile file cannot stall the UI. */
export const MAX_OUTLINE_ITEMS = 5000;
const MAX_OUTLINE_DEPTH = 16;

const numberOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function isRef(value: unknown): value is { num: number; gen: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { num?: unknown }).num === 'number' &&
    typeof (value as { gen?: unknown }).gen === 'number'
  );
}

/** Resolves a PDF destination (named or explicit) to a page and position. */
export async function resolveDestination(
  dest: string | unknown[] | null,
  resolver: DestinationResolver,
): Promise<Pick<OutlineItem, 'pageIndex' | 'left' | 'top'>> {
  const none = { pageIndex: null, left: null, top: null };
  try {
    const explicit = typeof dest === 'string' ? await resolver.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return none;
    const [target, mode] = explicit;
    let pageIndex: number | null = null;
    if (isRef(target)) pageIndex = await resolver.getPageIndex(target);
    else if (typeof target === 'number' && Number.isInteger(target)) pageIndex = target;
    if (pageIndex === null || pageIndex < 0 || pageIndex >= resolver.pageCount) return none;
    const name = (mode as { name?: unknown } | undefined)?.name;
    switch (name) {
      case 'XYZ':
        return { pageIndex, left: numberOrNull(explicit[2]), top: numberOrNull(explicit[3]) };
      case 'FitH':
      case 'FitBH':
        return { pageIndex, left: null, top: numberOrNull(explicit[2]) };
      case 'FitR':
        return { pageIndex, left: numberOrNull(explicit[2]), top: numberOrNull(explicit[5]) };
      default:
        return { pageIndex, left: null, top: null };
    }
  } catch {
    return none;
  }
}

export async function resolveOutline(
  nodes: readonly RawOutlineNode[] | null,
  resolver: DestinationResolver,
): Promise<OutlineItem[]> {
  let budget = MAX_OUTLINE_ITEMS;
  const visit = async (level: readonly RawOutlineNode[], depth: number): Promise<OutlineItem[]> => {
    const kept = level.slice(0, Math.max(0, budget));
    budget -= kept.length;
    return Promise.all(
      kept.map(async (node) => ({
        title: typeof node.title === 'string' ? node.title.replace(/\0/g, '').trim() : '',
        ...(await resolveDestination(node.dest, resolver)),
        url: typeof node.url === 'string' ? node.url : null,
        bold: node.bold === true,
        italic: node.italic === true,
        children:
          depth < MAX_OUTLINE_DEPTH && Array.isArray(node.items) && node.items.length > 0
            ? await visit(node.items, depth + 1)
            : [],
      })),
    );
  };
  return nodes ? visit(nodes, 0) : [];
}
