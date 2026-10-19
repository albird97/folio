import type { PageModel } from '@folio/document-model';
import { Input } from '@folio/shared-ui';
import { useId, useState } from 'react';
import { parsePageRange } from '../../format';
import type { WorkspaceDocument } from '../../store/workspace';

/** Which pages an export takes. */
export type PageScope = 'all' | 'current' | 'selected' | 'range';

export interface PageScopeState {
  scope: PageScope;
  setScope(scope: PageScope): void;
  range: string;
  setRange(range: string): void;
  /** The current page's position. */
  current: number;
  /** Positions of the pages selected in the pages panel, in document order. */
  selected: number[];
  /** The chosen pages, in document order; null while the typed range is not valid. */
  positions: number[] | null;
  pages: readonly PageModel[];
}

/**
 * The pages a tool works on: every page, the current one, the pages
 * selected in the pages panel (chosen to begin with when there are several)
 * or pages typed like "1-3, 5".
 */
export function usePageScope(doc: WorkspaceDocument): PageScopeState {
  const pages = doc.editor?.model.pages ?? [];
  const current = Math.max(
    0,
    pages.findIndex((page) => page.id === doc.view?.currentPageId),
  );
  const chosen = new Set(doc.selection.pages);
  const selected = pages.flatMap((page, index) => (chosen.has(page.id) ? [index] : []));
  const [scope, setScope] = useState<PageScope>(() => (selected.length > 1 ? 'selected' : 'all'));
  const [range, setRange] = useState(`1-${pages.length}`);
  const positions =
    scope === 'all'
      ? pages.map((_, index) => index)
      : scope === 'current'
        ? [current]
        : scope === 'selected'
          ? selected.length > 0
            ? selected
            : null
          : parsePageRange(range, pages.length);
  return { scope, setScope, range, setRange, current, selected, positions, pages };
}

/** Radio buttons for the scopes of {@link usePageScope}, with the range's field. */
export function PageScopeField({
  state,
  rangeLabel,
}: {
  state: PageScopeState;
  /** The accessible name of the range field, e.g. "Pages to export". */
  rangeLabel: string;
}) {
  const id = useId();
  const { scope, setScope, range, setRange, current, selected, positions, pages } = state;
  const count = pages.length;
  return (
    <>
      <fieldset className="mt-4 space-y-2 text-sm">
        <legend className="mb-1 text-xs font-semibold">Pages</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === 'all'}
            onChange={() => setScope('all')}
          />
          {count === 1 ? 'The page' : `All ${count.toLocaleString()} pages`}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === 'current'}
            onChange={() => setScope('current')}
          />
          Current page ({current + 1})
        </label>
        {selected.length > 0 ? (
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-scope`}
              checked={scope === 'selected'}
              onChange={() => setScope('selected')}
            />
            Selected pages ({selected.length.toLocaleString()})
          </label>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === 'range'}
            onChange={() => setScope('range')}
          />
          Pages
          <Input
            aria-label={rangeLabel}
            className="h-7 w-40"
            value={range}
            onFocus={() => setScope('range')}
            onChange={(event) => setRange(event.target.value)}
            aria-invalid={(scope === 'range' && !positions) || undefined}
          />
        </label>
      </fieldset>
      {scope === 'range' && !positions ? (
        <p role="alert" className="mt-2 text-xs text-danger-ink">
          Enter pages like 1-3, 5 (from 1 to {count}).
        </p>
      ) : null}
    </>
  );
}
