import { describe, expect, it } from 'vitest';
import {
  activateIn,
  afterClose,
  paneKeys,
  setSplit,
  showIn,
  SINGLE_PANE,
  type Focus,
} from './split';

const single = (activeKey: string | null, otherKey: string | null = null): Focus => ({
  activeKey,
  split: { ...SINGLE_PANE, otherKey },
});
const split = (left: string | null, right: string | null, active: 'left' | 'right'): Focus => ({
  activeKey: active === 'left' ? left : right,
  split: { on: true, otherKey: active === 'left' ? right : left, activeSide: active },
});

describe('split view panes', () => {
  it('remembers the previous document while there is one pane', () => {
    let focus = single(null);
    focus = activateIn(focus, 'a');
    expect(focus).toEqual(single('a'));
    focus = activateIn(focus, 'b');
    expect(focus).toEqual(single('b', 'a'));
    focus = activateIn(focus, 'c');
    expect(focus).toEqual(single('c', 'b'));
    expect(activateIn(focus, 'c')).toBe(focus);
  });

  it('turns on with the active document on the left and the previous one beside it', () => {
    const keys = ['a', 'b', 'c'];
    expect(paneKeys(setSplit(single('c', 'a'), true, keys))).toEqual({ left: 'c', right: 'a' });
    // A closed or unknown document is replaced by the tab next to the active one.
    expect(paneKeys(setSplit(single('b', 'gone'), true, keys))).toEqual({
      left: 'b',
      right: 'c',
    });
    expect(paneKeys(setSplit(single('c', null), true, keys))).toEqual({ left: 'c', right: 'b' });
    // One document leaves the right pane empty.
    expect(paneKeys(setSplit(single('a'), true, ['a']))).toEqual({ left: 'a', right: null });
    // Off keeps the documents for next time.
    const on = split('a', 'b', 'right');
    expect(setSplit(on, false, keys)).toEqual({
      activeKey: 'b',
      split: { on: false, otherKey: 'a', activeSide: 'right' },
    });
    expect(setSplit(on, true, keys)).toBe(on);
  });

  it('keeps documents in their panes when focus moves between them', () => {
    const focus = split('a', 'b', 'left');
    const moved = activateIn(focus, 'b');
    expect(moved).toEqual(split('a', 'b', 'right'));
    expect(activateIn(moved, 'a')).toEqual(focus);
  });

  it('shows another tab in the focused pane, or in an empty one', () => {
    expect(activateIn(split('a', 'b', 'right'), 'c')).toEqual(split('a', 'c', 'right'));
    expect(activateIn(split('a', 'b', 'left'), 'c')).toEqual(split('c', 'b', 'left'));
    expect(activateIn(split('a', null, 'left'), 'c')).toEqual(split('a', 'c', 'right'));
  });

  it('shows a document in a chosen pane, trading places with the other pane', () => {
    // The other pane picks a new document and gets focus.
    expect(showIn(split('a', 'b', 'left'), 'right', 'c')).toEqual(split('a', 'c', 'right'));
    // Picking the document of the other pane swaps them.
    expect(showIn(split('a', 'b', 'left'), 'left', 'b')).toEqual(split('b', 'a', 'left'));
    expect(showIn(split('a', null, 'left'), 'right', 'a')).toEqual(split(null, 'a', 'right'));
    // The empty pane is filled.
    expect(showIn(split('a', null, 'left'), 'right', 'b')).toEqual(split('a', 'b', 'right'));
  });

  it('fills the pane of a closed document with the next tab, else moves focus across', () => {
    // The other document closes: its pane empties.
    expect(afterClose(split('a', 'b', 'left'), 'b', ['a', 'c'], 1)).toEqual(
      split('a', null, 'left'),
    );
    // The active one closes: the next tab not shown in the other pane takes its place.
    expect(afterClose(split('a', 'b', 'left'), 'a', ['b', 'c'], 0)).toEqual(
      split('c', 'b', 'left'),
    );
    expect(afterClose(split('a', 'b', 'right'), 'b', ['a'], 1)).toEqual(split('a', null, 'left'));
    expect(afterClose(split('a', null, 'left'), 'a', [], 0)).toEqual(split(null, null, 'left'));
    // One pane: the neighbouring tab, as always.
    expect(afterClose(single('b', 'a'), 'b', ['a', 'c'], 1)).toEqual(single('c', 'a'));
    expect(afterClose(single('b', 'c'), 'b', ['a', 'c'], 1)).toEqual(single('c', null));
    expect(afterClose(single('b', 'a'), 'a', ['b'], 0)).toEqual(single('b', null));
  });
});
