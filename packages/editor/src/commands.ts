import type { AppCommand } from '@folio/platform-adapters';

export type ShortcutProfile = 'desktop' | 'browser';

/**
 * Shortcut notation per command (see `matchesShortcut`). The browser profile
 * avoids keys Chrome reserves for itself (Ctrl/⌘+W, Ctrl+Tab, Ctrl+T, …),
 * which pages cannot intercept.
 */
export const COMMAND_SHORTCUTS: Record<ShortcutProfile, Record<AppCommand, readonly string[]>> = {
  desktop: {
    open: ['Mod+O'],
    'close-tab': ['Mod+W'],
    'next-tab': ['Ctrl+Tab'],
    'previous-tab': ['Ctrl+Shift+Tab'],
    'toggle-left-panel': ['Mod+Alt+1'],
    'toggle-right-panel': ['Mod+Alt+2'],
    'cycle-theme': [],
  },
  browser: {
    open: ['Mod+O'],
    'close-tab': ['Alt+W'],
    'next-tab': ['Alt+PageDown'],
    'previous-tab': ['Alt+PageUp'],
    'toggle-left-panel': ['Mod+Alt+1'],
    'toggle-right-panel': ['Mod+Alt+2'],
    'cycle-theme': [],
  },
};

export const COMMAND_LABELS: Record<AppCommand, string> = {
  open: 'Open PDF…',
  'close-tab': 'Close document',
  'next-tab': 'Next document',
  'previous-tab': 'Previous document',
  'toggle-left-panel': 'Toggle pages panel',
  'toggle-right-panel': 'Toggle properties panel',
  'cycle-theme': 'Switch theme',
};

/**
 * A native menu accelerator and the web keyboard handler can both fire for the
 * same key press, depending on platform and focus. Identical commands within
 * this window are treated as one.
 */
export const COMMAND_DEDUPE_MS = 120;
