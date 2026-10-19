import { isDirty, undoLabel, type PageNumberStamp } from '@folio/document-model';
import { createPdfEngine } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeWorkerSrc, readFixture, type FixtureName } from '../../../../tests/setup/fixtures';
import { PERMISSION_MESSAGES } from './editing';
import { createWorkspaceStore, type WorkspaceStore } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function openFixture(name: FixtureName) {
  const store = createWorkspaceStore(engine);
  await store.getState().openFiles([memoryFile(name, readFixture(name))]);
  return { store, key: store.getState().documents[0]!.key };
}

const doc = (store: WorkspaceStore, key: string) =>
  store.getState().documents.find((entry) => entry.key === key)!;

async function pageTexts(bytes: Uint8Array) {
  const handle = await engine.open(bytes);
  const texts: string[] = [];
  for (let index = 0; index < handle.info.pageCount; index += 1) {
    const { items } = await handle.getPageText(index);
    texts.push(items.map((item) => item.str).join(' '));
  }
  await handle.destroy();
  return texts;
}

const NUMBERS: PageNumberStamp = {
  format: 'Page {page} of {total}',
  position: 'bottom-center',
  fontFamily: 'sans',
  fontSize: 10,
  color: '#1f2328',
  margin: 36,
  startNumber: 1,
  pages: { from: 1, to: null },
};

describe('workspace store: page numbers and watermarks', () => {
  it('adds page numbers through the history and saves them into the pages', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const state = () => store.getState();
    expect(state().setStamps(key, { pageNumbers: NUMBERS }, 'Add page numbers')).toBe(true);
    expect(undoLabel(doc(store, key).editor!)).toBe('Add page numbers');
    expect(isDirty(doc(store, key).editor!)).toBe(true);
    expect((await pageTexts((await state().exportDocument(key)).bytes))[1]).toContain(
      'Page 2 of 3',
    );

    state().undo(key);
    expect(doc(store, key).editor!.model.stamps.pageNumbers).toBeNull();
    expect((await pageTexts((await state().exportDocument(key)).bytes))[1]).not.toContain(
      'Page 2 of 3',
    );
    state().redo(key);
    expect(doc(store, key).editor!.model.stamps.pageNumbers).toEqual(NUMBERS);
    await store.destroy();
  });

  it('prints and extracts pages with their numbers in the whole document', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const state = () => store.getState();
    state().setStamps(key, { pageNumbers: NUMBERS }, 'Add page numbers');
    const last = doc(store, key).editor!.model.pages[2]!.id;
    // As printing without comments asks for it.
    const printed = await state().exportDocument(key, {
      pageIds: [last],
      withoutAnnotations: true,
      unprotected: true,
    });
    expect(await pageTexts(printed.bytes)).toEqual([expect.stringContaining('Page 3 of 3')]);
    await store.destroy();
  });

  it('leaves documents that do not allow changes as they are, and says why', async () => {
    const { store, key } = await openFixture('encrypted-owner-restricted.pdf');
    const state = () => store.getState();
    expect(doc(store, key).permissions.modify).toBe(false);
    expect(state().setStamps(key, { pageNumbers: NUMBERS }, 'Add page numbers')).toBe(false);
    expect(doc(store, key).editor!.model.stamps.pageNumbers).toBeNull();
    expect(state().notice?.message).toBe(PERMISSION_MESSAGES.modify);
    await store.destroy();
  });
});
