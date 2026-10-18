import { CanvasCache } from './canvas-cache';
import { RenderScheduler } from './render-scheduler';

/**
 * Rendering resources shared by every open document: the PDF.js worker draws
 * one page at a time anyway, and one pixel budget caps memory no matter how
 * many documents are open. Cache variants start with the document key.
 */
export const pageCache = new CanvasCache(40_000_000);
export const thumbnailCache = new CanvasCache(10_000_000);
export const scheduler = new RenderScheduler(2);

/** Priorities: lower runs first. */
export const PRIORITY = {
  visiblePage: 0,
  nearbyPage: 100,
  thumbnail: 1000,
} as const;

export const pageVariant = (docKey: string, rotation: number, scale: number, ratio: number) =>
  `${docKey}|r${rotation}@${scale.toFixed(4)}x${ratio.toFixed(2)}`;

export const thumbnailVariant = (docKey: string, rotation: number, ratio: number) =>
  `${docKey}|thumb-r${rotation}x${ratio.toFixed(2)}`;

/** Drops cached renderings of documents that are no longer open. */
export function forgetDocuments(openKeys: ReadonlySet<string>): void {
  const isClosed = (variant: string) => !openKeys.has(variant.slice(0, variant.indexOf('|')));
  pageCache.removeWhere(isClosed);
  thumbnailCache.removeWhere(isClosed);
}
