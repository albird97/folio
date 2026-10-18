import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../tests/setup/fixtures';
import { sniffPdf } from './sniff';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('sniffPdf', () => {
  it('detects the header and version', () => {
    expect(sniffPdf(readFixture('basic-3-pages.pdf'))).toEqual({ isPdf: true, headerVersion: '1.7' });
  });

  it('accepts leading junk within the first 1024 bytes', () => {
    expect(sniffPdf(bytes(`${' '.repeat(500)}%PDF-1.4\n`)).isPdf).toBe(true);
    expect(sniffPdf(bytes(`${' '.repeat(1100)}%PDF-1.4\n`)).isPdf).toBe(false);
  });

  it('rejects non-PDF content', () => {
    expect(sniffPdf(readFixture('not-a-pdf.pdf')).isPdf).toBe(false);
    expect(sniffPdf(new Uint8Array()).isPdf).toBe(false);
    expect(sniffPdf(bytes('%PDF')).isPdf).toBe(false);
  });
});
