import {
  createDocumentModel,
  createEditorState,
  execute,
  type SourceId,
} from '@folio/document-model';
import { createPdfEngine } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import {
  makeLargePdf,
  nodeWorkerSrc,
  readFixture,
  type FixtureName,
} from '../../../../tests/setup/fixtures';
import { applyPageInfo } from './editing';
import { createWorkspaceStore, type WorkspaceStore } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function openFixture(name: FixtureName) {
  const store = createWorkspaceStore(engine);
  await store.getState().openFiles([memoryFile(name, readFixture(name))]);
  const doc = store.getState().documents[0]!;
  return { store, key: doc.key };
}

const current = (store: WorkspaceStore) => store.getState().documents[0]!;

async function searchDone(store: WorkspaceStore) {
  await expect.poll(() => current(store).search.status, { timeout: 10_000 }).toBe('done');
  return current(store).search;
}

describe('workspace store: viewing', () => {
  it('streams exact page sizes into the model of large documents', async () => {
    const bytes = await makeLargePdf(300, (index) => (index >= 150 ? [842, 595] : [612, 792]));
    const store = createWorkspaceStore(engine);
    await store.getState().openFiles([memoryFile('large.pdf', bytes)]);
    await expect.poll(() => current(store).pagesComplete, { timeout: 10_000 }).toBe(true);
    const pages = current(store).editor!.model.pages;
    expect(pages).toHaveLength(300);
    expect(pages[0]?.size).toEqual({ width: 612, height: 792 });
    expect(pages[149]?.size).toEqual({ width: 612, height: 792 });
    expect(pages[150]?.size).toEqual({ width: 842, height: 595 });
    expect(pages[299]?.size).toEqual({ width: 842, height: 595 });
    await store.destroy();
  });

  it('requests navigation and clears only the request it handled', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    store.getState().navigate(key, { pageIndex: 2, point: { x: 72, y: 500 }, align: 'top' });
    const first = current(store).navigation!;
    expect(first.target).toMatchObject({ pageIndex: 2, point: { x: 72, y: 500 } });
    expect(current(store).view?.currentPageId).toBe(current(store).editor?.model.pages[2]?.id);
    store.getState().navigate(key, { pageIndex: 1, align: 'top' });
    // A late clear for the earlier request leaves the newer one in place.
    store.getState().clearNavigation(key, first.seq);
    expect(current(store).navigation?.target.pageIndex).toBe(1);
    store.getState().clearNavigation(key, current(store).navigation!.seq);
    expect(current(store).navigation).toBeNull();
    // Pages that do not exist are ignored.
    store.getState().navigate(key, { pageIndex: 9, align: 'top' });
    expect(current(store).navigation).toBeNull();
    await store.destroy();
  });

  it('zooms within limits, by preset steps, and keeps fit modes in sync', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    expect(current(store).view).toMatchObject({ zoomMode: 'auto', zoom: 1 });
    store.getState().syncFitZoom(key, 1.07);
    expect(current(store).view).toMatchObject({ zoomMode: 'auto', zoom: 1.07 });
    store.getState().zoomBy(key, 1);
    expect(current(store).view).toMatchObject({ zoomMode: 'custom', zoom: 1.1 });
    store.getState().zoomBy(key, -1);
    store.getState().zoomBy(key, -1);
    expect(current(store).view?.zoom).toBe(0.9);
    // Fit scales computed by the viewer do not override a custom zoom.
    store.getState().syncFitZoom(key, 2);
    expect(current(store).view?.zoom).toBe(0.9);
    store.getState().setZoom(key, 'custom', 50);
    expect(current(store).view?.zoom).toBe(8);
    store.getState().setZoom(key, 'custom', 0);
    expect(current(store).view?.zoom).toBe(0.1);
    store.getState().setZoom(key, 'fit-page');
    expect(current(store).view).toMatchObject({ zoomMode: 'fit-page', zoom: 0.1 });
    await store.destroy();
  });

  it('rotates the view without touching the document model', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const model = current(store).editor!.model;
    store.getState().rotateView(key, -90);
    expect(current(store).view?.rotation).toBe(270);
    store.getState().rotateView(key, 90);
    store.getState().rotateView(key, 90);
    expect(current(store).view?.rotation).toBe(90);
    expect(current(store).editor!.model).toBe(model);
    expect(current(store).editor!.history.past).toHaveLength(0);
    await store.destroy();
  });

  it('records the scroll position', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const second = current(store).editor!.model.pages[1]!.id;
    store.getState().updatePosition(key, second, 0.25);
    expect(current(store).view).toMatchObject({ currentPageId: second, pageOffset: 0.25 });
    store.getState().updatePosition(key, second, -3);
    expect(current(store).view?.pageOffset).toBe(-1);
    const view = current(store).view;
    store.getState().updatePosition(key, second, -1.0000001);
    expect(current(store).view).toBe(view);
    await store.destroy();
  });

  it('searches every page, starting from the current one, and steps through matches', async () => {
    const { store, key } = await openFixture('outline-and-text.pdf');
    store.getState().setCurrentPage(key, current(store).editor!.model.pages[2]!.id);
    store.getState().setSearch(key, { query: 'fox' });
    const search = await searchDone(store);
    expect(search.matches).toHaveLength(8);
    expect(search.matches.map((match) => match.pageIndex)).toEqual([0, 1, 1, 1, 2, 2, 3, 3]);
    // The first match at or after page 3 is active, and the viewer is sent there.
    expect(search.active).toBe(4);
    expect(current(store).navigation?.target).toMatchObject({ pageIndex: 2, align: 'center' });
    expect(search.matches[4]?.excerpt.match).toBe('Fox');

    store.getState().stepSearch(key, 1);
    store.getState().stepSearch(key, 1);
    store.getState().stepSearch(key, 1);
    store.getState().stepSearch(key, 1);
    expect(current(store).search.active).toBe(0);
    store.getState().stepSearch(key, -1);
    expect(current(store).search.active).toBe(7);
    store.getState().selectMatch(key, 1);
    expect(current(store).search.active).toBe(1);
    expect(current(store).navigation?.target.pageIndex).toBe(1);

    store.getState().setSearch(key, { options: { wholeWords: true, matchCase: true } });
    expect((await searchDone(store)).matches).toHaveLength(6);

    store.getState().closeSearch(key);
    expect(current(store).search).toMatchObject({
      open: false,
      query: '',
      matches: [],
      active: -1,
      options: { wholeWords: true, matchCase: true },
    });
    await store.destroy();
  });

  it('wraps to the first match when none follows the current page', async () => {
    const { store, key } = await openFixture('outline-and-text.pdf');
    store.getState().setCurrentPage(key, current(store).editor!.model.pages[5]!.id);
    store.getState().setSearch(key, { query: 'fox' });
    const search = await searchDone(store);
    expect(search.active).toBe(0);
    store.getState().setSearch(key, { query: '   ' });
    expect(current(store).search).toMatchObject({ status: 'idle', matches: [], active: -1 });
    await store.destroy();
  });

  it('keeps the original bytes for "Save a copy"', async () => {
    const { store, key } = await openFixture('outline-and-text.pdf');
    expect(store.getBytes(key)).toEqual(readFixture('outline-and-text.pdf'));
    expect(store.getBytes('missing')).toBeNull();
    await store.destroy();
  });
});

describe('applyPageInfo', () => {
  it('patches pages of a source by their source index, in the model and the history', () => {
    const model = createDocumentModel({
      fileName: 'a.pdf',
      byteLength: 10,
      sha256: '0'.repeat(64),
      pdfVersion: '1.7',
      encryption: 'none',
      origin: { kind: 'generated' },
      metadata: {},
      pages: [
        { size: { width: 612, height: 792 }, rotation: 0 },
        { size: { width: 612, height: 792 }, rotation: 0 },
        { size: { width: 612, height: 792 }, rotation: 0 },
      ],
    });
    const sourceId = Object.keys(model.sources)[0] as SourceId;
    // Page 2 is deleted before its exact size arrives; undo must bring back the exact size.
    const state = execute(
      createEditorState(model),
      { type: 'pages/remove', pageIds: [model.pages[2]!.id] },
      { label: 'Delete' },
    );
    expect(applyPageInfo(state, sourceId, [])).toBe(state);
    const updated = applyPageInfo(state, sourceId, [
      { index: 1, info: { size: { width: 100, height: 200 }, rotation: 90, userUnit: 2 } },
      { index: 2, info: { size: { width: 300, height: 400 }, rotation: 0, userUnit: 1 } },
      { index: 7, info: { size: { width: 1, height: 1 }, rotation: 0, userUnit: 1 } },
    ]);
    expect(updated.model.pages[0]).toBe(state.model.pages[0]);
    expect(updated.model.pages[1]).toMatchObject({
      size: { width: 100, height: 200 },
      sourceRotation: 90,
      userUnit: 2,
    });
    const inverse = updated.history.past[0]!.inverse;
    expect(inverse.type === 'pages/insert' && inverse.entries[0]!.page.size).toEqual({
      width: 300,
      height: 400,
    });
    // Other sources are left alone.
    expect(
      applyPageInfo(state, 'src_000000000000000000000000' as SourceId, [
        { index: 1, info: { size: { width: 1, height: 1 }, rotation: 0, userUnit: 1 } },
      ]).model.pages[1],
    ).toEqual(state.model.pages[1]);
  });
});
