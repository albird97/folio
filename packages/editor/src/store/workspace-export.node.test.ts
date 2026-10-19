import type { FormFieldId } from '@folio/document-model';
import { PDFDocument } from '@cantoo/pdf-lib';
import { createPdfEngine, extractText } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeWorkerSrc, readFixture, type FixtureName } from '../../../../tests/setup/fixtures';
import { createWorkspaceStore, type WorkspaceStore } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function openFixture(name: FixtureName) {
  const store = createWorkspaceStore(engine);
  await store.getState().openFiles([memoryFile(name, readFixture(name))]);
  return { store, key: store.getState().documents[0]!.key };
}

const model = (store: WorkspaceStore, key: string) =>
  store.getState().documents.find((entry) => entry.key === key)!.editor!.model;

async function textOf(bytes: Uint8Array) {
  const handle = await engine.open(bytes);
  try {
    return await extractText(handle);
  } finally {
    await handle.destroy();
  }
}

describe('workspace store: exports for the export tools', () => {
  it('leaves out page numbers and the watermark when asked', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    expect(
      store.getState().setStamps(
        key,
        {
          pageNumbers: {
            format: 'Folio page {page}',
            position: 'bottom-center',
            fontFamily: 'sans',
            fontSize: 10,
            color: '#000000',
            margin: 36,
            startNumber: 1,
            pages: { from: 1, to: null },
          },
        },
        'Add page numbers',
      ),
    ).toBe(true);
    expect(await textOf((await store.getState().exportDocument(key)).bytes)).toContain(
      'Folio page 2',
    );
    const without = await store.getState().exportDocument(key, { withoutStamps: true });
    expect(await textOf(without.bytes)).not.toContain('Folio page');
    // The document keeps them.
    expect(model(store, key).stamps.pageNumbers).not.toBeNull();
    await store.getState().close(key);
  });

  it('leaves out values filled in with Folio when asked', async () => {
    const { store, key } = await openFixture('form-fields.pdf');
    await expect.poll(() => Object.keys(model(store, key).formFields).length).toBeGreaterThan(0);
    const field = Object.values(model(store, key).formFields).find(
      (entry) => entry.name === 'name',
    )!;
    expect(store.getState().fillFormField(key, field.id as FormFieldId, 'Grace Hopper')).toBe(true);
    const nameIn = async (bytes: Uint8Array) =>
      (await PDFDocument.load(bytes, { updateMetadata: false }))
        .getForm()
        .getTextField('name')
        .getText() ?? '';
    expect(await nameIn((await store.getState().exportDocument(key)).bytes)).toBe('Grace Hopper');
    const original = await nameIn(readFixture('form-fields.pdf'));
    expect(
      await nameIn((await store.getState().exportDocument(key, { withoutFormValues: true })).bytes),
    ).toBe(original);
    await store.getState().close(key);
  });

  it('compresses copies when asked, without changing the document', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const plain = await store.getState().exportDocument(key);
    const progress: number[] = [];
    const compressed = await store.getState().exportDocument(key, {
      compression: { images: null, onProgress: (done) => progress.push(done) },
    });
    expect(compressed.bytes.length).toBeLessThanOrEqual(plain.bytes.length);
    expect(await textOf(compressed.bytes)).toBe(await textOf(plain.bytes));
    // Lossless: no image to re-encode, so nothing to report.
    expect(progress).toEqual([]);
    expect(store.getState().documents[0]!.editor!.history.past).toHaveLength(0);
    await store.getState().close(key);
  });
});
