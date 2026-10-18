import { isDirty, type PageId } from '@folio/document-model';
import type { PdfEngine } from '@folio/pdf-core';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import {
  createMemoryPlatformAdapter,
  type IncomingFile,
  type PlatformAdapter,
  type WriteFileRequest,
  type WriteFileResult,
} from '@folio/platform-adapters';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context';
import { createUiStore } from '../store/ui';
import { createWorkspaceStore } from '../store/workspace';
import { useSave } from './use-save';

const EXPORTED = new TextEncoder().encode('%PDF-1.7 exported');

/** A desktop-like workspace with one granted file open and changed. */
async function setup(results: WriteFileResult[], { granted = true } = {}) {
  const memory = createMemoryPlatformAdapter({ saveInPlace: true });
  const writes: WriteFileRequest[] = [];
  const adapter: PlatformAdapter = {
    ...memory.adapter,
    writeFile: vi.fn(async (request: WriteFileRequest): Promise<WriteFileResult> => {
      writes.push(request);
      return results.shift() ?? { status: 'saved' };
    }),
  };
  const engine: PdfEngine = {
    open: async () => fakeDocumentHandle({ info: { pageCount: 2 } }),
    destroy: () => undefined,
  };
  const workspace = createWorkspaceStore(engine);
  const ui = createUiStore(adapter.storage);
  const original = new TextEncoder().encode('%PDF-1.7 original');
  const file: IncomingFile = {
    name: 'Report.pdf',
    size: original.byteLength,
    origin: { kind: 'local-file', handle: granted ? 'grant-1' : null },
    read: async () => original,
  };
  await act(() => workspace.getState().openFiles([file]));
  const key = workspace.getState().documents[0]!.key;
  // Exporting is covered by the exporter's tests; here only Save's decisions matter.
  workspace.setState({ exportDocument: async () => ({ bytes: EXPORTED, warnings: [] }) });
  const doc = () => workspace.getState().documents.find((entry) => entry.key === key)!;
  const firstPage = doc().editor!.model.pages[0]!.id as PageId;
  act(() => workspace.getState().rotatePages(key, [firstPage], 90));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkspaceProvider
      adapter={adapter}
      engine={engine}
      profile="desktop"
      stores={{ workspace, ui }}
    >
      {children}
    </WorkspaceProvider>
  );
  const { result } = renderHook(() => useSave(), { wrapper });
  return { save: () => result.current(key), doc, writes, memory, ui, workspace };
}

describe('Save', () => {
  it('writes back to the opened file, checked against what Folio read', async () => {
    const { save, doc, writes, workspace } = await setup([{ status: 'saved' }]);
    const opened = doc().diskSha256;
    expect(opened).toMatch(/^[0-9a-f]{64}$/);
    expect(isDirty(doc().editor!)).toBe(true);
    await act(async () => expect(await save()).toBe(true));
    expect(writes).toEqual([{ handle: 'grant-1', bytes: EXPORTED, expectedSha256: opened }]);
    expect(isDirty(doc().editor!)).toBe(false);
    // The next save expects what was just written.
    expect(doc().diskSha256).not.toBe(opened);
    expect(workspace.getState().notice?.message).toBe('Saved Report.pdf.');
  });

  it('asks before replacing a file another program changed', async () => {
    const { save, writes, ui } = await setup([{ status: 'changed-on-disk' }, { status: 'saved' }]);
    let saved: Promise<boolean> | undefined;
    act(() => {
      saved = save();
    });
    await vi.waitFor(() => expect(ui.getState().dialog?.kind).toBe('save-conflict'));
    const dialog = ui.getState().dialog;
    act(() => {
      if (dialog?.kind === 'save-conflict') dialog.resolve('overwrite');
    });
    await act(async () => expect(await saved).toBe(true));
    expect(writes.map((write) => write.overwriteExternalChanges)).toEqual([undefined, true]);
  });

  it('keeps the document unsaved when the user cancels the conflict', async () => {
    const { save, doc, writes, ui } = await setup([{ status: 'changed-on-disk' }]);
    let saved: Promise<boolean> | undefined;
    act(() => {
      saved = save();
    });
    await vi.waitFor(() => expect(ui.getState().dialog?.kind).toBe('save-conflict'));
    act(() => ui.getState().closeDialog());
    await act(async () => expect(await saved).toBe(false));
    expect(writes).toHaveLength(1);
    expect(isDirty(doc().editor!)).toBe(true);
  });

  it('falls back to Save As when the file cannot be written', async () => {
    const { save, memory, workspace } = await setup([
      { status: 'unavailable', message: 'The file is read-only.' },
    ]);
    await act(async () => expect(await save()).toBe(true));
    expect(memory.saved).toEqual([{ name: 'Report.pdf', bytes: EXPORTED }]);
    expect(workspace.getState().notice?.message).toContain('Saved as Report.pdf.');
  });

  it('uses Save As for documents without a file to write to', async () => {
    const { save, writes, memory } = await setup([], { granted: false });
    await act(async () => expect(await save()).toBe(true));
    expect(writes).toHaveLength(0);
    expect(memory.saved).toHaveLength(1);
  });
});
