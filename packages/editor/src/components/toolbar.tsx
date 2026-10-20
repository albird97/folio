import { primarySource } from '@folio/document-model';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ICON,
  IconButton,
  Kbd,
  nextThemePreference,
  type ThemePreference,
} from '@folio/shared-ui';
import {
  ChevronDown,
  Columns2,
  Download,
  FolderOpen,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Printer,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Sun,
  Wrench,
} from 'lucide-react';
import { Toolbar as ToolbarPrimitive } from 'radix-ui';
import type { AppCommand } from '@folio/platform-adapters';
import { COMMAND_LABELS, COMMAND_SHORTCUTS } from '../commands';
import { useActiveDocument, useUi, useWorkspaceContext } from '../context';
import { formatBytes } from '../format';
import { useSaveAs } from '../hooks/use-save-as';
import { useSendToDesktop } from '../hooks/use-send-to-desktop';
import { PageControls, ZoomControls } from './viewer-controls';

const THEME_META: Record<ThemePreference, { label: string; Icon: typeof Sun }> = {
  system: { label: 'Theme: match system', Icon: Monitor },
  light: { label: 'Theme: light', Icon: Sun },
  dark: { label: 'Theme: dark', Icon: Moon },
};

const Separator = () => <ToolbarPrimitive.Separator className="mx-1 h-5 w-px bg-line" />;

/** The Tools menu, in groups (the same as the desktop app's Tools menu). */
const TOOL_GROUPS: readonly (readonly AppCommand[])[] = [
  ['sign'],
  ['page-numbers', 'watermark'],
  ['recognize-text'],
  ['export-images', 'export-text', 'reduce-file-size', 'protect'],
  ['ask-ai'],
];

/** Menu labels end in "…" like the commands; sentence case like the rest of the UI. */
function ToolsMenu({
  disabled,
  onCommand,
}: {
  disabled: boolean;
  onCommand(command: AppCommand): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <ToolbarPrimitive.Button asChild>
          <Button variant="ghost" disabled={disabled}>
            <Wrench size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
            Tools
            <ChevronDown size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
          </Button>
        </ToolbarPrimitive.Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {TOOL_GROUPS.map((group, index) => (
          <div key={group[0]}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group.map((command) => (
              <DropdownMenuItem key={command} onSelect={() => onCommand(command)}>
                {COMMAND_LABELS[command]}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceToolbar({ onCommand }: { onCommand(command: AppCommand): void }) {
  const { adapter, workspace, profile, shortcutPlatform } = useWorkspaceContext();
  const doc = useActiveDocument();
  const leftPanelOpen = useUi((state) => state.leftPanelOpen);
  const rightPanelOpen = useUi((state) => state.rightPanelOpen);
  const toggleLeftPanel = useUi((state) => state.toggleLeftPanel);
  const toggleRightPanel = useUi((state) => state.toggleRightPanel);
  const splitView = useUi((state) => state.splitView);
  const toggleSplitView = useUi((state) => state.toggleSplitView);
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
  const sendToDesktop = useSendToDesktop();
  const inPlace = adapter.features.saveInPlace && doc?.saveTarget != null;

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
      {adapter.features.openFromUrl && adapter.openUrl ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarPrimitive.Button asChild>
              <IconButton
                label="More ways to open"
                size="icon-sm"
                className="-ml-1 w-5"
                icon={<ChevronDown size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />}
              />
            </ToolbarPrimitive.Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onCommand('open')}>Open a PDF…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCommand('open-url')}>
              Open from a web address…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {adapter.features.saveCopy ? (
        <>
          <ToolbarPrimitive.Button asChild>
            {inPlace ? (
              <IconButton
                label="Save"
                icon={<Save size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
                disabled={!ready}
                onClick={() => onCommand('save')}
                shortcut={shortcut('save')}
              />
            ) : (
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
            )}
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
              {inPlace ? (
                <DropdownMenuItem onSelect={() => onCommand('save')}>Save</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => doc && void saveAs(doc.key)}>
                {desktop ? 'Save as…' : 'Download PDF'}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!doc?.permissions.modify}
                onSelect={() => doc && void saveAs(doc.key, { flatten: true })}
              >
                {desktop ? 'Save with comments flattened…' : 'Download with comments flattened'}
              </DropdownMenuItem>
              {doc?.info && doc.info.forms !== 'none' ? (
                <DropdownMenuItem
                  disabled={!doc.permissions.modify}
                  onSelect={() => void saveAs(doc.key, { flattenForms: true })}
                >
                  {desktop ? 'Save with form flattened…' : 'Download with form flattened'}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => onCommand('save-copy')}>
                {desktop ? 'Save a copy of the original…' : 'Download the original'}
              </DropdownMenuItem>
              {sendToDesktop ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => doc && sendToDesktop(doc.key)}>
                    Open in Folio for desktop…
                  </DropdownMenuItem>
                </>
              ) : null}
              {adapter.features.printing ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onCommand('print')}>Print…</DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
      {adapter.features.printing ? (
        <ToolbarPrimitive.Button asChild>
          <IconButton
            label="Print…"
            icon={<Printer size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
            disabled={!ready}
            onClick={() => onCommand('print')}
            shortcut={shortcut('print')}
          />
        </ToolbarPrimitive.Button>
      ) : null}
      <ToolsMenu disabled={!ready} onCommand={onCommand} />

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
          label={COMMAND_LABELS['toggle-split-view']}
          icon={<Columns2 size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          pressed={doc !== null && splitView}
          disabled={doc === null}
          onClick={toggleSplitView}
          shortcut={shortcut('toggle-split-view')}
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
