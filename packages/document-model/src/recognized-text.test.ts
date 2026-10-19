import { describe, expect, it } from 'vitest';
import type { Rotation } from './geometry';
import {
  layoutRecognizedText,
  parseRecognizedText,
  RECOGNIZED_DESCENT,
  RecognizedTextError,
  recognizedTextLines,
  serializeRecognizedText,
  spaceBetween,
  type RecognizedTextData,
  type RecognizedWord,
} from './recognized-text';

const word = (text: string, line: number, x: number, y: number, width = 40, height = 12) =>
  ({ text, box: { x, y, width, height }, confidence: 90, line }) satisfies RecognizedWord;

const data = (words: RecognizedWord[], rotation: Rotation = 0): RecognizedTextData => ({
  version: 1,
  languages: 'eng+ind+chi_sim',
  rotation,
  words,
});

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The error parsing `value` throws. */
function parseError(value: unknown): RecognizedTextError {
  try {
    parseRecognizedText(
      typeof value === 'string' ? new TextEncoder().encode(value) : encode(value),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(RecognizedTextError);
    return error as RecognizedTextError;
  }
  throw new Error('expected the data to be refused');
}

describe('recognized text data', () => {
  it('round-trips through its JSON form', () => {
    const value = data([
      word('Selamat', 0, 72, 700),
      word('pagi', 0, 120, 700),
      word('你好', 1, 72, 680),
    ]);
    expect(parseRecognizedText(serializeRecognizedText(value))).toEqual(value);
  });

  it('refuses damaged data without repeating its text', () => {
    const valid = data([word('confidential-word', 0, 72, 700)]);
    const broken = [
      'not json {',
      { ...valid, version: 2 },
      { ...valid, languages: 'eng; rm -rf' },
      { ...valid, rotation: 45 },
      { ...valid, words: [{ ...valid.words[0], box: { x: 1, y: 2, width: -3, height: 4 } }] },
      { ...valid, words: [{ ...valid.words[0], box: { x: null, y: 2, width: 3, height: 4 } }] },
      { ...valid, words: [{ ...valid.words[0], confidence: 101 }] },
      { ...valid, words: [{ ...valid.words[0], text: '' }] },
      { ...valid, words: [{ ...valid.words[0], text: 'x'.repeat(1001) }] },
      { ...valid, words: [word('confidential-word', 1, 0, 0), word('confidential-word', 0, 0, 0)] },
      { ...valid, words: Array.from({ length: 50_001 }, () => valid.words[0]) },
    ];
    for (const value of broken) {
      expect(parseError(value).message).not.toContain('confidential');
    }
    // Invalid UTF-8 is not quietly replaced.
    expect(() => parseRecognizedText(new Uint8Array([0x7b, 0xff, 0x7d]))).toThrow(
      RecognizedTextError,
    );
  });

  it('gives the text as lines, joining Chinese words without spaces', () => {
    const value = data([
      word('The', 0, 72, 700),
      word('lighthouse', 0, 120, 700),
      word('keeper.', 0, 200, 700),
      word('Kucing', 1, 72, 680),
      word('tidur.', 1, 130, 680),
      word('文字', 2, 72, 660),
      word('识别', 2, 100, 660),
      word('，', 2, 128, 660),
      word('PDF', 2, 140, 660),
      word('文件', 2, 180, 660),
    ]);
    expect(recognizedTextLines(value)).toEqual([
      'The lighthouse keeper.',
      'Kucing tidur.',
      '文字识别， PDF 文件',
    ]);
    expect(spaceBetween('文字', '識別')).toBe(false);
    expect(spaceBetween('PDF', '文件')).toBe(true);
    expect(recognizedTextLines(data([]))).toEqual([]);
  });
});

describe('recognized text layout', () => {
  it('places words and the spaces between them on even lines', () => {
    // Two words of different heights on one line, and a second line.
    const value = data([
      word('Hello', 0, 72, 700, 50, 10),
      word('world', 0, 130, 698, 60, 14),
      word('again', 1, 72, 660, 55, 12),
    ]);
    const runs = layoutRecognizedText(value);
    expect(runs.map((run) => [run.text, run.lineEnd])).toEqual([
      ['Hello', false],
      [' ', false],
      ['world', true],
      ['again', true],
    ]);
    const [hello, space, world, again] = runs;
    // The line spans 698–712: every run of it is 14 high, its baseline above the bottom.
    expect(hello!.fontSize).toBeCloseTo(14);
    expect(world!.fontSize).toBeCloseTo(14);
    expect(hello!.matrix).toEqual([1, 0, 0, 1, 72, 698 + 14 * RECOGNIZED_DESCENT]);
    expect(hello!.width).toBeCloseTo(50);
    // The space fills the gap between the words.
    expect(space!.matrix[4]).toBeCloseTo(122);
    expect(space!.width).toBeCloseTo(8);
    expect(world!.matrix[4]).toBeCloseTo(130);
    expect(world!.width).toBeCloseTo(60);
    expect(again!.fontSize).toBeCloseTo(12);
    expect(again!.matrix[5]).toBeCloseTo(660 + 12 * RECOGNIZED_DESCENT);
  });

  it('runs along the line at every rotation the text was read at', () => {
    // One line of two words, as boxes in page space of an unrotated page,
    // for text that reads upright when the page is turned by `rotation`.
    const cases: Array<{ rotation: Rotation; first: RecognizedWord; second: RecognizedWord }> = [
      {
        rotation: 0,
        first: word('one', 0, 100, 500, 30, 10),
        second: word('two', 0, 140, 500, 30, 10),
      },
      // Turned clockwise: the text runs up the page, its top towards -x.
      {
        rotation: 90,
        first: word('one', 0, 300, 100, 10, 30),
        second: word('two', 0, 300, 140, 10, 30),
      },
      // Upside down: the text runs right to left.
      {
        rotation: 180,
        first: word('one', 0, 140, 500, 30, 10),
        second: word('two', 0, 100, 500, 30, 10),
      },
      // Turned counterclockwise: the text runs down the page.
      {
        rotation: 270,
        first: word('one', 0, 300, 140, 10, 30),
        second: word('two', 0, 300, 100, 10, 30),
      },
    ];
    const directions = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };
    for (const { rotation, first, second } of cases) {
      const [one, space, two] = layoutRecognizedText(data([first, second], rotation));
      const [a, b] = directions[rotation];
      expect(
        one!.matrix.slice(0, 2).map((value) => value + 0),
        `${rotation}`,
      ).toEqual([a, b]);
      expect(one!.fontSize, `${rotation}`).toBeCloseTo(10);
      expect(one!.width, `${rotation}`).toBeCloseTo(30);
      expect(space!.width, `${rotation}`).toBeCloseTo(10);
      // Each word starts at the edge of its box the text reads from, on the baseline.
      const start = (box: RecognizedWord['box']) =>
        ({
          0: [box.x, box.y + 2],
          90: [box.x + box.width - 2, box.y],
          180: [box.x + box.width, box.y + box.height - 2],
          270: [box.x + 2, box.y + box.height],
        })[rotation];
      expect(one!.matrix[4], `${rotation}`).toBeCloseTo(start(first.box)[0]!);
      expect(one!.matrix[5], `${rotation}`).toBeCloseTo(start(first.box)[1]!);
      expect(two!.matrix[4], `${rotation}`).toBeCloseTo(start(second.box)[0]!);
      expect(two!.matrix[5], `${rotation}`).toBeCloseTo(start(second.box)[1]!);
    }
  });

  it('joins Chinese words without space runs', () => {
    const runs = layoutRecognizedText(
      data([word('文字', 0, 72, 700, 24, 12), word('识别', 0, 96, 700, 24, 12)]),
    );
    expect(runs.map((run) => run.text)).toEqual(['文字', '识别']);
  });
});
