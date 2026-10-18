import { primarySource } from '@folio/document-model';
import {
  Button,
  ICON,
  IconButton,
  Kbd,
  nextThemePreference,
  type ThemePreference,
} from '@folio/shared-ui';
import { FolderOpen, Monitor, Moon, PanelLeft, PanelRight, Sun } from 'lucide-react';
import { Toolbar as ToolbarPrimitive } from 'radix-ui';
import { COMMAND_SHORTCUTS } from '../commands';
import { useActiveDocument, useUi, useWorkspaceContext } from '../context';
import { formatBytes } from '../format';

const THEME_META: Record<ThemePreference, { label: string; Icon: typeof Sun }> = {
  system: { label: 'Theme: match system', Icon: Monitor },
  light: { label: 'Theme: light', Icon: Sun },
  dark: { label: 'Theme: dark', Icon: Moon },
};

export function WorkspaceToolbar({ onOpen }: { onOpen(): void }) {
  const { profile, shortcutPlatform } = useWorkspaceContext();
  const doc = useActiveDocument();
  const leftPanelOpen = useUi((state) => state.leftPanelOpen);
  const rightPanelOpen = useUi((state) => state.rightPanelOpen);
  const toggleLeftPanel = useUi((state) => state.toggleLeftPanel);
  const toggleRightPanel = useUi((state) => state.toggleRightPanel);
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const shortcuts = COMMAND_SHORTCUTS[profile];
  const ready = doc?.status === 'ready';
  const source = doc?.editor ? primarySource(doc.editor.model) : null;
  const { label: themeLabel, Icon: ThemeIcon } = THEME_META[theme];
  const nextTheme = THEME_META[nextThemePreference(theme)].label.replace('Theme: ', '');

  return (
    <ToolbarPrimitive.Root
      aria-label="Workspace"
      className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2"
    >
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label={leftPanelOpen ? 'Hide pages panel' : 'Show pages panel'}
          icon={<PanelLeft size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          pressed={ready && leftPanelOpen}
          disabled={!ready}
          onClick={toggleLeftPanel}
          shortcut={{ keys: shortcuts['toggle-left-panel'][0]!, platform: shortcutPlatform }}
        />
      </ToolbarPrimitive.Button>
      <ToolbarPrimitive.Separator className="mx-1 h-5 w-px bg-line" />
      <ToolbarPrimitive.Button asChild>
        <Button variant="ghost" onClick={onOpen}>
          <FolderOpen size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
          Open
          <Kbd
            shortcut={shortcuts.open[0]!}
            platform={shortcutPlatform}
            className="ml-1 text-ink-subtle"
          />
        </Button>
      </ToolbarPrimitive.Button>

      <div className="mx-3 flex min-w-0 flex-1 items-baseline gap-2">
        {doc ? (
          <>
            <h1 className="truncate text-sm font-semibold" title={doc.fileName}>
              {doc.editor?.model.metadata.title || doc.fileName}
            </h1>
            {source ? (
              <span className="shrink-0 text-xs text-ink-muted tabular">
                {source.pageCount} {source.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                {formatBytes(source.byteLength)}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <ToolbarPrimitive.Button asChild>
        <IconButton
          label={`${themeLabel}. Switch to ${nextTheme}`}
          icon={<ThemeIcon size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          onClick={() => setTheme(nextThemePreference(theme))}
        />
      </ToolbarPrimitive.Button>
      <ToolbarPrimitive.Button asChild>
        <IconButton
          label={rightPanelOpen ? 'Hide properties panel' : 'Show properties panel'}
          icon={<PanelRight size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          pressed={doc !== null && rightPanelOpen}
          disabled={doc === null}
          onClick={toggleRightPanel}
          shortcut={{ keys: shortcuts['toggle-right-panel'][0]!, platform: shortcutPlatform }}
        />
      </ToolbarPrimitive.Button>
    </ToolbarPrimitive.Root>
  );
}
