import type { DocumentOrigin, SourceDescriptor } from '@folio/document-model';
import type { PdfDocumentInfo } from './engine';

export function toSourceDescriptor(
  info: PdfDocumentInfo,
  file: { fileName: string; byteLength: number; sha256: string; origin: DocumentOrigin },
): SourceDescriptor {
  return {
    fileName: file.fileName,
    byteLength: file.byteLength,
    sha256: file.sha256,
    origin: file.origin,
    pdfVersion: info.pdfVersion,
    encryption: info.encryption,
    metadata: info.metadata,
    pages: info.pages.map((page) => ({ size: page.size, rotation: page.rotation })),
  };
}
