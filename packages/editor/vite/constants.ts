/** Folder (relative to the app's base URL) that serves Tesseract's worker, cores and language data. */
export const TESSERACT_ASSET_DIR = 'tesseract';

/** Languages whose recognition data ships with Folio, as Tesseract codes. */
export const OCR_LANGUAGE_CODES = ['eng', 'ind', 'chi_sim', 'chi_tra'] as const;
