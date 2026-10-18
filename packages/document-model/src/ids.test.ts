import { describe, expect, it } from 'vitest';
import { isId, newAnnotationId, newDocumentId, newPageId } from './ids';

describe('ids', () => {
  it('generates prefixed, unique identifiers', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newPageId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^page_[0-9a-f]{24}$/);
  });

  it('validates the kind of an identifier', () => {
    expect(isId('page', newPageId())).toBe(true);
    expect(isId('page', newAnnotationId())).toBe(false);
    expect(isId('document', newDocumentId())).toBe(true);
    expect(isId('document', 'doc_123')).toBe(false);
    expect(isId('document', 42)).toBe(false);
  });
});
