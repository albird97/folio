/// <reference types="vite/client" />
import latin from '@fontsource-variable/dancing-script/files/dancing-script-latin-wght-normal.woff2?url';
import latinExt from '@fontsource-variable/dancing-script/files/dancing-script-latin-ext-wght-normal.woff2?url';
import vietnamese from '@fontsource-variable/dancing-script/files/dancing-script-vietnamese-wght-normal.woff2?url';

/*
 * The handwriting font typed signatures are drawn in: Dancing Script
 * (SIL Open Font License 1.1), bundled with the app because neither app may
 * load fonts from the web. It is added to the page only when the Type tab
 * opens, and the browser then fetches just the subsets a name needs.
 */

/** The family name Folio gives the font. */
const SIGNATURE_FONT_FAMILY = 'Folio Signature';
/** The font, then the system's own handwriting font for characters it lacks. */
export const SIGNATURE_FONT_STACK = `"${SIGNATURE_FONT_FAMILY}", cursive`;
/** Typed signatures are drawn a little heavier than the font's regular weight. */
export const SIGNATURE_FONT_WEIGHT = 500;

/** The font's subsets and the characters each covers (as Fontsource publishes them). */
const FACES = [
  {
    url: latin,
    unicodeRange:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  },
  {
    url: latinExt,
    unicodeRange:
      'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  },
  {
    url: vietnamese,
    unicodeRange:
      'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
  },
];

let added = false;

/**
 * Adds the handwriting font to the page (once) and waits until the subsets
 * `text` needs are loaded, so drawing it on a canvas uses the font rather
 * than a fallback. Resolves without it where the FontFace API is missing
 * or the font cannot be loaded: the system's handwriting font is used then.
 */
export async function loadSignatureFont(text: string): Promise<void> {
  if (typeof FontFace === 'undefined' || !('fonts' in document)) return;
  if (!added) {
    added = true;
    for (const { url, unicodeRange } of FACES) {
      document.fonts.add(
        new FontFace(SIGNATURE_FONT_FAMILY, `url("${url}") format("woff2")`, {
          weight: '400 700',
          unicodeRange,
        }),
      );
    }
  }
  try {
    await document.fonts.load(
      `${SIGNATURE_FONT_WEIGHT} 32px ${SIGNATURE_FONT_STACK}`,
      text || 'Aa',
    );
  } catch {
    // Drawn in the fallback font instead.
  }
}
