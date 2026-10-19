import {
  createDocumentModel,
  createEditorState,
  createViewState,
  pageStamps,
  type PageNumberStamp,
} from '@folio/document-model';
import type * as DocumentModelModule from '@folio/document-model';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS } from '../store/editing';
import { EMPTY_SELECTION, IDLE_SEARCH, type WorkspaceDocument } from '../store/workspace';
import type { PageOverlayProps } from './page-overlays';
import { StampLayer } from './stamp-layer';

// Counts layouts, to tell when the layer renders.
vi.mock('@folio/document-model', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentModelModule>();
  return { ...actual, pageStamps: vi.fn(actual.pageStamps) };
});

const NUMBERS: PageNumberStamp = {
  format: 'Page {page} of {total}',
  position: 'bottom-center',
  fontFamily: 'sans',
  fontSize: 10,
  color: '#1f2328',
  margin: 36,
  startNumber: 1,
  pages: { from: 2, to: null },
};

function document(): WorkspaceDocument {
  const model = createDocumentModel({
    fileName: 'doc.pdf',
    byteLength: 4,
    sha256: 'a'.repeat(64),
    pdfVersion: '1.7',
    encryption: 'none',
    origin: { kind: 'generated' },
    metadata: {},
    pages: Array.from({ length: 12 }, () => ({ size: { width: 612, height: 792 }, rotation: 0 })),
  });
  const stamped = { ...model, stamps: { pageNumbers: NUMBERS, watermark: null } };
  return {
    key: 'tab-1',
    fileName: 'doc.pdf',
    byteLength: 4,
    status: 'ready',
    error: null,
    passwordRejected: false,
    editor: createEditorState(stamped),
    view: createViewState(stamped),
    info: null,
    permissions: ALL_PERMISSIONS,
    pagesComplete: true,
    navigation: null,
    search: IDLE_SEARCH,
    selection: EMPTY_SELECTION,
    busy: null,
    saveTarget: null,
    diskSha256: null,
    recoveryId: 'doc-1',
  };
}

const props = (doc: WorkspaceDocument, position: number): PageOverlayProps => ({
  doc,
  page: doc.editor!.model.pages[position]!,
  position,
  pageCount: 12,
  box: { top: 24, left: 40, width: 612, height: 792 },
  scale: 1,
  viewRotation: 0,
  handle: null,
  tool: 'select',
});

describe('stamp layer', () => {
  it('draws the stamps of a page as hidden text that lets pointers through', () => {
    const doc = document();
    const { container, rerender } = render(<StampLayer {...props(doc, 1)} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('pointer-events')).toBe('none');
    expect(svg.getAttribute('data-stamp-layer')).toBe('2');
    expect(svg.getAttribute('style')).toContain('top: 24px');
    expect(svg.querySelector('[data-stamp="pageNumbers"]')?.textContent).toBe('Page 1 of 11');
    // The first page is not in the range.
    rerender(<StampLayer {...props(doc, 0)} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders again only when what it draws changes, not when the view scrolls', () => {
    const doc = document();
    const { rerender } = render(<StampLayer {...props(doc, 1)} />);
    const layouts = vi.mocked(pageStamps);
    layouts.mockClear();
    // Scrolling gives the document a new view (and a new object).
    const scrolled = { ...doc, view: { ...doc.view!, pageOffset: 0.4 } };
    rerender(<StampLayer {...props(scrolled, 1)} tool="ink" />);
    expect(layouts).not.toHaveBeenCalled();

    rerender(
      <StampLayer {...props(scrolled, 1)} box={{ top: 24, left: 40, width: 700, height: 905 }} />,
    );
    expect(layouts).toHaveBeenCalledTimes(1);
    const restamped = {
      ...scrolled,
      editor: {
        ...scrolled.editor!,
        model: { ...scrolled.editor!.model, stamps: { pageNumbers: null, watermark: null } },
      },
    };
    rerender(<StampLayer {...props(restamped, 1)} />);
    expect(layouts).toHaveBeenCalledTimes(2);
  });
});
