import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_MATRIX,
  capability,
  renderCapabilityMarkdown,
  runtimeMismatches,
} from './capabilities';
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

  it('reserves Full for what works today', () => {
    for (const entry of CAPABILITY_MATRIX) {
      for (const [target, support] of Object.entries(entry.targets)) {
        if (support.level !== 'full') continue;
        expect(support.note ?? '', `${entry.id}/${target} is conditional`).not.toMatch(
          /\bonce\b|\bwill\b|\bnot yet\b|\bpending\b|\bplanned\b/i,
        );
      }
    }
  });

  it('claims no manual checks (none have been recorded)', () => {
    for (const entry of CAPABILITY_MATRIX) {
      const notes = Object.values(entry.targets).map((support) => support.note ?? '');
      expect([entry.verification, ...notes].join(' '), entry.id).not.toMatch(/manual/i);
    }
  });

  it('keeps native integration Limited on macOS and Windows until tried on a real machine', () => {
    // Implemented and compiled in the macOS and Windows CI builds, but not yet
    // run on that OS. Remove a target once it has been verified there.
    const both = ['macos', 'windows'] as const;
    const untested: Record<string, ReadonlyArray<'macos' | 'windows'>> = {
      'open-picker': both,
      'open-drag-drop': both,
      // Tried on a Mac (release build, macOS 26): Finder open events, launch arguments.
      'open-file-association': ['windows'],
      'native-menus': both,
      shortcuts: both,
      'zoom-rotate-view': both,
      'export-pdf': both,
      clipboard: both,
      // Tried on a Mac: Save wrote filled-in form values and recognized text back.
      save: ['windows'],
      printing: both,
      recovery: both,
      'recent-files': both,
      'single-instance': both,
      'native-messaging': both,
    };
    for (const [id, targets] of Object.entries(untested)) {
      const entry = capability(id);
      expect(entry.plannedPhase, id).not.toBeNull();
      for (const target of targets) {
        expect(entry.targets[target].level, `${id}/${target}`).toBe('limited');
        expect(entry.targets[target].note, `${id}/${target}`).toMatch(
          /not yet verified on a real (Mac|Windows PC)\.$/,
        );
      }
    }
    // And nothing else claims to be unverified while rated Full.
    for (const entry of CAPABILITY_MATRIX) {
      for (const [target, support] of Object.entries(entry.targets)) {
        if (/not yet verified/.test(support.note ?? '')) {
          expect(support.level, `${entry.id}/${target}`).toBe('limited');
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
    // What the extension reports, plus a feature it does not have.
    const chrome = {
      ...WEB_FEATURES,
      openFromUrl: true,
      browserTabIntegration: true,
      nativeMessaging: true,
    };
    expect(runtimeMismatches(chrome, 'chrome')).toEqual([]);
    expect(runtimeMismatches({ ...chrome, fileAssociations: true }, 'chrome')).toEqual([
      expect.stringContaining('open-file-association'),
    ]);
  });
});
