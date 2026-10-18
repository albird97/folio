import { primarySource } from '@folio/document-model';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ICON,
  IconButton,
  Kbd,
  nextThemePreference,
  type ThemePreference,
} from '@folio/shared-ui';
import {
  ChevronDown,
  Download,
  FolderOpen,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Sun,
} from 'lucide-react';
import { Toolbar as ToolbarPrimitive } from 'radix-ui';
import type { AppCommand } from '@folio/platform-adapters';
import { COMMAND_SHORTCUTS } from '../commands';
import { useActiveDocument, useUi, useWorkspaceContext } from '../context';
import { formatBytes } from '../format';
import { useSaveAs } from '../hooks/use-save-as';
import { PageControls, ZoomControls } from './viewer-controls';

const THEME_META: Record<ThemePreference, { label: string; Icon: typeof Sun }> = {
  system: { label: 'Theme: match system', Icon: Monitor },
  light: { label: 'Theme: light', Icon: Sun },
  dark: { label: 'Theme: dark', Icon: Moon },
};

const Separator = () => <ToolbarPrimitive.Separator className="mx-1 h-5 w-px bg-line" />;

export function WorkspaceToolbar({ onCommand }: { onCommand(command: AppCommand): void }) {
  const { adapter, workspace, profile, shortcutPlatform } = useWorkspaceContext();
  const doc = useActiveDocument();
  const leftPanelOpen = useUi((state) => state.leftPanelOpen);
  const rightPanelOpen = useUi((state) => state.rightPanelOpen);
  const toggleLeftPanel = useUi((state) => state.toggleLeftPanel);
  const toggleRightPanel = useUi((state) => state.toggleRightPanel);
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const shortcuts = COMMAND_SHORTCUTS[profile];
  const shortcut = (command: AppCommand) => {
    const keys = shortcuts[command][0];
    return keys ? { keys, platform: shortcutPlatform } : undefined;
  };
  const ready = doc?.status === 'ready' && doc.editor !== null && doc.view !== null;
  const pages = ready ? doc.editor!.model.pages : null;
  const view = ready ? doc.view : null;
  const source = doc?.editor ? primarySource(doc.editor.model) : null;
  const { label: themeLabel, Icon: ThemeIcon } = THEME_META[theme];
  const nextTheme = THEME_META[nextThemePreference(theme)].label.replace('Theme: ', '');
  const desktop = adapter.platform === 'desktop';
  const saveAs = useSaveAs();

  return (
    <ToolbarPrimitive.Root
      aria-label="Workspace"
      className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2"
    >
      {/* Panel toggles keep a fixed name; `pressed` says whether the panel is shown. */}
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label="Sidebar"
          icon={<PanelLeft size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          pressed={ready && leftPanelOpen}
          disabled={!ready}
          onClick={toggleLeftPanel}
          shortcut={shortcut('toggle-left-panel')}
        />
      </ToolbarPrimitive.Button>
      <Separator />
      <ToolbarPrimitive.Button asChild>
        <Button variant="ghost" onClick={() => onCommand('open')}>
          <FolderOpen size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
          Open
          <Kbd
            shortcut={shortcuts.open[0]!}
            platform={shortcutPlatform}
            className="ml-1 hidden text-ink-subtle xl:inline-flex"
          />
        </Button>
      </ToolbarPrimitive.Button>
      {adapter.features.saveCopy ? (
        <>
          <ToolbarPrimitive.Button asChild>
            <IconButton
              label={desktop ? 'Save as…' : 'Download PDF'}
              icon={
                desktop ? (
                  <Save size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
                ) : (
                  <Download size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
                )
              }
              disabled={!ready}
              onClick={() => onCommand('save-as')}
              shortcut={shortcut('save-as')}
            />
          </ToolbarPrimitive.Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!ready}>
              <ToolbarPrimitive.Button asChild>
                <IconButton
                  label="More ways to save"
                  size="icon-sm"
                  className="-ml-1 w-5"
                  icon={<ChevronDown size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />}
                />
              </ToolbarPrimitive.Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => doc && void saveAs(doc.key)}>
                {desktop ? 'Save as…' : 'Download PDF'}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!doc?.permissions.modify}
                onSelect={() => doc && void saveAs(doc.key, { flatten: true })}
              >
                {desktop ? 'Save with comments flattened…' : 'Download with comments flattened'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onCommand('save-copy')}>
                {desktop ? 'Save a copy of the original…' : 'Download the original'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}

      <div className="mx-2 flex min-w-0 flex-1 items-baseline gap-2">
        {doc ? (
          <>
            <h1 className="truncate text-sm font-semibold" title={doc.fileName}>
              {doc.editor?.model.metadata.title || doc.fileName}
            </h1>
            {source && pages ? (
              <span className="hidden shrink-0 text-xs text-ink-muted tabular 2xl:inline">
                {pages.length} {pages.length === 1 ? 'page' : 'pages'} ·{' '}
                {formatBytes(source.byteLength)}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {ready && pages && view ? (
        <>
          <PageControls docKey={doc.key} pages={pages} view={view} />
          <Separator />
          <ZoomControls docKey={doc.key} view={view} />
          <Separator />
          <ToolbarPrimitive.Button asChild>
            <IconButton
              label="Rotate counterclockwise"
              icon={<RotateCcw size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
              onClick={() => onCommand('rotate-counterclockwise')}
              shortcut={shortcut('rotate-counterclockwise')}
            />
          </ToolbarPrimitive.Button>
          <ToolbarPrimitive.Button asChild>
            <IconButton
              label="Rotate clockwise"
              icon={<RotateCw size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
              onClick={() => onCommand('rotate-clockwise')}
              shortcut={shortcut('rotate-clockwise')}
            />
          </ToolbarPrimitive.Button>
          <Separator />
          <ToolbarPrimitive.Button asChild>
            <IconButton
              label="Find"
              icon={<Search size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
              pressed={doc.search.open}
              onClick={() => {
                // A toggle: the shortcut (⌘F) only ever opens or focuses it.
                if (doc.search.open) workspace.getState().closeSearch(doc.key);
                else onCommand('find');
              }}
              shortcut={shortcut('find')}
            />
          </ToolbarPrimitive.Button>
        </>
      ) : null}

      <ToolbarPrimitive.Button asChild>
        <IconButton
          label={`${themeLabel}. Switch to ${nextTheme}`}
          icon={<ThemeIcon size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          onClick={() => setTheme(nextThemePreference(theme))}
        />
      </ToolbarPrimitive.Button>
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label="Properties panel"
          icon={<PanelRight size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          pressed={doc !== null && rightPanelOpen}
          disabled={doc === null}
          onClick={toggleRightPanel}
          shortcut={shortcut('toggle-right-panel')}
        />
      </ToolbarPrimitive.Button>
    </ToolbarPrimitive.Root>
  );
}
