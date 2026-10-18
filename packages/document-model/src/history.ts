import { newOperationId, type OperationId } from './ids';
import { applyOperation, type Operation } from './operations';
import type { DocumentModel } from './types';

export interface HistoryEntry {
  id: OperationId;
  /** Human-readable label for menus, e.g. "Rotate 2 pages". */
  label: string;
  operation: Operation;
  inverse: Operation;
  timestamp: number;
  /** Consecutive entries with the same key (e.g. dragging one annotation) merge into one. */
  coalesceKey: string | null;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
  limit: number;
}

/**
 * A document plus its operation history. Immutable: every function returns a
 * new state. `savedEntryId` marks the history position that matches what is
 * on disk, which is how dirty state stays correct across undo and redo.
 */
export interface EditorDocumentState {
  model: DocumentModel;
  history: History;
  /** Top of `past` when the document was last saved; null means "as opened". */
  savedEntryId: OperationId | null;
}

export const DEFAULT_HISTORY_LIMIT = 200;
export const COALESCE_WINDOW_MS = 1500;

export function createEditorState(
  model: DocumentModel,
  limit: number = DEFAULT_HISTORY_LIMIT,
): EditorDocumentState {
  return { model, history: { past: [], future: [], limit }, savedEntryId: null };
}

export interface ExecuteOptions {
  label: string;
  coalesceKey?: string;
  now?: number;
}

function coalesce(top: HistoryEntry, next: Operation, nextInverse: Operation): HistoryEntry | null {
  const a = top.operation;
  if (a.type === 'annotations/replace' && next.type === 'annotations/replace') {
    const ids = (ops: typeof a.annotations) =>
      ops
        .map((annotation) => annotation.id)
        .sort()
        .join();
    if (ids(a.annotations) === ids(next.annotations)) {
      return { ...top, operation: next };
    }
  }
  if (a.type === 'metadata/update' && next.type === 'metadata/update') {
    const inverse = top.inverse.type === 'metadata/update' ? top.inverse.patch : {};
    const nextPrevious = nextInverse.type === 'metadata/update' ? nextInverse.patch : {};
    return {
      ...top,
      operation: { type: 'metadata/update', patch: { ...a.patch, ...next.patch } },
      // Keep the oldest "before" value for every key.
      inverse: { type: 'metadata/update', patch: { ...nextPrevious, ...inverse } },
    };
  }
  return null;
}

export function execute(
  state: EditorDocumentState,
  operation: Operation,
  options: ExecuteOptions,
): EditorDocumentState {
  const { model, inverse } = applyOperation(state.model, operation);
  const now = options.now ?? Date.now();
  const coalesceKey = options.coalesceKey ?? null;
  const past = [...state.history.past];
  const top = past.at(-1);

  if (
    top &&
    coalesceKey !== null &&
    top.coalesceKey === coalesceKey &&
    now - top.timestamp <= COALESCE_WINDOW_MS &&
    top.id !== state.savedEntryId
  ) {
    const merged = coalesce(top, operation, inverse);
    if (merged) {
      past[past.length - 1] = { ...merged, timestamp: now };
      return { ...state, model, history: { ...state.history, past, future: [] } };
    }
  }

  past.push({
    id: newOperationId(),
    label: options.label,
    operation,
    inverse,
    timestamp: now,
    coalesceKey,
  });
  if (past.length > state.history.limit) past.splice(0, past.length - state.history.limit);
  return { ...state, model, history: { ...state.history, past, future: [] } };
}

export const canUndo = (state: EditorDocumentState) => state.history.past.length > 0;
export const canRedo = (state: EditorDocumentState) => state.history.future.length > 0;

export function undo(state: EditorDocumentState): EditorDocumentState {
  const entry = state.history.past.at(-1);
  if (!entry) return state;
  const { model } = applyOperation(state.model, entry.inverse);
  return {
    ...state,
    model,
    history: {
      ...state.history,
      past: state.history.past.slice(0, -1),
      future: [entry, ...state.history.future],
    },
  };
}

export function redo(state: EditorDocumentState): EditorDocumentState {
  const [entry, ...future] = state.history.future;
  if (!entry) return state;
  const { model } = applyOperation(state.model, entry.operation);
  return {
    ...state,
    model,
    history: { ...state.history, past: [...state.history.past, entry], future },
  };
}

export function isDirty(state: EditorDocumentState): boolean {
  return (state.history.past.at(-1)?.id ?? null) !== state.savedEntryId;
}

export function markSaved(state: EditorDocumentState): EditorDocumentState {
  return { ...state, savedEntryId: state.history.past.at(-1)?.id ?? null };
}

export const undoLabel = (state: EditorDocumentState) => state.history.past.at(-1)?.label ?? null;
export const redoLabel = (state: EditorDocumentState) => state.history.future[0]?.label ?? null;
