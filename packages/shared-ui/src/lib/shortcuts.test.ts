import { describe, expect, it } from 'vitest';
import { formatShortcut, matchesShortcut, shortcutLabel } from './shortcuts';

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('shortcuts', () => {
  it('formats per platform', () => {
    expect(formatShortcut('Mod+Shift+O', 'macos')).toEqual(['⌘', '⇧', 'O']);
    expect(shortcutLabel('Mod+Shift+O', 'macos')).toBe('⌘⇧O');
    expect(shortcutLabel('Mod+Shift+O', 'other')).toBe('Ctrl+Shift+O');
  });

  it('matches Mod to Cmd on macOS and Ctrl elsewhere', () => {
    expect(matchesShortcut(key('o', { metaKey: true }), 'Mod+O', 'macos')).toBe(true);
    expect(matchesShortcut(key('o', { ctrlKey: true }), 'Mod+O', 'macos')).toBe(false);
    expect(matchesShortcut(key('o', { ctrlKey: true }), 'Mod+O', 'other')).toBe(true);
    expect(matchesShortcut(key('o', { ctrlKey: true, shiftKey: true }), 'Mod+O', 'other')).toBe(false);
  });

  it('matches Ctrl+Tab literally on every platform', () => {
    expect(matchesShortcut(key('Tab', { ctrlKey: true }), 'Ctrl+Tab', 'macos')).toBe(true);
    expect(matchesShortcut(key('Tab', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Tab', 'other')).toBe(true);
    expect(matchesShortcut(key('Tab', { ctrlKey: true }), 'Ctrl+Shift+Tab', 'other')).toBe(false);
  });

  it('matches letters and digits by physical key when modifiers change the character', () => {
    expect(matchesShortcut({ ...key('¡', { metaKey: true, altKey: true }), code: 'Digit1' }, 'Mod+Alt+1', 'macos')).toBe(true);
    expect(matchesShortcut({ ...key('ø', { metaKey: true }), code: 'KeyO' }, 'Mod+O', 'macos')).toBe(true);
    expect(matchesShortcut({ ...key('o', { metaKey: true }), code: 'KeyP' }, 'Mod+O', 'macos')).toBe(false);
  });

  it('ignores Shift for symbol keys', () => {
    expect(matchesShortcut(key('\\', { metaKey: true }), 'Mod+\\', 'macos')).toBe(true);
  });
});
