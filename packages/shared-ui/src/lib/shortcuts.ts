export type ShortcutPlatform = 'macos' | 'other';

/**
 * Shortcut notation: "Mod+O", "Mod+Shift+]", "Ctrl+Tab". `Mod` is ⌘ on macOS
 * and Ctrl elsewhere. The plus key is written "Plus" ("Mod+Plus").
 */
const KEY_NAMES: Record<string, string> = { Plus: '+' };

export function formatShortcut(shortcut: string, platform: ShortcutPlatform): string[] {
  return shortcut.split('+').map((token) => {
    const part = KEY_NAMES[token] ?? token;
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
  getModifierState?(key: string): boolean;
}

/** Whether a shortcut is held with Ctrl or ⌘, so it never types text. */
export function usesCommandModifier(shortcut: string): boolean {
  const modifiers = shortcut.split('+').slice(0, -1);
  return modifiers.includes('Mod') || modifiers.includes('Ctrl');
}

/**
 * Whether a shortcut may run while a text field has focus: Ctrl/⌘ shortcuts
 * and function keys (F3 is "find next" in text fields too) never type text.
 */
export function worksInTextFields(shortcut: string): boolean {
  return (
    usesCommandModifier(shortcut) || /^F([1-9]|1[0-9]|2[0-4])$/.test(shortcut.split('+').at(-1)!)
  );
}

/** Matches a keyboard event against shortcut notation. */
export function matchesShortcut(
  event: KeyLike,
  shortcut: string,
  platform: ShortcutPlatform,
): boolean {
  // AltGr types characters ("@" is AltGr+2 on Spanish keyboards). Windows
  // reports it as Ctrl+Alt, which would otherwise look like Mod+Alt.
  if (event.getModifierState?.('AltGraph')) return false;
  const parts = shortcut.split('+');
  const key = KEY_NAMES[parts.at(-1)!] ?? parts.at(-1)!;
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
  // Letters follow the keyboard layout (⌘Z on AZERTY is the key labelled Z,
  // whose `code` is KeyW). Only when a modifier or a non-Latin layout turns the
  // key into another character (⌥W is "∑" on a Mac) does the physical key decide.
  if (/^[a-z]$/i.test(key) && !/^[a-z]$/i.test(event.key) && event.code) {
    return event.code === `Key${key.toUpperCase()}`;
  }
  // Digits match on the physical key: Option/Alt and Shift change `key` (⌥1 is
  // "¡" on a Mac keyboard, and AZERTY types digits with Shift) but not `code`.
  if (event.code && /^[0-9]$/.test(key)) return event.code === `Digit${key}`;
  return event.key.toLowerCase() === key.toLowerCase();
}
