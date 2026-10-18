import { OpenUrlError } from '@folio/platform-adapters';
import { originPattern, parseWebUrl } from '../shared/web-pdf';

/**
 * Downloads a PDF the user asked to open from the web. Runs in the service
 * worker, the only extension context allowed to reach other servers (every
 * page locks itself to the extension with its own CSP). Requests carry no
 * cookies unless the user agreed to send them for this one request, and
 * never a referrer.
 */

/** Largest PDF Folio downloads; it is held in memory twice while handed over. */
export const MAX_URL_PDF_BYTES = 256 * 1024 * 1024;
/** PDF readers accept the header anywhere in the first 1024 bytes. */
const HEADER_WINDOW = 1024;

export interface FetchPdfOptions {
  /** Send the browser's cookies for the site (the user agreed). */
  withCredentials: boolean;
  signal?: AbortSignal;
  onProgress?(received: number, total: number | null): void;
  /** Whether Folio may read from the URL's site (host permission). */
  hasAccess(origin: string): Promise<boolean>;
  fetch?: typeof fetch;
  /** Default {@link MAX_URL_PDF_BYTES}. */
  maxBytes?: number;
}

export interface FetchedPdf {
  name: string;
  bytes: Uint8Array;
}

/** A file name from Content-Disposition or the address, ending in `.pdf`. */
export function pdfNameFor(url: URL, disposition: string | null): string {
  let name: string | null = null;
  if (disposition) {
    const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/.exec(disposition);
    try {
      name = extended
        ? decodeURIComponent(extended[1]!.trim())
        : (plain?.[1] ?? plain?.[2]?.trim() ?? null);
    } catch {
      name = plain?.[1] ?? plain?.[2]?.trim() ?? null;
    }
  }
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop();
    try {
      name = last ? decodeURIComponent(last) : null;
    } catch {
      name = last ?? null;
    }
  }
  // Only the last part of anything path-like, without control characters.
  const cleaned = Array.from((name ?? '').split(/[\\/]/).pop() ?? '')
    .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20 && char !== '\u007f')
    .join('')
    .trim()
    .slice(0, 200);
  const base = cleaned || url.hostname;
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

const looksLikePdf = (head: Uint8Array) => {
  const text = new TextDecoder('latin1').decode(head.subarray(0, HEADER_WINDOW));
  return text.includes('%PDF-');
};

export async function fetchPdf(raw: string, options: FetchPdfOptions): Promise<FetchedPdf> {
  const url = parseWebUrl(raw);
  const host = url.hostname;
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url.href, {
      credentials: options.withCredentials ? 'include' : 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Without access to the site, Chrome's cross-origin rules block the request.
    if (!(await options.hasAccess(originPattern(url)))) {
      throw new OpenUrlError(
        'permission-denied',
        `Folio needs your permission to read files from ${host}.`,
      );
    }
    throw new OpenUrlError(
      'network',
      `Folio could not reach ${host}. Check the address and your connection.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw options.withCredentials
      ? new OpenUrlError('blocked', `${host} did not allow access to this file.`)
      : new OpenUrlError(
          'auth-required',
          `${host} needs you to be signed in to download this file.`,
        );
  }
  if (response.status === 404 || response.status === 410) {
    throw new OpenUrlError('not-found', `There is no file at that address on ${host}.`);
  }
  if (!response.ok) {
    throw new OpenUrlError('network', `${host} answered with an error (${response.status}).`);
  }

  const maxBytes = options.maxBytes ?? MAX_URL_PDF_BYTES;
  const tooLarge = () =>
    new OpenUrlError(
      'too-large',
      `The file is larger than Folio opens from the web (${Math.round(maxBytes / 1024 / 1024)} MB).`,
    );
  const declared = Number(response.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total !== null && total > maxBytes) throw tooLarge();
  const contentType = response.headers.get('content-type') ?? '';
  const isWebPage = /^\s*(text\/html|application\/xhtml)/i.test(contentType);

  // Read with a running size check, so an endless or lying response stops early.
  const reader = response.body?.getReader();
  if (!reader) throw new OpenUrlError('network', `${host} sent an empty answer.`);
  const parts: Uint8Array[] = [];
  let received = 0;
  let checked = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(value);
    // A web page instead of a PDF is clear from its first bytes; stop there.
    if (!checked && received >= HEADER_WINDOW) {
      checked = true;
      const head = concat(parts, Math.min(received, HEADER_WINDOW));
      if (!looksLikePdf(head)) {
        await reader.cancel();
        throw notPdf(host, isWebPage, options.withCredentials);
      }
    }
    options.onProgress?.(received, total);
  }
  const bytes = concat(parts, received);
  if (!looksLikePdf(bytes)) throw notPdf(host, isWebPage, options.withCredentials);
  return {
    name: pdfNameFor(
      new URL(response.url || url.href),
      response.headers.get('content-disposition'),
    ),
    bytes,
  };
}

/**
 * A web page where a PDF was expected is often a sign-in page: offer to try
 * again with the user's sign-in, once.
 */
function notPdf(host: string, isWebPage: boolean, withCredentials: boolean): OpenUrlError {
  if (isWebPage && !withCredentials) {
    return new OpenUrlError(
      'auth-required',
      `${host} sent a web page, not a PDF. If the file needs you to be signed in, Folio can try again with your sign-in.`,
    );
  }
  return new OpenUrlError(
    'not-a-pdf',
    isWebPage
      ? `${host} sent a web page, not a PDF. To keep a web page as a PDF, use “Save page as PDF”.`
      : 'The file at that address is not a PDF.',
  );
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    if (offset >= length) break;
    const take = Math.min(part.byteLength, length - offset);
    out.set(part.subarray(0, take), offset);
    offset += take;
  }
  return out;
}
