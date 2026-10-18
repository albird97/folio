//! Registers the desktop binary as Chrome's native messaging host
//! `io.github.albird97.folio`. Chrome finds the host through a manifest file:
//!
//! - macOS: `~/Library/Application Support/{Google/Chrome,Chromium}/NativeMessagingHosts/`
//! - Linux: `~/.config/{google-chrome,chromium}/NativeMessagingHosts/`
//! - Windows: a manifest in Folio's data directory, named by the default value
//!   of `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio`
//!
//! The official Folio extension is always allowed; other extension ids are
//! only added after the user confirms them in a native dialog. Folio keeps
//! its own record of them in its data folder, and the host only answers
//! extensions from that record (Chrome's manifests can be edited by anyone
//! who can write to the browser's folder, so they are not trusted).
//!
//! Only the registration state and extension ids reach the webview, never
//! the manifest locations or the executable path.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "io.github.albird97.folio";
pub const MANIFEST_FILE: &str = "io.github.albird97.folio.json";
/// The official Folio extension, whose development key gives it this id.
/// A Chrome Web Store release must replace it with the id the store assigns.
pub const OFFICIAL_EXTENSION_IDS: &[&str] = &["ghfckfnleaidabfhaplbnfknipajedan"];
const DESCRIPTION: &str = "Folio desktop app: opens PDFs sent from the Folio Chrome extension.";
/// Folio's record of the other extensions the user allowed.
const RECORD_FILE: &str = "native-messaging.json";
const MAX_EXTRA_EXTENSIONS: usize = 16;
const MAX_FILE_BYTES: u64 = 64 * 1024;
const ORIGIN_PREFIX: &str = "chrome-extension://";
#[cfg(windows)]
const REGISTRY_KEY: &str = r"Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio";

/// Chrome extension ids: 32 letters from `a` to `p`.
pub fn is_valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn is_official(id: &str) -> bool {
    OFFICIAL_EXTENSION_IDS.contains(&id)
}

fn origin(id: &str) -> String {
    format!("{ORIGIN_PREFIX}{id}/")
}

/// The extension id in a caller origin, which must be exactly
/// `chrome-extension://<id>/`.
pub fn extension_id_from_origin(origin: &str) -> Option<&str> {
    origin
        .strip_prefix(ORIGIN_PREFIX)?
        .strip_suffix('/')
        .filter(|id| is_valid_extension_id(id))
}

/// The host manifest Chrome reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    #[serde(rename = "type")]
    pub kind: String,
    pub allowed_origins: Vec<String>,
}

impl Manifest {
    pub fn new(exe: &Path, extension_ids: &[String]) -> Self {
        Manifest {
            name: HOST_NAME.to_owned(),
            description: DESCRIPTION.to_owned(),
            path: exe.to_path_buf(),
            kind: "stdio".to_owned(),
            allowed_origins: extension_ids.iter().map(|id| origin(id)).collect(),
        }
    }

    /// The extension ids the manifest allows.
    pub fn extension_ids(&self) -> Vec<String> {
        self.allowed_origins
            .iter()
            .filter_map(|origin| extension_id_from_origin(origin).map(str::to_owned))
            .collect()
    }

    fn belongs_to(&self, exe: &Path) -> bool {
        self.name == HOST_NAME && same_file(&self.path, exe)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    extension_ids: Vec<String>,
}

fn record_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RECORD_FILE)
}

/// The other extensions the user allowed, from Folio's own record.
pub fn registered_extension_ids(data_dir: &Path) -> Vec<String> {
    let record: Record = paths::read_limited(&record_path(data_dir), MAX_FILE_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut ids: Vec<String> = Vec::new();
    for id in record.extension_ids {
        if is_valid_extension_id(&id) && !is_official(&id) && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.truncate(MAX_EXTRA_EXTENSIONS);
    ids
}

/// The extensions the host answers: the official one and those the user
/// allowed.
pub fn allowed_extension_ids(data_dir: Option<&Path>) -> Vec<String> {
    let mut ids: Vec<String> = OFFICIAL_EXTENSION_IDS
        .iter()
        .map(|id| (*id).to_owned())
        .collect();
    if let Some(data_dir) = data_dir {
        ids.extend(registered_extension_ids(data_dir));
    }
    ids
}

/// `native_messaging_status` in the frontend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Chrome would start this copy of Folio.
    pub registered: bool,
    /// Extensions that can reach it (the official one first).
    pub extension_ids: Vec<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistrationError {
    #[error("Enter the ID of the extension: 32 letters from a to p.")]
    InvalidExtensionId,
    #[error("Folio can allow at most 16 other extensions.")]
    InvalidRequest,
    #[error("Chrome integration is not available on this computer.")]
    Unavailable,
    #[error("Move Folio to the Applications folder, open it from there and try again.")]
    Translocated,
    #[error("Chrome or Chromium was not found for this user. Open it once, then try again.")]
    BrowserNotFound,
    #[error("Chrome integration was not changed.")]
    Cancelled,
    #[error("Folio could not register itself with Chrome.")]
    Failed,
}

impl RegistrationError {
    pub fn code(&self) -> &'static str {
        match self {
            RegistrationError::InvalidExtensionId => "invalid-extension-id",
            RegistrationError::InvalidRequest => "invalid-request",
            RegistrationError::Unavailable => "unavailable",
            RegistrationError::Translocated => "app-translocated",
            RegistrationError::BrowserNotFound => "browser-not-found",
            RegistrationError::Cancelled => "cancelled",
            RegistrationError::Failed => "registration-failed",
        }
    }
}

/// Where this platform's browsers look for the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locations {
    pub manifests: Vec<PathBuf>,
    /// Windows: the `HKEY_CURRENT_USER` key whose default value names the
    /// (first) manifest.
    pub registry_key: Option<String>,
    /// macOS and Linux: a manifest is only written for a browser whose
    /// folder exists (`<browser>/NativeMessagingHosts/<manifest>`), so
    /// nothing is created for browsers that are not installed.
    pub browser_folders: bool,
}

#[cfg(not(windows))]
fn browser_locations(base: &Path, browsers: &[&str]) -> Locations {
    Locations {
        manifests: browsers
            .iter()
            .map(|browser| {
                base.join(browser)
                    .join("NativeMessagingHosts")
                    .join(MANIFEST_FILE)
            })
            .collect(),
        registry_key: None,
        browser_folders: true,
    }
}

#[cfg(target_os = "macos")]
pub fn locations() -> Option<Locations> {
    // `~/Library/Application Support`
    let base = dirs::data_dir()?;
    Some(browser_locations(&base, &["Google/Chrome", "Chromium"]))
}

#[cfg(target_os = "linux")]
pub fn locations() -> Option<Locations> {
    // `$XDG_CONFIG_HOME`, `~/.config` by default
    let base = dirs::config_dir()?;
    Some(browser_locations(&base, &["google-chrome", "chromium"]))
}

#[cfg(windows)]
pub fn locations() -> Option<Locations> {
    let manifest = paths::app_data_dir()?
        .join("native-messaging")
        .join(MANIFEST_FILE);
    Some(Locations {
        manifests: vec![manifest],
        registry_key: Some(REGISTRY_KEY.to_owned()),
        browser_folders: false,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn locations() -> Option<Locations> {
    None
}

/// The manifests to write: for installed browsers only, where that matters.
fn manifest_targets(locations: &Locations) -> Vec<&PathBuf> {
    locations
        .manifests
        .iter()
        .filter(|path| {
            !locations.browser_folders
                || path
                    .parent()
                    .and_then(Path::parent)
                    .is_some_and(Path::is_dir)
        })
        .collect()
}

fn read_manifest(path: &Path) -> Option<Manifest> {
    let bytes = paths::read_limited(path, MAX_FILE_BYTES).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Validates and de-duplicates the other extension ids to allow, keeping
/// their order. The official extension is always allowed, so it is left out.
pub fn clean_extension_ids(ids: &[String]) -> Result<Vec<String>, RegistrationError> {
    let mut cleaned: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim();
        if !is_valid_extension_id(id) {
            return Err(RegistrationError::InvalidExtensionId);
        }
        if !is_official(id) && !cleaned.iter().any(|known| known == id) {
            cleaned.push(id.to_owned());
        }
    }
    if cleaned.len() > MAX_EXTRA_EXTENSIONS {
        return Err(RegistrationError::InvalidRequest);
    }
    Ok(cleaned)
}

/// Refuses registrations that could not work, before the user is asked.
pub fn check_can_register(locations: &Locations, exe: &Path) -> Result<(), RegistrationError> {
    if paths::is_translocated(exe) {
        return Err(RegistrationError::Translocated);
    }
    if manifest_targets(locations).is_empty() {
        return Err(RegistrationError::BrowserNotFound);
    }
    Ok(())
}

/// The title and text of the native confirmation dialog.
pub fn confirmation_text(extra_ids: &[String]) -> (String, String) {
    let official = OFFICIAL_EXTENSION_IDS.join(", ");
    if extra_ids.is_empty() {
        return (
            "Allow the Folio extension to send documents?".to_owned(),
            format!(
                "The Folio extension for Chrome will be able to send PDF documents \
                 to this copy of Folio. Folio asks you before it opens each one.\n\n\
                 Extension ID: {official}"
            ),
        );
    }
    let others = extra_ids
        .iter()
        .map(|id| format!("• {id}"))
        .collect::<Vec<_>>()
        .join("\n");
    (
        "Allow these Chrome extensions to send documents?".to_owned(),
        format!(
            "These Chrome extensions will be able to send PDF documents to this \
             copy of Folio. Folio asks you before it opens each one. Only allow \
             extensions you trust.\n\n\
             The Folio extension: {official}\n\nOther extensions:\n{others}"
        ),
    )
}

/// Whether Chrome would start `exe`, and for which allowed extensions.
pub fn status(locations: &Locations, exe: &Path, data_dir: Option<&Path>) -> Status {
    let allowed = allowed_extension_ids(data_dir);
    let mut status = Status::default();
    for (index, path) in locations.manifests.iter().enumerate() {
        let Some(manifest) = read_manifest(path) else {
            continue;
        };
        let reachable = match &locations.registry_key {
            // Chrome reads the manifest the registry names.
            Some(key) => {
                index == 0 && registry::get(key).is_some_and(|named| same_file(&named, path))
            }
            None => true,
        };
        if !reachable || !manifest.belongs_to(exe) {
            continue;
        }
        status.registered = true;
        for id in manifest.extension_ids() {
            if allowed.contains(&id) && !status.extension_ids.contains(&id) {
                status.extension_ids.push(id);
            }
        }
    }
    status.extension_ids.sort_by_key(|id| !is_official(id));
    status
}

/// Writes Folio's record, the manifests (for installed browsers) and on
/// Windows the registry value, so Chrome starts `exe` for the official
/// extension and `extra_ids`. Call only after the user confirmed.
pub fn register(
    locations: &Locations,
    exe: &Path,
    data_dir: &Path,
    extra_ids: &[String],
) -> Result<(), RegistrationError> {
    let extra_ids = clean_extension_ids(extra_ids)?;
    check_can_register(locations, exe)?;
    let record = serde_json::to_vec_pretty(&Record {
        extension_ids: extra_ids.clone(),
    })
    .map_err(|_| RegistrationError::Failed)?;
    paths::prepare_data_dir(data_dir).map_err(|_| RegistrationError::Failed)?;
    paths::write_atomically(&record_path(data_dir), &record)
        .map_err(|_| RegistrationError::Failed)?;

    let mut ids: Vec<String> = OFFICIAL_EXTENSION_IDS
        .iter()
        .map(|id| (*id).to_owned())
        .collect();
    ids.extend(extra_ids);
    let manifest = serde_json::to_vec_pretty(&Manifest::new(exe, &ids))
        .map_err(|_| RegistrationError::Failed)?;
    for path in manifest_targets(locations) {
        let folder = path.parent().ok_or(RegistrationError::Failed)?;
        paths::create_private_dir(folder).map_err(|_| RegistrationError::Failed)?;
        paths::write_atomically(path, &manifest).map_err(|_| RegistrationError::Failed)?;
    }
    if let Some(key) = &locations.registry_key {
        registry::set(key, &locations.manifests[0]).map_err(|_| RegistrationError::Failed)?;
    }
    Ok(())
}

/// Removes what this copy of Folio registered: manifests that point to
/// `exe`, the registry value when it names such a manifest, and Folio's
/// record. Registrations of other copies are left alone.
pub fn unregister(
    locations: &Locations,
    exe: &Path,
    data_dir: Option<&Path>,
) -> Result<(), RegistrationError> {
    let mut failed = false;
    let mut removed_any = false;
    for (index, path) in locations.manifests.iter().enumerate() {
        if !read_manifest(path).is_some_and(|manifest| manifest.belongs_to(exe)) {
            continue;
        }
        if let (0, Some(key)) = (index, &locations.registry_key) {
            if registry::get(key).is_some_and(|named| same_file(&named, path)) {
                failed |= registry::remove(key).is_err();
            }
        }
        match std::fs::remove_file(path) {
            Ok(()) => removed_any = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed = true,
        }
    }
    if removed_any {
        if let Some(data_dir) = data_dir {
            match std::fs::remove_file(record_path(data_dir)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => failed = true,
            }
        }
    }
    if failed {
        Err(RegistrationError::Failed)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
mod registry {
    use std::io;
    use std::path::{Path, PathBuf};
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    pub fn set(key: &str, manifest: &Path) -> io::Result<()> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(key)?;
        key.set_value("", &manifest.as_os_str())
    }

    pub fn get(key: &str) -> Option<PathBuf> {
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(key).ok()?;
        key.get_value::<std::ffi::OsString, _>("")
            .ok()
            .map(PathBuf::from)
    }

    pub fn remove(key: &str) -> io::Result<()> {
        match RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(key) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}

/// Only Windows has a registry; other platforms never set a registry key.
#[cfg(not(windows))]
mod registry {
    use std::io;
    use std::path::{Path, PathBuf};

    pub fn set(_key: &str, _manifest: &Path) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }

    pub fn get(_key: &str) -> Option<PathBuf> {
        None
    }

    pub fn remove(_key: &str) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFICIAL: &str = "ghfckfnleaidabfhaplbnfknipajedan";
    const EXTENSION: &str = "abcdefghijklmnopabcdefghijklmnop";
    const OTHER: &str = "ppppppppppppppppaaaaaaaaaaaaaaaa";

    struct Setup {
        dir: tempfile::TempDir,
        locations: Locations,
        exe: PathBuf,
        data: PathBuf,
    }

    /// Chrome is installed (its folder exists), Chromium is not.
    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("google-chrome")).unwrap();
        let locations = Locations {
            manifests: ["google-chrome", "chromium"]
                .iter()
                .map(|browser| {
                    dir.path()
                        .join(browser)
                        .join("NativeMessagingHosts")
                        .join(MANIFEST_FILE)
                })
                .collect(),
            registry_key: None,
            browser_folders: true,
        };
        let exe = dir.path().join("folio-desktop");
        std::fs::write(&exe, b"").unwrap();
        let data = dir.path().join("data");
        Setup {
            dir,
            locations,
            exe,
            data,
        }
    }

    #[test]
    fn validates_extension_ids_and_origins() {
        assert!(is_valid_extension_id(EXTENSION));
        assert!(OFFICIAL_EXTENSION_IDS
            .iter()
            .all(|id| is_valid_extension_id(id)));
        assert!(!is_valid_extension_id(&EXTENSION.to_uppercase()));
        assert!(!is_valid_extension_id("abcdefghijklmnopabcdefghijklmnoq"));
        assert!(!is_valid_extension_id("abc"));
        assert!(!is_valid_extension_id(&format!("{EXTENSION}a")));
        assert_eq!(
            extension_id_from_origin(&format!("chrome-extension://{EXTENSION}/")),
            Some(EXTENSION)
        );
        for origin in [
            format!("chrome-extension://{EXTENSION}"),
            format!("chrome-extension://{EXTENSION}//"),
            format!("chrome-extension://{EXTENSION}/x"),
            format!("Chrome-Extension://{EXTENSION}/"),
            format!("moz-extension://{EXTENSION}/"),
            "chrome-extension://../".to_owned(),
        ] {
            assert_eq!(extension_id_from_origin(&origin), None, "{origin}");
        }
        assert_eq!(
            clean_extension_ids(&[EXTENSION.into(), format!(" {EXTENSION} "), OTHER.into()]),
            Ok(vec![EXTENSION.to_owned(), OTHER.to_owned()])
        );
        // The official extension needs no extra entry.
        assert_eq!(clean_extension_ids(&[OFFICIAL.into()]), Ok(vec![]));
        assert_eq!(clean_extension_ids(&[]), Ok(vec![]));
        assert_eq!(
            clean_extension_ids(&["chrome-extension://abc/".into()]),
            Err(RegistrationError::InvalidExtensionId)
        );
        let many: Vec<String> = (0..17u8)
            .map(|index| {
                let (high, low) = ((b'a' + index / 16) as char, (b'a' + index % 16) as char);
                format!("{}{high}{low}", "a".repeat(30))
            })
            .collect();
        assert!(many.iter().all(|id| is_valid_extension_id(id)));
        assert_eq!(
            clean_extension_ids(&many),
            Err(RegistrationError::InvalidRequest)
        );
    }

    #[test]
    fn writes_the_manifest_chrome_expects() {
        let manifest = Manifest::new(
            Path::new("/Applications/Folio.app/Contents/MacOS/folio-desktop"),
            &[OFFICIAL.to_owned(), OTHER.to_owned()],
        );
        assert_eq!(
            serde_json::to_value(&manifest).unwrap(),
            serde_json::json!({
                "name": "io.github.albird97.folio",
                "description": DESCRIPTION,
                "path": "/Applications/Folio.app/Contents/MacOS/folio-desktop",
                "type": "stdio",
                "allowed_origins": [
                    "chrome-extension://ghfckfnleaidabfhaplbnfknipajedan/",
                    "chrome-extension://ppppppppppppppppaaaaaaaaaaaaaaaa/"
                ]
            })
        );
        assert_eq!(manifest.extension_ids(), [OFFICIAL, OTHER]);
        // The host name is the one the host answers to.
        assert_eq!(HOST_NAME, crate::paths::IDENTIFIER);
    }

    #[test]
    fn registers_for_installed_browsers_and_unregisters() {
        let setup = setup();
        let (locations, exe, data) = (&setup.locations, &setup.exe, &setup.data);
        assert_eq!(status(locations, exe, Some(data)), Status::default());

        register(locations, exe, data, &[]).unwrap();
        let chrome = &locations.manifests[0];
        let manifest = read_manifest(chrome).unwrap();
        assert_eq!(&manifest.path, exe);
        assert_eq!(manifest.allowed_origins, [origin(OFFICIAL)]);
        // Nothing is created for Chromium, which is not installed.
        assert!(!setup.dir.path().join("chromium").exists());
        assert_eq!(
            status(locations, exe, Some(data)),
            Status {
                registered: true,
                extension_ids: vec![OFFICIAL.to_owned()]
            }
        );

        // Other extensions are added to Folio's record and the manifest.
        register(locations, exe, data, &[EXTENSION.to_owned()]).unwrap();
        assert_eq!(registered_extension_ids(data), [EXTENSION]);
        assert_eq!(
            allowed_extension_ids(Some(data)),
            [OFFICIAL.to_owned(), EXTENSION.to_owned()]
        );
        assert_eq!(
            status(locations, exe, Some(data)).extension_ids,
            [OFFICIAL, EXTENSION]
        );

        unregister(locations, exe, Some(data)).unwrap();
        unregister(locations, exe, Some(data)).unwrap();
        assert!(!chrome.exists());
        assert!(registered_extension_ids(data).is_empty());
        assert_eq!(status(locations, exe, Some(data)), Status::default());
    }

    #[test]
    fn only_allows_extensions_from_folios_own_record() {
        let setup = setup();
        let (locations, exe, data) = (&setup.locations, &setup.exe, &setup.data);
        register(locations, exe, data, &[]).unwrap();
        // Someone adds an extension to Chrome's manifest behind Folio's back.
        let chrome = &locations.manifests[0];
        let edited = Manifest::new(exe, &[OFFICIAL.to_owned(), OTHER.to_owned()]);
        std::fs::write(chrome, serde_json::to_vec(&edited).unwrap()).unwrap();
        assert_eq!(status(locations, exe, Some(data)).extension_ids, [OFFICIAL]);
        assert_eq!(allowed_extension_ids(Some(data)), [OFFICIAL]);
        // A damaged record allows the official extension only.
        std::fs::write(data.join(RECORD_FILE), b"{").unwrap();
        assert_eq!(allowed_extension_ids(Some(data)), [OFFICIAL]);
        assert_eq!(allowed_extension_ids(None), [OFFICIAL]);
    }

    #[test]
    fn leaves_other_copies_registrations_alone() {
        let setup = setup();
        let (locations, data) = (&setup.locations, &setup.data);
        let elsewhere = setup.dir.path().join("old-folio");
        register(locations, &elsewhere, data, &[]).unwrap();
        assert!(!status(locations, &setup.exe, Some(data)).registered);
        unregister(locations, &setup.exe, Some(data)).unwrap();
        assert!(locations.manifests[0].exists());
    }

    #[test]
    fn refuses_registrations_that_cannot_work() {
        let setup = setup();
        let (locations, exe, data) = (&setup.locations, &setup.exe, &setup.data);
        assert_eq!(
            register(locations, exe, data, &["nope".to_owned()]),
            Err(RegistrationError::InvalidExtensionId)
        );
        let translocated = Path::new(
            "/private/var/folders/x/T/AppTranslocation/ABC/d/Folio.app/Contents/MacOS/folio-desktop",
        );
        assert_eq!(
            check_can_register(locations, translocated),
            Err(RegistrationError::Translocated)
        );
        std::fs::remove_dir(setup.dir.path().join("google-chrome")).unwrap();
        assert_eq!(
            register(locations, exe, data, &[]),
            Err(RegistrationError::BrowserNotFound)
        );
        assert!(locations.manifests.iter().all(|path| !path.exists()));
        assert!(!data.join(RECORD_FILE).exists());
    }

    #[test]
    fn ignores_damaged_manifests() {
        let setup = setup();
        let first = &setup.locations.manifests[0];
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::write(first, b"{").unwrap();
        assert_eq!(
            status(&setup.locations, &setup.exe, Some(&setup.data)),
            Status::default()
        );
    }

    #[test]
    fn the_confirmation_names_every_extension() {
        let (title, text) = confirmation_text(&[]);
        assert!(title.contains("Folio extension"));
        assert!(text.contains(OFFICIAL));
        assert!(text.contains("asks you before it opens"));
        let (title, text) = confirmation_text(&[EXTENSION.to_owned(), OTHER.to_owned()]);
        assert!(title.contains("these Chrome extensions"));
        for id in [OFFICIAL, EXTENSION, OTHER] {
            assert!(text.contains(id), "{id}");
        }
        assert!(text.contains("Only allow extensions you trust"));
    }

    #[cfg(not(windows))]
    #[test]
    fn manifests_go_where_the_browsers_look() {
        let locations = browser_locations(
            Path::new("/home/alice/.config"),
            &["google-chrome", "chromium"],
        );
        assert_eq!(
            locations.manifests,
            [
                PathBuf::from(
                    "/home/alice/.config/google-chrome/NativeMessagingHosts/io.github.albird97.folio.json"
                ),
                PathBuf::from(
                    "/home/alice/.config/chromium/NativeMessagingHosts/io.github.albird97.folio.json"
                ),
            ]
        );
        assert_eq!(locations.registry_key, None);
        assert!(locations.browser_folders);
    }
}
