import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  createEditorState,
  execute,
  isDirty,
  markSaved,
  redo,
  redoLabel,
  undo,
  undoLabel,
} from './history';
import { sampleModel } from './test-helpers';

describe('history', () => {
  it('undoes and redoes operations exactly', () => {
    const initial = createEditorState(sampleModel(3));
    const pageId = initial.model.pages[0]!.id;
    const rotated = execute(
      initial,
      { type: 'pages/rotate', pageIds: [pageId], delta: 90 },
      { label: 'Rotate page' },
    );
    expect(rotated.model.pages[0]!.rotation).toBe(90);
    expect(undoLabel(rotated)).toBe('Rotate page');

    const undone = undo(rotated);
    expect(undone.model).toEqual(initial.model);
    expect(canUndo(undone)).toBe(false);
    expect(canRedo(undone)).toBe(true);
    expect(redoLabel(undone)).toBe('Rotate page');

    const redone = redo(undone);
    expect(redone.model).toEqual(rotated.model);
  });

  it('clears the redo stack when a new operation runs', () => {
    let state = createEditorState(sampleModel(2));
    const pageId = state.model.pages[0]!.id;
    state = execute(state, { type: 'pages/rotate', pageIds: [pageId], delta: 90 }, { label: 'A' });
    state = undo(state);
    state = execute(state, { type: 'pages/rotate', pageIds: [pageId], delta: 180 }, { label: 'B' });
    expect(canRedo(state)).toBe(false);
    expect(state.model.pages[0]!.rotation).toBe(180);
  });

  it('tracks dirty state relative to the last save across undo and redo', () => {
    let state = createEditorState(sampleModel(2));
    const pageId = state.model.pages[0]!.id;
    expect(isDirty(state)).toBe(false);
    state = execute(state, { type: 'pages/rotate', pageIds: [pageId], delta: 90 }, { label: 'A' });
    expect(isDirty(state)).toBe(true);
    state = markSaved(state);
    expect(isDirty(state)).toBe(false);
    state = undo(state);
    expect(isDirty(state)).toBe(true);
    state = redo(state);
    expect(isDirty(state)).toBe(false);
  });

  it('enforces the history limit', () => {
    let state = createEditorState(sampleModel(1), 5);
    const pageId = state.model.pages[0]!.id;
    for (let i = 0; i < 12; i += 1) {
      state = execute(state, { type: 'pages/rotate', pageIds: [pageId], delta: 90 }, { label: `${i}` });
    }
    expect(state.history.past).toHaveLength(5);
    expect(undoLabel(state)).toBe('11');
  });

  it('coalesces consecutive metadata edits into one undo step', () => {
    let state = createEditorState(sampleModel(1));
    const original = state.model.metadata.title;
    for (const [index, title] of ['N', 'Ne', 'New'].entries()) {
      state = execute(
        state,
        { type: 'metadata/update', patch: { title } },
        { label: 'Edit title', coalesceKey: 'title', now: 1000 + index * 100 },
      );
    }
    expect(state.history.past).toHaveLength(1);
    expect(state.model.metadata.title).toBe('New');
    expect(undo(state).model.metadata.title).toBe(original);
  });

  it('does not coalesce across a save point or outside the time window', () => {
    let state = createEditorState(sampleModel(1));
    const edit = (title: string, now: number) =>
      execute(
        state,
        { type: 'metadata/update', patch: { title } },
        { label: 'Edit title', coalesceKey: 'title', now },
      );
    state = edit('A', 0);
    state = markSaved(state);
    state = edit('B', 10);
    expect(state.history.past).toHaveLength(2);
    expect(isDirty(state)).toBe(true);
    state = edit('C', 10_000);
    expect(state.history.past).toHaveLength(3);
  });

  it('never stores PDF bytes in history', () => {
    let state = createEditorState(sampleModel(500));
    const pageIds = state.model.pages.map((page) => page.id);
    for (let i = 0; i < 50; i += 1) {
      state = execute(state, { type: 'pages/rotate', pageIds: [pageIds[i]!], delta: 90 }, { label: 'r' });
    }
    // Each entry is a small, ID-only operation.
    const size = JSON.stringify(state.history).length;
    expect(size).toBeLessThan(50 * 400);
  });
});
