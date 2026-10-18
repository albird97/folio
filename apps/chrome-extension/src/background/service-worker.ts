/**
 * Folio's service worker. Chrome stops it whenever it is idle, so it keeps no
 * state in memory beyond a queue of pending writes: everything lives in
 * chrome.storage and IndexedDB, and every listener is registered
 * synchronously at the top level.
 */
import { appendActivity, redactActivity, type ActivityEntry } from '../shared/activity';
import { parseMessage, type MessageResponse } from '../shared/messages';
import { newHandoffId, purgeExpiredHandoffs } from '../shared/handoff';
import { ACTIVITY_KEY, DEFAULT_SETTINGS, parseSettings, SETTINGS_KEY } from '../shared/settings';
import { FETCH_PORT, OPEN_URL_JOB_PREFIX, parseWebUrl } from '../shared/web-pdf';
import { serveFetchPort } from './fetch-port';

async function readActivity(): Promise<ActivityEntry[]> {
  const stored = (await chrome.storage.local.get(ACTIVITY_KEY))[ACTIVITY_KEY];
  return Array.isArray(stored) ? (stored as ActivityEntry[]) : [];
}

async function readSettings() {
  return parseSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}

/**
 * Every read-modify-write of the activity log runs through this queue, one
 * step at a time. Otherwise overlapping records (several PDFs opened at once)
 * would read the same log and drop each other's entries, and a record that
 * read the log before a Clear would write the cleared entries back. The queue
 * only has to order writes within one run of the worker: each step takes
 * milliseconds, far less than the idle time after which Chrome stops it.
 */
let activityQueue: Promise<unknown> = Promise.resolve();

function serialActivity<T>(step: () => Promise<T>): Promise<T> {
  const run = activityQueue.then(step);
  activityQueue = run.catch(() => undefined);
  return run;
}

/** Only this extension's own pages may talk to the worker. */
function isTrustedSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  return (
    sender?.id === chrome.runtime.id && (sender.url ?? '').startsWith(chrome.runtime.getURL(''))
  );
}

async function handle(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<MessageResponse> {
  if (!isTrustedSender(sender)) return { ok: false, error: 'forbidden-sender' };
  const message = parseMessage(raw);
  if (!message) return { ok: false, error: 'invalid-message' };

  switch (message.type) {
    case 'activity/record': {
      // Settings are read inside the queued step, so each record honours the
      // privacy settings as they are when it is written.
      const activity = await serialActivity(async () => {
        const [log, settings] = await Promise.all([readActivity(), readSettings()]);
        const next = appendActivity(log, message, settings, new Date(), crypto.randomUUID());
        await chrome.storage.local.set({ [ACTIVITY_KEY]: next });
        return next;
      });
      return { ok: true, activity };
    }
    case 'activity/clear':
      await serialActivity(() => chrome.storage.local.set({ [ACTIVITY_KEY]: [] }));
      return { ok: true, activity: [] };
    case 'editor/open': {
      const url = new URL(chrome.runtime.getURL('editor.html'));
      if (message.handoffId) url.searchParams.set('handoff', message.handoffId);
      await chrome.tabs.create({ url: url.href });
      return { ok: true };
    }
    case 'editor/open-url': {
      // The address goes to the editor through session storage, not the tab's URL.
      let target: URL;
      try {
        target = parseWebUrl(message.url);
      } catch {
        return { ok: false, error: 'invalid-message' };
      }
      const job = newHandoffId();
      await chrome.storage.session.set({ [`${OPEN_URL_JOB_PREFIX}${job}`]: target.href });
      const url = new URL(chrome.runtime.getURL('editor.html'));
      url.searchParams.set('open', job);
      await chrome.tabs.create({ url: url.href });
      return { ok: true };
    }
    case 'status/get':
      return {
        ok: true,
        status: {
          version: chrome.runtime.getManifest().version,
          desktopIntegration: 'unavailable',
        },
      };
  }
}

// Downloads for "Open from a web address", one port per download.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== FETCH_PORT || !isTrustedSender(port.sender)) {
    port.disconnect();
    return;
  }
  serveFetchPort(port);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, () => sendResponse({ ok: false, error: 'failed' }));
  return true; // Keeps the channel open for the async response.
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...parseSettings(stored) },
    });
    // The toolbar button opens the popup; the side panel is opened from there.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await purgeExpiredHandoffs();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void purgeExpiredHandoffs();
});

// Turning off "file names in activity" removes names that were already stored.
// Queued after any record in flight, so a name written under the old settings
// is removed too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
  const settings = parseSettings(changes[SETTINGS_KEY]?.newValue);
  void serialActivity(async () => {
    if (!settings.activityEnabled) return chrome.storage.local.set({ [ACTIVITY_KEY]: [] });
    const log = await readActivity();
    if (!settings.activityIncludesNames && log.some((entry) => entry.fileName !== null)) {
      return chrome.storage.local.set({ [ACTIVITY_KEY]: redactActivity(log) });
    }
    return undefined;
  });
});
