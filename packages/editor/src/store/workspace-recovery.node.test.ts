import {
  canUndo,
  isDirty,
  newAnnotationId,
  serializeRecoverySnapshot,
  undoLabel,
  type AssetId,
  type NoteAnnotation,
  type PageId,
} from '@folio/document-model';
import { createPdfEngine } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_PASSWORD,
  makePng,
  nodeWorkerSrc,
  readFixture,
  type FixtureName,
} from '../../../../tests/setup/fixtures';
import { createWorkspaceStore, type WorkspaceStore } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function openFixture(name: FixtureName, password?: string) {
  const store = createWorkspaceStore(engine);
  await store.getState().openFiles([memoryFile(name, readFixture(name))]);
  const key = store.getState().documents[0]!.key;
  if (password !== undefined) await store.getState().submitPassword(key, password);
  return { store, key };
}

const doc = (store: WorkspaceStore, key: string) =>
  store.getState().documents.find((entry) => entry.key === key)!;

const note = (pageId: PageId, contents: string): NoteAnnotation => ({
  id: newAnnotationId(),
  pageId,
  author: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  color: '#ffd400',
  opacity: 1,
  kind: 'note',
  position: { x: 100, y: 700 },
  contents,
});

/** What autosave stores for a document: its snapshot, source files and images. */
function recoveryRecord(store: WorkspaceStore, key: string) {
  const { editor, view } = doc(store, key);
  const files = new Map<string, Uint8Array>();
  for (const source of Object.values(editor!.model.sources)) {
    files.set(source.sha256, store.getSourceBytes(key, source.id)!);
  }
  for (const id of Object.keys(editor!.model.assets) as AssetId[]) {
    files.set(id, store.getAssetBytes(key, id)!);
  }
  return { snapshot: serializeRecoverySnapshot(editor!, view!), files };
}

async function pageTexts(store: WorkspaceStore, key: string) {
  const { bytes } = await store.getState().exportDocument(key);
  const handle = await engine.open(bytes);
  const texts: string[] = [];
  for (let index = 0; index < handle.info.pageCount; index += 1) {
    const { items } = await handle.getPageText(index);
    texts.push(items.map((item) => item.str).join(' '));
  }
  await handle.destroy();
  return texts;
}

describe('workspace store: crash recovery', () => {
  it('restores a document with its changes, history and inserted pages', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const state = store.getState();
    const [first] = doc(store, key).editor!.model.pages.map((page) => page.id) as [PageId];
    state.addAnnotations(key, [note(first, 'Recovered note')], { label: 'Add note' });
    const png = await makePng(4, 4);
    const asset = await state.registerImage(key, png, 'image/png');
    const now = new Date().toISOString();
    state.addAnnotations(
      key,
      [
        {
          id: newAnnotationId(),
          pageId: first,
          author: '',
          createdAt: now,
          modifiedAt: now,
          color: '#000000',
          opacity: 1,
          kind: 'added-image',
          rect: { x: 72, y: 72, width: 40, height: 40 },
          assetId: asset!.id,
          rotation: 0,
        },
      ],
      { label: 'Add image', assets: [asset!] },
    );
    expect(
      await state.insertPagesFromFile(
        key,
        memoryFile('outline.pdf', readFixture('outline-and-text.pdf')),
        3,
      ),
    ).toMatchObject({ status: 'inserted' });
    state.rotatePages(key, [first], 90);
    const record = recoveryRecord(store, key);
    const before = doc(store, key);

    const restoredStore = createWorkspaceStore(engine);
    const outcome = await restoredStore.getState().restoreDocument({
      ...record,
      recoveryId: 'doc-recovered',
    });
    expect(outcome.status).toBe('restored');
    const restoredKey = (outcome as { key: string }).key;
    const restored = doc(restoredStore, restoredKey);
    expect(restored.status).toBe('ready');
    expect(restored.recoveryId).toBe('doc-recovered');
    expect(restored.fileName).toBe('basic-3-pages.pdf');
    expect(restored.editor!.model).toEqual(before.editor!.model);
    expect(isDirty(restored.editor!)).toBe(true);
    expect(canUndo(restored.editor!)).toBe(true);
    expect(undoLabel(restored.editor!)).toBe('Rotate 1 page');
    // Nothing points Save at the original file: its access ended with the crash.
    expect(restored.saveTarget).toBeNull();
    expect(restoredStore.getAssetBytes(restoredKey, asset!.id)).toEqual(png);

    // The restored document saves like the original would have.
    expect(await pageTexts(restoredStore, restoredKey)).toEqual(await pageTexts(store, key));
    restoredStore.getState().undo(restoredKey);
    expect(doc(restoredStore, restoredKey).editor!.model.pages[0]!.rotation).toBe(0);
    await restoredStore.destroy();
    await store.destroy();
  });

  it('asks for passwords again: they are never stored', async () => {
    const { store, key } = await openFixture('encrypted-user-password.pdf', FIXTURE_PASSWORD);
    const [first] = doc(store, key).editor!.model.pages.map((page) => page.id) as [PageId];
    store.getState().addAnnotations(key, [note(first, 'Private')], { label: 'Add note' });
    const record = recoveryRecord(store, key);
    expect(record.snapshot).not.toContain(FIXTURE_PASSWORD);
    const sourceId = Object.keys(doc(store, key).editor!.model.sources)[0]!;

    const restoredStore = createWorkspaceStore(engine);
    const restore = (passwords?: Record<string, string>) =>
      restoredStore.getState().restoreDocument({
        ...record,
        recoveryId: 'doc-protected',
        ...(passwords ? { passwords } : {}),
      });
    expect(await restore()).toEqual({
      status: 'needs-password',
      sourceId,
      fileName: 'encrypted-user-password.pdf',
      rejected: false,
    });
    expect(await restore({ [sourceId]: 'wrong' })).toMatchObject({
      status: 'needs-password',
      rejected: true,
    });
    expect(restoredStore.getState().documents).toHaveLength(0);
    const outcome = await restore({ [sourceId]: FIXTURE_PASSWORD });
    expect(outcome.status).toBe('restored');
    const restored = doc(restoredStore, (outcome as { key: string }).key);
    expect(Object.values(restored.editor!.model.annotations)).toHaveLength(1);
    await restoredStore.destroy();
    await store.destroy();
  });

  it('refuses damaged or incomplete records without opening anything', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const record = recoveryRecord(store, key);
    const restoredStore = createWorkspaceStore(engine);
    const restore = (snapshot: string, files: Map<string, Uint8Array>) =>
      restoredStore.getState().restoreDocument({ snapshot, files, recoveryId: 'doc-damaged' });

    expect(await restore('{"format":"folio.recovery"', record.files)).toEqual({
      status: 'failed',
      message: 'The recovered data is damaged.',
    });
    expect(await restore(record.snapshot, new Map())).toEqual({
      status: 'failed',
      message: 'The copy of basic-3-pages.pdf kept for recovery is missing or damaged.',
    });
    const tampered = new Map(
      [...record.files].map(([name, bytes]) => {
        const copy = bytes.slice();
        const at = copy.length - 2;
        copy[at] = copy[at]! ^ 0xff;
        return [name, copy];
      }),
    );
    expect((await restore(record.snapshot, tampered)).status).toBe('failed');
    expect(restoredStore.getState().documents).toHaveLength(0);
    await restoredStore.destroy();
    await store.destroy();
  });
});

describe('workspace store: save targets', () => {
  it('points Save at the file from Save As and releases replaced files', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const first = vi.fn();
    const second = vi.fn();
    store.getState().setSaveTarget(key, { handle: 'h1', name: 'Copy.pdf' }, 'a'.repeat(64), first);
    expect(doc(store, key)).toMatchObject({
      saveTarget: { handle: 'h1', name: 'Copy.pdf' },
      diskSha256: 'a'.repeat(64),
      fileName: 'Copy.pdf',
    });
    store
      .getState()
      .setSaveTarget(key, { handle: 'h2', name: 'Final.pdf' }, 'b'.repeat(64), second);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(doc(store, key).fileName).toBe('Final.pdf');

    await store.getState().close(key);
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(first).toHaveBeenCalledOnce();

    // A document closed while saving gives the new file up at once.
    const late = vi.fn();
    store.getState().setSaveTarget(key, { handle: 'h3', name: 'Late.pdf' }, null, late);
    expect(late).toHaveBeenCalledOnce();
    await store.destroy();
  });
});
