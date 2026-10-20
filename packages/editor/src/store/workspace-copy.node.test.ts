import {
  canRedo,
  isDirty,
  newAnnotationId,
  parseRecognizedText,
  serializeRecoverySnapshot,
  sourcePageKey,
  undoLabel,
  type Annotation,
  type AssetId,
  type NoteAnnotation,
  type PageId,
  type RecognizedTextData,
  type SourceId,
} from '@folio/document-model';
import { createPdfEngine, pageTextToString } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PASSWORD,
  makePng,
  nodeWorkerSrc,
  readFixture,
  type FixtureName,
} from '../../../../tests/setup/fixtures';
import { documentPageText } from '../ocr/page-text';
import { PERMISSION_MESSAGES } from './editing';
import { createWorkspaceStore, type WorkspaceStore } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

/** Opens fixtures side by side in one workspace; returns their keys in order. */
async function openFixtures(...names: Array<FixtureName | [FixtureName, string]>) {
  const store = createWorkspaceStore(engine);
  await store
    .getState()
    .openFiles(names.map((name) => (Array.isArray(name) ? name[0] : name)).map(file));
  const keys = store.getState().documents.map((entry) => entry.key);
  for (const [index, name] of names.entries()) {
    if (Array.isArray(name)) await store.getState().submitPassword(keys[index]!, name[1]);
  }
  return { store, keys };
}

const file = (name: FixtureName) => memoryFile(name, readFixture(name));
const doc = (store: WorkspaceStore, key: string) =>
  store.getState().documents.find((entry) => entry.key === key)!;
const model = (store: WorkspaceStore, key: string) => doc(store, key).editor!.model;
const pageIds = (store: WorkspaceStore, key: string) =>
  model(store, key).pages.map((page) => page.id);
const sourceOf = (store: WorkspaceStore, key: string) =>
  Object.keys(model(store, key).sources)[0] as SourceId;

async function savedTexts(store: WorkspaceStore, key: string) {
  const { bytes } = await store.getState().exportDocument(key);
  const handle = await engine.open(bytes);
  const texts: string[] = [];
  for (let index = 0; index < handle.info.pageCount; index += 1) {
    texts.push(pageTextToString(await handle.getPageText(index)));
  }
  await handle.destroy();
  return texts;
}

const note = (pageId: PageId, contents: string): NoteAnnotation => ({
  id: newAnnotationId(),
  pageId,
  author: 'Reviewer',
  createdAt: '2026-01-01T00:00:00.000Z',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  color: '#ffd400',
  opacity: 1,
  kind: 'note',
  position: { x: 100, y: 700 },
  contents,
});

const RECOGNIZED: RecognizedTextData = {
  version: 1,
  languages: 'eng',
  rotation: 0,
  words: [
    { text: 'Harbour', box: { x: 72, y: 600, width: 70, height: 16 }, confidence: 90, line: 0 },
    { text: 'lights', box: { x: 150, y: 600, width: 50, height: 16 }, confidence: 90, line: 0 },
  ],
};

describe('workspace store: split view', () => {
  it('shows the documents side by side as they are opened, picked and closed', async () => {
    const { store, keys } = await openFixtures('basic-3-pages.pdf', 'outline-and-text.pdf');
    const [a, b] = keys as [string, string];
    const state = () => store.getState();
    expect(state().activeKey).toBe(a);
    state().activate(b);
    state().setSplitView(true);
    // The active document on the left, the one before it beside it.
    expect(state().split).toEqual({ on: true, otherKey: a, activeSide: 'left' });
    // A click in the right pane makes its document active; it stays on the right.
    state().activate(a);
    expect(state()).toMatchObject({ activeKey: a, split: { otherKey: b, activeSide: 'right' } });
    // A new file shows in the pane with focus.
    await state().openFiles([file('rotated-pages.pdf')]);
    const c = state().documents[2]!.key;
    expect(state()).toMatchObject({ activeKey: c, split: { otherKey: b, activeSide: 'right' } });
    state().showInPane('left', a);
    expect(state()).toMatchObject({ activeKey: a, split: { otherKey: c, activeSide: 'left' } });
    await state().close(c);
    expect(state()).toMatchObject({ activeKey: a, split: { otherKey: null } });
    // Off, the tabs work as before.
    state().setSplitView(false);
    state().activate(b);
    expect(state()).toMatchObject({ activeKey: b, split: { on: false, otherKey: a } });
    await store.destroy();
  });
});

describe('workspace store: copying pages between documents', () => {
  it('copies pages with their comments, images and recognized text as one change', async () => {
    const { store, keys } = await openFixtures('basic-3-pages.pdf', 'outline-and-text.pdf');
    const [from, to] = keys as [string, string];
    const state = () => store.getState();
    const [, second, third] = pageIds(store, from) as [PageId, PageId, PageId];

    // The source document: a note and a picture on page 2, recognized text on page 3.
    const png = await makePng(8, 8);
    const asset = (await state().registerImage(from, png, 'image/png'))!;
    const { position: _position, contents: _contents, ...common } = note(second, '');
    const image: Annotation = {
      ...common,
      kind: 'added-image',
      rect: { x: 100, y: 100, width: 50, height: 50 },
      assetId: asset.id,
      rotation: 0,
    };
    state().addAnnotations(from, [note(second, 'Check this'), image], {
      label: 'Add',
      assets: [asset],
    });
    await state().addRecognizedText(from, [
      { sourceId: sourceOf(store, from), pageIndex: 2, data: RECOGNIZED },
    ]);
    const before = model(store, from);

    expect(await state().copyPagesToDocument(from, [third, second], to, 1)).toBe(true);
    // The source is unchanged.
    expect(model(store, from)).toBe(before);
    const target = model(store, to);
    expect(target.pages).toHaveLength(8);
    const copies = target.pages.slice(1, 3);
    // In document order, as new pages of a new source with the same size and rotation.
    expect(copies.map((page) => page.source)).toEqual([
      { kind: 'source', sourceId: expect.any(String), pageIndex: 1 },
      { kind: 'source', sourceId: expect.any(String), pageIndex: 2 },
    ]);
    expect(copies.map((page) => page.id)).not.toContain(second);
    expect(copies[0]!.size).toEqual(before.pages[1]!.size);
    const copiedSource = copies[0]!.source.kind === 'source' ? copies[0]!.source.sourceId : null;
    expect(Object.keys(target.sources)).toHaveLength(2);
    expect(target.sources[copiedSource!]).toMatchObject({
      fileName: 'basic-3-pages.pdf',
      sha256: before.sources[sourceOf(store, from)]!.sha256,
    });
    expect(copiedSource).not.toBe(sourceOf(store, from));
    expect(store.getSourceHandle(to, copiedSource!)).not.toBe(
      store.getSourceHandle(from, sourceOf(store, from)),
    );

    // The comments came along with new ids; the picture's bytes too.
    const annotations = Object.values(target.annotations);
    expect(annotations.map((entry) => [entry.kind, entry.pageId])).toEqual([
      ['note', copies[0]!.id],
      ['added-image', copies[0]!.id],
    ]);
    expect(annotations.some((entry) => entry.id in before.annotations)).toBe(false);
    const copiedImage = annotations.find((entry) => entry.kind === 'added-image');
    const imageAsset = copiedImage && 'assetId' in copiedImage ? copiedImage.assetId : null;
    expect(target.assets[imageAsset!]).toMatchObject({ mimeType: 'image/png' });
    expect(store.getAssetBytes(to, imageAsset!)).toEqual(png);
    // So did the text recognized on page 3.
    const layer = target.textLayers[sourcePageKey(copiedSource!, 2)];
    expect(layer).toMatchObject({ languages: 'eng', wordCount: 2 });
    expect(parseRecognizedText(store.getAssetBytes(to, layer!.assetId)!)).toEqual(RECOGNIZED);
    expect(pageTextToString(await documentPageText(store, to, copies[1]!))).toContain(
      'Harbour lights',
    );

    // One undo step, with the new pages selected and shown.
    expect(undoLabel(doc(store, to).editor!)).toBe('Copy 2 pages from basic-3-pages.pdf');
    expect(doc(store, to).editor!.history.past).toHaveLength(1);
    expect(doc(store, to).selection.pages).toEqual(copies.map((page) => page.id));
    expect(doc(store, to).view?.currentPageId).toBe(copies[0]!.id);
    expect(isDirty(doc(store, to).editor!)).toBe(true);

    // Search finds text on them, recognized text included.
    state().setSearch(to, { query: 'Harbour' });
    await expect.poll(() => doc(store, to).search.status).toBe('done');
    expect(doc(store, to).search.matches.map((match) => match.pageIndex)).toEqual([2]);

    state().undo(to);
    expect(pageIds(store, to)).toHaveLength(6);
    expect(model(store, to).annotations).toEqual({});
    expect(model(store, to).textLayers).toEqual({});
    expect(canRedo(doc(store, to).editor!)).toBe(true);
    state().redo(to);
    expect(
      model(store, to)
        .pages.slice(1, 3)
        .map((page) => page.id),
    ).toEqual(copies.map((page) => page.id));
    expect(Object.keys(model(store, to).annotations)).toHaveLength(2);
    await store.destroy();
  });

  it('keeps the copies working after the source document closes', async () => {
    const { store, keys } = await openFixtures('outline-and-text.pdf', 'basic-3-pages.pdf');
    const [from, to] = keys as [string, string];
    const [first, , third] = pageIds(store, from);
    store.getState().addAnnotations(from, [note(first!, 'Carried over')], { label: 'Add note' });
    expect(await store.getState().copyPagesToDocument(from, [first!, third!], to, 3)).toBe(true);
    await store.getState().close(from);
    expect(store.getState().documents.map((entry) => entry.key)).toEqual([to]);

    // Saved: the target's pages, then the copies, in order, with the note.
    const texts = await savedTexts(store, to);
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain('Folio fixture page 1');
    expect(texts[2]).toContain('Folio fixture page 3');
    expect(texts[3]).toContain('Introduction');
    expect(texts[4]).not.toContain('Folio fixture');

    // Crash recovery keeps the copied file and its comment.
    const editor = doc(store, to).editor!;
    const files = new Map<string, Uint8Array>();
    for (const source of Object.values(editor.model.sources)) {
      files.set(source.sha256, store.getSourceBytes(to, source.id)!);
    }
    for (const id of Object.keys(editor.model.assets) as AssetId[]) {
      files.set(id, store.getAssetBytes(to, id)!);
    }
    const restored = await store.getState().restoreDocument({
      snapshot: serializeRecoverySnapshot(editor, doc(store, to).view!),
      files,
      recoveryId: 'doc-copy-test',
    });
    expect(restored.status).toBe('restored');
    const key = restored.status === 'restored' ? restored.key : '';
    expect(pageIds(store, key)).toHaveLength(5);
    expect(Object.values(model(store, key).annotations)).toMatchObject([
      { kind: 'note', contents: 'Carried over' },
    ]);
    expect(await savedTexts(store, key)).toEqual(texts);
    await store.destroy();
  });

  it('shares a file the target already has and keeps blank pages blank', async () => {
    const { store, keys } = await openFixtures('basic-3-pages.pdf', 'basic-3-pages.pdf');
    const [from, to] = keys as [string, string];
    store.getState().insertBlankPage(from, 0);
    const [blank, first] = pageIds(store, from);
    expect(await store.getState().copyPagesToDocument(from, [blank!, first!], to, 0)).toBe(true);
    const target = model(store, to);
    // The same file (by SHA-256): no second source, no second engine document.
    expect(Object.keys(target.sources)).toEqual([sourceOf(store, to)]);
    expect(target.pages[0]!.source).toEqual({ kind: 'blank' });
    expect(target.pages[1]!.source).toEqual({
      kind: 'source',
      sourceId: sourceOf(store, to),
      pageIndex: 0,
    });
    expect((await savedTexts(store, to)).slice(0, 2)).toEqual([
      '',
      expect.stringContaining('Folio fixture page 1'),
    ]);

    // Copying from a third document twice opens its file once.
    await store.getState().openFiles([file('outline-and-text.pdf')]);
    const third = store.getState().documents[2]!.key;
    const [a, b] = pageIds(store, third);
    await store.getState().copyPagesToDocument(third, [a!], to, 0);
    await store.getState().copyPagesToDocument(third, [b!], to, 0);
    expect(Object.keys(model(store, to).sources)).toHaveLength(2);
    // Text the target recognized itself stays when the same page comes again.
    await store
      .getState()
      .addRecognizedText(to, [{ sourceId: sourceOf(store, to), pageIndex: 0, data: RECOGNIZED }]);
    const own = model(store, to).textLayers;
    await store
      .getState()
      .addRecognizedText(from, [
        { sourceId: sourceOf(store, from), pageIndex: 0, data: { ...RECOGNIZED, words: [] } },
      ]);
    await store.getState().copyPagesToDocument(from, [first!], to, 0);
    expect(model(store, to).textLayers).toEqual(own);
    await store.destroy();
  });

  it('honours both documents’ permissions', async () => {
    const { store, keys } = await openFixtures(
      'basic-3-pages.pdf',
      'encrypted-owner-restricted.pdf',
    );
    const [open, restricted] = keys as [string, string];
    // The restricted document cannot take pages…
    expect(
      await store.getState().copyPagesToDocument(open, pageIds(store, open), restricted, 0),
    ).toBe(false);
    expect(store.getState().notice?.message).toBe(
      `encrypted-owner-restricted.pdf: ${PERMISSION_MESSAGES.assemble}`,
    );
    expect(pageIds(store, restricted)).toHaveLength(3);
    // …but its pages may be copied out (it allows copying).
    expect(
      await store.getState().copyPagesToDocument(restricted, pageIds(store, restricted), open, 3),
    ).toBe(true);
    expect(pageIds(store, open)).toHaveLength(6);

    // A document that forbids copying keeps its pages.
    store.setState((state) => ({
      documents: state.documents.map((entry) =>
        entry.key === restricted
          ? { ...entry, permissions: { ...entry.permissions, extract: false } }
          : entry,
      ),
    }));
    expect(
      await store.getState().copyPagesToDocument(restricted, pageIds(store, restricted), open, 0),
    ).toBe(false);
    expect(store.getState().notice?.message).toBe(
      `encrypted-owner-restricted.pdf: ${PERMISSION_MESSAGES.extract}`,
    );
    expect(pageIds(store, open)).toHaveLength(6);
    // Nothing to copy, or copying into itself, does nothing.
    expect(await store.getState().copyPagesToDocument(open, [], restricted, 0)).toBe(false);
    expect(await store.getState().copyPagesToDocument(open, pageIds(store, open), open, 0)).toBe(
      false,
    );
    await store.destroy();
  });

  it('copies pages of a protected document with its password and says they lose it', async () => {
    const { store, keys } = await openFixtures(
      ['encrypted-user-password.pdf', FIXTURE_PASSWORD],
      'outline-and-text.pdf',
    );
    const [locked, plain] = keys as [string, string];
    expect(doc(store, locked).status).toBe('ready');
    expect(
      await store.getState().copyPagesToDocument(locked, pageIds(store, locked), plain, 0),
    ).toBe(true);
    expect(store.getState().notice?.message).toBe(
      'The pages from encrypted-user-password.pdf will be saved without its password protection, like the rest of outline-and-text.pdf.',
    );
    await store.getState().close(locked);
    // Saved without a password, the copied text readable.
    const texts = await savedTexts(store, plain);
    expect(texts).toHaveLength(9);
    expect(texts[1]).toContain('Folio fixture page 2');

    // The other way round, the pages become protected like the rest: no notice.
    await store.getState().openFiles([file('encrypted-user-password.pdf')]);
    const again = store.getState().documents[1]!.key;
    await store.getState().submitPassword(again, FIXTURE_PASSWORD);
    store.getState().dismissNotice();
    expect(
      await store.getState().copyPagesToDocument(plain, [pageIds(store, plain)[3]!], again, 3),
    ).toBe(true);
    expect(store.getState().notice).toBeNull();
    const { bytes } = await store.getState().exportDocument(again);
    await expect(engine.open(bytes)).rejects.toMatchObject({ code: 'password-required' });
    await store.destroy();
  });
});
