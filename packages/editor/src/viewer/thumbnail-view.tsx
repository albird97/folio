import type { Rotation } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import type { SchedulableJob } from './render-scheduler';
import { pageCache, scheduler, thumbnailCache } from './resources';

export interface ThumbnailViewProps {
  docKey: string;
  handle: PdfDocumentHandle;
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

/** A low-resolution page image for the pages panel. */
export const ThumbnailView = memo(function ThumbnailView({
  docKey,
  handle,
  sourceIndex,
  rotation,
  width,
  height,
  scale,
  ratio,
  priority,
}: ThumbnailViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const job = useRef<{ id: string; start: () => SchedulableJob } | null>(null);
  const currentPriority = useEffectEvent(() => priority);
  const variant = `${docKey}|thumb-r${rotation}-${width}x${height}@${ratio.toFixed(2)}`;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let unpin: (() => void) | null = null;
    const show = (canvas: HTMLCanvasElement) => {
      canvas.className = 'block size-full';
      unpin = thumbnailCache.pin(sourceIndex, variant);
      thumbnailCache.put(sourceIndex, variant, canvas);
      host.replaceChildren(canvas);
    };
    const release = () => {
      unpin?.();
      host.replaceChildren();
    };

    const cached = thumbnailCache.get(sourceIndex, variant);
    if (cached) {
      show(cached);
      return release;
    }
    const rendered = pageCache.fallback(sourceIndex, `${docKey}|r${rotation}@`);
    const copy = rendered ? downscale(rendered.canvas, width * ratio, height * ratio) : null;
    if (copy) {
      show(copy);
      return release;
    }

    let cancelled = false;
    const id = `${docKey}|thumb|${sourceIndex}`;
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
      release();
    };
  }, [docKey, handle, sourceIndex, variant, rotation, width, height, scale, ratio]);

  useEffect(() => {
    if (job.current) scheduler.schedule(job.current.id, priority, job.current.start);
  }, [priority]);

  return <div ref={hostRef} className="size-full" />;
});
