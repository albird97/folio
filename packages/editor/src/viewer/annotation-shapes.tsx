import {
  annotationBounds,
  annotationFrame,
  arrowHeadPoints,
  arrowHeadSize,
  contentFrame,
  growRect,
  layoutAddedText,
  lineEnds,
  markupStroke,
  normalizeRect,
  noteIconGeometry,
  textWidth,
  type Annotation,
  type FontFamily,
  type Point,
} from '@folio/document-model';
import { memo, useId } from 'react';
import { svgMatrix } from './geometry';

/**
 * Fonts metrically compatible with the standard PDF fonts Folio saves added
 * text in, so text on screen takes the room it will take in the file.
 */
export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif',
  mono: '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", monospace',
};

const NOTE_OUTLINE = '#404040';

const pointList = (points: readonly Point[]) =>
  points.map((point) => `${point.x},${point.y}`).join(' ');

const pathOf = (points: readonly Point[]) =>
  points.length === 0
    ? ''
    : // A single point draws a dot (round caps on a zero-length segment).
      `M${points[0]!.x} ${points[0]!.y}` +
      (points.length === 1
        ? ` L${points[0]!.x} ${points[0]!.y}`
        : points
            .slice(1)
            .map((point) => ` L${point.x} ${point.y}`)
            .join(''));

/**
 * One annotation drawn in page space (y up), the way the exporter writes its
 * appearance: same geometry, same text layout.
 */
export const AnnotationShape = memo(function AnnotationShape({
  annotation,
  imageUrl,
}: {
  annotation: Annotation;
  imageUrl?: string | null;
}) {
  const clipId = useId();
  switch (annotation.kind) {
    case 'highlight':
      return (
        <g opacity={annotation.opacity} style={{ mixBlendMode: 'multiply' }}>
          {annotation.rects.map((raw, index) => {
            const rect = normalizeRect(raw);
            return (
              <rect
                key={index}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                fill={annotation.color}
              />
            );
          })}
        </g>
      );
    case 'underline':
    case 'strikeout': {
      const kind = annotation.kind === 'underline' ? 'underline' : 'strikeout';
      return (
        <g opacity={annotation.opacity} stroke={annotation.color}>
          {annotation.rects.map((raw, index) => {
            const rect = normalizeRect(raw);
            const { y, thickness } = markupStroke(rect, kind);
            return (
              <line
                key={index}
                x1={rect.x}
                x2={rect.x + rect.width}
                y1={y}
                y2={y}
                strokeWidth={thickness}
              />
            );
          })}
        </g>
      );
    }
    case 'note': {
      const { outline, lines } = noteIconGeometry(annotation.position);
      return (
        <g opacity={annotation.opacity}>
          <polygon
            points={pointList(outline)}
            fill={annotation.color}
            stroke={NOTE_OUTLINE}
            strokeWidth={0.8}
            strokeLinejoin="round"
          />
          {lines.map(([from, to], index) => (
            <line
              key={index}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={NOTE_OUTLINE}
              strokeWidth={1}
            />
          ))}
        </g>
      );
    }
    case 'ink':
      return (
        <g
          opacity={annotation.opacity}
          fill="none"
          stroke={annotation.color}
          strokeWidth={annotation.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {annotation.paths.map((path, index) => (
            <path key={index} d={pathOf(path)} />
          ))}
        </g>
      );
    case 'shape': {
      const stroke = annotation.strokeWidth > 0 ? annotation.color : 'none';
      if (annotation.shape === 'line' || annotation.shape === 'arrow') {
        const [from, to] = lineEnds(annotation.rect);
        return (
          <g
            opacity={annotation.opacity}
            fill="none"
            stroke={stroke}
            strokeWidth={annotation.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
            {annotation.shape === 'arrow' ? (
              <polyline
                points={pointList(arrowHeadPoints(from, to, arrowHeadSize(annotation.strokeWidth)))}
              />
            ) : null}
          </g>
        );
      }
      // Inset by half the stroke so the outline stays inside the box.
      const inner = growRect(annotationFrame(annotation), -annotation.strokeWidth / 2);
      const width = Math.max(0, inner.width);
      const height = Math.max(0, inner.height);
      const fill = annotation.fill ?? 'none';
      return (
        <g
          opacity={annotation.opacity}
          fill={fill}
          stroke={stroke}
          strokeWidth={annotation.strokeWidth}
          strokeLinejoin="round"
        >
          {annotation.shape === 'rectangle' ? (
            <rect x={inner.x} y={inner.y} width={width} height={height} />
          ) : (
            <ellipse
              cx={inner.x + width / 2}
              cy={inner.y + height / 2}
              rx={width / 2}
              ry={height / 2}
            />
          )}
        </g>
      );
    }
    case 'added-text': {
      const { lines, frame } = layoutAddedText(annotation);
      return (
        <g opacity={annotation.opacity} transform={svgMatrix(frame.matrix)}>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={frame.width} height={frame.height} />
          </clipPath>
          <g
            clipPath={`url(#${clipId})`}
            fill={annotation.color}
            fontFamily={FONT_STACKS[annotation.fontFamily]}
            fontSize={annotation.fontSize}
          >
            {lines.map((line, index) =>
              line.text ? (
                <text
                  key={index}
                  x={line.x}
                  y={-line.y}
                  transform="scale(1 -1)"
                  xmlSpace="preserve"
                  textLength={textWidth(line.text, annotation.fontFamily, annotation.fontSize)}
                  lengthAdjust="spacing"
                >
                  {line.text}
                </text>
              ) : null,
            )}
          </g>
        </g>
      );
    }
    case 'added-image':
    case 'signature': {
      const frame = contentFrame(annotation.rect, annotation.rotation);
      return (
        <g opacity={annotation.opacity} transform={svgMatrix(frame.matrix)}>
          {imageUrl ? (
            <image
              href={imageUrl}
              x={0}
              y={0}
              width={frame.width}
              height={frame.height}
              preserveAspectRatio="none"
              transform={`translate(0 ${frame.height}) scale(1 -1)`}
            />
          ) : (
            <rect
              x={0}
              y={0}
              width={frame.width}
              height={frame.height}
              fill="none"
              stroke="#888"
              strokeDasharray="4 3"
            />
          )}
        </g>
      );
    }
  }
});

/** A shape that is easy to point at: thin strokes get a wide invisible hit area. */
export function AnnotationHitArea({
  annotation,
  slop,
}: {
  annotation: Annotation;
  /** Extra reach in page units (a few screen pixels). */
  slop: number;
}) {
  if (annotation.kind === 'ink') {
    return (
      <g
        fill="none"
        stroke="transparent"
        strokeWidth={annotation.strokeWidth + slop * 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="stroke"
      >
        {annotation.paths.map((path, index) => (
          <path key={index} d={pathOf(path)} />
        ))}
      </g>
    );
  }
  if (
    annotation.kind === 'shape' &&
    (annotation.shape === 'line' || annotation.shape === 'arrow')
  ) {
    const [from, to] = lineEnds(annotation.rect);
    return (
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke="transparent"
        strokeWidth={annotation.strokeWidth + slop * 2}
        strokeLinecap="round"
        pointerEvents="stroke"
      />
    );
  }
  if (
    annotation.kind === 'highlight' ||
    annotation.kind === 'underline' ||
    annotation.kind === 'strikeout'
  ) {
    return (
      <g fill="transparent" pointerEvents="all">
        {annotation.rects.map((raw, index) => {
          const rect = normalizeRect(raw);
          return <rect key={index} x={rect.x} y={rect.y} width={rect.width} height={rect.height} />;
        })}
      </g>
    );
  }
  const bounds = growRect(annotationBounds(annotation), slop / 2);
  return (
    <rect
      x={bounds.x}
      y={bounds.y}
      width={bounds.width}
      height={bounds.height}
      fill="transparent"
      pointerEvents="all"
    />
  );
}
