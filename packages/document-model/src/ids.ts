/**
 * Stable, branded identifiers.
 *
 * IDs are opaque strings with a type prefix (`page_…`, `annot_…`). The brand
 * prevents passing a PageId where an AnnotationId is expected, while the
 * prefix keeps serialized snapshots readable and lets us validate input.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type DocumentId = Brand<string, 'DocumentId'>;
export type SourceId = Brand<string, 'SourceId'>;
export type PageId = Brand<string, 'PageId'>;
export type AnnotationId = Brand<string, 'AnnotationId'>;
export type FormFieldId = Brand<string, 'FormFieldId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type OperationId = Brand<string, 'OperationId'>;

export const ID_PREFIXES = {
  document: 'doc',
  source: 'src',
  page: 'page',
  annotation: 'annot',
  formField: 'field',
  asset: 'asset',
  operation: 'op',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const RANDOM_BYTES = 12;
const ID_PATTERN = /^[a-z]+_[0-9a-f]{24}$/;

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function randomHex(): string {
  // `getRandomValues` (unlike `randomUUID`) is available outside secure
  // contexts, in service workers, in Node and in every desktop webview.
  const cryptoImpl = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!cryptoImpl) {
    throw new Error('A Web Crypto implementation is required to generate IDs.');
  }
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(RANDOM_BYTES));
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function make<T extends string>(kind: IdKind): T {
  return `${ID_PREFIXES[kind]}_${randomHex()}` as T;
}

export const newDocumentId = (): DocumentId => make<DocumentId>('document');
export const newSourceId = (): SourceId => make<SourceId>('source');
export const newPageId = (): PageId => make<PageId>('page');
export const newAnnotationId = (): AnnotationId => make<AnnotationId>('annotation');
export const newFormFieldId = (): FormFieldId => make<FormFieldId>('formField');
export const newAssetId = (): AssetId => make<AssetId>('asset');
export const newOperationId = (): OperationId => make<OperationId>('operation');

/** Returns true when `value` is a well-formed ID of the given kind. */
export function isId(kind: IdKind, value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ID_PATTERN.test(value) &&
    value.startsWith(`${ID_PREFIXES[kind]}_`)
  );
}
