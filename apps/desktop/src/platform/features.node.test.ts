import { runtimeMismatches } from '@folio/platform-adapters';
import { describe, expect, it } from 'vitest';
import { TAURI_FEATURES } from './features';

describe('desktop runtime features', () => {
  it.each(['macos', 'windows'] as const)('match the capability matrix for %s', (target) => {
    expect(runtimeMismatches(TAURI_FEATURES, target)).toEqual([]);
  });
});
