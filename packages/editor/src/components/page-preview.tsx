import type { PdfDocumentHandle } from '@folio/pdf-core';
import { rotatedSize, type PageModel } from '@folio/document-model';
import { Banner, Spinner } from '@folio/shared-ui';
import { useEffect, useRef, useState } from 'react';

const PADDING = 40;
const MAX_SCALE = 2;

/**
 * Renders one page, fitted to the available space. This is the Phase 1
 * preview; the continuous, virtualized viewer replaces it in Phase 2.
 */
export function PagePreview({
  handle,
  page,
  position,
  pageCount,
}: {
  handle: PdfDocumentHandle;
  page: PageModel;
  /** Zero-based position of the page in the document (not in its source file). */
  position: number;
  pageCount: number;
}) {
  // Phase 1 documents have a single source; multi-source rendering lands with merge.
  const sourceIndex = page.source.kind === 'source' ? page.source.pageIndex : position;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [state, setState] = useState<'rendering' | 'done' | 'error'>('rendering');

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { width, height } = entry.contentRect;
        setBox((previous) =>
          previous && Math.abs(previous.width - width) < 2 && Math.abs(previous.height - height) < 2
            ? previous
            : { width, height },
        );
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const rotation = page.rotation;
  const effective = rotatedSize(
    page.size,
    ((page.sourceRotation + page.rotation) % 360) as PageModel['rotation'],
  );
  const scale = box
    ? Math.min(
        MAX_SCALE,
        Math.max(0.1, (box.width - PADDING * 2) / effective.width),
        Math.max(0.1, (box.height - PADDING * 2) / effective.height),
      )
    : null;

  useEffect(() => {
    // The canvas stays mounted (hidden) after an error, so the next page or
    // document always gets a fresh render here.
    const canvas = canvasRef.current;
    if (!canvas || scale === null) return;
    setState('rendering');
    let superseded = false;
    const job = handle.renderPage(sourceIndex, canvas, {
      scale,
      rotation,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    job.promise.then(
      (completed) => {
        if (completed && !superseded) setState('done');
      },
      () => {
        if (!superseded) setState('error');
      },
    );
    return () => {
      superseded = true;
      job.cancel();
    };
  }, [handle, sourceIndex, rotation, scale]);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col items-center justify-center"
    >
      {state === 'error' ? (
        <Banner tone="danger" title="This page could not be rendered.">
          The document may be damaged or use an unsupported feature.
        </Banner>
      ) : null}
      <figure hidden={state === 'error'} className="flex flex-col items-center gap-3">
        <div className="relative">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Page ${position + 1} of ${pageCount}`}
            data-testid="page-canvas"
            data-render-state={state}
            className="block bg-page shadow-page"
          />
          {state === 'rendering' ? (
            <div className="absolute inset-0 flex items-center justify-center text-[oklch(0.45_0.01_230)]">
              <Spinner label={`Rendering page ${position + 1}`} />
            </div>
          ) : null}
        </div>
        <figcaption className="text-xs text-ink-muted tabular">
          Page {position + 1} of {pageCount}
        </figcaption>
      </figure>
    </div>
  );
}
