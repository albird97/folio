import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_MATRIX, renderCapabilityMarkdown, runtimeMismatches } from './capabilities';
import { WEB_FEATURES } from './web';

describe('capability matrix', () => {
  it('has unique ids and covers every target', () => {
    const ids = CAPABILITY_MATRIX.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CAPABILITY_MATRIX) {
      expect(Object.keys(entry.targets).sort()).toEqual(['chrome', 'macos', 'windows']);
    }
  });

  it('explains every limitation and plans every gap', () => {
    for (const entry of CAPABILITY_MATRIX) {
      for (const [target, support] of Object.entries(entry.targets)) {
        if (support.level === 'limited') {
          expect(support.note, `${entry.id}/${target} needs a note`).toBeTruthy();
        }
        const notApplicable = support.note === 'Not applicable.';
        if ((support.level === 'none' || support.level === 'limited') && !notApplicable) {
          expect(
            entry.plannedPhase !== null || /cannot|Not applicable/.test(support.note ?? ''),
            `${entry.id}/${target} needs a planned phase or an explanation`,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps PLATFORM_CAPABILITIES.md in sync (run `pnpm capabilities:generate`)', () => {
    const file = readFileSync(
      join(import.meta.dirname, '../../../PLATFORM_CAPABILITIES.md'),
      'utf8',
    );
    expect(file).toBe(renderCapabilityMarkdown());
  });

  it('flags adapters that claim unsupported features', () => {
    expect(runtimeMismatches({ ...WEB_FEATURES, nativeMessaging: true }, 'chrome')).toEqual([
      expect.stringContaining('native-messaging'),
    ]);
  });
});
