import { isDirty } from '@folio/document-model';
import { createPdfEngine } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_PASSWORD, nodeWorkerSrc, readFixture } from '../../../../tests/setup/fixtures';
import { createWorkspaceStore, isLikelyPdfName } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const basic = () => memoryFile('basic-3-pages.pdf', readFixture('basic-3-pages.pdf'));

describe('workspace store', () => {
  it('opens a document into a ready tab with a model, view and engine handle', async () => {
    const store = createWorkspaceStore(engine);
    await store.getState().openFiles([basic()]);
    const [doc] = store.getState().documents;
    expect(doc?.status).toBe('ready');
    expect(store.getState().activeKey).toBe(doc?.key);
    expect(doc?.editor?.model.pages).toHaveLength(3);
    expect(doc?.editor && isDirty(doc.editor)).toBe(false);
    expect(doc?.view?.currentPageId).toBe(doc?.editor?.model.pages[0]?.id);
    expect(store.getHandle(doc!.key)?.info.pageCount).toBe(3);
    await store.destroy();
  });

  it('asks for a password, rejects a wrong one and unlocks with the right one', async () => {
    const store = createWorkspaceStore(engine);
    await store.getState().openFiles([memoryFile('locked.pdf', readFixture('encrypted-user-password.pdf'))]);
    const key = store.getState().documents[0]!.key;
    expect(store.getState().documents[0]?.status).toBe('needs-password');
    expect(store.getState().documents[0]?.passwordRejected).toBe(false);

    await store.getState().submitPassword(key, 'nope');
    expect(store.getState().documents[0]).toMatchObject({ status: 'needs-password', passwordRejected: true });

    await store.getState().submitPassword(key, FIXTURE_PASSWORD);
    expect(store.getState().documents[0]).toMatchObject({ status: 'ready', passwordRejected: false });
    expect(store.getState().documents[0]?.info?.encryption).toBe('password-protected');
    await store.destroy();
  });

  it('shows a typed error for invalid files and skips other file types', async () => {
    const store = createWorkspaceStore(engine);
    await store.getState().openFiles([
      memoryFile('notes.pdf', readFixture('not-a-pdf.pdf')),
      memoryFile('photo.png', new Uint8Array([1, 2, 3])),
    ]);
    const { documents, notice } = store.getState();
    expect(documents).toHaveLength(1);
    expect(documents[0]?.status).toBe('error');
    expect(documents[0]?.error?.code).toBe('not-a-pdf');
    expect(notice?.message).toBe('Skipped 1 file that is not a PDF.');
    await store.destroy();
  });

  it('cycles and closes tabs, releasing native resources', async () => {
    const store = createWorkspaceStore(engine);
    const release = vi.fn();
    const files = [basic(), { ...basic(), name: 'second.pdf', release }, basic()];
    await store.getState().openFiles(files);
    const keys = store.getState().documents.map((doc) => doc.key);
    expect(store.getState().activeKey).toBe(keys[0]);
    store.getState().activateRelative(-1);
    expect(store.getState().activeKey).toBe(keys[2]);
    store.getState().activateRelative(1);
    expect(store.getState().activeKey).toBe(keys[0]);

    store.getState().activate(keys[1]!);
    await store.getState().close(keys[1]!);
    expect(release).toHaveBeenCalledOnce();
    expect(store.getHandle(keys[1]!)).toBeNull();
    expect(store.getState().activeKey).toBe(keys[2]);
    expect(store.getState().documents.map((doc) => doc.key)).toEqual([keys[0], keys[2]]);
    await store.destroy();
  });

  it('changes the current page only to pages that exist', async () => {
    const store = createWorkspaceStore(engine);
    await store.getState().openFiles([basic()]);
    const doc = store.getState().documents[0]!;
    const third = doc.editor!.model.pages[2]!.id;
    store.getState().setCurrentPage(doc.key, third);
    expect(store.getState().documents[0]?.view?.currentPageId).toBe(third);
    store.getState().setCurrentPage(doc.key, 'page_000000000000000000000000' as never);
    expect(store.getState().documents[0]?.view?.currentPageId).toBe(third);
    await store.destroy();
  });

  it('opens large documents', async () => {
    const { PDFDocument } = await import('@cantoo/pdf-lib');
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 400; i += 1) pdf.addPage([612, 792]);
    const bytes = await pdf.save();
    const store = createWorkspaceStore(engine);
    const started = performance.now();
    await store.getState().openFiles([memoryFile('large.pdf', bytes)]);
    const elapsed = performance.now() - started;
    expect(store.getState().documents[0]?.editor?.model.pages).toHaveLength(400);
    // Generous bound for CI machines; catches accidental per-page O(n²) work.
    expect(elapsed).toBeLessThan(5000);
    await store.destroy();
  });

  it('decides which dropped files to try', () => {
    expect(isLikelyPdfName('a.pdf')).toBe(true);
    expect(isLikelyPdfName('A.PDF')).toBe(true);
    expect(isLikelyPdfName('download')).toBe(true);
    expect(isLikelyPdfName('photo.jpeg')).toBe(false);
  });
});
