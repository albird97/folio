import type { AppCommand } from '@folio/platform-adapters';

export type ShortcutProfile = 'desktop' | 'browser';

/**
 * Shortcut notation per command (see `matchesShortcut`). The browser profile
 * avoids keys Chrome reserves for itself (Ctrl/⌘+W, Ctrl+Tab, Ctrl+T, …),
 * which pages cannot intercept.
 */
const SHARED: Omit<
  Record<AppCommand, readonly string[]>,
  'close-tab' | 'next-tab' | 'previous-tab'
> = {
  open: ['Mod+O'],
  'save-copy': ['Mod+Shift+S'],
  'toggle-left-panel': ['Mod+Alt+1'],
  'toggle-right-panel': ['Mod+Alt+2'],
  'cycle-theme': [],
  'zoom-in': ['Mod+=', 'Mod+Plus'],
  'zoom-out': ['Mod+-'],
  'zoom-actual-size': ['Mod+0'],
  'zoom-fit-width': [],
  'zoom-fit-page': [],
  'rotate-clockwise': [],
  'rotate-counterclockwise': [],
  'go-to-page': ['Mod+Alt+G'],
  find: ['Mod+F'],
  'find-next': ['Mod+G', 'F3'],
  'find-previous': ['Mod+Shift+G', 'Shift+F3'],
};

export const COMMAND_SHORTCUTS: Record<ShortcutProfile, Record<AppCommand, readonly string[]>> = {
  desktop: {
    ...SHARED,
    'close-tab': ['Mod+W'],
    'next-tab': ['Ctrl+Tab'],
    'previous-tab': ['Ctrl+Shift+Tab'],
    // ⌘R/⌘L rotate, as in macOS Preview. Browsers keep them for reload and the address bar.
    'rotate-clockwise': ['Mod+R'],
    'rotate-counterclockwise': ['Mod+L'],
  },
  browser: {
    ...SHARED,
    'close-tab': ['Alt+W'],
    'next-tab': ['Alt+PageDown'],
    'previous-tab': ['Alt+PageUp'],
  },
};

export const COMMAND_LABELS: Record<AppCommand, string> = {
  open: 'Open PDF…',
  'save-copy': 'Save a copy…',
  'close-tab': 'Close document',
  'next-tab': 'Next document',
  'previous-tab': 'Previous document',
  'toggle-left-panel': 'Toggle sidebar',
  'toggle-right-panel': 'Toggle properties panel',
  'cycle-theme': 'Switch theme',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'zoom-actual-size': 'Actual size',
  'zoom-fit-width': 'Fit width',
  'zoom-fit-page': 'Fit page',
  'rotate-clockwise': 'Rotate view clockwise',
  'rotate-counterclockwise': 'Rotate view counterclockwise',
  'go-to-page': 'Go to page…',
  find: 'Find…',
  'find-next': 'Find next',
  'find-previous': 'Find previous',
};

/**
 * A native menu accelerator and the web keyboard handler can both fire for the
 * same key press, depending on platform and focus. Identical commands within
 * this window are treated as one.
 */
export const COMMAND_DEDUPE_MS = 120;
