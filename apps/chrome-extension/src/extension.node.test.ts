import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeMismatches } from '@folio/platform-adapters';
import { describe, expect, it } from 'vitest';
import {
  appendActivity,
  describeActivity,
  redactActivity,
  ACTIVITY_LIMIT,
  type ActivityEntry,
} from './shared/activity';
import { parseMessage } from './shared/messages';
import { PERMISSION_EXPLANATIONS } from './shared/permissions';
import { DEFAULT_SETTINGS, parseSettings } from './shared/settings';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'manifest.json'), 'utf8'));

describe('manifest', () => {
  it('is a Manifest V3 extension with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('requests only the permissions it uses, with no host access', () => {
    expect(manifest.permissions).toEqual(['storage', 'sidePanel']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it('explains every permission it requests', () => {
    expect(Object.keys(PERMISSION_EXPLANATIONS).sort()).toEqual([...manifest.permissions].sort());
  });

  it('allows no remote code', () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval';/);
    expect(csp).not.toMatch(/https?:|'unsafe-eval'|'unsafe-inline'/);
  });
});

describe('capabilities', () => {
  it('match what the Chrome adapter reports', async () => {
    // Imported lazily: the adapter module touches `chrome` only when called.
    const { CHROME_FEATURES } = await import('./platform/chrome-adapter');
    expect(runtimeMismatches(CHROME_FEATURES, 'chrome')).toEqual([]);
  });
});

describe('messages', () => {
  it('accepts well-formed messages', () => {
    expect(parseMessage({ type: 'status/get' })).toEqual({ type: 'status/get' });
    expect(parseMessage({ type: 'activity/record', kind: 'opened', pageCount: 3 })).not.toBeNull();
    expect(parseMessage({ type: 'editor/open', handoffId: 'a'.repeat(32) })).not.toBeNull();
  });

  it('rejects unknown, malformed and oversized messages', () => {
    expect(parseMessage({ type: 'nope' })).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage({ type: 'editor/open', handoffId: '../x' })).toBeNull();
    expect(parseMessage({ type: 'activity/record', kind: 'opened', pageCount: 1.5 })).toBeNull();
    expect(
      parseMessage({ type: 'activity/record', kind: 'opened', fileName: 'x'.repeat(300) }),
    ).toBeNull();
    const circular: Record<string, unknown> = { type: 'status/get' };
    circular.self = circular;
    expect(parseMessage(circular)).toBeNull();
  });
});

describe('activity', () => {
  const now = new Date('2026-10-18T10:00:00Z');

  it('stores counts but drops file names unless allowed', () => {
    const [entry] = appendActivity(
      [],
      { kind: 'opened', pageCount: 3, fileName: 'salary.pdf' },
      DEFAULT_SETTINGS,
      now,
      'a',
    );
    expect(entry).toEqual({
      id: 'a',
      at: now.toISOString(),
      kind: 'opened',
      pageCount: 3,
      fileName: null,
    });
    const [named] = appendActivity(
      [],
      { kind: 'opened', fileName: 'salary.pdf' },
      { ...DEFAULT_SETTINGS, activityIncludesNames: true },
      now,
      'b',
    );
    expect(named?.fileName).toBe('salary.pdf');
    expect(describeActivity(entry!)).toBe('Opened a PDF · 3 pages');
  });

  it('records nothing when disabled and caps the log', () => {
    expect(
      appendActivity(
        [],
        { kind: 'opened' },
        { ...DEFAULT_SETTINGS, activityEnabled: false },
        now,
        'a',
      ),
    ).toEqual([]);
    let log: ActivityEntry[] = [];
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i += 1)
      log = appendActivity(log, { kind: 'opened' }, DEFAULT_SETTINGS, now, `${i}`);
    expect(log).toHaveLength(ACTIVITY_LIMIT);
    expect(log[0]?.id).toBe(`${ACTIVITY_LIMIT + 4}`);
  });

  it('redacts stored names', () => {
    const log = appendActivity(
      [],
      { kind: 'opened', fileName: 'a.pdf' },
      { ...DEFAULT_SETTINGS, activityIncludesNames: true },
      now,
      'a',
    );
    expect(redactActivity(log)[0]?.fileName).toBeNull();
  });

  it('falls back to safe defaults for corrupted settings', () => {
    expect(parseSettings({ activityEnabled: 'yes' })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.activityIncludesNames).toBe(false);
  });
});
