import {
  serializeRecognizedText,
  serializeRecoverySnapshot,
  undoLabel,
  type AssetId,
  type RecognizedTextData,
  type RecognizedWord,
  type SourceId,
} from '@folio/document-model';
import { createPdfEngine, pageTextToString } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeWorkerSrc, readFixture, type FixtureName } from '../../../../tests/setup/fixtures';
import { documentPageText } from '../ocr/page-text';
import { PERMISSION_MESSAGES } from './editing';
import { createWorkspaceStore, type WorkspaceStore } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function openFixture(name: FixtureName) {
  const store = createWorkspaceStore(engine);
  await store.getState().openFiles([memoryFile(name, readFixture(name))]);
  const key = store.getState().documents[0]!.key;
  return { store, key };
}

const doc = (store: WorkspaceStore, key: string) =>
  store.getState().documents.find((entry) => entry.key === key)!;
const sourceOf = (store: WorkspaceStore, key: string) =>
  Object.keys(doc(store, key).editor!.model.sources)[0] as SourceId;

const word = (text: string, line: number, x: number, width: number, y = 600) =>
  ({ text, box: { x, y, width, height: 16 }, confidence: 91, line }) satisfies RecognizedWord;

/** What OCR found on a page: two lines. */
const RECOGNIZED: RecognizedTextData = {
  version: 1,
  languages: 'eng',
  rotation: 0,
  words: [
    word('The', 0, 72, 34),
    word('lighthouse', 0, 112, 86),
    word('keeper', 0, 204, 54),
    word('Ships', 1, 72, 40, 570),
    word('at', 1, 118, 14, 570),
    word('dawn.', 1, 138, 42, 570),
  ],
};

async function searchFor(store: WorkspaceStore, key: string, query: string) {
  store.getState().setSearch(key, { query });
  return finished(store, key);
}

async function finished(store: WorkspaceStore, key: string) {
  await expect.poll(() => doc(store, key).search.status, { timeout: 10_000 }).toBe('done');
  return doc(store, key).search;
}

describe('workspace store: recognized text', () => {
  it('searches recognized text like the page’s own, until the recognition is undone', async () => {
    const { store, key } = await openFixture('scanned-pages.pdf');
    const sourceId = sourceOf(store, key);
    expect((await searchFor(store, key, 'lighthouse')).matches).toEqual([]);

    expect(
      await store.getState().addRecognizedText(key, [{ sourceId, pageIndex: 0, data: RECOGNIZED }]),
    ).toBe(true);
    const editor = doc(store, key).editor!;
    expect(undoLabel(editor)).toBe('Recognize text');
    expect(Object.values(editor.model.textLayers)).toEqual([
      { assetId: expect.any(String), languages: 'eng', wordCount: 6 },
    ]);

    // The open search runs again by itself and finds the word where it is.
    let search = await finished(store, key);
    expect(search.matches).toHaveLength(1);
    const [match] = search.matches;
    expect(match).toMatchObject({ pageIndex: 0, excerpt: { match: 'lighthouse' } });
    const page = doc(store, key).editor!.model.pages[0]!;
    const text = await documentPageText(store, key, page);
    expect(text.items[match!.start.item]?.str).toBe('lighthouse');
    expect(pageTextToString(text)).toBe('The lighthouse keeper\nShips at dawn.');
    // A phrase across words and lines.
    expect((await searchFor(store, key, 'keeper ships')).matches).toHaveLength(1);

    store.getState().setSearch(key, { query: 'lighthouse' });
    await finished(store, key);
    store.getState().undo(key);
    expect(doc(store, key).editor!.model.textLayers).toEqual({});
    search = await finished(store, key);
    expect(search.matches).toEqual([]);
    store.getState().redo(key);
    expect((await finished(store, key)).matches).toHaveLength(1);
    await store.destroy();
  });

  it('gives the text of a page: its own runs, then the recognized ones', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const sourceId = sourceOf(store, key);
    const pages = doc(store, key).editor!.model.pages;
    const own = await documentPageText(store, key, pages[1]!);
    await store.getState().addRecognizedText(key, [{ sourceId, pageIndex: 1, data: RECOGNIZED }]);
    const text = await documentPageText(store, key, pages[1]!);
    expect(text.items.slice(0, own.items.length).map((item) => item.str)).toEqual(
      own.items.map((item) => item.str),
    );
    // The recognized text starts a new line, placed in user space.
    expect(text.items[own.items.length - 1]!.hasEOL).toBe(true);
    const lighthouse = text.items.find((item) => item.str === 'lighthouse')!;
    expect(lighthouse.transform).toEqual([16, 0, 0, 16, 112, 600 + 16 * 0.2]);
    expect(lighthouse.width).toBeCloseTo(86);
    expect(pageTextToString(text)).toContain('Folio fixture page 2');
    expect(pageTextToString(text).endsWith('The lighthouse keeper\nShips at dawn.')).toBe(true);
    // Other pages are unaffected; a page shown twice shares the text.
    expect(pageTextToString(await documentPageText(store, key, pages[0]!))).not.toContain(
      'lighthouse',
    );
    store.getState().duplicatePages(key, [pages[1]!.id]);
    const copy = doc(store, key).editor!.model.pages[2]!;
    expect(pageTextToString(await documentPageText(store, key, copy))).toContain('lighthouse');
    await store.destroy();
  });

  it('saves the text into the file and keeps it through crash recovery', async () => {
    const { store, key } = await openFixture('scanned-pages.pdf');
    const sourceId = sourceOf(store, key);
    await store.getState().addRecognizedText(key, [{ sourceId, pageIndex: 1, data: RECOGNIZED }]);

    const { bytes } = await store.getState().exportDocument(key);
    const saved = await engine.open(bytes);
    expect(pageTextToString(await saved.getPageText(1))).toContain('lighthouse keeper');
    expect(pageTextToString(await saved.getPageText(0))).toBe('');
    await saved.destroy();

    // What autosave keeps: the snapshot, the source file and the text's JSON.
    const { editor, view } = doc(store, key);
    const files = new Map<string, Uint8Array>();
    for (const source of Object.values(editor!.model.sources)) {
      files.set(source.sha256, store.getSourceBytes(key, source.id)!);
    }
    for (const id of Object.keys(editor!.model.assets) as AssetId[]) {
      files.set(id, store.getAssetBytes(key, id)!);
    }
    const outcome = await store.getState().restoreDocument({
      snapshot: serializeRecoverySnapshot(editor!, view!),
      files,
      recoveryId: 'doc-restored',
    });
    expect(outcome.status).toBe('restored');
    const restored = outcome.status === 'restored' ? outcome.key : '';
    expect((await searchFor(store, restored, 'lighthouse')).matches).toEqual([
      expect.objectContaining({ pageIndex: 1 }),
    ]);
    await store.destroy();
  });

  it('shows no text for stored data that is damaged', async () => {
    const { store, key } = await openFixture('scanned-pages.pdf');
    const ref = await store
      .getState()
      .registerData(key, new TextEncoder().encode('{"version":1'), 'application/json');
    store.getState().apply(
      key,
      {
        type: 'text-layers/set',
        entries: [
          {
            key: `${sourceOf(store, key)}:0`,
            layer: { assetId: ref!.id, languages: 'eng', wordCount: 1 },
          },
        ],
        assets: [ref!],
      },
      { label: 'Recognize text' },
    );
    expect(store.getRecognizedText(key, ref!.id)).toBeNull();
    const page = doc(store, key).editor!.model.pages[0]!;
    expect((await documentPageText(store, key, page)).items).toEqual([]);
    await store.destroy();
  });

  it('needs the permission to change the document', async () => {
    const { store, key } = await openFixture('encrypted-owner-restricted.pdf');
    expect(doc(store, key).permissions.modify).toBe(false);
    const added = await store
      .getState()
      .addRecognizedText(key, [{ sourceId: sourceOf(store, key), pageIndex: 0, data: RECOGNIZED }]);
    expect(added).toBe(false);
    expect(store.getState().notice?.message).toBe(PERMISSION_MESSAGES.modify);
    expect(doc(store, key).editor!.model.textLayers).toEqual({});
    await store.destroy();
  });

  it('registers the same text data once', async () => {
    const { store, key } = await openFixture('scanned-pages.pdf');
    const sourceId = sourceOf(store, key);
    await store.getState().addRecognizedText(key, [{ sourceId, pageIndex: 0, data: RECOGNIZED }]);
    const [assetId] = Object.keys(doc(store, key).editor!.model.assets) as AssetId[];
    const again = await store
      .getState()
      .registerData(key, serializeRecognizedText(RECOGNIZED), 'application/json');
    expect(again?.id).toBe(assetId);
    expect(store.getRecognizedText(key, assetId!)).toEqual(RECOGNIZED);
    await store.destroy();
  });
});
