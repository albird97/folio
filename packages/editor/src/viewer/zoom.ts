import type { Size, ZoomMode } from '@folio/document-model';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Steps for zoom in/out, like most document viewers. */
export const ZOOM_PRESETS: readonly number[] = [
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8,
];
/** "auto" never enlarges pages beyond this, so wide windows do not show giant text. */
export const MAX_AUTO_ZOOM = 1.25;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next preset strictly above (1) or below (-1) `zoom`. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const epsilon = 0.001;
  if (direction === 1) return ZOOM_PRESETS.find((preset) => preset > zoom + epsilon) ?? MAX_ZOOM;
  return [...ZOOM_PRESETS].reverse().find((preset) => preset < zoom - epsilon) ?? MIN_ZOOM;
}

export interface FitArea {
  /** Space available for pages, in CSS pixels. */
  width: number;
  height: number;
}

/**
 * The scale for a fit mode, given the (rotated) page size in points and the
 * area the page must fit in.
 */
export function fitZoom(mode: Exclude<ZoomMode, 'custom'>, page: Size, area: FitArea): number {
  if (page.width <= 0 || page.height <= 0 || area.width <= 0 || area.height <= 0) return 1;
  const widthScale = area.width / page.width;
  const pageScale = Math.min(widthScale, area.height / page.height);
  switch (mode) {
    case 'fit-width':
      return clampZoom(widthScale);
    case 'fit-page':
      return clampZoom(pageScale);
    case 'auto':
      return clampZoom(Math.min(MAX_AUTO_ZOOM, page.width > page.height ? pageScale : widthScale));
  }
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** Parses user input such as "150", "150%" or "1.5x". Returns null when invalid. */
export function parseZoom(input: string): number | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(%|x)?\s*$/i.exec(input);
  if (!match) return null;
  const value = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  return clampZoom(match[2]?.toLowerCase() === 'x' ? value : value / 100);
}
