import type { Rotation } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from 'react';
import type { SchedulableJob } from './render-scheduler';
import {
  formVariant,
  pageCache,
  scheduler,
  thumbnailCache,
  variantFormRevision,
} from './resources';

export interface ThumbnailViewProps {
  /** Identifies the document and source file in the render caches. */
  cacheKey: string;
  /** The engine document of the page's file, or null for a blank page. */
  handle: PdfDocumentHandle | null;
  sourceIndex: number;
  /** Added to the page's own /Rotate. */
  rotation: Rotation;
  /** CSS size of the thumbnail. */
  width: number;
  height: number;
  /** CSS pixels per PDF point. */
  scale: number;
  ratio: number;
  priority: number;
  /** How often the page's form fields changed (see `PageView`). */
  formRevision: number;
}

/** Copies an existing page rendering instead of asking PDF.js to draw the page again. */
function downscale(
  source: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  if (source.width === 0 || source.height === 0) return null;
  const canvas = source.ownerDocument.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The image a thumbnail shows, and the variant it was drawn for without form values. */
interface Shown {
  sized: string;
  release: () => void;
}

/** Takes the image off the thumbnail. */
function clear(host: HTMLElement, shown: RefObject<Shown | null>): void {
  shown.current?.release();
  shown.current = null;
  host.replaceChildren();
}

/** A low-resolution page image for the pages panel. */
export const ThumbnailView = memo(function ThumbnailView({
  cacheKey,
  handle,
  sourceIndex,
  rotation,
  width,
  height,
  scale,
  ratio,
  priority,
  formRevision,
}: ThumbnailViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shown = useRef<Shown | null>(null);
  const job = useRef<{ id: string; start: () => SchedulableJob } | null>(null);
  const currentPriority = useEffectEvent(() => priority);
  const sized = `${cacheKey}|thumb-r${rotation}-${width}x${height}@${ratio.toFixed(2)}`;
  const variant = sized + formVariant(formRevision);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !handle) return;
    const show = (canvas: HTMLCanvasElement) => {
      canvas.className = 'block size-full';
      const release = thumbnailCache.pin(sourceIndex, variant);
      thumbnailCache.put(sourceIndex, variant, canvas);
      host.replaceChildren(canvas);
      shown.current?.release();
      shown.current = { sized, release };
    };
    // Another size or turn starts blank; new form values keep the image until redrawn.
    if (shown.current?.sized !== sized) clear(host, shown);

    const cached = thumbnailCache.get(sourceIndex, variant);
    if (cached) {
      show(cached);
      return;
    }
    const rendered = pageCache.fallback(sourceIndex, `${cacheKey}|r${rotation}@`);
    // Only a rendering with the page's current form values will do.
    const copy =
      rendered && variantFormRevision(rendered.variant) === formRevision
        ? downscale(rendered.canvas, width * ratio, height * ratio)
        : null;
    if (copy) {
      show(copy);
      return;
    }

    let cancelled = false;
    const id = `${cacheKey}|thumb|${sourceIndex}`;
    const start = (): SchedulableJob => {
      const canvas = host.ownerDocument.createElement('canvas');
      const render = handle.renderPage(sourceIndex, canvas, {
        scale,
        rotation,
        devicePixelRatio: ratio,
        styleCanvas: false,
      });
      const promise = render.promise.then(
        (completed) => {
          if (cancelled || !completed) {
            canvas.width = 0;
            canvas.height = 0;
            return;
          }
          job.current = null;
          show(canvas);
        },
        () => {
          if (!cancelled) job.current = null;
        },
      );
      return { promise, cancel: render.cancel };
    };
    job.current = { id, start };
    scheduler.schedule(id, currentPriority(), start);
    return () => {
      cancelled = true;
      job.current = null;
      scheduler.cancel(id);
    };
  }, [
    cacheKey,
    handle,
    sourceIndex,
    sized,
    variant,
    formRevision,
    rotation,
    width,
    height,
    scale,
    ratio,
  ]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    return () => {
      if (host) clear(host, shown);
    };
  }, [handle, sourceIndex]);

  useEffect(() => {
    if (job.current) scheduler.schedule(job.current.id, priority, job.current.start);
  }, [priority]);

  return <div ref={hostRef} className="size-full" />;
});
