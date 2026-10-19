import { pageTextToString } from '@folio/pdf-core';
import { documentPageText } from '../ocr/page-text';
import type { WorkspaceStore } from '../store/workspace';
import type { AiDocument } from './prompt';

/**
 * Reads the text of the pages at `positions` (0-based, in document order):
 * the PDF's own text plus text recognized on scanned pages, as search finds
 * it. Pages without text (blank pages, scans not recognized yet) are left
 * out but counted. Null when the document is no longer open.
 */
export async function readDocumentText(
  workspace: WorkspaceStore,
  key: string,
  positions: readonly number[],
  signal?: AbortSignal,
): Promise<AiDocument | null> {
  const model = workspace.getState().documents.find((doc) => doc.key === key)?.editor?.model;
  if (!model) return null;
  const document: AiDocument = { pages: [], pagesRead: 0 };
  for (const position of [...new Set(positions)].sort((a, b) => a - b)) {
    const page = model.pages[position];
    if (!page) continue;
    if (signal?.aborted) return null;
    const text = pageTextToString(await documentPageText(workspace, key, page)).trim();
    document.pagesRead += 1;
    if (text) document.pages.push({ pageId: page.id, pageNumber: position + 1, text });
  }
  return document;
}
