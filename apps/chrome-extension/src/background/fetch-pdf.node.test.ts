import { describe, expect, it, vi } from 'vitest';
import { OpenUrlError } from '@folio/platform-adapters';
import { parseWebUrl } from '../shared/web-pdf';
import { fetchPdf, pdfNameFor } from './fetch-pdf';

const PDF = new TextEncoder().encode('%PDF-1.7\n' + 'x'.repeat(3000) + '\n%%EOF\n');
const HTML = new TextEncoder().encode('<!doctype html><title>Sign in</title>' + ' '.repeat(2000));

/** A response streamed in small chunks, like a network body. */
function respond(
  bytes: Uint8Array,
  init: { status?: number; headers?: Record<string, string>; url?: string } = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 700) {
        controller.enqueue(bytes.slice(offset, offset + 700));
      }
      controller.close();
    },
  });
  const response = new Response(body, { status: init.status ?? 200, headers: init.headers });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}

const granted = async () => true;

async function failure(promise: Promise<unknown>): Promise<OpenUrlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenUrlError);
    return error as OpenUrlError;
  }
  throw new Error('expected a failure');
}

describe('fetching PDFs from the web', () => {
  it('downloads a PDF without cookies or referrer and reports progress', async () => {
    const fetchMock = vi.fn(async () =>
      respond(PDF, { headers: { 'content-length': String(PDF.length) } }),
    );
    const progress: Array<[number, number | null]> = [];
    const result = await fetchPdf('https://example.com/files/Annual%20report.pdf#page=2', {
      withCredentials: false,
      hasAccess: granted,
      fetch: fetchMock as unknown as typeof fetch,
      onProgress: (received, total) => progress.push([received, total]),
    });
    expect(result.name).toBe('Annual report.pdf');
    expect(result.bytes).toEqual(PDF);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/files/Annual%20report.pdf',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }),
    );
    expect(progress.at(-1)).toEqual([PDF.length, PDF.length]);
  });

  it('sends cookies only when asked to', async () => {
    const fetchMock = vi.fn(async () => respond(PDF));
    await fetchPdf('https://example.com/a.pdf', {
      withCredentials: true,
      hasAccess: granted,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('asks for sign-in when the site refuses or sends a web page', async () => {
    const run = (response: Response, withCredentials = false) =>
      failure(
        fetchPdf('https://intranet.example/doc', {
          withCredentials,
          hasAccess: granted,
          fetch: (async () => response) as unknown as typeof fetch,
        }),
      );
    expect((await run(respond(new Uint8Array(), { status: 401 }))).code).toBe('auth-required');
    expect((await run(respond(new Uint8Array(), { status: 403 }), true)).code).toBe('blocked');
    const page = { headers: { 'content-type': 'text/html; charset=utf-8' } };
    expect((await run(respond(HTML, page))).code).toBe('auth-required');
    // After signing in, a web page is just not a PDF.
    const signedIn = await run(respond(HTML, page), true);
    expect(signedIn.code).toBe('not-a-pdf');
    expect(signedIn.message).toContain('Save page as PDF');
    const binary = await run(respond(new Uint8Array(2048).fill(7)));
    expect(binary).toMatchObject({
      code: 'not-a-pdf',
      message: 'The file at that address is not a PDF.',
    });
    expect((await run(respond(new Uint8Array(), { status: 404 }))).code).toBe('not-found');
    expect((await run(respond(new Uint8Array(), { status: 500 }))).message).toContain('(500)');
  });

  it('stops at the size limit, declared or not', async () => {
    const big = new Uint8Array(5000);
    big.set(PDF.subarray(0, 9));
    const run = (headers: Record<string, string>) =>
      failure(
        fetchPdf('https://example.com/big.pdf', {
          withCredentials: false,
          hasAccess: granted,
          maxBytes: 4000,
          fetch: (async () => respond(big, { headers })) as unknown as typeof fetch,
        }),
      );
    expect((await run({ 'content-length': '5000' })).code).toBe('too-large');
    expect((await run({})).code).toBe('too-large');
  });

  it('tells a missing permission from a network failure', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const denied = await failure(
      fetchPdf('https://example.com/a.pdf', {
        withCredentials: false,
        hasAccess: async (origin) => origin !== 'https://example.com/*',
        fetch: offline,
      }),
    );
    expect(denied).toMatchObject({
      code: 'permission-denied',
      message: 'Folio needs your permission to read files from example.com.',
    });
    const network = await failure(
      fetchPdf('https://example.com/a.pdf', {
        withCredentials: false,
        hasAccess: granted,
        fetch: offline,
      }),
    );
    expect(network.code).toBe('network');
  });

  it('only opens web addresses', () => {
    for (const raw of [
      'file:///etc/passwd',
      'chrome://settings',
      'javascript:alert(1)',
      'data:,x',
      'nope',
    ]) {
      expect(() => parseWebUrl(raw), raw).toThrow(OpenUrlError);
    }
    expect(() => parseWebUrl('https://user:secret@example.com/a.pdf')).toThrow(/user name/);
    expect(parseWebUrl(' http://example.com/a.pdf#x ').href).toBe('http://example.com/a.pdf');
  });

  it('names files from the response or the address', () => {
    const url = new URL('https://example.com/download?id=7');
    expect(pdfNameFor(url, `attachment; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`)).toBe('Résumé.pdf');
    expect(pdfNameFor(url, 'attachment; filename="report.PDF"')).toBe('report.PDF');
    expect(pdfNameFor(url, 'attachment; filename="../../etc/passwd"')).toBe('passwd.pdf');
    expect(pdfNameFor(url, null)).toBe('download.pdf');
    expect(pdfNameFor(new URL('https://example.com/'), null)).toBe('example.com.pdf');
    expect(pdfNameFor(url, 'inline; filename="a\u0007b.pdf"')).toBe('ab.pdf');
  });
});
