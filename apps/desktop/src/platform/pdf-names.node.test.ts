import { isLikelyPdfName } from '@folio/editor';
import { describe, expect, it } from 'vitest';
import cases from './pdf-name-cases.json';

// The Rust side (`files::is_likely_pdf_name`) runs the same table, so a file
// the native layer refuses is never one the UI would have tried.
describe('PDF name rule shared with the native layer', () => {
  it.each(cases.pdf)('tries %j', (name) => {
    expect(isLikelyPdfName(name)).toBe(true);
  });

  it.each(cases.notPdf)('skips %j', (name) => {
    expect(isLikelyPdfName(name)).toBe(false);
  });
});
