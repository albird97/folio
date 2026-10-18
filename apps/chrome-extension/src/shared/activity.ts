import { z } from 'zod';

export const ACTIVITY_LIMIT = 30;

export const activityKindSchema = z.enum(['opened', 'inspected', 'sent-to-editor']);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export interface ActivityEntry {
  id: string;
  at: string;
  kind: ActivityKind;
  pageCount: number | null;
  /** Only stored when the user opted in to file names in activity. */
  fileName: string | null;
}

export interface ActivityInput {
  kind: ActivityKind;
  pageCount?: number | undefined;
  fileName?: string | undefined;
}

export interface PrivacySettings {
  activityEnabled: boolean;
  activityIncludesNames: boolean;
}

/**
 * Appends an activity entry, honouring the privacy settings. Pure, so the
 * rules are unit tested and enforced in one place (the service worker).
 */
export function appendActivity(
  log: readonly ActivityEntry[],
  input: ActivityInput,
  settings: PrivacySettings,
  now: Date,
  id: string,
): ActivityEntry[] {
  if (!settings.activityEnabled) return [...log];
  const entry: ActivityEntry = {
    id,
    at: now.toISOString(),
    kind: input.kind,
    pageCount: input.pageCount ?? null,
    fileName: settings.activityIncludesNames ? (input.fileName ?? null) : null,
  };
  return [entry, ...log].slice(0, ACTIVITY_LIMIT);
}

/** Removes stored file names, e.g. after the user turns the option off. */
export function redactActivity(log: readonly ActivityEntry[]): ActivityEntry[] {
  return log.map((entry) => ({ ...entry, fileName: null }));
}

export function describeActivity(entry: ActivityEntry): string {
  const what = {
    opened: 'Opened a PDF',
    inspected: 'Inspected a PDF',
    'sent-to-editor': 'Sent a PDF to the editor',
  }[entry.kind];
  const pages =
    entry.pageCount === null
      ? ''
      : ` · ${entry.pageCount} ${entry.pageCount === 1 ? 'page' : 'pages'}`;
  return `${what}${pages}`;
}
