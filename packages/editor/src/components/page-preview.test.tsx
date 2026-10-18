import type { PageId, PageModel, SourceId } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PagePreview } from './page-preview';

class FixedSizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [{ contentRect: { width: 800, height: 1000 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}

beforeAll(() => vi.stubGlobal('ResizeObserver', FixedSizeObserver));
afterAll(() => vi.unstubAllGlobals());

const page = (pageIndex: number): PageModel => ({
  id: `page_${pageIndex}` as PageId,
  source: { kind: 'source', sourceId: 'source_1' as SourceId, pageIndex },
  size: { width: 612, height: 792 },
  userUnit: 1,
  sourceRotation: 0,
  rotation: 0,
});

/** A handle whose renders finish only when the test settles them. */
function controlledHandle() {
  const jobs: Array<{
    pageIndex: number;
    resolve(completed: boolean): void;
    reject(error: Error): void;
  }> = [];
  const handle = {
    renderPage: (pageIndex: number) => {
      let settle!: Pick<(typeof jobs)[number], 'resolve' | 'reject'>;
      const promise = new Promise<boolean>((resolve, reject) => {
        settle = { resolve, reject };
      });
      jobs.push({ pageIndex, ...settle });
      return { promise, cancel: () => undefined };
    },
  } as unknown as PdfDocumentHandle;
  return { handle, jobs };
}

const renderState = () => screen.getByTestId('page-canvas').dataset.renderState;

async function settleLast(jobs: ReturnType<typeof controlledHandle>['jobs'], ok: boolean) {
  await vi.waitFor(() => expect(jobs.length).toBeGreaterThan(0));
  const job = jobs.at(-1)!;
  if (ok) job.resolve(true);
  else job.reject(new Error('damaged page'));
}

describe('page preview', () => {
  it('renders later pages and documents after one page fails', async () => {
    const first = controlledHandle();
    const preview = (handle: PdfDocumentHandle, index: number) => (
      <PagePreview handle={handle} page={page(index)} position={index} pageCount={3} />
    );
    const { rerender } = render(preview(first.handle, 0));
    await settleLast(first.jobs, true);
    await vi.waitFor(() => expect(renderState()).toBe('done'));

    rerender(preview(first.handle, 1));
    await settleLast(first.jobs, false);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This page could not be rendered.',
    );

    rerender(preview(first.handle, 2));
    await vi.waitFor(() => expect(first.jobs.at(-1)?.pageIndex).toBe(2));
    expect(screen.queryByRole('alert')).toBeNull();
    await settleLast(first.jobs, true);
    await vi.waitFor(() => expect(renderState()).toBe('done'));

    const second = controlledHandle();
    rerender(preview(first.handle, 1));
    await settleLast(first.jobs, false);
    await screen.findByRole('alert');
    rerender(preview(second.handle, 0));
    await settleLast(second.jobs, true);
    await vi.waitFor(() => expect(renderState()).toBe('done'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores the outcome of a render that a newer page replaced', async () => {
    const { handle, jobs } = controlledHandle();
    const { rerender } = render(
      <PagePreview handle={handle} page={page(0)} position={0} pageCount={2} />,
    );
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    rerender(<PagePreview handle={handle} page={page(1)} position={1} pageCount={2} />);
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    jobs[1]!.resolve(true);
    await vi.waitFor(() => expect(renderState()).toBe('done'));
    jobs[0]!.reject(new Error('failed after it was replaced'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderState()).toBe('done');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
