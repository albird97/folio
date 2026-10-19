import {
  applyOperation,
  createDocumentModel,
  newAssetId,
  newPageId,
  sourcePageKey,
  type DocumentModel,
  type PageModel,
  type SourceId,
} from '@folio/document-model';
import { describe, expect, it } from 'vitest';
import { pagesToRecognize, type RecognitionScope } from './selection';

/**
 * Five source pages, then a copy of page 2 and a blank page: pages 1 and 3
 * have text of their own, page 4 was recognized before.
 */
function document(): { model: DocumentModel; sourceId: SourceId } {
  const created = createDocumentModel({
    fileName: 'scan.pdf',
    byteLength: 100,
    sha256: 'a'.repeat(64),
    pdfVersion: '1.7',
    encryption: 'none',
    origin: { kind: 'generated' },
    metadata: {},
    pages: Array.from({ length: 5 }, () => ({ size: { width: 612, height: 792 }, rotation: 0 })),
  });
  const sourceId = Object.keys(created.sources)[0] as SourceId;
  const copy: PageModel = { ...created.pages[1]!, id: newPageId() };
  const blank: PageModel = { ...created.pages[0]!, id: newPageId(), source: { kind: 'blank' } };
  const asset = {
    id: newAssetId(),
    mimeType: 'application/json' as const,
    byteLength: 10,
    sha256: 'b'.repeat(64),
  };
  let model = applyOperation(created, {
    type: 'pages/insert',
    entries: [
      { index: 5, page: copy },
      { index: 6, page: blank },
    ],
    annotations: [],
    sources: [],
  }).model;
  model = applyOperation(model, {
    type: 'text-layers/set',
    entries: [
      {
        key: sourcePageKey(sourceId, 3),
        layer: { assetId: asset.id, languages: 'eng', wordCount: 3 },
      },
    ],
    assets: [asset],
  }).model;
  return { model, sourceId };
}

const OWN_TEXT = new Set([0, 2]);

function chosen(
  scope: RecognitionScope,
  options: { positions?: number[]; include?: boolean; known?: number } = {},
) {
  const { model, sourceId } = document();
  const result = pagesToRecognize(
    model,
    { scope, positions: options.positions ?? [], includePagesWithText: options.include ?? false },
    (key) => {
      const index = Number(key.slice(key.indexOf(':') + 1));
      if (!key.startsWith(sourceId) || index >= (options.known ?? 5)) return undefined;
      return OWN_TEXT.has(index);
    },
  );
  return {
    unknown: result.unknown,
    // Positions in the document, from 1.
    pages: result.pages.map((page) => model.pages.indexOf(page) + 1),
  };
}

describe('pages to recognize', () => {
  it('finds the pages without text, each source page once and no blank pages', () => {
    expect(chosen('without-text')).toEqual({ pages: [2, 5], unknown: false });
    // Until every page is checked, the choice is not final.
    expect(chosen('without-text', { known: 2 })).toEqual({ pages: [2], unknown: true });
  });

  it('reads chosen pages again, and pages with text only when asked', () => {
    expect(chosen('all')).toEqual({ pages: [2, 4, 5], unknown: false });
    expect(chosen('all', { include: true, known: 0 })).toEqual({
      pages: [1, 2, 3, 4, 5],
      unknown: false,
    });
    // Page 6 is a copy of page 2, page 7 is blank and page 3 has text.
    expect(chosen('range', { positions: [5, 1, 6, 2] })).toEqual({ pages: [2], unknown: false });
    expect(chosen('range', { positions: [5, 6] })).toEqual({ pages: [6], unknown: false });
    expect(chosen('current', { positions: [0] })).toEqual({ pages: [], unknown: false });
    expect(chosen('current', { positions: [0], include: true })).toEqual({
      pages: [1],
      unknown: false,
    });
  });
});
