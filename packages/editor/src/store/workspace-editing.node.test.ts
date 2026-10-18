import {
  canRedo,
  canUndo,
  isDirty,
  newAnnotationId,
  undoLabel,
  type Annotation,
  type NoteAnnotation,
  type PageId,
} from '@folio/document-model';
import { createPdfEngine } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
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
const pageIds = (store: WorkspaceStore, key: string) =>
  doc(store, key).editor!.model.pages.map((page) => page.id);
const editor = (store: WorkspaceStore, key: string) => doc(store, key).editor!;

async function pageTexts(bytes: Uint8Array, password?: string) {
  const handle = await engine.open(bytes, password === undefined ? {} : { password });
  const texts: string[] = [];
  for (let index = 0; index < handle.info.pageCount; index += 1) {
    const { items } = await handle.getPageText(index);
    texts.push(items.map((item) => item.str).join(' '));
  }
  await handle.destroy();
  return texts;
}

const note = (pageId: PageId, contents = 'Check'): NoteAnnotation => ({
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

describe('workspace store: page editing', () => {
  it('rotates, deletes, duplicates and moves pages through the history', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const [a, b, c] = pageIds(store, key) as [PageId, PageId, PageId];
    const state = () => store.getState();

    state().rotatePages(key, [a, c], 90);
    expect(editor(store, key).model.pages.map((page) => page.rotation)).toEqual([90, 0, 90]);
    expect(undoLabel(editor(store, key))).toBe('Rotate 2 pages');
    expect(isDirty(editor(store, key))).toBe(true);

    state().duplicatePages(key, [b]);
    const afterDuplicate = pageIds(store, key);
    expect(afterDuplicate).toHaveLength(4);
    expect(afterDuplicate.slice(0, 2)).toEqual([a, b]);
    // The copy follows its original and becomes the selection.
    expect(doc(store, key).selection.pages).toEqual([afterDuplicate[2]]);

    state().movePages(key, [c], 0);
    expect(pageIds(store, key)[0]).toBe(c);

    state().navigate(key, { pageIndex: 3, align: 'top' });
    state().deletePages(key, [pageIds(store, key)[3]!]);
    expect(pageIds(store, key)).toHaveLength(3);
    // The current page moved to the nearest remaining one.
    expect(doc(store, key).view?.currentPageId).toBe(pageIds(store, key)[2]);

    // Every page cannot go.
    state().deletePages(key, pageIds(store, key));
    expect(pageIds(store, key)).toHaveLength(3);
    expect(store.getState().notice?.message).toBe('A document needs at least one page.');

    for (let step = 0; step < 4; step += 1) state().undo(key);
    expect(pageIds(store, key)).toEqual([a, b, c]);
    expect(editor(store, key).model.pages.map((page) => page.rotation)).toEqual([0, 0, 0]);
    expect(canUndo(editor(store, key))).toBe(false);
    expect(isDirty(editor(store, key))).toBe(false);
    state().redo(key);
    expect(editor(store, key).model.pages.map((page) => page.rotation)).toEqual([90, 0, 90]);
    expect(canRedo(editor(store, key))).toBe(true);
    await store.destroy();
  });

  it('inserts blank pages shaped like the page before them', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    store.getState().rotatePages(key, [pageIds(store, key)[0]!], 90);
    store.getState().insertBlankPage(key, 1);
    const blank = editor(store, key).model.pages[1]!;
    expect(blank.source).toEqual({ kind: 'blank' });
    // Letter portrait turned a quarter: a landscape blank page.
    expect(blank.size).toEqual({ width: 792, height: 612 });
    expect(doc(store, key).selection.pages).toEqual([blank.id]);
    await store.destroy();
  });

  it('inserts pages from another file and searches and saves them', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const outcome = await store
      .getState()
      .insertPagesFromFile(key, memoryFile('outline.pdf', readFixture('outline-and-text.pdf')), 1);
    expect(outcome).toEqual({ status: 'inserted', count: 6 });
    const model = editor(store, key).model;
    expect(model.pages).toHaveLength(9);
    expect(Object.keys(model.sources)).toHaveLength(2);
    const inserted = model.pages[1]!;
    expect(
      inserted.source.kind === 'source' && store.getSourceHandle(key, inserted.source.sourceId),
    ).toBeTruthy();
    expect(undoLabel(editor(store, key))).toBe('Insert 6 pages from outline.pdf');

    store.getState().setSearch(key, { query: 'photosynthesis' });
    await expect.poll(() => doc(store, key).search.status).toBe('done');
    expect(doc(store, key).search.matches.map((match) => match.pageIndex)).toEqual([5]);

    // Deleting pages re-runs the search against the new page order.
    store.getState().deletePages(key, [model.pages[0]!.id]);
    await expect.poll(() => doc(store, key).search.matches[0]?.pageIndex).toBe(4);

    const { bytes } = await store.getState().exportDocument(key);
    const texts = await pageTexts(bytes);
    expect(texts).toHaveLength(8);
    expect(texts[0]).toContain('Introduction');
    expect(texts[6]).toContain('Folio fixture page 2');
    await store.destroy();
  });

  it('asks for the password of a protected file before inserting its pages', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const file = () => memoryFile('locked.pdf', readFixture('encrypted-user-password.pdf'));
    expect(await store.getState().insertPagesFromFile(key, file(), 0)).toEqual({
      status: 'needs-password',
      rejected: false,
    });
    expect(await store.getState().insertPagesFromFile(key, file(), 0, 'wrong')).toEqual({
      status: 'needs-password',
      rejected: true,
    });
    expect(await store.getState().insertPagesFromFile(key, file(), 0, FIXTURE_PASSWORD)).toEqual({
      status: 'inserted',
      count: 3,
    });
    expect(store.getState().notice?.message).toMatch(/without its password protection/);
    // The saved document needs the password of neither file.
    const texts = await pageTexts((await store.getState().exportDocument(key)).bytes);
    expect(texts).toHaveLength(6);
    await store.destroy();
  });

  it('honours the permissions of restricted documents', async () => {
    const { store, key } = await openFixture('encrypted-owner-restricted.pdf');
    expect(doc(store, key).permissions).toMatchObject({
      assemble: false,
      annotate: false,
      modify: false,
    });
    store.getState().rotatePages(key, [pageIds(store, key)[0]!], 90);
    expect(canUndo(editor(store, key))).toBe(false);
    expect(store.getState().notice?.message).toMatch(/does not allow changing its pages/);
    expect(
      store.getState().addAnnotations(key, [note(pageIds(store, key)[0]!)], { label: 'Add note' }),
    ).toBe(false);
    await store.destroy();
  });

  it('keeps saved copies of protected documents protected', async () => {
    const { store, key } = await openFixture('encrypted-user-password.pdf', FIXTURE_PASSWORD);
    store.getState().deletePages(key, [pageIds(store, key)[0]!]);
    const { bytes } = await store.getState().exportDocument(key);
    await expect(engine.open(bytes)).rejects.toMatchObject({ code: 'password-required' });
    expect(await pageTexts(bytes, FIXTURE_PASSWORD)).toHaveLength(2);
    await store.destroy();
  });

  it('extracts pages and splits documents into new tabs', async () => {
    const { store, key } = await openFixture('outline-and-text.pdf');
    const ids = pageIds(store, key);
    const extract = await store.getState().exportDocument(key, { pageIds: [ids[4]!] });
    expect(await pageTexts(extract.bytes)).toEqual([expect.stringContaining('Chapter 2')]);

    const parts = await store.getState().splitDocument(key, [ids.slice(0, 2), ids.slice(2)]);
    expect(parts).toBe(2);
    const documents = store.getState().documents;
    expect(documents.map((entry) => entry.fileName)).toEqual([
      'outline-and-text.pdf',
      'outline-and-text (part 1).pdf',
      'outline-and-text (part 2).pdf',
    ]);
    expect(documents.map((entry) => entry.editor?.model.pages.length)).toEqual([6, 2, 4]);
    expect(store.getState().activeKey).toBe(documents[1]!.key);
    await store.destroy();
  });

  it('opens the parts of a protected document without asking again', async () => {
    const { store, key } = await openFixture('encrypted-user-password.pdf', FIXTURE_PASSWORD);
    const ids = pageIds(store, key);
    await store.getState().splitDocument(key, [[ids[0]!], ids.slice(1)]);
    const parts = store.getState().documents.slice(1);
    expect(parts.map((entry) => entry.status)).toEqual(['ready', 'ready']);
    expect(parts[0]?.info?.encryption).toBe('password-protected');
    await store.destroy();
  });
});

describe('workspace store: annotations and properties', () => {
  it('adds, changes and deletes annotations, merging quick changes into one step', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const pageId = pageIds(store, key)[0]!;
    const added = note(pageId);
    expect(store.getState().addAnnotations(key, [added], { label: 'Add note' })).toBe(true);
    expect(doc(store, key).selection.annotations).toEqual([added.id]);

    for (const x of [110, 120, 130]) {
      store.getState().updateAnnotations(key, [{ ...added, position: { x, y: 700 } }], {
        label: 'Move note',
        coalesceKey: `move:${added.id}`,
      });
    }
    expect(editor(store, key).history.past).toHaveLength(2);
    expect(editor(store, key).model.annotations[added.id]).toMatchObject({
      position: { x: 130, y: 700 },
    });
    store.getState().undo(key);
    expect(editor(store, key).model.annotations[added.id]).toMatchObject({
      position: { x: 100, y: 700 },
    });

    store.getState().deleteAnnotations(key, [added.id]);
    expect(editor(store, key).model.annotations).toEqual({});
    expect(doc(store, key).selection.annotations).toEqual([]);
    // Deleting the page also removes its annotations, and undo brings both back.
    store.getState().undo(key);
    store.getState().deletePages(key, [pageId]);
    expect(editor(store, key).model.annotations).toEqual({});
    store.getState().undo(key);
    expect(Object.keys(editor(store, key).model.annotations)).toEqual([added.id]);
    await store.destroy();
  });

  it('keeps image bytes for annotations and exports them', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const png = await makePng(8, 8);
    const asset = await store.getState().registerImage(key, png, 'image/png');
    expect(asset).toMatchObject({ mimeType: 'image/png', byteLength: png.byteLength });
    const pageId = pageIds(store, key)[0]!;
    const { position: _position, contents: _contents, ...common } = note(pageId);
    const image: Annotation = {
      ...common,
      kind: 'added-image',
      rect: { x: 100, y: 100, width: 50, height: 50 },
      assetId: asset!.id,
      rotation: 0,
    };
    expect(
      store.getState().addAnnotations(key, [image], { label: 'Add image', assets: [asset!] }),
    ).toBe(true);
    // The same picture again reuses the asset.
    expect((await store.getState().registerImage(key, png, 'image/png'))?.id).toBe(asset!.id);
    const { bytes } = await store.getState().exportDocument(key, { flatten: true });
    expect(bytes.byteLength).toBeGreaterThan(0);
    // Undo, then redo, still finds the bytes.
    store.getState().undo(key);
    store.getState().redo(key);
    await expect(store.getState().exportDocument(key)).resolves.toBeTruthy();
    await store.destroy();
  });

  it('edits document properties as one undo step while typing', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    store.getState().updateMetadata(key, { title: 'Q' });
    store.getState().updateMetadata(key, { title: 'Q1' });
    store.getState().updateMetadata(key, { title: 'Q1 report' });
    expect(editor(store, key).history.past).toHaveLength(1);
    expect(editor(store, key).model.metadata.title).toBe('Q1 report');
    store.getState().undo(key);
    expect(editor(store, key).model.metadata.title).toBe('Folio Basic Fixture');
    await store.destroy();
  });
});
