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
  'open-url': [],
  save: ['Mod+S'],
  'save-as': ['Mod+Shift+S'],
  'save-copy': ['Mod+Alt+S'],
  print: ['Mod+P'],
  undo: ['Mod+Z'],
  redo: ['Mod+Shift+Z', 'Mod+Y'],
  'toggle-left-panel': ['Mod+Alt+1'],
  'toggle-right-panel': ['Mod+Alt+2'],
  'toggle-split-view': ['Mod+Alt+3'],
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
  'insert-pages': [],
  'insert-blank-page': [],
  'rotate-pages-clockwise': [],
  'rotate-pages-counterclockwise': [],
  'delete-pages': [],
  'extract-pages': [],
  sign: [],
  'page-numbers': [],
  watermark: [],
  'recognize-text': [],
  'export-images': [],
  'export-text': [],
  'reduce-file-size': [],
  protect: [],
  'ask-ai': [],
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
  'open-url': 'Open from a web address…',
  save: 'Save',
  'save-as': 'Save as…',
  'save-copy': 'Save a copy of the original…',
  print: 'Print…',
  undo: 'Undo',
  redo: 'Redo',
  'close-tab': 'Close document',
  'next-tab': 'Next document',
  'previous-tab': 'Previous document',
  'toggle-left-panel': 'Toggle sidebar',
  'toggle-right-panel': 'Toggle properties panel',
  'toggle-split-view': 'Show two documents side by side',
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
  'insert-pages': 'Insert pages from a file…',
  'insert-blank-page': 'Insert a blank page',
  'rotate-pages-clockwise': 'Rotate pages clockwise',
  'rotate-pages-counterclockwise': 'Rotate pages counterclockwise',
  'delete-pages': 'Delete pages',
  'extract-pages': 'Extract pages…',
  sign: 'Add a signature…',
  'page-numbers': 'Page numbers…',
  watermark: 'Watermark…',
  'recognize-text': 'Recognize text (OCR)…',
  'export-images': 'Export pages as images…',
  'export-text': 'Export text…',
  'reduce-file-size': 'Reduce file size…',
  protect: 'Password protection…',
  'ask-ai': 'Ask Claude about this document…',
};

/**
 * A native menu accelerator and the web keyboard handler can both fire for the
 * same key press, depending on platform and focus. Identical commands within
 * this window are treated as one.
 */
export const COMMAND_DEDUPE_MS = 120;
