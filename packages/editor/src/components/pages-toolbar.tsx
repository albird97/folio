import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ICON,
  IconButton,
} from '@folio/shared-ui';
import { CopyPlus, Ellipsis, FilePlus2, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { useWorkspace } from '../context';
import type { PageCommands } from '../hooks/use-page-commands';
import type { WorkspaceDocument } from '../store/workspace';

/** Commands for the selected pages (or the current page), above the thumbnails. */
export function PagesToolbar({
  doc,
  commands,
}: {
  doc: WorkspaceDocument;
  commands: PageCommands;
}) {
  const selectPages = useWorkspace((state) => state.selectPages);
  const canArrange = doc.permissions.assemble;
  const count = doc.selection.pages.length;
  const subject = count > 1 ? `${count} pages` : 'page';
  const icon = { size: ICON.md, strokeWidth: ICON.stroke, 'aria-hidden': true } as const;

  return (
    <div
      role="toolbar"
      aria-label="Page tools"
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!canArrange}>
          <IconButton label="Insert pages" size="icon-sm" icon={<FilePlus2 {...icon} />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => commands.insertFromFile()}>
            Pages from a PDF…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => commands.insertBlank()}>Blank page</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton
        label={`Rotate ${subject} counterclockwise`}
        size="icon-sm"
        icon={<RotateCcw {...icon} />}
        disabled={!canArrange}
        onClick={() => commands.rotate(-90)}
      />
      <IconButton
        label={`Rotate ${subject} clockwise`}
        size="icon-sm"
        icon={<RotateCw {...icon} />}
        disabled={!canArrange}
        onClick={() => commands.rotate(90)}
      />
      <IconButton
        label={`Duplicate ${subject}`}
        size="icon-sm"
        icon={<CopyPlus {...icon} />}
        disabled={!canArrange}
        onClick={() => commands.duplicate()}
      />
      <IconButton
        label={`Delete ${subject}`}
        size="icon-sm"
        icon={<Trash2 {...icon} />}
        disabled={!canArrange}
        onClick={() => commands.deletePages()}
      />
      <span className="min-w-0 flex-1 truncate px-1 text-right text-2xs text-ink-muted tabular">
        {count > 1 ? `${count} selected` : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="More page commands" size="icon-sm" icon={<Ellipsis {...icon} />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!doc.permissions.extract} onSelect={() => commands.extract()}>
            Extract {subject}…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!doc.permissions.extract} onSelect={() => commands.split()}>
            Split document…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              selectPages(doc.key, doc.editor?.model.pages.map((page) => page.id) ?? [])
            }
          >
            Select all pages
          </DropdownMenuItem>
          <DropdownMenuItem disabled={count === 0} onSelect={() => selectPages(doc.key, [], null)}>
            Clear selection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
