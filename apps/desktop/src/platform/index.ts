import { createWebPlatformAdapter, type PlatformAdapter } from '@folio/platform-adapters';
import { createTauriPlatformAdapter, isTauri } from './tauri';

export interface DesktopPlatform {
  adapter: PlatformAdapter;
  /** True inside the Tauri shell; false when the UI runs in a plain browser (dev, UI tests). */
  native: boolean;
}

export async function createDesktopPlatform(): Promise<DesktopPlatform> {
  if (isTauri()) return { adapter: await createTauriPlatformAdapter(), native: true };
  return { adapter: createWebPlatformAdapter(), native: false };
}
