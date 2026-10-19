//! Opt-in updates. Folio looks for a new version only when the user chooses
//! Check for Updates… (in the Folio menu on macOS, the Help menu elsewhere)
//! or turns on Check for Updates Automatically, which then checks at most
//! once a day, shortly after startup. Otherwise it makes no request for
//! updates at all. Everything happens natively: the webview can neither
//! check for, download nor install an update (the capability grants no
//! updater permission), and the dialogs are Folio's own native ones, whose
//! default button changes nothing.
//!
//! 1. The release feed is the single `plugins.updater.endpoints` entry in
//!    `tauri.conf.json`. Only a newer version counts (see [`is_update`]).
//! 2. "Folio 0.3.0 is available. You have 0.2.0. Install it and restart
//!    Folio?", with the feed's release notes as plain text.
//! 3. The download is verified by the updater plugin: its minisign signature
//!    must match the public key in `tauri.conf.json`, and the signature must
//!    name the version the feed announced (`requireSignedVersion`), so a
//!    tampered feed cannot pass an older release off as new.
//! 4. Unsaved work is asked about the way quitting asks
//!    ([`CloseIntent::Update`] through the close guard); then the update is
//!    installed and Folio restarts.
//!
//! The setting and the time of the last check live in [`SETTINGS_FILE`] in
//! Folio's data folder.

use crate::close_guard::{CloseGuard, CloseIntent};
use crate::connect::{self, Level, Notice, Question};
use crate::{paths, save, Storage};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

/// The setting and the time of the last check, next to `recent.json`.
pub const SETTINGS_FILE: &str = "updates.json";
/// It holds two short values; anything larger is not Folio's.
const MAX_SETTINGS_BYTES: u64 = 4 * 1024;
/// The automatic check runs at most this often.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// How long after startup the automatic check waits, so that it does not
/// compete with opening documents.
const STARTUP_DELAY: Duration = Duration::from_secs(10);
/// The release feed must answer within this time.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// The whole download must arrive within this time.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Release notes beyond this many lines or bytes are cut, so that the
/// question still fits on the screen.
const MAX_NOTES_LINES: usize = 15;
const MAX_NOTES_BYTES: usize = 1500;

/// The user's choice, and when Folio last checked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Settings {
    /// Check once a day, shortly after startup. Off until the user turns it
    /// on.
    pub check_automatically: bool,
    /// When Folio last checked, automatically or not.
    pub last_check: Option<SystemTime>,
}

/// [`SETTINGS_FILE`] as stored.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(default)]
    check_automatically: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_check: Option<String>,
}

impl Settings {
    /// Reads [`SETTINGS_FILE`]. Anything but a JSON object with a boolean
    /// `checkAutomatically` (and a timestamp as Folio writes it) leaves
    /// automatic checks off, so a damaged file never makes Folio go online.
    /// A last check that cannot be read counts as none.
    pub fn parse(bytes: &[u8]) -> Settings {
        // Objects only: serde would also read the fields from an array.
        if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
            return Settings::default();
        }
        let Ok(stored) = serde_json::from_slice::<Stored>(bytes) else {
            return Settings::default();
        };
        Settings {
            check_automatically: stored.check_automatically,
            last_check: stored
                .last_check
                .as_deref()
                .and_then(crate::time::parse_iso8601),
        }
    }

    pub fn to_json(self) -> Vec<u8> {
        let stored = Stored {
            check_automatically: self.check_automatically,
            last_check: self.last_check.map(crate::time::iso8601),
        };
        serde_json::to_vec_pretty(&stored).unwrap_or_default()
    }
}

/// The settings, kept in [`SETTINGS_FILE`].
pub struct UpdateSettings {
    /// `None` without a data folder: the setting then lasts for the session.
    file: Option<PathBuf>,
    settings: Mutex<Settings>,
}

impl UpdateSettings {
    pub fn load(file: Option<PathBuf>) -> Self {
        let settings = file.as_deref().and_then(read).unwrap_or_default();
        UpdateSettings {
            file,
            settings: Mutex::new(settings),
        }
    }

    pub fn get(&self) -> Settings {
        *lock(&self.settings)
    }

    /// Turns the daily check on or off. Returns the new settings.
    pub fn set_check_automatically(&self, on: bool) -> Settings {
        self.update(|settings| settings.check_automatically = on)
    }

    /// Remembers that Folio checked at `now`. Returns the new settings.
    pub fn record_check(&self, now: SystemTime) -> Settings {
        self.update(|settings| settings.last_check = Some(now))
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) -> Settings {
        let mut settings = lock(&self.settings);
        // Another copy of Folio may have changed the other value meanwhile.
        if let Some(stored) = self.file.as_deref().and_then(read) {
            *settings = stored;
        }
        change(&mut settings);
        if let Some(file) = &self.file {
            // Losing the setting is not worth interrupting the user for.
            if let Some(folder) = file.parent() {
                let _ = paths::create_private_dir(folder);
            }
            let _ = paths::write_atomically(file, &settings.to_json());
        }
        *settings
    }
}

fn read(file: &std::path::Path) -> Option<Settings> {
    let bytes = paths::read_limited(file, MAX_SETTINGS_BYTES).ok()?;
    Some(Settings::parse(&bytes))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether the automatic check should run at `now`: the user turned it on,
/// and Folio has not checked for a day. A last check in the future means the
/// clock was turned back: a small step is waited out, but a large one (or a
/// clock that was far off when Folio checked) must not stop the checks for
/// good.
pub fn automatic_check_due(settings: &Settings, now: SystemTime) -> bool {
    if !settings.check_automatically {
        return false;
    }
    let Some(last) = settings.last_check else {
        return true;
    };
    match now.duration_since(last) {
        Ok(elapsed) => elapsed >= CHECK_INTERVAL,
        Err(ahead) => ahead.duration() > CHECK_INTERVAL,
    }
}

/// Whether the feed's `offered` version is an update for `current`: only a
/// newer version (build metadata does not count), and a pre-release only for
/// someone who runs one already, so a test build published by mistake does
/// not reach everyone.
pub fn is_update(current: &Version, offered: &Version) -> bool {
    offered.cmp_precedence(current).is_gt() && (offered.pre.is_empty() || !current.pre.is_empty())
}

/// The feed's release notes as plain text for a native dialog: line by line
/// without control or invisible characters (such as direction overrides),
/// without runs of blank lines, and cut to what a dialog can show. `None`
/// when nothing is left.
pub fn clean_notes(notes: &str) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut cut = false;
    for line in notes.lines() {
        // Cut below, as a whole, so that a cut is always marked.
        let line = save::clean_display_text(line, usize::MAX);
        // No blank lines at the start, nor two in a row.
        if line.is_empty() && lines.last().is_none_or(String::is_empty) {
            continue;
        }
        if lines.len() == MAX_NOTES_LINES {
            // Only more text is cut, not blank lines after the last line.
            if line.is_empty() {
                continue;
            }
            cut = true;
            break;
        }
        lines.push(line);
    }
    let text = lines.join("\n");
    let kept = save::truncate_to_bytes(text.trim_end(), MAX_NOTES_BYTES);
    let cut = cut || kept.len() < text.trim_end().len();
    let kept = kept.trim_end();
    match (kept.is_empty(), cut) {
        (true, _) => None,
        (false, true) => Some(format!("{kept}…")),
        (false, false) => Some(kept.to_owned()),
    }
}

/// Asks whether to install `offered`. The default button keeps the version
/// the user has.
pub fn update_question(current: &str, offered: &str, notes: Option<&str>) -> Question {
    let mut text = format!("You have {current}. Install it and restart Folio?");
    if let Some(notes) = notes.and_then(clean_notes) {
        text.push_str("\n\n");
        text.push_str(&notes);
    }
    Question {
        title: format!("Folio {offered} is available"),
        text,
        safe: "Not now",
        action: "Install and restart",
    }
}

pub fn up_to_date_notice(current: &str) -> Notice {
    Notice {
        level: Level::Info,
        title: "Folio is up to date".to_owned(),
        text: format!("Folio {current} is the newest version."),
    }
}

/// The user kept working when asked about unsaved changes.
pub fn not_updated_notice() -> Notice {
    Notice {
        level: Level::Info,
        title: "Folio was not updated".to_owned(),
        text: "Save your changes, then choose Check for Updates… again.".to_owned(),
    }
}

/// Where an update failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Check,
    Download,
    Install,
}

/// What went wrong, in words for the user. The plugin's own messages are
/// never shown: they can contain paths and addresses.
pub fn failure_notice(stage: Stage, error: &UpdaterError) -> Notice {
    let notice = |level, title: &str, text: String| Notice {
        level,
        title: title.to_owned(),
        text,
    };
    match error {
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => notice(
            Level::Error,
            "The update could not be verified",
            "Folio did not install it: it is not signed with Folio’s update key, or it \
             was changed on the way. Your copy of Folio was not changed."
                .to_owned(),
        ),
        UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_)
        | UpdaterError::UnsupportedArch
        | UpdaterError::UnsupportedOs => notice(
            Level::Warning,
            "Folio cannot update itself here",
            "A new version of Folio is available, but not as an update for this computer. \
             Download and install it yourself."
                .to_owned(),
        ),
        UpdaterError::PreviousAppNotRestored(kept) => notice(
            Level::Error,
            "Folio could not install the update",
            format!(
                "Folio could not put the previous version back either. It was kept as \
                 \u{201c}{}\u{201d}, next to where Folio was installed or in your home \
                 folder.",
                kept.file_name()
                    .map(|name| name.to_string_lossy())
                    .unwrap_or_default()
            ),
        ),
        _ => match stage {
            Stage::Check => notice(
                Level::Warning,
                "Folio could not check for updates",
                "Check your internet connection and try again later.".to_owned(),
            ),
            Stage::Download => notice(
                Level::Warning,
                "Folio could not download the update",
                "Check your internet connection and try again later.".to_owned(),
            ),
            Stage::Install => notice(
                Level::Error,
                "Folio could not install the update",
                "Your copy of Folio was not changed. Try again later, or download and \
                 install the new version yourself."
                    .to_owned(),
            ),
        },
    }
}

/// Set while a check, its questions or a download are under way, so that a
/// second click does not start another.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Clears [`RUNNING`] however the check ends.
struct Running;

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

/// What started a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trigger {
    /// Check for Updates…: also says when Folio is up to date, or why it
    /// could not check.
    Menu,
    /// The daily check: says nothing unless there is an update.
    Automatic,
}

/// A verified update, waiting until nothing unsaved is left.
struct Downloaded {
    update: Update,
    bytes: Vec<u8>,
}

/// The update state of the running app.
#[derive(Default)]
pub struct Updates {
    /// Check for Updates Automatically, which shows the setting.
    setting_item: Mutex<Option<CheckMenuItem<Wry>>>,
    downloaded: Mutex<Option<Downloaded>>,
}

impl Updates {
    /// Keeps the menu item that shows the setting.
    pub fn set_menu_item(&self, item: CheckMenuItem<Wry>) {
        *lock(&self.setting_item) = Some(item);
    }

    fn show_setting(&self, on: bool) {
        if let Some(item) = lock(&self.setting_item).as_ref() {
            let _ = item.set_checked(on);
        }
    }

    fn take_downloaded(&self) -> Option<Downloaded> {
        lock(&self.downloaded).take()
    }
}

/// Check for Updates….
pub fn check_now(app: &AppHandle) {
    start(app, Trigger::Menu);
}

/// Check for Updates Automatically: turns the daily check on or off. Turning
/// it on lets Folio check right away, unless it did within the last day.
pub fn toggle_automatic(app: &AppHandle) {
    let storage = app.state::<Storage>();
    let on = !storage.updates.get().check_automatically;
    let settings = storage.updates.set_check_automatically(on);
    app.state::<Updates>().show_setting(on);
    if automatic_check_due(&settings, SystemTime::now()) {
        start(app, Trigger::Automatic);
    }
}

/// At startup: the daily check, if the user turned it on and it is due.
pub fn check_if_due(app: &AppHandle) {
    let due = |app: &AppHandle| {
        automatic_check_due(&app.state::<Storage>().updates.get(), SystemTime::now())
    };
    if !due(app) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_DELAY);
        // The user may have turned it off, or checked, meanwhile.
        if due(&app) {
            start(&app, Trigger::Automatic);
        }
    });
}

/// The checks, questions and downloads run on their own thread, never on the
/// main thread that draws the dialogs.
fn start(app: &AppHandle, trigger: Trigger) {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _running = Running;
        run(&app, trigger);
    });
}

fn run(app: &AppHandle, trigger: Trigger) {
    let checked = check(app);
    // Recorded however it went: the daily rule is about how often Folio goes
    // online, not whether that worked.
    app.state::<Storage>()
        .updates
        .record_check(SystemTime::now());
    let mut update = match checked {
        Ok(Some(update)) => update,
        Ok(None) if trigger == Trigger::Menu => {
            let current = app.package_info().version.to_string();
            return connect::tell(app, &up_to_date_notice(&current));
        }
        Err(error) if trigger == Trigger::Menu => {
            return connect::tell(app, &failure_notice(Stage::Check, &error));
        }
        // The daily check stays quiet unless there is something to install.
        _ => return,
    };
    let question = update_question(
        &update.current_version,
        &update.version,
        update.body.as_deref(),
    );
    if !connect::ask(app, &question) {
        return;
    }
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    // The plugin verifies the signature before it returns the bytes.
    let bytes = match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
        Ok(bytes) => bytes,
        Err(error) => return connect::tell(app, &failure_notice(Stage::Download, &error)),
    };
    *lock(&app.state::<Updates>().downloaded) = Some(Downloaded { update, bytes });
    // Unsaved work is asked about first, as when quitting. The answer
    // installs the update (`install`) or keeps it from being installed
    // (`kept_working`).
    if !crate::hold_close(app, CloseIntent::Update) {
        install(app);
    }
}

fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    let updater = app
        .updater_builder()
        .version_comparator(|current, release| is_update(&current, &release.version))
        .timeout(CHECK_TIMEOUT)
        .build()?;
    tauri::async_runtime::block_on(updater.check())
}

/// Installs the downloaded update and restarts Folio, once nothing unsaved is
/// left. The window goes away first, so nothing new is typed into it. The
/// installation runs on its own thread: the confirmation arrives on the main
/// thread, which the plugin needs on macOS to ask for an administrator's
/// password.
pub fn install(app: &AppHandle) {
    let Some(Downloaded { update, bytes }) = app.state::<Updates>().take_downloaded() else {
        return;
    };
    if let Some(window) = crate::main_window(app) {
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || match update.install(&bytes) {
        // On Windows, the installer has taken over and Folio has quit by now.
        Ok(()) => app.request_restart(),
        Err(error) => {
            // The documents are still open, and the UI only reports changes
            // to unsaved work: closing asks it again (it answers at once when
            // nothing is unsaved).
            app.state::<CloseGuard>().set_enabled(true);
            crate::focus_main_window(&app);
            connect::tell(&app, &failure_notice(Stage::Install, &error));
        }
    });
}

/// The user kept working when asked about unsaved changes: the downloaded
/// update is not installed, and Folio says how to update later.
pub fn kept_working(app: &AppHandle) {
    if app.state::<Updates>().take_downloaded().is_some() {
        let app = app.clone();
        std::thread::spawn(move || connect::tell(&app, &not_updated_notice()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use std::time::UNIX_EPOCH;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    const HOUR: u64 = 60 * 60;
    const DAY: u64 = 24 * HOUR;

    #[test]
    fn automatic_checks_are_off_until_the_user_turns_them_on() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data").join(SETTINGS_FILE);
        let settings = UpdateSettings::load(Some(file.clone()));
        assert_eq!(settings.get(), Settings::default());
        assert!(!settings.get().check_automatically);
        // Nothing is written until something changes.
        assert!(!file.exists());
        assert!(!automatic_check_due(&settings.get(), SystemTime::now()));
        assert_eq!(UpdateSettings::load(None).get(), Settings::default());
    }

    #[test]
    fn persists_the_setting_and_the_last_check() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data").join(SETTINGS_FILE);
        let settings = UpdateSettings::load(Some(file.clone()));
        settings.set_check_automatically(true);
        let checked = at(1_700_000_000) + Duration::from_millis(123);
        settings.record_check(checked);
        let reloaded = UpdateSettings::load(Some(file.clone())).get();
        assert_eq!(
            reloaded,
            Settings {
                check_automatically: true,
                last_check: Some(checked),
            }
        );
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "checkAutomatically": true,
                "lastCheck": "2023-11-14T22:13:20.123Z"
            })
        );
        settings.set_check_automatically(false);
        assert!(!UpdateSettings::load(Some(file)).get().check_automatically);
        // Without a data folder, the setting lasts for the session.
        let session = UpdateSettings::load(None);
        assert!(session.set_check_automatically(true).check_automatically);
        assert!(session.get().check_automatically);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_settings_in_a_private_folder() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("data");
        UpdateSettings::load(Some(folder.join(SETTINGS_FILE))).set_check_automatically(true);
        let mode = std::fs::metadata(&folder).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn another_copys_change_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        let this = UpdateSettings::load(Some(file.clone()));
        let other = UpdateSettings::load(Some(file.clone()));
        other.set_check_automatically(true);
        // This copy records a check without turning the setting off again.
        let settings = this.record_check(at(DAY));
        assert!(settings.check_automatically);
        assert!(UpdateSettings::load(Some(file)).get().check_automatically);
    }

    #[test]
    fn a_damaged_settings_file_leaves_automatic_checks_off() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        for damaged in [
            &b"{ not json"[..],
            b"",
            b"null",
            b"true",
            br#"[true, "2026-01-01T00:00:00.000Z"]"#,
            br#"{"checkAutomatically": "true"}"#,
            br#"{"checkAutomatically": 1}"#,
            br#"{"checkAutomatically": false, "checkAutomatically": true}"#,
            br#"{"checkAutomatically": true, "lastCheck": 1700000000}"#,
            b"\xef\xbb\xbf{\"checkAutomatically\": true}",
        ] {
            std::fs::write(&file, damaged).unwrap();
            let settings = UpdateSettings::load(Some(file.clone())).get();
            assert!(
                !settings.check_automatically,
                "{}",
                String::from_utf8_lossy(damaged)
            );
        }
        // Too large to be Folio's.
        let mut large = br#"{"checkAutomatically": true, "x": ""#.to_vec();
        large.resize(MAX_SETTINGS_BYTES as usize + 1, b' ');
        large.extend_from_slice(br#""}"#);
        std::fs::write(&file, &large).unwrap();
        assert!(
            !UpdateSettings::load(Some(file.clone()))
                .get()
                .check_automatically
        );
        // Fields Folio does not know are ignored, like in `recent.json`; a
        // last check it cannot read counts as none.
        std::fs::write(
            &file,
            br#"{"checkAutomatically": true, "lastCheck": "yesterday", "theme": "dark"}"#,
        )
        .unwrap();
        assert_eq!(
            UpdateSettings::load(Some(file)).get(),
            Settings {
                check_automatically: true,
                last_check: None,
            }
        );
    }

    #[test]
    fn checks_at_most_once_a_day() {
        let on = |last_check: Option<u64>| Settings {
            check_automatically: true,
            last_check: last_check.map(at),
        };
        let now = 100 * DAY;
        assert!(automatic_check_due(&on(None), at(now)));
        assert!(!automatic_check_due(&on(Some(now)), at(now)));
        assert!(!automatic_check_due(&on(Some(now - DAY + 1)), at(now)));
        assert!(automatic_check_due(&on(Some(now - DAY)), at(now)));
        assert!(automatic_check_due(&on(Some(now - 30 * DAY)), at(now)));
        // The clock was turned back an hour: the check it did counts.
        assert!(!automatic_check_due(&on(Some(now + HOUR)), at(now)));
        // A check "in" a distant future does not stop checking for good.
        assert!(automatic_check_due(&on(Some(now + 2 * DAY)), at(now)));
        // Never while it is off.
        let off = Settings {
            check_automatically: false,
            last_check: None,
        };
        assert!(!automatic_check_due(&off, at(now)));
    }

    #[test]
    fn only_newer_versions_are_updates() {
        assert!(is_update(&version("0.2.0"), &version("0.3.0")));
        assert!(is_update(&version("0.2.0"), &version("0.2.1")));
        assert!(is_update(&version("0.9.9"), &version("1.0.0")));
        assert!(!is_update(&version("0.2.0"), &version("0.2.0")));
        assert!(!is_update(&version("0.3.0"), &version("0.2.9")));
        // Build metadata does not make a version newer.
        assert!(!is_update(&version("0.2.0+1"), &version("0.2.0+2")));
        // Pre-releases reach only those who run one.
        assert!(!is_update(&version("0.2.0"), &version("0.3.0-beta.1")));
        assert!(is_update(
            &version("0.3.0-beta.1"),
            &version("0.3.0-beta.2")
        ));
        assert!(is_update(&version("0.3.0-beta.2"), &version("0.3.0")));
        assert!(!is_update(
            &version("0.3.0-beta.2"),
            &version("0.3.0-beta.1")
        ));
    }

    #[test]
    fn announces_the_versions_and_keeps_the_current_one_by_default() {
        let question = update_question("0.2.0", "0.3.0", None);
        assert_eq!(question.title, "Folio 0.3.0 is available");
        assert_eq!(
            question.text,
            "You have 0.2.0. Install it and restart Folio?"
        );
        assert_eq!(
            (question.safe, question.action),
            ("Not now", "Install and restart")
        );
        let question = update_question("0.2.0", "0.3.0", Some("Forms and signatures.\n"));
        assert_eq!(
            question.text,
            "You have 0.2.0. Install it and restart Folio?\n\nForms and signatures."
        );
        // Notes that are only blank add nothing.
        let question = update_question("0.2.0", "0.3.0", Some(" \n\u{202E}\n"));
        assert_eq!(
            question.text,
            "You have 0.2.0. Install it and restart Folio?"
        );
    }

    #[test]
    fn shows_release_notes_as_short_plain_text() {
        assert_eq!(
            clean_notes("\r\n## What’s new\r\n\r\n\r\n- Forms\u{202E}\u{0}\n- Signatures \n\n"),
            Some("## What’s new\n\n- Forms\n- Signatures".to_owned())
        );
        assert_eq!(clean_notes(""), None);
        assert_eq!(clean_notes("\n\t\n"), None);
        // Long notes are cut, between characters, and say so.
        let long = clean_notes(&"é".repeat(2000)).unwrap();
        assert!(long.ends_with("é…"));
        assert!(long.len() <= MAX_NOTES_BYTES + '…'.len_utf8());
        let many: String = (1..=40).map(|line| format!("Line {line}\n")).collect();
        let cut = clean_notes(&many).unwrap();
        assert_eq!(cut.lines().count(), MAX_NOTES_LINES);
        assert!(cut.ends_with("Line 15…"));
        // Exactly the limit is not cut, nor are blank lines after it.
        let fifteen: String = (1..=15).map(|line| format!("Line {line}\n")).collect();
        assert!(clean_notes(&fifteen).unwrap().ends_with("Line 15"));
        assert!(clean_notes(&format!("{fifteen}\n \n\n"))
            .unwrap()
            .ends_with("Line 15"));
    }

    #[test]
    fn says_when_folio_is_up_to_date_or_was_not_updated() {
        let notice = up_to_date_notice("0.2.0");
        assert_eq!(notice.level, Level::Info);
        assert_eq!(notice.title, "Folio is up to date");
        assert_eq!(notice.text, "Folio 0.2.0 is the newest version.");
        assert!(not_updated_notice().text.contains("Check for Updates…"));
    }

    #[test]
    fn explains_failures_without_paths_or_addresses() {
        let io = || UpdaterError::Io(std::io::Error::other("/Applications/Folio.app: denied"));
        let cases = [
            (
                Stage::Check,
                UpdaterError::ReleaseNotFound,
                "could not check",
            ),
            (Stage::Check, io(), "could not check"),
            (
                Stage::Check,
                UpdaterError::TargetsNotFound(vec!["linux-x86_64-deb".into()]),
                "not as an update for this computer",
            ),
            (
                Stage::Download,
                UpdaterError::Network("https://example.com/Folio.tar.gz: 404".into()),
                "could not download",
            ),
            (
                Stage::Download,
                UpdaterError::MissingSignedVersion,
                "not signed",
            ),
            (
                Stage::Download,
                UpdaterError::SignedVersionMismatch {
                    signed: "0.2.0".into(),
                    announced: "0.3.0".into(),
                },
                "not signed",
            ),
            (Stage::Install, io(), "was not changed"),
            (
                Stage::Install,
                UpdaterError::PreviousAppNotRestored(PathBuf::from(
                    "/Users/alice/Folio (previous version).app",
                )),
                "\u{201c}Folio (previous version).app\u{201d}",
            ),
        ];
        for (stage, error, phrase) in cases {
            let notice = failure_notice(stage, &error);
            let words = format!("{} {}", notice.title, notice.text);
            assert!(words.contains(phrase), "{stage:?}: {words}");
            assert_ne!(notice.level, Level::Info);
            for text in [&notice.title, &notice.text] {
                assert!(!text.contains(['/', '\\']), "{text}");
                assert!(!text.contains("http"), "{text}");
            }
        }
    }

    fn config() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    #[test]
    fn the_feed_is_one_secure_address_and_releases_must_name_their_version() {
        let updater = &config()["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([
                "https://github.com/albird97/folio/releases/latest/download/latest.json"
            ])
        );
        assert_eq!(updater["requireSignedVersion"], true);
        // The plugin's defaults, which must stay off.
        for dangerous in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
            "allowDowngrades",
        ] {
            assert!(updater.get(dangerous).is_none(), "{dangerous}");
        }
    }

    /// The configured key must be a minisign public key: the base64 of its
    /// two-line text form, whose key line holds 42 bytes ("Ed", an 8-byte key
    /// id and a 32-byte Ed25519 key). The private key is never in the
    /// repository.
    #[test]
    fn the_public_key_is_a_minisign_key() {
        let engine = base64::engine::general_purpose::STANDARD;
        let pubkey = config()["plugins"]["updater"]["pubkey"]
            .as_str()
            .unwrap()
            .to_owned();
        let text = String::from_utf8(engine.decode(pubkey).unwrap()).unwrap();
        let mut lines = text.lines();
        assert!(lines
            .next()
            .unwrap()
            .starts_with("untrusted comment: minisign public key"));
        let key = engine.decode(lines.next().unwrap()).unwrap();
        assert_eq!(key.len(), 42);
        assert_eq!(&key[..2], b"Ed");
        assert!(!text.contains("secret key"));
    }

    #[test]
    fn only_release_builds_make_updater_artifacts() {
        // Normal builds need no private key.
        assert!(config()["bundle"].get("createUpdaterArtifacts").is_none());
        let release: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.release.conf.json")).unwrap();
        assert_eq!(release["bundle"]["createUpdaterArtifacts"], true);
    }

    #[test]
    fn the_webview_has_no_updater_or_process_permission() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        assert!(!permissions.is_empty());
        for permission in permissions {
            // A name, or an object naming it with a scope.
            let permission = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap();
            assert!(
                !permission.starts_with("updater:") && !permission.starts_with("process:"),
                "{permission}"
            );
        }
    }
}

/// The settings file may be damaged or edited, and the feed's text comes
/// from the network: neither turns automatic checks on, makes Folio check
/// more than once a day, nor puts anything but plain text in a dialog.
#[cfg(test)]
mod properties {
    use super::*;
    use crate::fuzz;
    use proptest::prelude::*;
    use serde_json::{json, Value};
    use std::time::UNIX_EPOCH;

    /// The last millisecond with a four-digit year.
    const LAST: u64 = 253_402_300_799_999;

    fn time() -> impl Strategy<Value = SystemTime> {
        (0..=LAST).prop_map(|millis| UNIX_EPOCH + Duration::from_millis(millis))
    }

    /// Settings files as Folio writes them, edited, or damaged.
    fn settings_file() -> impl Strategy<Value = Vec<u8>> {
        let check = prop_oneof![Just(json!(true)), Just(json!(false)), fuzz::json()];
        let last = prop::option::of(prop_oneof![
            time().prop_map(|time| json!(crate::time::iso8601(time))),
            fuzz::json(),
        ]);
        let others = prop::collection::vec((fuzz::text(), fuzz::json()), 0..2);
        let edited = (check, last, others).prop_map(|(check, last, others)| {
            let mut object: serde_json::Map<String, Value> = others.into_iter().collect();
            object.insert("checkAutomatically".into(), check);
            if let Some(last) = last {
                object.insert("lastCheck".into(), last);
            }
            serde_json::to_vec(&object).unwrap()
        });
        prop_oneof![3 => edited, 1 => fuzz::bytes()]
    }

    fn version() -> impl Strategy<Value = Version> {
        (
            0u64..3,
            0u64..3,
            0u64..3,
            prop::option::of("(alpha|beta|rc)\\.[0-9]"),
            prop::option::of("[0-9a-z]{1,4}"),
        )
            .prop_map(|(major, minor, patch, pre, build)| {
                let mut text = format!("{major}.{minor}.{patch}");
                if let Some(pre) = pre {
                    text = format!("{text}-{pre}");
                }
                if let Some(build) = build {
                    text = format!("{text}+{build}");
                }
                Version::parse(&text).unwrap()
            })
    }

    proptest! {
        #![proptest_config(fuzz::config(1024))]

        #[test]
        fn only_a_file_that_says_so_turns_checks_on(bytes in settings_file()) {
            let settings = Settings::parse(&bytes);
            if settings.check_automatically || settings.last_check.is_some() {
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                prop_assert_eq!(
                    value.get("checkAutomatically").map_or(Some(false), Value::as_bool),
                    Some(settings.check_automatically)
                );
                prop_assert_eq!(
                    value["lastCheck"].as_str().and_then(crate::time::parse_iso8601),
                    settings.last_check
                );
            }
        }

        #[test]
        fn settings_read_back_as_written(
            check_automatically in any::<bool>(),
            last_check in prop::option::of(time()),
        ) {
            let settings = Settings { check_automatically, last_check };
            prop_assert_eq!(Settings::parse(&settings.to_json()), settings);
        }

        #[test]
        fn checks_at_most_once_a_day(
            check_automatically in any::<bool>(),
            last in time(),
            since in 0..CHECK_INTERVAL.as_millis() as u64,
        ) {
            let settings = Settings { check_automatically, last_check: Some(last) };
            let since = Duration::from_millis(since);
            prop_assert!(!automatic_check_due(&settings, last + since));
            prop_assert_eq!(
                automatic_check_due(&settings, last + CHECK_INTERVAL + since),
                check_automatically
            );
        }

        #[test]
        fn release_notes_become_short_plain_text(
            lines in prop::collection::vec(fuzz::text(), 0..30),
            separator in prop::sample::select(vec!["\n", "\r\n", "\n\n", "\u{2028}"]),
        ) {
            if let Some(text) = clean_notes(&lines.join(separator)) {
                prop_assert!(text.lines().count() <= MAX_NOTES_LINES);
                prop_assert!(text.len() <= MAX_NOTES_BYTES + '…'.len_utf8());
                prop_assert!(!text.starts_with('\n') && !text.ends_with('\n'));
                prop_assert!(!text.contains("\n\n\n"));
                for line in text.lines() {
                    prop_assert_eq!(save::clean_display_text(line, usize::MAX), line);
                }
            }
        }

        #[test]
        fn only_newer_versions_are_updates(a in version(), b in version()) {
            prop_assert!(!is_update(&a, &a));
            prop_assert!(!(is_update(&a, &b) && is_update(&b, &a)));
            if is_update(&a, &b) {
                prop_assert!(b.cmp_precedence(&a).is_gt());
                prop_assert!(b.pre.is_empty() || !a.pre.is_empty());
            }
        }

        #[test]
        fn the_question_names_both_versions_and_keeps_by_default(
            current in version(),
            offered in version(),
            notes in prop::option::of(fuzz::text()),
        ) {
            let question = update_question(&current.to_string(), &offered.to_string(), notes.as_deref());
            prop_assert_eq!(question.title, format!("Folio {offered} is available"));
            let start = format!("You have {current}. Install it and restart Folio?");
            prop_assert!(question.text.starts_with(&start));
            prop_assert_eq!(question.safe, "Not now");
        }
    }
}
