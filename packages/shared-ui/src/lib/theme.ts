import { useEffect, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const QUERY = '(prefers-color-scheme: dark)';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(current);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length]!;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

function subscribe(callback: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const list = matchMedia(QUERY);
  list.addEventListener('change', callback);
  return () => list.removeEventListener('change', callback);
}

export function applyTheme(
  theme: ResolvedTheme,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = theme;
}

/** Applies the system theme before React renders, avoiding a flash of the wrong theme. */
export function applyInitialTheme(preference: ThemePreference = 'system'): void {
  applyTheme(resolveTheme(preference, systemPrefersDark()));
}

/** Resolves and applies a theme preference, following OS changes while set to "system". */
export function useTheme(preference: ThemePreference): ResolvedTheme {
  const systemDark = useSyncExternalStore(subscribe, systemPrefersDark, () => false);
  const resolved = resolveTheme(preference, systemDark);
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);
  return resolved;
}
