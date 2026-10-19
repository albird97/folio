import type { PageModel, Rotation } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import type { Tool } from '../store/ui';
import type { WorkspaceDocument } from '../store/workspace';
import type { PageBox } from './layout';

/** What a layer drawn over one page of the viewer gets. */
export interface PageOverlayProps {
  doc: WorkspaceDocument;
  page: PageModel;
  /** Position of the page in the document, from 0. */
  position: number;
  pageCount: number;
  box: PageBox;
  /** CSS pixels per PDF point. */
  scale: number;
  viewRotation: Rotation;
  /** The engine document of the page's file, or null for a blank page. */
  handle: PdfDocumentHandle | null;
  tool: Tool;
}
