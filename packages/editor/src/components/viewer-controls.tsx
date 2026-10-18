import type { DocumentViewState, PageModel } from '@folio/document-model';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ICON,
  IconButton,
} from '@folio/shared-ui';
import { ChevronDown, ChevronUp, ZoomIn, ZoomOut } from 'lucide-react';
import { Toolbar as ToolbarPrimitive } from 'radix-ui';
import { useState, type KeyboardEvent } from 'react';
import { COMMAND_SHORTCUTS } from '../commands';
import { useWorkspace, useWorkspaceContext } from '../context';
import { formatZoom, MAX_ZOOM, MIN_ZOOM } from '../viewer/zoom';

export const PAGE_INPUT_ID = 'folio-page-number';
const MENU_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function PageControls({
  docKey,
  pages,
  view,
}: {
  docKey: string;
  pages: readonly PageModel[];
  view: DocumentViewState;
}) {
  const navigate = useWorkspace((state) => state.navigate);
  const [draft, setDraft] = useState<string | null>(null);
  const currentIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === view.currentPageId),
  );
  const go = (index: number) =>
    navigate(docKey, {
      pageIndex: Math.min(pages.length - 1, Math.max(0, index)),
      align: 'top',
    });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setDraft(null);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = Number.parseInt((draft ?? '').trim(), 10);
    if (Number.isFinite(value)) go(value - 1);
    setDraft(null);
    event.currentTarget.select();
  };

  return (
    <div className="flex items-center gap-0.5">
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label="Previous page"
          icon={<ChevronUp size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          disabled={currentIndex === 0}
          onClick={() => go(currentIndex - 1)}
        />
      </ToolbarPrimitive.Button>
      <span className="flex items-center gap-1.5 text-xs text-ink-muted tabular">
        <input
          id={PAGE_INPUT_ID}
          aria-label={`Page number, ${pages.length.toLocaleString()} pages`}
          inputMode="numeric"
          autoComplete="off"
          value={draft ?? String(currentIndex + 1)}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={onKeyDown}
          className="h-7 rounded-md bg-raised text-center text-sm text-ink shadow-[inset_0_0_0_1px_var(--folio-border-strong)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--folio-focus)] focus-visible:outline-2 focus-visible:outline-focus/35"
          style={{ width: `${Math.max(3, String(pages.length).length + 1.5)}ch` }}
        />
        <span aria-hidden className="whitespace-nowrap">
          of {pages.length.toLocaleString()}
        </span>
      </span>
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label="Next page"
          icon={<ChevronDown size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          disabled={currentIndex >= pages.length - 1}
          onClick={() => go(currentIndex + 1)}
        />
      </ToolbarPrimitive.Button>
    </div>
  );
}

export function ZoomControls({ docKey, view }: { docKey: string; view: DocumentViewState }) {
  const { profile, shortcutPlatform } = useWorkspaceContext();
  const setZoom = useWorkspace((state) => state.setZoom);
  const zoomBy = useWorkspace((state) => state.zoomBy);
  const shortcuts = COMMAND_SHORTCUTS[profile];
  const preset = MENU_ZOOMS.find((zoom) => Math.abs(zoom - view.zoom) < 0.0005);
  const value =
    view.zoomMode !== 'custom' ? view.zoomMode : preset !== undefined ? String(preset) : '';

  const choose = (next: string) => {
    if (next === 'auto' || next === 'fit-width' || next === 'fit-page') setZoom(docKey, next);
    else setZoom(docKey, 'custom', Number(next));
  };

  return (
    <div className="flex items-center gap-0.5">
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label="Zoom out"
          icon={<ZoomOut size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          disabled={view.zoom <= MIN_ZOOM + 0.0005}
          onClick={() => zoomBy(docKey, -1)}
          shortcut={{ keys: shortcuts['zoom-out'][0]!, platform: shortcutPlatform }}
        />
      </ToolbarPrimitive.Button>
      <DropdownMenu>
        <ToolbarPrimitive.Button asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Zoom, ${formatZoom(view.zoom)}`}
              className="w-[4.75rem] justify-between px-2 tabular"
            >
              {formatZoom(view.zoom)}
              <ChevronDown
                size={ICON.sm}
                strokeWidth={ICON.stroke}
                aria-hidden
                className="text-ink-muted"
              />
            </Button>
          </DropdownMenuTrigger>
        </ToolbarPrimitive.Button>
        <DropdownMenuContent align="center">
          <DropdownMenuRadioGroup value={value} onValueChange={choose}>
            <DropdownMenuRadioItem value="auto">Automatic</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="fit-width">Fit width</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="fit-page">Fit page</DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {MENU_ZOOMS.map((zoom) => (
              <DropdownMenuRadioItem key={zoom} value={String(zoom)} className="tabular">
                {formatZoom(zoom)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label="Zoom in"
          icon={<ZoomIn size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          disabled={view.zoom >= MAX_ZOOM - 0.0005}
          onClick={() => zoomBy(docKey, 1)}
          shortcut={{ keys: shortcuts['zoom-in'][0]!, platform: shortcutPlatform }}
        />
      </ToolbarPrimitive.Button>
    </div>
  );
}
