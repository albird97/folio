import type { DocumentMetadata } from '@folio/document-model';
import {
  decodePDFRawStream,
  PDFName,
  PDFRawStream,
  PDFStream,
  type PDFDocument,
} from '@cantoo/pdf-lib';

/** XML 1.0 allows tab, line feed and carriage return among the control characters. */
const allowedInXml = (char: string) => {
  const code = char.codePointAt(0)!;
  return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
};

const escapeXml = (value: string) =>
  Array.from(value)
    .filter(allowedInXml)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Properties Folio writes; existing values of these are replaced. */
const ELEMENTS = [
  'dc:title',
  'dc:creator',
  'dc:description',
  'pdf:Keywords',
  'pdf:Producer',
  'xmp:CreatorTool',
  'xmp:CreateDate',
  'xmp:ModifyDate',
  'xmp:MetadataDate',
] as const;

/**
 * Rewrites the document-information fields of an XMP packet, keeping
 * everything else it describes. Returns null when the packet is not in the
 * usual RDF form, in which case it is left alone.
 */
export function updateXmp(
  xml: string,
  metadata: DocumentMetadata,
  dates: { created: string | null; modified: string },
): string | null {
  if (!/<\/rdf:RDF>/.test(xml)) return null;
  let out = xml;
  for (const name of ELEMENTS) {
    const escaped = name.replace(':', '\\:');
    out = out
      .replace(new RegExp(`<${escaped}\\b[^>]*/>`, 'g'), '')
      .replace(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?</${escaped}>`, 'g'), '')
      .replace(new RegExp(`\\s${escaped}\\s*=\\s*("[^"]*"|'[^']*')`, 'g'), '');
  }
  const alt = (value: string) =>
    `<rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt>`;
  const authors = metadata.author
    .split(/;\s*/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const fields = [
    metadata.title ? `<dc:title>${alt(metadata.title)}</dc:title>` : '',
    authors.length > 0
      ? `<dc:creator><rdf:Seq>${authors.map((name) => `<rdf:li>${escapeXml(name)}</rdf:li>`).join('')}</rdf:Seq></dc:creator>`
      : '',
    metadata.subject ? `<dc:description>${alt(metadata.subject)}</dc:description>` : '',
    metadata.keywords.length > 0
      ? `<pdf:Keywords>${escapeXml(metadata.keywords.join(', '))}</pdf:Keywords>`
      : '',
    `<pdf:Producer>${escapeXml(metadata.producer)}</pdf:Producer>`,
    metadata.creator ? `<xmp:CreatorTool>${escapeXml(metadata.creator)}</xmp:CreatorTool>` : '',
    dates.created ? `<xmp:CreateDate>${dates.created}</xmp:CreateDate>` : '',
    `<xmp:ModifyDate>${dates.modified}</xmp:ModifyDate>`,
    `<xmp:MetadataDate>${dates.modified}</xmp:MetadataDate>`,
  ].join('');
  const description =
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
    `${fields}</rdf:Description>`;
  return out.replace(/<\/rdf:RDF>/, `${description}</rdf:RDF>`);
}

/**
 * Writes the document information dictionary and, when the document has
 * one, keeps its XMP metadata consistent with it.
 */
export function writeMetadata(doc: PDFDocument, metadata: DocumentMetadata, now: Date): void {
  doc.setTitle(metadata.title);
  doc.setAuthor(metadata.author);
  doc.setSubject(metadata.subject);
  // Comma-separated, as most readers (and Folio's) split them.
  doc.setKeywords([metadata.keywords.join(', ')]);
  doc.setCreator(metadata.creator);
  doc.setProducer(metadata.producer);
  const created = metadata.creationDate ? new Date(metadata.creationDate) : null;
  if (created && !Number.isNaN(created.getTime())) doc.setCreationDate(created);
  doc.setModificationDate(now);

  const ref = doc.catalog.get(PDFName.of('Metadata'));
  const stream = ref ? doc.context.lookup(ref) : undefined;
  if (!(stream instanceof PDFStream)) return;
  let xml: string;
  try {
    const bytes =
      stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
    xml = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return;
  }
  const updated = updateXmp(xml, metadata, {
    created: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    modified: now.toISOString(),
  });
  if (updated === null) return;
  // Metadata streams stay uncompressed so other tools can read them.
  const replacement = doc.context.stream(updated, {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(replacement));
}
