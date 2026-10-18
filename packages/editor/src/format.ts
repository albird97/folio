import { describePageSize, rotatedSize, type PageModel } from '@folio/document-model';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const POINTS_PER_INCH = 72;

/** "Letter · 8.5 × 11 in" or "210 × 297 mm" depending on what fits the size best. */
export function formatPageSize(
  page: Pick<PageModel, 'size' | 'sourceRotation' | 'rotation'>,
): string {
  const effective = rotatedSize(
    page.size,
    ((page.sourceRotation + page.rotation) % 360) as 0 | 90 | 180 | 270,
  );
  const name = describePageSize(page.size);
  const inches = `${trim(effective.width / POINTS_PER_INCH)} × ${trim(effective.height / POINTS_PER_INCH)} in`;
  const mm = `${Math.round((effective.width / POINTS_PER_INCH) * 25.4)} × ${Math.round((effective.height / POINTS_PER_INCH) * 25.4)} mm`;
  const metric = name !== null && /^A\d$/.test(name);
  const dimensions = metric ? mm : inches;
  return name ? `${name} · ${dimensions}` : dimensions;
}

function trim(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function formatDate(iso: string | null, locale?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Pages typed like "1-3, 5" (1-based), as sorted 0-based positions; null when invalid. */
export function parsePageRange(text: string, pageCount: number): number[] | null {
  const positions = new Set<number>();
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(trimmed);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to < from || to > pageCount) return null;
    for (let page = from; page <= to; page += 1) positions.add(page - 1);
  }
  return positions.size > 0 ? [...positions].sort((a, b) => a - b) : null;
}
