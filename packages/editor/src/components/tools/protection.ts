import {
  isPdfError,
  type PdfDocumentInfo,
  type PdfEngine,
  type PdfPermissions,
} from '@folio/pdf-core';

/** The actions a protected PDF can allow or restrict, in the order the dialog lists them. */
export const PERMISSION_LABELS: ReadonlyArray<{ key: keyof PdfPermissions; label: string }> = [
  { key: 'print', label: 'Printing' },
  { key: 'copy', label: 'Copying text and images' },
  { key: 'modify', label: 'Changing the document' },
  { key: 'annotate', label: 'Adding comments' },
  { key: 'fillForms', label: 'Filling in forms' },
  { key: 'assemble', label: 'Inserting, deleting and rotating pages' },
];

/** What a document does not allow; nothing for documents without restrictions. */
export function restrictionsOf(permissions: PdfPermissions | null): Array<keyof PdfPermissions> {
  return permissions
    ? PERMISSION_LABELS.map(({ key }) => key).filter((key) => !permissions[key])
    : [];
}

/** How the opened file is protected, in a sentence. */
export function describeProtection(info: PdfDocumentInfo): string {
  const restricted = restrictionsOf(info.permissions);
  const what =
    restricted.length === 0
      ? ''
      : PERMISSION_LABELS.filter(({ key }) => restricted.includes(key))
          .map(({ label }) => label.toLowerCase())
          .join(', ');
  if (info.encryption === 'none') return 'This document is not protected.';
  if (info.encryption === 'password-protected') {
    return what
      ? `This document needs a password to open, and does not allow ${what}.`
      : 'This document needs a password to open.';
  }
  return what
    ? `This document opens without a password, but does not allow ${what}.`
    : 'This document is encrypted, but opens without a password and allows everything.';
}

/**
 * Protection can be removed from documents opened with their password that
 * restrict nothing. Restrictions can only be lifted with the permissions
 * password, which Folio never has.
 */
export function canRemoveProtection(info: PdfDocumentInfo): boolean {
  return info.encryption === 'password-protected' && restrictionsOf(info.permissions).length === 0;
}

export type PasswordStrength = { level: 'weak' | 'fair' | 'strong'; hint: string };

/** A plain hint about how hard a password is to guess (length and kinds of characters). */
export function passwordStrength(password: string): PasswordStrength | null {
  if (password === '') return null;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) =>
    kind.test(password),
  ).length;
  const length = [...password].length;
  if (length < 8) {
    return {
      level: 'weak',
      hint: 'Weak: short passwords are easy to guess. Use 8 or more characters.',
    };
  }
  if (length >= 16 || (length >= 12 && kinds >= 2) || kinds >= 3) {
    return { level: 'strong', hint: 'Strong.' };
  }
  return {
    level: 'fair',
    hint: 'Fair: a longer password, or one that mixes letters, numbers and symbols, is stronger.',
  };
}

export interface ExpectedProtection {
  /** The password to open the copy; '' when it opens without one. */
  password: string;
  /** What the copy allows; null for a copy without any protection. */
  permissions: PdfPermissions | null;
  pageCount: number;
}

const samePermissions = (actual: PdfPermissions, expected: PdfPermissions) =>
  (Object.keys(expected) as Array<keyof PdfPermissions>).every(
    (key) => actual[key] === expected[key],
  );

/**
 * Checks a protected (or unprotected) copy before it is saved, by opening it
 * the way readers will: with PDF.js, it must ask for the password when it
 * has one, open with it to the same number of pages, and allow exactly what
 * was chosen; a copy without protection must not be encrypted at all.
 */
export async function verifyProtection(
  engine: PdfEngine,
  bytes: Uint8Array,
  expected: ExpectedProtection,
): Promise<boolean> {
  if (expected.password !== '') {
    try {
      const opened = await engine.open(bytes);
      await opened.destroy();
      return false;
    } catch (error) {
      if (!isPdfError(error, 'password-required')) return false;
    }
  }
  let handle;
  try {
    handle = await engine.open(
      bytes,
      expected.password === '' ? {} : { password: expected.password },
    );
  } catch {
    return false;
  }
  try {
    const { info } = handle;
    if (info.pageCount !== expected.pageCount) return false;
    if (!expected.permissions) return info.encryption === 'none';
    return (
      info.encryption !== 'none' &&
      info.permissions !== null &&
      samePermissions(info.permissions, expected.permissions)
    );
  } finally {
    await handle.destroy();
  }
}
