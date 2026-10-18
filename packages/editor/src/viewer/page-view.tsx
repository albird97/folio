import type { Rotation } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import { Spinner } from '@folio/shared-ui';
import {
  memo,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { matchRanges, type TextMatch } from '../search/match';
import type { PageBox } from './layout';
import type { SchedulableJob } from './render-scheduler';
import { pageCache, pageVariant, scheduler } from './resources';

/** Search matches on one page. */
export interface PageHits {
  matches: readonly TextMatch[];
  /** Index in `matches` of the active match, or -1. */
  active: number;
}

export interface PageViewProps {
  docKey: string;
  handle: PdfDocumentHandle;
  /** Position in the document, from 0. */
  position: number;
  pageCount: number;
  /** The engine page to draw. */
  sourceIndex: number;
  box: PageBox;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Added to the page's own /Rotate. */
  rotation: Rotation;
  userUnit: number;
  ratio: number;
  /** Queue priority of this page's rendering (lower runs first). */
  priority: number;
  hits: PageHits | null;
}

interface Shown {
  canvas: HTMLCanvasElement;
  variant: string;
  release: () => void;
}

interface QueuedJob {
  id: string;
  start: () => SchedulableJob;
  /** In the render queue (a re-render waits for the zoom to settle first). */
  queued: boolean;
}

/** A canvas re-rendered for a new zoom waits this long, so pinching does not re-render every step. */
const RERENDER_DELAY_MS = 120;
/** Text layers follow the canvases of pages at a similar distance. */
const TEXT_PRIORITY_OFFSET = 50;

const rotationPrefix = (docKey: string, rotation: Rotation) => `${docKey}|r${rotation}@`;

function mark(canvas: HTMLCanvasElement, state: 'rendering' | 'done'): void {
  canvas.className = 'absolute inset-0 block size-full';
  canvas.dataset.testid = 'page-canvas';
  canvas.dataset.renderState = state;
}

/** Replaces the canvas on screen, releasing the pin on the previous one. */
function swap(host: HTMLElement, slot: RefObject<Shown | null>, next: Shown | null): void {
  const previous = slot.current;
  slot.current = next;
  if (!next) host.replaceChildren();
  else if (host.firstChild !== next.canvas) host.replaceChildren(next.canvas);
  previous?.release();
}

/** Highlight boxes for the matches, as fractions of the page box so they survive zooming. */
function drawHits(
  page: HTMLElement,
  layer: HTMLElement,
  divs: readonly HTMLElement[] | null,
  hits: PageHits | null,
): void {
  layer.replaceChildren();
  if (!divs || !hits || hits.matches.length === 0) return;
  const bounds = page.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  const lengths = divs.map((div) => div.textContent?.length ?? 0);
  const range = page.ownerDocument.createRange();
  if (typeof range.getClientRects !== 'function') return;
  const percent = (value: number, total: number) => `${((value / total) * 100).toFixed(3)}%`;
  hits.matches.forEach((match, index) => {
    for (const part of matchRanges(match, lengths)) {
      const node = divs[part.item]?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      range.setStart(node, part.from);
      range.setEnd(node, part.to);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        const box = page.ownerDocument.createElement('div');
        box.className = 'folio-hit';
        if (index === hits.active) box.dataset.active = '';
        box.style.left = percent(rect.left - bounds.left, bounds.width);
        box.style.top = percent(rect.top - bounds.top, bounds.height);
        box.style.width = percent(rect.width, bounds.width);
        box.style.height = percent(rect.height, bounds.height);
        layer.append(box);
      }
    }
  });
}

/**
 * One page of the continuous viewer: the rendered canvas, the selectable
 * text layer and search highlights. Canvases come from a shared cache and
 * are attached imperatively; the previous rendering stays on screen
 * (stretched) while the page re-renders at a new zoom.
 */
export const PageView = memo(function PageView({
  docKey,
  handle,
  position,
  pageCount,
  sourceIndex,
  box,
  scale,
  rotation,
  userUnit,
  ratio,
  priority,
  hits,
}: PageViewProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const hitsRef = useRef<HTMLDivElement>(null);
  const shown = useRef<Shown | null>(null);
  const canvasJob = useRef<QueuedJob | null>(null);
  const textJob = useRef<QueuedJob | null>(null);
  const [failedVariant, setFailedVariant] = useState<string | null>(null);
  const [textLayer, setTextLayer] = useState<{
    rotation: Rotation;
    divs: readonly HTMLElement[];
  } | null>(null);

  const variant = pageVariant(docKey, rotation, scale, ratio);
  const failed = failedVariant === variant;
  const currentPriority = useEffectEvent(() => priority);
  const currentScale = useEffectEvent(() => scale);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cached = pageCache.get(sourceIndex, variant);
    if (cached) {
      mark(cached, 'done');
      swap(host, shown, { canvas: cached, variant, release: pageCache.pin(sourceIndex, variant) });
      return;
    }
    // Keep an older rendering with the same orientation on screen meanwhile.
    const prefix = rotationPrefix(docKey, rotation);
    if (!shown.current?.variant.startsWith(prefix)) {
      const fallback = pageCache.fallback(sourceIndex, prefix);
      swap(
        host,
        shown,
        fallback
          ? {
              canvas: fallback.canvas,
              variant: fallback.variant,
              release: pageCache.pin(sourceIndex, fallback.variant),
            }
          : null,
      );
    }
    if (shown.current) mark(shown.current.canvas, 'rendering');

    let cancelled = false;
    const id = `${docKey}|page|${sourceIndex}`;
    const start = (): SchedulableJob => {
      const canvas = host.ownerDocument.createElement('canvas');
      const job = handle.renderPage(sourceIndex, canvas, {
        scale,
        rotation,
        devicePixelRatio: ratio,
        styleCanvas: false,
      });
      const promise = job.promise.then(
        (completed) => {
          if (cancelled || !completed) {
            canvas.width = 0;
            canvas.height = 0;
            return;
          }
          canvasJob.current = null;
          // Pin before adding: adding may evict, and this canvas is about to be shown.
          const release = pageCache.pin(sourceIndex, variant);
          pageCache.put(sourceIndex, variant, canvas);
          mark(canvas, 'done');
          swap(host, shown, { canvas, variant, release });
        },
        () => {
          if (cancelled) return;
          canvasJob.current = null;
          setFailedVariant(variant);
        },
      );
      return { promise, cancel: job.cancel };
    };
    const job: QueuedJob = { id, start, queued: false };
    canvasJob.current = job;
    const enqueue = () => {
      // Never twice, and not after the page finished or was superseded.
      if (canvasJob.current !== job || job.queued) return;
      job.queued = true;
      scheduler.schedule(id, currentPriority(), start);
    };
    const timer = shown.current ? setTimeout(enqueue, RERENDER_DELAY_MS) : null;
    if (!timer) enqueue();
    return () => {
      cancelled = true;
      canvasJob.current = null;
      if (timer) clearTimeout(timer);
      scheduler.cancel(id);
    };
  }, [docKey, handle, sourceIndex, variant, scale, rotation, ratio]);

  // The text layer scales with CSS variables, so only a new orientation redraws it.
  useEffect(() => {
    const container = textRef.current;
    if (!container) return;
    let cancelled = false;
    const id = `${docKey}|text|${sourceIndex}`;
    const start = () => {
      const job = handle.renderTextLayer(sourceIndex, container, {
        scale: currentScale(),
        rotation,
      });
      job.promise.then(
        (result) => {
          if (cancelled || !result) return;
          textJob.current = null;
          setTextLayer({ rotation, divs: result.textDivs });
        },
        () => {
          // Pages without usable text simply cannot be selected or searched visually.
          if (!cancelled) textJob.current = null;
        },
      );
      return job;
    };
    textJob.current = { id, start, queued: true };
    scheduler.schedule(id, currentPriority() + TEXT_PRIORITY_OFFSET, start);
    return () => {
      cancelled = true;
      textJob.current = null;
      scheduler.cancel(id);
      container.replaceChildren();
    };
  }, [docKey, handle, sourceIndex, rotation]);

  useEffect(() => {
    // Jobs still waiting in the queue move up or down as the page scrolls.
    for (const [job, offset] of [
      [canvasJob.current, 0],
      [textJob.current, TEXT_PRIORITY_OFFSET],
    ] as const) {
      if (job?.queued) scheduler.schedule(job.id, priority + offset, job.start);
    }
  }, [priority]);

  const textDivs = textLayer?.rotation === rotation ? textLayer.divs : null;
  useLayoutEffect(() => {
    const page = pageRef.current;
    const layer = hitsRef.current;
    if (page && layer) drawHits(page, layer, textDivs, hits);
  }, [textDivs, hits]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    return () => {
      if (host) swap(host, shown, null);
      handle.releasePage(sourceIndex);
    };
  }, [handle, sourceIndex]);

  const label = `Page ${position + 1} of ${pageCount}`;
  return (
    <div
      ref={pageRef}
      data-page={position + 1}
      className="folio-page absolute overflow-hidden bg-page shadow-page"
      style={
        {
          top: box.top,
          left: box.left,
          width: box.width,
          height: box.height,
          '--scale-factor': scale,
          '--user-unit': userUnit,
        } as CSSProperties
      }
    >
      <div ref={hostRef} role="img" aria-label={label} className="peer absolute inset-0" />
      {failed ? null : (
        <div className="pointer-events-none absolute inset-0 hidden items-center justify-center text-[oklch(0.45_0.01_230)] peer-empty:flex">
          <Spinner />
        </div>
      )}
      <div ref={textRef} className="textLayer" />
      <div ref={hitsRef} aria-hidden className="pointer-events-none absolute inset-0" />
      {failed ? (
        <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-xs font-medium text-[oklch(0.45_0.15_25)]">
          This page could not be rendered.
        </p>
      ) : null}
    </div>
  );
});
