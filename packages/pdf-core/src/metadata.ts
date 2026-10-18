import { EMPTY_METADATA, type DocumentMetadata } from '@folio/document-model';

/** The subset of PDF.js' `info` object that Folio reads. */
export interface PdfJsInfo {
  Title?: unknown;
  Author?: unknown;
  Subject?: unknown;
  Keywords?: unknown;
  Creator?: unknown;
  Producer?: unknown;
  CreationDate?: unknown;
  ModDate?: unknown;
  PDFFormatVersion?: unknown;
  EncryptFilterName?: unknown;
  IsLinearized?: unknown;
  IsAcroFormPresent?: unknown;
  IsXFAPresent?: unknown;
  IsSignaturesPresent?: unknown;
}

export interface XmpLike {
  get(name: string): unknown;
}

type DateParser = (value: string) => Date | null;

const text = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\0/g, '').trim() : '';

export function splitKeywords(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
}

function isoDate(value: unknown, parse: DateParser): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = parse(raw);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/**
 * Normalizes the Info dictionary, falling back to XMP for fields that are
 * commonly only present there.
 */
export function normalizeMetadata(
  info: PdfJsInfo,
  xmp: XmpLike | null,
  parseDate: DateParser,
): DocumentMetadata {
  const fromXmp = (key: string) => {
    const value = xmp?.get(key);
    // PDF.js returns dc:creator and dc:subject (rdf:Seq/Bag) as string arrays.
    if (Array.isArray(value)) {
      return value
        .map(text)
        .filter((item) => item.length > 0)
        .join('; ');
    }
    return text(value);
  };
  return {
    ...EMPTY_METADATA,
    title: text(info.Title) || fromXmp('dc:title'),
    author: text(info.Author) || fromXmp('dc:creator'),
    subject: text(info.Subject) || fromXmp('dc:description'),
    keywords: splitKeywords(text(info.Keywords) || fromXmp('pdf:keywords')),
    creator: text(info.Creator) || fromXmp('xmp:creatortool'),
    producer: text(info.Producer) || fromXmp('pdf:producer'),
    creationDate: isoDate(info.CreationDate, parseDate),
    modificationDate: isoDate(info.ModDate, parseDate),
  };
}
