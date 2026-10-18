import { describe, expect, it } from 'vitest';
import {
  formatShortcut,
  matchesShortcut,
  shortcutLabel,
  usesCommandModifier,
  worksInTextFields,
} from './shortcuts';

const key = (
  k: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {},
) => ({
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
    expect(matchesShortcut(key('o', { ctrlKey: true, shiftKey: true }), 'Mod+O', 'other')).toBe(
      false,
    );
  });

  it('matches Ctrl+Tab literally on every platform', () => {
    expect(matchesShortcut(key('Tab', { ctrlKey: true }), 'Ctrl+Tab', 'macos')).toBe(true);
    expect(
      matchesShortcut(key('Tab', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Tab', 'other'),
    ).toBe(true);
    expect(matchesShortcut(key('Tab', { ctrlKey: true }), 'Ctrl+Shift+Tab', 'other')).toBe(false);
  });

  it('matches by physical key when modifiers change the character', () => {
    expect(
      matchesShortcut(
        { ...key('¡', { metaKey: true, altKey: true }), code: 'Digit1' },
        'Mod+Alt+1',
        'macos',
      ),
    ).toBe(true);
    expect(
      matchesShortcut({ ...key('ø', { metaKey: true }), code: 'KeyO' }, 'Mod+O', 'macos'),
    ).toBe(true);
    expect(
      matchesShortcut({ ...key('ø', { metaKey: true }), code: 'KeyP' }, 'Mod+O', 'macos'),
    ).toBe(false);
    // AZERTY types digits with Shift; without it the 2 key is "é".
    expect(
      matchesShortcut(
        { ...key('é', { ctrlKey: true, altKey: true }), code: 'Digit2' },
        'Mod+Alt+2',
        'other',
      ),
    ).toBe(true);
  });

  it('matches letters by the layout, not the US position of the key', () => {
    // French AZERTY: the key labelled Z sits where QWERTY has W, and vice versa.
    expect(
      matchesShortcut({ ...key('z', { ctrlKey: true }), code: 'KeyW' }, 'Mod+W', 'other'),
    ).toBe(false);
    expect(
      matchesShortcut({ ...key('z', { metaKey: true }), code: 'KeyW' }, 'Mod+W', 'macos'),
    ).toBe(false);
    expect(
      matchesShortcut({ ...key('w', { ctrlKey: true }), code: 'KeyZ' }, 'Mod+W', 'other'),
    ).toBe(true);
    expect(matchesShortcut({ ...key('z', { altKey: true }), code: 'KeyW' }, 'Alt+W', 'other')).toBe(
      false,
    );
    // Dvorak: O is typed on the QWERTY S key, and the QWERTY O key types R.
    expect(
      matchesShortcut({ ...key('o', { ctrlKey: true }), code: 'KeyS' }, 'Mod+O', 'other'),
    ).toBe(true);
    expect(
      matchesShortcut({ ...key('r', { ctrlKey: true }), code: 'KeyO' }, 'Mod+O', 'other'),
    ).toBe(false);
    expect(
      matchesShortcut(
        { ...key('O', { ctrlKey: true, shiftKey: true }), code: 'KeyO' },
        'Mod+Shift+O',
        'other',
      ),
    ).toBe(true);
  });

  it('falls back to the physical key when the layout types no Latin letter', () => {
    expect(matchesShortcut({ ...key('∑', { altKey: true }), code: 'KeyW' }, 'Alt+W', 'macos')).toBe(
      true,
    );
    // Russian layout: the QWERTY O key types "щ".
    expect(
      matchesShortcut({ ...key('щ', { ctrlKey: true }), code: 'KeyO' }, 'Mod+O', 'other'),
    ).toBe(true);
    expect(matchesShortcut(key('щ', { ctrlKey: true }), 'Mod+O', 'other')).toBe(false);
  });

  it('never matches while AltGr is held', () => {
    // Windows reports AltGr as Ctrl+Alt; AltGr+2 types "@" on Spanish keyboards.
    const altGr = (k: string, code: string) => ({
      ...key(k, { ctrlKey: true, altKey: true }),
      code,
      getModifierState: (modifier: string) => modifier === 'AltGraph',
    });
    expect(matchesShortcut(altGr('@', 'Digit2'), 'Mod+Alt+2', 'other')).toBe(false);
    expect(matchesShortcut(altGr('|', 'Digit1'), 'Mod+Alt+1', 'other')).toBe(false);
    expect(
      matchesShortcut(
        { ...altGr('@', 'Digit2'), getModifierState: () => false },
        'Mod+Alt+2',
        'other',
      ),
    ).toBe(true);
  });

  it('ignores Shift for symbol keys', () => {
    expect(matchesShortcut(key('\\', { metaKey: true }), 'Mod+\\', 'macos')).toBe(true);
  });

  it('tells shortcuts held with Ctrl or ⌘ apart from ones that could type text', () => {
    expect(usesCommandModifier('Mod+O')).toBe(true);
    expect(usesCommandModifier('Ctrl+Shift+Tab')).toBe(true);
    expect(usesCommandModifier('Alt+W')).toBe(false);
    expect(usesCommandModifier('Alt+PageDown')).toBe(false);
    // Function keys never type text either, so they also work in fields.
    expect(worksInTextFields('F3')).toBe(true);
    expect(worksInTextFields('Shift+F3')).toBe(true);
    expect(worksInTextFields('Mod+G')).toBe(true);
    expect(worksInTextFields('Alt+W')).toBe(false);
    expect(worksInTextFields('F')).toBe(false);
  });

  it('names the plus key and does not require Shift for symbols', () => {
    expect(shortcutLabel('Mod+Plus', 'other')).toBe('Ctrl++');
    expect(matchesShortcut(key('+', { ctrlKey: true, shiftKey: true }), 'Mod+Plus', 'other')).toBe(
      true,
    );
    expect(matchesShortcut(key('=', { metaKey: true }), 'Mod+=', 'macos')).toBe(true);
    expect(matchesShortcut(key('-', { ctrlKey: true }), 'Mod+-', 'other')).toBe(true);
    expect(
      matchesShortcut({ ...key('F3', { shiftKey: true }), code: 'F3' }, 'Shift+F3', 'other'),
    ).toBe(true);
    expect(matchesShortcut({ ...key('F3'), code: 'F3' }, 'Shift+F3', 'other')).toBe(false);
  });
});
