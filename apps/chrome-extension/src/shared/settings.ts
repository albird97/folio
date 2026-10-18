import { z } from './zod';
import type { PrivacySettings } from './activity';

export const SETTINGS_KEY = 'settings';
export const ACTIVITY_KEY = 'activity';

export const settingsSchema = z.object({
  activityEnabled: z.boolean().default(true),
  activityIncludesNames: z.boolean().default(false),
});

export type ExtensionSettings = PrivacySettings;

export const DEFAULT_SETTINGS: ExtensionSettings = settingsSchema.parse({});

export function parseSettings(value: unknown): ExtensionSettings {
  const result = settingsSchema.safeParse(value ?? {});
  return result.success ? result.data : DEFAULT_SETTINGS;
}
