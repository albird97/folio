import type { OutlineItem, PdfEngine } from '@folio/pdf-core';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import { createMemoryPlatformAdapter, memoryFile } from '@folio/platform-adapters';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context';
import { createUiStore } from '../store/ui';
import { createWorkspaceStore, type WorkspaceStore } from '../store/workspace';
import { FindBar } from './find-bar';
import { OutlinePanel } from './outline-panel';
import { ResultsPanel } from './results-panel';

const run = (str: string, hasEOL = false) => ({
  str,
  hasEOL,
  transform: [1, 0, 0, 1, 72, 700],
  width: str.length * 6,
  height: 12,
});

const PAGE_TEXT = [
  [run('The quick brown fox', true), run('jumps over the lazy dog.')],
  [run('No match here.')],
  [run('Another Fox, and a fox.')],
];

const item = (title: string, pageIndex: number | null, extra: Partial<OutlineItem> = {}) => ({
  title,
  pageIndex,
  left: null,
  top: null,
  url: null,
  bold: false,
  italic: false,
  children: [],
  ...extra,
});

const OUTLINE: OutlineItem[] = [
  item('Introduction', 0),
  item('Chapter 1', 1, {
    bold: true,
    children: [item('Section 1.1', 2, { left: 72, top: 540 })],
  }),
  item('Folio on the web', null, { url: 'https://example.com/folio' }),
];

async function setup() {
  const handle = fakeDocumentHandle({
    info: { pageCount: PAGE_TEXT.length },
    getPageText: async (pageIndex) => ({ items: PAGE_TEXT[pageIndex] ?? [] }),
    getOutline: async () => OUTLINE,
  });
  const engine: PdfEngine = { open: async () => handle, destroy: () => undefined };
  const { adapter } = createMemoryPlatformAdapter();
  const workspace = createWorkspaceStore(engine);
  const ui = createUiStore(adapter.storage);
  await workspace.getState().openFiles([memoryFile('doc.pdf', new Uint8Array([37, 80, 68, 70]))]);
  const key = workspace.getState().documents[0]!.key;
  const doc = () => workspace.getState().documents[0]!;
  const wrap = (children: ReactNode) => (
    <WorkspaceProvider
      adapter={adapter}
      engine={engine}
      profile="desktop"
      stores={{ workspace, ui }}
    >
      {children}
    </WorkspaceProvider>
  );
  return { workspace, ui, handle, key, doc, wrap };
}

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

async function searchFinished(workspace: WorkspaceStore) {
  await waitFor(() => expect(workspace.getState().documents[0]!.search.status).toBe('done'));
}

describe('bookmarks', () => {
  it('works as a tree with the keyboard and follows destinations', async () => {
    const { workspace, key, doc, wrap, handle } = await setup();
    render(wrap(<OutlinePanel docKey={key} handle={handle} />));
    const tree = await screen.findByRole('tree', { name: 'Bookmarks' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
    const intro = screen.getByRole('treeitem', { name: /Introduction/ });
    const chapter = screen.getByRole('treeitem', { name: /Chapter 1/ });
    expect(intro.tabIndex).toBe(0);
    expect(chapter.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(intro, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(chapter);
    fireEvent.keyDown(chapter, { key: 'ArrowRight' });
    expect(chapter.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(chapter, { key: 'ArrowRight' });
    const section = screen.getByRole('treeitem', { name: /Section 1\.1/ });
    expect(document.activeElement).toBe(section);
    expect(section.getAttribute('aria-level')).toBe('2');

    fireEvent.keyDown(section, { key: 'Enter' });
    expect(doc().navigation?.target).toEqual({
      pageIndex: 2,
      point: { x: 72, y: 540 },
      align: 'top',
    });
    fireEvent.keyDown(section, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chapter);
    fireEvent.keyDown(chapter, { key: 'ArrowLeft' });
    expect(chapter.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(chapter, { key: 'End' });

    const link = screen.getByRole('treeitem', { name: /Folio on the web, link to example\.com/ });
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute('aria-disabled')).toBe('true');
    const before = doc().navigation;
    fireEvent.click(link);
    expect(doc().navigation).toBe(before);
    expect(tree).toBeTruthy();
    await workspace.destroy();
  });

  it('says when a document has no bookmarks', async () => {
    const { key, wrap, workspace } = await setup();
    render(wrap(<OutlinePanel docKey={key} handle={fakeDocumentHandle()} />));
    expect(await screen.findByText('This PDF has no bookmarks.')).toBeTruthy();
    await workspace.destroy();
  });
});

describe('find bar', () => {
  it('searches as you type, steps with Enter and closes with Escape', async () => {
    const { workspace, key, doc, wrap } = await setup();
    act(() => workspace.getState().openSearch(key));
    const onClose = vi.fn();
    const view = render(wrap(<FindBar doc={doc()} onClose={onClose} />));
    const rerender = () => view.rerender(wrap(<FindBar doc={doc()} onClose={onClose} />));
    const input = screen.getByRole('searchbox', { name: 'Find in document' });
    // Mounting (e.g. switching back to this tab) must not take focus; ⌘F focuses explicitly.
    expect(document.activeElement).not.toBe(input);
    input.focus();

    fireEvent.change(input, { target: { value: 'fox' } });
    // Typing waits for a pause before searching.
    expect(doc().search.query).toBe('');
    await searchFinished(workspace);
    rerender();
    expect(doc().search.matches).toHaveLength(3);
    expect(screen.getByRole('status').textContent).toBe('3 results');
    expect(screen.getByText('1 of 3')).toBeTruthy();
    // The count describes the field instead of being part of its name.
    expect(input.getAttribute('aria-describedby')).toBe('folio-find-summary');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(doc().search.active).toBe(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(doc().search.active).toBe(2);

    rerender();
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    await searchFinished(workspace);
    expect(doc().search.matches).toHaveLength(2);
    rerender();
    expect(screen.getByRole('button', { name: 'Match case' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // While the typed text differs from what was searched, nothing is announced.
    fireEvent.change(input, { target: { value: 'dog' } });
    rerender();
    expect(screen.getByRole('status').textContent).toBe('');
    // Enter searches at once instead of waiting.
    fireEvent.keyDown(input, { key: 'Enter' });
    await searchFinished(workspace);
    expect(doc().search.matches).toHaveLength(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    await workspace.destroy();
  });

  it('shows all results in the sidebar', async () => {
    const { workspace, ui, key, doc, wrap } = await setup();
    act(() => workspace.getState().setSearch(key, { query: 'fox' }));
    await searchFinished(workspace);
    render(wrap(<FindBar doc={doc()} onClose={() => undefined} />));
    fireEvent.click(screen.getByRole('button', { name: 'Show all results' }));
    expect(ui.getState()).toMatchObject({ leftPanelOpen: true, sidebarTab: 'results' });
    await workspace.destroy();
  });
});

describe('search results', () => {
  it('lists every match with its context and selects one', async () => {
    const { workspace, key, doc, wrap } = await setup();
    act(() => workspace.getState().setSearch(key, { query: 'fox' }));
    await searchFinished(workspace);
    const onFind = vi.fn();
    const view = render(wrap(<ResultsPanel doc={doc()} onFind={onFind} />));
    const list = screen.getByRole('list', { name: 'Search results' });
    const rows = list.querySelectorAll('button');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toBe('Page 1The quick brown fox jumps over the lazy dog.');
    expect(rows[0]!.querySelector('mark')?.textContent).toBe('fox');
    expect(rows[2]!.textContent).toContain('Page 3');
    expect(screen.getByText('3 results')).toBeTruthy();

    fireEvent.click(rows[2]!);
    expect(doc().search.active).toBe(2);
    expect(doc().navigation?.target).toMatchObject({ pageIndex: 2, align: 'center' });
    view.rerender(wrap(<ResultsPanel doc={doc()} onFind={onFind} />));
    fireEvent.keyDown(screen.getAllByRole('button')[2]!, { key: 'ArrowUp' });
    expect(doc().search.active).toBe(1);
    view.rerender(wrap(<ResultsPanel doc={doc()} onFind={onFind} />));
    expect(document.activeElement?.getAttribute('data-index')).toBe('1');
    await workspace.destroy();
  });

  it('invites a search when there is none', async () => {
    const { workspace, doc, wrap } = await setup();
    const onFind = vi.fn();
    render(wrap(<ResultsPanel doc={doc()} onFind={onFind} />));
    fireEvent.click(screen.getByRole('button', { name: /Find in document/ }));
    expect(onFind).toHaveBeenCalledOnce();
    await workspace.destroy();
  });
});
