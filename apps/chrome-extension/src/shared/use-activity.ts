import { useEffect, useState } from 'react';
import type { ActivityEntry } from './activity';
import {
  ACTIVITY_KEY,
  DEFAULT_SETTINGS,
  parseSettings,
  SETTINGS_KEY,
  type ExtensionSettings,
} from './settings';

/** Live view of the activity log and privacy settings in chrome.storage.local. */
export function useActivity() {
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let active = true;
    void chrome.storage.local.get([ACTIVITY_KEY, SETTINGS_KEY]).then((values) => {
      if (!active) return;
      setActivity(
        Array.isArray(values[ACTIVITY_KEY]) ? (values[ACTIVITY_KEY] as ActivityEntry[]) : [],
      );
      setSettings(parseSettings(values[SETTINGS_KEY]));
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (ACTIVITY_KEY in changes) {
        const next = changes[ACTIVITY_KEY]?.newValue;
        setActivity(Array.isArray(next) ? (next as ActivityEntry[]) : []);
      }
      if (SETTINGS_KEY in changes) setSettings(parseSettings(changes[SETTINGS_KEY]?.newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return { activity, settings };
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (seconds < 60) return format.format(-seconds, 'second');
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86_400) return format.format(-Math.round(seconds / 3600), 'hour');
  return format.format(-Math.round(seconds / 86_400), 'day');
}
