export type ShortcutPlatform = 'macos' | 'other';

/**
 * Shortcut notation: "Mod+O", "Mod+Shift+]", "Ctrl+Tab". `Mod` is ⌘ on macOS
 * and Ctrl elsewhere.
 */
export function formatShortcut(shortcut: string, platform: ShortcutPlatform): string[] {
  return shortcut.split('+').map((part) => {
    if (platform === 'macos') {
      switch (part) {
        case 'Mod':
          return '⌘';
        case 'Shift':
          return '⇧';
        case 'Alt':
          return '⌥';
        case 'Ctrl':
          return '⌃';
        default:
          return part;
      }
    }
    return part === 'Mod' ? 'Ctrl' : part;
  });
}

export function shortcutLabel(shortcut: string, platform: ShortcutPlatform): string {
  const parts = formatShortcut(shortcut, platform);
  return platform === 'macos' ? parts.join('') : parts.join('+');
}

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Matches a keyboard event against shortcut notation. */
export function matchesShortcut(
  event: KeyLike,
  shortcut: string,
  platform: ShortcutPlatform,
): boolean {
  const parts = shortcut.split('+');
  const key = parts.at(-1)!;
  const wants = new Set(parts.slice(0, -1));
  const mod = platform === 'macos' ? event.metaKey : event.ctrlKey;
  const ctrlRequired = wants.has('Ctrl') || (wants.has('Mod') && platform !== 'macos');
  const metaRequired = wants.has('Mod') && platform === 'macos';
  if (wants.has('Mod') && !mod) return false;
  if (event.ctrlKey !== ctrlRequired) return false;
  if (event.metaKey !== metaRequired) return false;
  if (event.altKey !== wants.has('Alt')) return false;
  // Shift changes `key` for symbols, so only enforce it for letters, digits and named keys.
  if (/^[a-z0-9]$/i.test(key) || key.length > 1) {
    if (event.shiftKey !== wants.has('Shift')) return false;
  }
  // Letters and digits match on the physical key: Option/Alt and Shift change
  // `key` (⌥1 is "¡" on a Mac keyboard) but not `code`.
  if (event.code && /^[a-z]$/i.test(key)) return event.code === `Key${key.toUpperCase()}`;
  if (event.code && /^[0-9]$/.test(key)) return event.code === `Digit${key}`;
  return event.key.toLowerCase() === key.toLowerCase();
}
