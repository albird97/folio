import { z } from 'zod';

/**
 * Zod, configured for Folio's Content Security Policies. Zod compiles object
 * schemas with `new Function` unless told not to, and the check whether that
 * is allowed is itself reported as a CSP violation (script-src) by the
 * browser, even though Zod catches the error. Every schema module imports
 * `z` from here, so the setting is in place before the first schema exists.
 */
z.config({ jitless: true });

export { z };
