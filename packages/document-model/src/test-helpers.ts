import { createDocumentModel, type SourceDescriptor } from './create';
import type { DocumentModel } from './types';

export function descriptor(pageCount: number, overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    fileName: 'sample.pdf',
    byteLength: 1024,
    sha256: 'a'.repeat(64),
    pdfVersion: '1.7',
    encryption: 'none',
    origin: { kind: 'local-file', handle: null },
    metadata: { title: 'Sample' },
    pages: Array.from({ length: pageCount }, () => ({ size: { width: 612, height: 792 }, rotation: 0 })),
    ...overrides,
  };
}

export function sampleModel(pageCount = 3): DocumentModel {
  return createDocumentModel(descriptor(pageCount));
}
