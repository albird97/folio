/// <reference types="vite/client" />
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { createPdfEngine, type PdfEngine } from './engine';
import { PDFJS_ASSET_DIR } from '../vite/constants';

/**
 * Creates the engine for a Vite-built page (desktop webview or extension
 * page). The worker and PDF.js assets ship inside the app bundle; nothing is
 * fetched from the network, which Manifest V3 requires anyway.
 */
export function createBrowserPdfEngine(): PdfEngine {
  const base = new URL(`${import.meta.env.BASE_URL}${PDFJS_ASSET_DIR}/`, globalThis.location.href);
  return createPdfEngine({ workerSrc, assetBaseUrl: base.href });
}
