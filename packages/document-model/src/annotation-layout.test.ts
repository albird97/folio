import { describe, expect, it } from 'vitest';
import {
  annotationBounds,
  annotationFrame,
  canShowCharacter,
  contentFrame,
  isMovable,
  isResizable,
  layoutAddedText,
  LINE_HEIGHT,
  lineEnds,
  moveAnnotation,
  NOTE_ICON_SIZE,
  textWidth,
  toStandardFontText,
  withFrame,
  wrapText,
} from './annotation-layout';
import { newAnnotationId, newPageId } from './ids';
import { STANDARD_FONT_METRICS } from './standard-font-metrics';
import type { Annotation } from './types';

const base = {
  id: newAnnotationId(),
  pageId: newPageId(),
  author: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  color: '#000000',
  opacity: 1,
};

describe('standard font text', () => {
  it('gives every family the same character set', () => {
    const sets = Object.values(STANDARD_FONT_METRICS).map((metrics) =>
      metrics.widths.filter((_, index) => index % 2 === 0).join(','),
    );
    expect(new Set(sets).size).toBe(1);
    expect(sets[0]!.split(',')).toHaveLength(218);
  });

  it('replaces what the fonts cannot show and says so', () => {
    expect(canShowCharacter('é')).toBe(true);
    expect(canShowCharacter('€')).toBe(true);
    expect(canShowCharacter('你')).toBe(false);
    expect(toStandardFontText('Café\tok')).toEqual({ text: 'Café ok', lossy: false });
    expect(toStandardFontText('a 😀 b')).toEqual({ text: 'a ? b', lossy: true });
  });

  it('measures with the standard metrics', () => {
    // Helvetica "H" is 722/1000 em; Courier is monospaced at 600.
    expect(textWidth('H', 'sans', 10)).toBeCloseTo(7.22);
    expect(textWidth('iii', 'mono', 10)).toBeCloseTo(18);
    expect(textWidth('你', 'sans', 10)).toBe(textWidth('?', 'sans', 10));
  });
});

describe('wrapText', () => {
  const measure = (line: string) => line.length;

  it('breaks at spaces and keeps paragraphs', () => {
    expect(wrapText('one two three four', 9, measure)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('a\n\nb', 9, measure)).toEqual(['a', '', 'b']);
  });

  it('breaks words wider than the box, including the first one', () => {
    expect(wrapText('abcdefghij xy', 4, measure)).toEqual(['abcd', 'efgh', 'ij', 'xy']);
  });

  it('does not split characters outside the BMP', () => {
    expect(wrapText('😀😀😀', 2, (line) => Array.from(line).length)).toEqual(['😀😀', '😀']);
  });
});

describe('layoutAddedText', () => {
  it('places baselines from the top of the box and drops lines below it', () => {
    const { lines, lossy } = layoutAddedText({
      rect: { x: 10, y: 100, width: 60, height: 30 },
      text: 'iiii iiii iiii iiii iiii iiii iiii iiii',
      fontSize: 10,
      fontFamily: 'mono',
      rotation: 0,
    });
    expect(lossy).toBe(false);
    // Each "iiii" is 24pt wide in Courier 10, so two fit in 56pt. The third
    // line is partly visible (clipped); the fourth starts below the box.
    const top = 30 - 2 - 6.29;
    expect(lines.map((line) => line.text)).toEqual(['iiii iiii', 'iiii iiii', 'iiii iiii']);
    expect(lines[0]!.x).toBe(2);
    expect(lines[0]!.y).toBeCloseTo(top);
    expect(lines[1]!.y).toBeCloseTo(top - 10 * LINE_HEIGHT);
  });

  it('lays text out along the long edge of boxes added to turned pages', () => {
    const { frame, lines } = layoutAddedText({
      rect: { x: 10, y: 100, width: 30, height: 60 },
      text: 'iiii iiii',
      fontSize: 10,
      fontFamily: 'mono',
      rotation: 90,
    });
    expect(frame).toMatchObject({ width: 60, height: 30 });
    expect(lines.map((line) => line.text)).toEqual(['iiii iiii']);
  });
});

describe('contentFrame', () => {
  const rect = { x: 10, y: 20, width: 30, height: 60 };
  const apply = ([a, b, c, d, e, f]: number[], x: number, y: number) => [
    a! * x + c! * y + e!,
    b! * x + d! * y + f!,
  ];

  it('maps the content box onto the page box for every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const frame = contentFrame(rect, rotation);
      const corners = [apply(frame.matrix, 0, 0), apply(frame.matrix, frame.width, frame.height)];
      const xs = corners.map(([x]) => x!).sort((a, b) => a - b);
      const ys = corners.map(([, y]) => y!).sort((a, b) => a - b);
      expect([xs, ys]).toEqual([
        [10, 40],
        [20, 80],
      ]);
    }
  });

  it('keeps content level when the page is shown turned', () => {
    // On a page shown turned 90° clockwise, "right" on screen is page +y.
    const [a, b] = contentFrame(rect, 90).matrix;
    expect([a, b]).toEqual([0, 1]);
    const [a2, b2] = contentFrame(rect, 270).matrix;
    expect([a2, b2]).toEqual([0, -1]);
  });
});

describe('frames, moving and resizing', () => {
  const ink: Annotation = {
    ...base,
    kind: 'ink',
    paths: [
      [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
    ],
    strokeWidth: 2,
  };
  const arrow: Annotation = {
    ...base,
    kind: 'shape',
    shape: 'arrow',
    rect: { x: 100, y: 100, width: 50, height: -20 },
    strokeWidth: 1,
    fill: null,
  };
  const note: Annotation = { ...base, kind: 'note', position: { x: 50, y: 60 }, contents: '' };
  const highlight: Annotation = {
    ...base,
    kind: 'highlight',
    rects: [{ x: 0, y: 0, width: 10, height: 5 }],
    text: '',
  };

  it('reports frames and painted bounds', () => {
    expect(annotationFrame(ink)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
    expect(annotationBounds(ink)).toEqual({ x: -2, y: -2, width: 14, height: 24 });
    expect(annotationFrame(note)).toEqual({
      x: 50,
      y: 60 - NOTE_ICON_SIZE,
      width: NOTE_ICON_SIZE,
      height: NOTE_ICON_SIZE,
    });
    expect(annotationFrame(arrow)).toEqual({ x: 100, y: 80, width: 50, height: 20 });
  });

  it('moves every kind of geometry', () => {
    expect(moveAnnotation(note, 5, -5)).toMatchObject({ position: { x: 55, y: 55 } });
    expect(moveAnnotation(ink, 1, 2)).toMatchObject({
      paths: [
        [
          { x: 1, y: 2 },
          { x: 11, y: 22 },
        ],
      ],
    });
    const moved = moveAnnotation(arrow, 10, 10);
    expect(moved).toMatchObject({ rect: { x: 110, y: 110, width: 50, height: -20 } });
  });

  it('stretches resizable annotations and keeps an arrow pointing the same way', () => {
    const stretched = withFrame(arrow, { x: 0, y: 0, width: 100, height: 40 });
    expect(stretched.kind === 'shape' && lineEnds(stretched.rect)).toEqual([
      { x: 0, y: 40 },
      { x: 100, y: 0 },
    ]);
    const scaled = withFrame(ink, { x: 0, y: 0, width: 20, height: 10 });
    expect(scaled).toMatchObject({
      paths: [
        [
          { x: 0, y: 0 },
          { x: 20, y: 10 },
        ],
      ],
    });
  });

  it('only moves notes and does not move text markup', () => {
    expect(isResizable(note)).toBe(false);
    expect(isMovable(note)).toBe(true);
    expect(isMovable(highlight)).toBe(false);
    const resized = withFrame(note, { x: 0, y: 0, width: 200, height: 200 });
    expect(annotationFrame(resized)).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });
});
