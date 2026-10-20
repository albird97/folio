import { describe, expect, it } from 'vitest';
import { createSourceDocument, primarySource } from './create';
import { newAnnotationId, newAssetId, newPageId } from './ids';
import { applyOperation, movePagesOperation, OperationError, type Operation } from './operations';
import { descriptor, sampleModel } from './test-helpers';
import type { Annotation, DocumentModel, NoteAnnotation, PageModel } from './types';

function note(model: DocumentModel, pageIndex: number, contents = 'Check this'): NoteAnnotation {
  const page = model.pages[pageIndex]!;
  return {
    id: newAnnotationId(),
    kind: 'note',
    pageId: page.id,
    author: 'Tester',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    color: '#f5b83d',
    opacity: 1,
    position: { x: 10, y: 10 },
    contents,
  };
}

/** Applying an operation and then its inverse must restore the model exactly. */
function expectRoundTrip(model: DocumentModel, operation: Operation): DocumentModel {
  const forward = applyOperation(model, operation);
  const back = applyOperation(forward.model, forward.inverse);
  expect(back.model).toEqual(model);
  return forward.model;
}

const ids = (model: DocumentModel) => model.pages.map((page) => page.id);

describe('page operations', () => {
  it('rotates pages and inverts the rotation', () => {
    const model = sampleModel(3);
    const [first, , third] = model.pages;
    const rotated = expectRoundTrip(model, {
      type: 'pages/rotate',
      pageIds: [first!.id, third!.id],
      delta: 90,
    });
    expect(rotated.pages.map((page) => page.rotation)).toEqual([90, 0, 90]);
    expect(rotated.pages[0]!.sourceRotation).toBe(0);
  });

  it('does not mutate its input', () => {
    const model = sampleModel(2);
    const snapshot = structuredClone(model);
    applyOperation(model, { type: 'pages/rotate', pageIds: [model.pages[0]!.id], delta: 180 });
    expect(model).toEqual(snapshot);
  });

  it('moves non-contiguous pages as a block', () => {
    const model = sampleModel(5);
    const [a, b, c, d, e] = ids(model);
    const op = movePagesOperation(model, [d!, b!], 0);
    const moved = expectRoundTrip(model, op);
    expect(ids(moved)).toEqual([b, d, a, c, e]);

    const toEnd = applyOperation(model, movePagesOperation(model, [a!], 4)).model;
    expect(ids(toEnd)).toEqual([b, c, d, e, a]);
  });

  it('rejects invalid reorders', () => {
    const model = sampleModel(3);
    const [a, b] = ids(model);
    expect(() => applyOperation(model, { type: 'pages/reorder', order: [a!, b!] })).toThrow(
      OperationError,
    );
    expect(() =>
      applyOperation(model, { type: 'pages/reorder', order: [a!, a!, b!] }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-order' }) as Error);
  });

  it('removes pages together with their annotations and restores both on undo', () => {
    const model = sampleModel(4);
    const withNotes = applyOperation(model, {
      type: 'annotations/add',
      annotations: [note(model, 1), note(model, 3), note(model, 0)],
    }).model;
    const target = [withNotes.pages[1]!.id, withNotes.pages[3]!.id];
    const removed = expectRoundTrip(withNotes, { type: 'pages/remove', pageIds: target });
    expect(removed.pages).toHaveLength(2);
    expect(Object.values(removed.annotations)).toHaveLength(1);
  });

  it('refuses to remove every page', () => {
    const model = sampleModel(2);
    expect(() => applyOperation(model, { type: 'pages/remove', pageIds: ids(model) })).toThrowError(
      expect.objectContaining({ code: 'empty-document' }) as Error,
    );
  });

  it('inserts pages at final indices and validates their source', () => {
    const model = sampleModel(2);
    const blank = (): PageModel => ({
      id: newPageId(),
      source: { kind: 'blank' },
      size: { width: 612, height: 792 },
      userUnit: 1,
      sourceRotation: 0,
      rotation: 0,
    });
    const x = blank();
    const y = blank();
    const inserted = expectRoundTrip(model, {
      type: 'pages/insert',
      entries: [
        { index: 3, page: y },
        { index: 0, page: x },
      ],
      annotations: [],
      sources: [],
    });
    expect(ids(inserted)).toEqual([x.id, model.pages[0]!.id, model.pages[1]!.id, y.id]);

    const orphan: PageModel = {
      ...blank(),
      source: { kind: 'source', sourceId: 'src_000000000000000000000000' as never, pageIndex: 0 },
    };
    expect(() =>
      applyOperation(model, {
        type: 'pages/insert',
        entries: [{ index: 0, page: orphan }],
        annotations: [],
        sources: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'unknown-source' }) as Error);
  });

  it('registers the sources of inserted pages and keeps them after an undo', () => {
    const model = sampleModel(2);
    const { source, pages } = createSourceDocument(descriptor(1, { fileName: 'other.pdf' }));
    const forward = applyOperation(model, {
      type: 'pages/insert',
      entries: [{ index: 0, page: pages[0]! }],
      annotations: [],
      sources: [source],
    });
    expect(Object.keys(forward.model.sources)).toHaveLength(2);
    // The opened file stays the primary source, whatever comes first.
    expect(primarySource(forward.model)?.fileName).toBe('sample.pdf');
    const back = applyOperation(forward.model, forward.inverse);
    expect(ids(back.model)).toEqual(ids(model));
    expect(back.model.sources[source.id]).toEqual(source);
  });

  it('registers the images of annotations on inserted pages and keeps them after an undo', () => {
    const model = sampleModel(1);
    const asset = {
      id: newAssetId(),
      mimeType: 'image/png' as const,
      byteLength: 10,
      sha256: 'c'.repeat(64),
    };
    const page: PageModel = { ...model.pages[0]!, id: newPageId() };
    const { position: _position, contents: _contents, ...common } = note(model, 0);
    const image: Annotation = {
      ...common,
      pageId: page.id,
      kind: 'signature',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      assetId: asset.id,
      rotation: 0,
    };
    const insert = (assets?: (typeof asset)[]): Operation => ({
      type: 'pages/insert',
      entries: [{ index: 1, page }],
      annotations: [image],
      sources: [],
      ...(assets ? { assets } : {}),
    });
    // An image the document does not know is refused, like annotations/add.
    expect(() => applyOperation(model, insert())).toThrowError(
      expect.objectContaining({ code: 'unknown-asset' }) as Error,
    );
    const forward = applyOperation(model, insert([asset]));
    expect(forward.model.assets[asset.id]).toEqual(asset);
    expect(forward.model.annotations[image.id]).toEqual(image);
    const back = applyOperation(forward.model, forward.inverse);
    expect(ids(back.model)).toEqual(ids(model));
    expect(back.model.annotations).toEqual({});
    expect(back.model.assets[asset.id]).toEqual(asset);
    // Redo needs nothing new: the image is still known.
    expect(applyOperation(back.model, insert()).model.annotations[image.id]).toEqual(image);
    // Without images, the assets keep their identity.
    expect(
      applyOperation(model, {
        type: 'pages/insert',
        entries: [{ index: 0, page }],
        annotations: [],
        sources: [],
      }).model.assets,
    ).toBe(model.assets);
  });

  it('reports unknown pages', () => {
    const model = sampleModel(1);
    expect(() =>
      applyOperation(model, { type: 'pages/rotate', pageIds: [newPageId()], delta: 90 }),
    ).toThrowError(expect.objectContaining({ code: 'unknown-page' }) as Error);
  });
});

describe('metadata and annotation operations', () => {
  it('updates metadata and restores previous values', () => {
    const model = sampleModel(1);
    const updated = expectRoundTrip(model, {
      type: 'metadata/update',
      patch: { title: 'New title', keywords: ['a', 'b'] },
    });
    expect(updated.metadata.title).toBe('New title');
    expect(updated.metadata.keywords).toEqual(['a', 'b']);
  });

  it('adds, replaces and removes annotations', () => {
    const model = sampleModel(2);
    const annotation = note(model, 0);
    const added = expectRoundTrip(model, { type: 'annotations/add', annotations: [annotation] });
    const replacement: Annotation = { ...annotation, contents: 'Edited' };
    const replaced = expectRoundTrip(added, {
      type: 'annotations/replace',
      annotations: [replacement],
    });
    expect((replaced.annotations[annotation.id] as NoteAnnotation).contents).toBe('Edited');
    expectRoundTrip(replaced, { type: 'annotations/remove', ids: [annotation.id] });
    expect(() =>
      applyOperation(added, { type: 'annotations/add', annotations: [annotation] }),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-id' }) as Error);
  });

  it('registers the images of added annotations', () => {
    const model = sampleModel(1);
    const asset = {
      id: newAssetId(),
      mimeType: 'image/png' as const,
      byteLength: 10,
      sha256: 'b'.repeat(64),
    };
    const { position: _position, contents: _contents, ...common } = note(model, 0);
    const image: Annotation = {
      ...common,
      kind: 'added-image',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      assetId: asset.id,
      rotation: 0,
    };
    expect(() =>
      applyOperation(model, { type: 'annotations/add', annotations: [image] }),
    ).toThrowError(expect.objectContaining({ code: 'unknown-asset' }) as Error);
    const forward = applyOperation(model, {
      type: 'annotations/add',
      annotations: [image],
      assets: [asset],
    });
    expect(forward.model.assets[asset.id]).toEqual(asset);
    // Undo removes the annotation; the image stays known for a redo.
    const back = applyOperation(forward.model, forward.inverse);
    expect(back.model.annotations).toEqual({});
    expect(back.model.assets[asset.id]).toEqual(asset);
  });

  it('applies batches atomically and inverts them in reverse order', () => {
    const model = sampleModel(3);
    const [a, b, c] = ids(model);
    const batch: Operation = {
      type: 'batch',
      operations: [
        { type: 'pages/rotate', pageIds: [a!], delta: 90 },
        { type: 'pages/reorder', order: [c!, b!, a!] },
        { type: 'metadata/update', patch: { author: 'Batch' } },
      ],
    };
    const result = expectRoundTrip(model, batch);
    expect(ids(result)).toEqual([c, b, a]);
    expect(() =>
      applyOperation(model, {
        type: 'batch',
        operations: [
          { type: 'pages/rotate', pageIds: [a!], delta: 90 },
          { type: 'pages/rotate', pageIds: [newPageId()], delta: 90 },
        ],
      }),
    ).toThrow(OperationError);
  });
});
