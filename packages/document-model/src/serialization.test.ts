import { describe, expect, it } from 'vitest';
import { createViewState } from './create';
import { createEditorState, execute, isDirty, markSaved } from './history';
import { parseRecoverySnapshot, serializeRecoverySnapshot, SnapshotError } from './serialization';
import { sampleModel } from './test-helpers';

function editedState() {
  let state = createEditorState(sampleModel(3));
  const [a, b, c] = state.model.pages.map((page) => page.id);
  state = execute(state, { type: 'pages/rotate', pageIds: [a!], delta: 270 }, { label: 'Rotate' });
  state = markSaved(state);
  state = execute(state, { type: 'pages/reorder', order: [c!, a!, b!] }, { label: 'Move' });
  state = execute(
    state,
    {
      type: 'metadata/update',
      patch: { title: 'Recovered', creationDate: '2026-01-15T09:30:00.000Z' },
    },
    { label: 'Title' },
  );
  return state;
}

describe('recovery snapshots', () => {
  it('round-trips the model, history, dirty state and view', () => {
    const state = editedState();
    const view = { ...createViewState(state.model), zoom: 1.5, zoomMode: 'custom' as const };
    const restored = parseRecoverySnapshot(serializeRecoverySnapshot(state, view));
    expect(restored.editor).toEqual(state);
    expect(restored.view).toEqual(view);
    expect(isDirty(restored.editor)).toBe(true);
  });

  it('rejects malformed input with typed errors', () => {
    const expectCode = (text: string, code: SnapshotError['code']) => {
      try {
        parseRecoverySnapshot(text);
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(SnapshotError);
        expect((error as SnapshotError).code).toBe(code);
      }
    };
    expectCode('{not json', 'invalid-json');
    expectCode('{"format":"something-else"}', 'unsupported-format');
    expectCode('{"format":"folio.recovery","formatVersion":99}', 'unsupported-format');

    const state = editedState();
    const valid = JSON.parse(serializeRecoverySnapshot(state, createViewState(state.model)));
    valid.editor.model.pages[0].rotation = 45;
    expectCode(JSON.stringify(valid), 'invalid-shape');
  });

  it('detects internally inconsistent snapshots', () => {
    const state = editedState();
    const valid = JSON.parse(serializeRecoverySnapshot(state, createViewState(state.model)));
    valid.view.currentPageId = 'page_ffffffffffffffffffffffff';
    expect(() => parseRecoverySnapshot(JSON.stringify(valid))).toThrowError(
      expect.objectContaining({ code: 'inconsistent' }) as Error,
    );
  });

  it('does not echo document content in validation errors', () => {
    const state = editedState();
    const valid = JSON.parse(serializeRecoverySnapshot(state, createViewState(state.model)));
    valid.editor.model.metadata.title = { secret: 'Quarterly salaries' };
    try {
      parseRecoverySnapshot(JSON.stringify(valid));
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('Quarterly');
    }
  });
});
