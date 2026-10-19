import { OCR_LANGUAGE_CODES } from '../../vite/constants';

/** A language Folio can recognize text in (its recognition data ships with Folio). */
export type OcrLanguage = (typeof OCR_LANGUAGE_CODES)[number];

/** The languages, in the order they are offered. */
export const OCR_LANGUAGES: ReadonlyArray<{ code: OcrLanguage; label: string }> = [
  { code: 'eng', label: 'English' },
  { code: 'ind', label: 'Indonesian' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'chi_tra', label: 'Chinese (Traditional)' },
];

export const isOcrLanguage = (value: unknown): value is OcrLanguage =>
  (OCR_LANGUAGE_CODES as readonly unknown[]).includes(value);
