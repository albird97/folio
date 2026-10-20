export type PaneSide = 'left' | 'right';

/**
 * Split view: two open documents side by side. The active document (tabs,
 * toolbars, menus and shortcuts act on it) is in one pane; `otherKey` is in
 * the other. Tracked while split view is off too, so turning it on shows the
 * document that was active before the current one.
 */
export interface SplitPanes {
  on: boolean;
  /** The document in the pane without focus; null leaves that pane empty. */
  otherKey: string | null;
  /** The pane the active document is in. */
  activeSide: PaneSide;
}

export const SINGLE_PANE: SplitPanes = { on: false, otherKey: null, activeSide: 'left' };

/** Which document shows where, and which one is active. */
export interface Focus {
  activeKey: string | null;
  split: SplitPanes;
}

const otherSide = (side: PaneSide): PaneSide => (side === 'left' ? 'right' : 'left');

/** The document in each pane. */
export function paneKeys({ activeKey, split }: Focus): Record<PaneSide, string | null> {
  return split.activeSide === 'left'
    ? { left: activeKey, right: split.otherKey }
    : { left: split.otherKey, right: activeKey };
}

/**
 * Shows `key` in a pane and gives that pane focus. A document already shown
 * in the other pane trades places with the one it replaces.
 */
export function showIn(focus: Focus, side: PaneSide, key: string): Focus {
  const panes = paneKeys(focus);
  const away = otherSide(side);
  const replaced = panes[side];
  const next = { ...panes, [side]: key };
  if (panes[away] === key) next[away] = replaced;
  return {
    activeKey: key,
    split: { ...focus.split, otherKey: next[away], activeSide: side },
  };
}

/**
 * Makes `key` the active document (a tab, a click in a pane, a new file).
 * In split view a document already shown keeps its pane, an empty pane is
 * filled first, and otherwise the focused pane shows it; with one pane, the
 * document it replaces becomes the other one.
 */
export function activateIn(focus: Focus, key: string): Focus {
  const { activeKey, split } = focus;
  if (key === activeKey) return focus;
  if (activeKey === null) {
    return {
      activeKey: key,
      split: split.otherKey === key ? { ...split, otherKey: null } : split,
    };
  }
  if (!split.on) return { activeKey: key, split: { ...split, otherKey: activeKey } };
  const panes = paneKeys(focus);
  const shownAt = panes.left === key ? 'left' : panes.right === key ? 'right' : null;
  if (shownAt) return showIn(focus, shownAt, key);
  const empty = panes.left === null ? 'left' : panes.right === null ? 'right' : null;
  return showIn(focus, empty ?? split.activeSide, key);
}

/**
 * Turns split view on or off. On, the active document stays on the left
 * and the other pane shows the document active before it (else the tab
 * next to it, or nothing when there is one document).
 */
export function setSplit(focus: Focus, on: boolean, keys: readonly string[]): Focus {
  const { activeKey, split } = focus;
  if (!on) return split.on ? { activeKey, split: { ...split, on: false } } : focus;
  if (split.on) return focus;
  const valid = (key: string | null) => key !== null && key !== activeKey && keys.includes(key);
  const index = activeKey === null ? -1 : keys.indexOf(activeKey);
  const neighbour = keys[index + 1] ?? keys[index - 1] ?? null;
  const otherKey = valid(split.otherKey) ? split.otherKey : valid(neighbour) ? neighbour : null;
  return { activeKey, split: { on: true, otherKey, activeSide: 'left' } };
}

/**
 * The documents shown once `key` closes. `remaining` lists the open
 * documents in tab order after it closed; `index` is where it was. The
 * active document's pane shows the tab next to it (one not shown in the
 * other pane); with nothing left to show there, focus moves to the other
 * pane.
 */
export function afterClose(
  focus: Focus,
  key: string,
  remaining: readonly string[],
  index: number,
): Focus {
  const { activeKey, split } = focus;
  const otherKey = split.otherKey === key ? null : split.otherKey;
  if (activeKey !== key) return { activeKey, split: { ...split, otherKey } };
  const candidates = split.on ? remaining.filter((entry) => entry !== otherKey) : remaining;
  const neighbour = candidates[Math.min(index, candidates.length - 1)] ?? null;
  if (neighbour !== null) {
    return {
      activeKey: neighbour,
      split: { ...split, otherKey: otherKey === neighbour ? null : otherKey },
    };
  }
  if (split.on && otherKey !== null) {
    return {
      activeKey: otherKey,
      split: { ...split, otherKey: null, activeSide: otherSide(split.activeSide) },
    };
  }
  return { activeKey: null, split: { ...split, otherKey: null } };
}
