import { pageStamps, type PageModel, type PageStamp, type Rotation } from '@folio/document-model';
import { memo, type ComponentPropsWithoutRef } from 'react';
import { FONT_STACKS } from './annotation-shapes';
import { displaySpaceSize, pageToDisplay, svgMatrix } from './geometry';
import type { PageOverlayProps } from './page-overlays';

/**
 * Stamps laid out for one page (see `pageStamps`), drawn over it the way the
 * exporter writes them: same layout, and fonts metrically compatible with
 * the standard ones, spaced to the width they take in the file. The page
 * canvas is opaque, so a watermark under the content is multiplied into the
 * page instead, which looks the same on white pages.
 */
export function StampMarks({
  page,
  viewRotation,
  stamps,
  ...svg
}: {
  page: PageModel;
  viewRotation: Rotation;
  stamps: readonly PageStamp[];
} & Omit<ComponentPropsWithoutRef<'svg'>, 'viewBox' | 'children'>) {
  const display = displaySpaceSize(page, viewRotation);
  return (
    <svg
      aria-hidden
      {...svg}
      viewBox={`0 0 ${display.width} ${display.height}`}
      preserveAspectRatio="none"
      pointerEvents="none"
    >
      <g transform={svgMatrix(pageToDisplay(page, viewRotation))}>
        {stamps.map((stamp) => (
          <g
            key={stamp.kind}
            data-stamp={stamp.kind}
            transform={svgMatrix(stamp.matrix)}
            opacity={stamp.opacity}
            style={stamp.layer === 'under' ? { mixBlendMode: 'multiply' } : undefined}
          >
            <text
              x={0}
              y={0}
              transform="scale(1 -1)"
              xmlSpace="preserve"
              fill={stamp.color}
              fontFamily={FONT_STACKS[stamp.fontFamily]}
              fontSize={stamp.fontSize}
              textLength={stamp.width}
              lengthAdjust="spacing"
            >
              {stamp.text}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

/** Overlays re-render whenever the document changes (scrolling, too): only stamps matter here. */
const sameStamps = (before: PageOverlayProps, after: PageOverlayProps) =>
  before.doc.editor?.model.stamps === after.doc.editor?.model.stamps &&
  before.page === after.page &&
  before.position === after.position &&
  before.pageCount === after.pageCount &&
  before.viewRotation === after.viewRotation &&
  before.box.top === after.box.top &&
  before.box.left === after.box.left &&
  before.box.width === after.box.width &&
  before.box.height === after.box.height;

/** The document's page numbers and watermark on one page, as they will be saved. */
export const StampLayer = memo(function StampLayer({
  doc,
  page,
  position,
  pageCount,
  box,
  viewRotation,
}: PageOverlayProps) {
  const stamps = doc.editor?.model.stamps;
  const shown = stamps ? pageStamps(page, stamps, position, pageCount) : [];
  if (shown.length === 0) return null;
  return (
    <StampMarks
      page={page}
      viewRotation={viewRotation}
      stamps={shown}
      data-stamp-layer={position + 1}
      className="pointer-events-none absolute"
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    />
  );
}, sameStamps);
