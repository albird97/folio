export type PdfErrorCode =
  | 'empty-file'
  | 'not-a-pdf'
  | 'invalid-pdf'
  | 'password-required'
  | 'incorrect-password'
  | 'too-large'
  | 'unsupported'
  | 'unknown';

const MESSAGES: Record<PdfErrorCode, string> = {
  'empty-file': 'The file is empty.',
  'not-a-pdf': 'This file is not a PDF document.',
  'invalid-pdf': 'This PDF is damaged or uses a structure Folio cannot read.',
  'password-required': 'This PDF is protected with a password.',
  'incorrect-password': 'The password is incorrect.',
  'too-large': 'This file is larger than Folio can open.',
  unsupported: 'This PDF uses features Folio does not support yet.',
  unknown: 'The PDF could not be opened.',
};

/**
 * A user-presentable error. Messages never include document content, file
 * names or paths, so they are safe to log.
 */
export class PdfError extends Error {
  override readonly name = 'PdfError';
  constructor(
    readonly code: PdfErrorCode,
    message: string = MESSAGES[code],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isPdfError(error: unknown, code?: PdfErrorCode): error is PdfError {
  return error instanceof PdfError && (code === undefined || error.code === code);
}
