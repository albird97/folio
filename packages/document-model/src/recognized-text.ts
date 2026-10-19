import { contentFrame, normalizeRect, unionRects, type Matrix } from './annotation-layout';
import type { Point, Rect, Rotation } from './geometry';
import { z } from './zod';

/*
 * Text recognized in the image of a page (OCR), as Folio keeps it: one JSON
 * asset per source page (`RecognizedText` in the model points at it). The
 * words are laid out here, for both the viewer (a selectable text layer) and
 * the exporter (invisible text in the saved PDF), so the two agree.
 */

export const RECOGNIZED_TEXT_VERSION = 1;

/** Limits that keep damaged or hostile data from flooding a page; recognizers stay within them. */
export const MAX_RECOGNIZED_WORDS = 50_000;
export const MAX_RECOGNIZED_WORD_LENGTH = 1_000;

export interface RecognizedWord {
  text: string;
  /**
   * The word's box in page space: PDF user space of the source page from
   * the lower-left corner of its visible area, unscaled by /UserUnit, like
   * annotation geometry.
   */
  box: Rect;
  /** How sure the recognizer was, from 0 to 100. */
  confidence: number;
  /** The word's line, numbered in reading order from 0. */
  line: number;
}

export interface RecognizedTextData {
  version: typeof RECOGNIZED_TEXT_VERSION;
  /** Tesseract language codes the text was read with, e.g. "eng+ind". */
  languages: string;
  /**
   * Clockwise rotation of the page at which its text reads upright: the
   * page's rotation when it was recognized.
   */
  rotation: Rotation;
  /** In reading order: line by line, each line from its start. */
  words: RecognizedWord[];
}

export class RecognizedTextError extends Error {
  override readonly name = 'RecognizedTextError';
  constructor(message: string) {
    super(message);
  }
}

const finite = z.number().refine(Number.isFinite, 'Expected a finite number');

const schema = z.object({
  version: z.literal(RECOGNIZED_TEXT_VERSION),
  languages: z
    .string()
    .max(200)
    .regex(/^[a-z_]+(\+[a-z_]+)*$/),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  words: z
    .array(
      z.object({
        text: z.string().min(1).max(MAX_RECOGNIZED_WORD_LENGTH),
        box: z.object({
          x: finite,
          y: finite,
          width: finite.positive(),
          height: finite.positive(),
        }),
        confidence: finite.min(0).max(100),
        line: z.number().int().nonnegative(),
      }),
    )
    .max(MAX_RECOGNIZED_WORDS)
    .refine(
      (words) => words.every((word, index) => index === 0 || word.line >= words[index - 1]!.line),
      'Lines must be in reading order',
    ),
});

const encoder = new TextEncoder();

export function serializeRecognizedText(data: RecognizedTextData): Uint8Array {
  return encoder.encode(JSON.stringify(data));
}

/**
 * Reads recognized text stored by Folio. Stored data is never trusted: it
 * is validated, and errors name what is wrong without repeating any of the
 * text.
 */
export function parseRecognizedText(bytes: Uint8Array): RecognizedTextData {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RecognizedTextError('The recognized text is not valid JSON.');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    // Only paths, never values: values are document content.
    const paths = result.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ');
    throw new RecognizedTextError(`The recognized text failed validation at ${paths}.`);
  }
  return result.data as RecognizedTextData;
}

/**
 * Chinese and Japanese are written without spaces between words: words
 * recognized in them, and their punctuation, join without one.
 */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

/** Whether a space separates two neighbouring words of a line. */
export function spaceBetween(before: string, after: string): boolean {
  const last = Array.from(before).at(-1) ?? '';
  const first = Array.from(after)[0] ?? '';
  return !(UNSPACED.test(last) && UNSPACED.test(first));
}

/** The words grouped into lines, in reading order. */
function lines(data: RecognizedTextData): RecognizedWord[][] {
  const out: RecognizedWord[][] = [];
  for (const word of data.words) {
    const line = out.at(-1);
    if (line && line[0]!.line === word.line) line.push(word);
    else out.push([word]);
  }
  return out;
}

/** The recognized text as plain lines, in reading order (for copying and exporting text). */
export function recognizedTextLines(data: RecognizedTextData): string[] {
  return lines(data).map((line) =>
    line
      .map((word, index) =>
        index > 0 && spaceBetween(line[index - 1]!.text, word.text) ? ` ${word.text}` : word.text,
      )
      .join(''),
  );
}

/** Where the baseline sits above the bottom of a line, as a share of the line's height. */
export const RECOGNIZED_DESCENT = 0.2;

/** A word, or the space between two words, placed on its line. */
export interface RecognizedRun {
  text: string;
  /**
   * Places the run in page space: its origin is the start of the run on the
   * baseline, and its axes run along the line and up the line (unscaled).
   */
  matrix: Matrix;
  /** The line's height, in page-space units. */
  fontSize: number;
  /** Length along the baseline, in page-space units. */
  width: number;
  /** The last run of its line. */
  lineEnd: boolean;
}

function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const apply = ([a, b, c, d, e, f]: Matrix, { x, y }: Point): Point => ({
  x: a * x + c * y + e,
  y: b * x + d * y + f,
});

/**
 * Lays out the recognized words as runs of text, line by line. Every run of
 * a line takes the line's height, so selections and the saved text have
 * even lines; each word spans its own box along the line, and the space
 * between two words spans the gap. Lines read upright at the rotation the
 * text was recognized at.
 */
export function layoutRecognizedText(data: RecognizedTextData): RecognizedRun[] {
  const runs: RecognizedRun[] = [];
  for (const line of lines(data)) {
    const frame = contentFrame(unionRects(line.map((word) => word.box)), data.rotation);
    const fontSize = frame.height;
    const toLine = invert(frame.matrix);
    // Each word's extent along the line, in the line's upright frame.
    const spans = line.map((word) => {
      const box = normalizeRect(word.box);
      const corners = [
        apply(toLine, { x: box.x, y: box.y }),
        apply(toLine, { x: box.x + box.width, y: box.y + box.height }),
      ];
      return {
        text: word.text,
        start: Math.min(corners[0]!.x, corners[1]!.x),
        end: Math.max(corners[0]!.x, corners[1]!.x),
      };
    });
    const [a, b, c, d, e, f] = frame.matrix;
    const baseline = fontSize * RECOGNIZED_DESCENT;
    const at = (along: number): Matrix => [
      a,
      b,
      c,
      d,
      a * along + c * baseline + e,
      b * along + d * baseline + f,
    ];
    spans.forEach((span, index) => {
      const next = spans[index + 1];
      runs.push({
        text: span.text,
        matrix: at(span.start),
        fontSize,
        width: span.end - span.start,
        lineEnd: !next,
      });
      if (next && spaceBetween(span.text, next.text)) {
        runs.push({
          text: ' ',
          matrix: at(span.end),
          fontSize,
          width: Math.max(0, next.start - span.end),
          lineEnd: false,
        });
      }
    });
  }
  return runs;
}
