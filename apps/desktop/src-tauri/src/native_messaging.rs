//! Registers the desktop binary as Chrome's native messaging host
//! `io.github.albird97.folio` for the official Folio extension. Chrome finds
//! the host through a manifest file:
//!
//! - macOS: `~/Library/Application Support/{Google/Chrome,Chromium}/NativeMessagingHosts/`
//! - Linux: `~/.config/{google-chrome,chromium}/NativeMessagingHosts/`
//! - Windows: a manifest in Folio's data directory, named by the default value
//!   of `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio`
//!
//! Registering and unregistering only happen natively, through File ▸
//! Connect to Chrome… (see `connect`); the webview can at most read the
//! status. The host answers [`OFFICIAL_EXTENSION_IDS`] and nothing else,
//! whatever a manifest says (anyone who can write to the browser's folder
//! can edit those).
//!
//! Only the registration state and extension ids reach the webview, never
//! the manifest locations or the executable path.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "io.github.albird97.folio";
pub const MANIFEST_FILE: &str = "io.github.albird97.folio.json";
/// The extensions the host answers and registration allows, as Chrome
/// reports them in the caller's origin.
///
/// This is the development id: the public key in the extension's manifest
/// gives it this id, and so would any unpacked extension that carries the
/// same public key. Replace it with the id the Chrome Web Store assigns
/// before publishing. Whichever extension connects, Folio still asks the
/// user before it opens each document it receives.
pub const OFFICIAL_EXTENSION_IDS: &[&str] = &["ghfckfnleaidabfhaplbnfknipajedan"];
const DESCRIPTION: &str = "Folio desktop app: opens PDFs sent from the Folio Chrome extension.";
const MAX_FILE_BYTES: u64 = 64 * 1024;
const ORIGIN_PREFIX: &str = "chrome-extension://";
#[cfg(windows)]
const REGISTRY_KEY: &str = r"Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio";

/// Chrome extension ids: 32 letters from `a` to `p`.
pub fn is_valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

/// Whether the host answers this extension.
pub fn is_official(id: &str) -> bool {
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
    pub fn new(exe: &Path, extension_ids: &[&str]) -> Self {
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

/// `native_messaging_status` in the frontend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Chrome would start this copy of Folio.
    pub registered: bool,
    /// Official extensions that can reach it.
    pub extension_ids: Vec<String>,
    /// The browsers that would start it (for Folio's own dialogs).
    #[serde(skip)]
    pub browsers: Vec<&'static str>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistrationError {
    #[error("Chrome integration is not available on this computer.")]
    Unavailable,
    #[error("Move Folio to the Applications folder, open it from there and try again.")]
    Translocated,
    #[error("Folio is in a place other users or apps could change, or that may go away. Move it to Applications, Program Files or a folder only you can change, open it from there and try again.")]
    UnsafeLocation,
    #[error("Chrome or Chromium was not found for this user. Open it once, then try again.")]
    BrowserNotFound,
    #[error("Folio could not change its registration with Chrome.")]
    Failed,
}

impl RegistrationError {
    pub fn code(&self) -> &'static str {
        match self {
            RegistrationError::Unavailable => "unavailable",
            RegistrationError::Translocated => "app-translocated",
            RegistrationError::UnsafeLocation => "unsafe-location",
            RegistrationError::BrowserNotFound => "browser-not-found",
            RegistrationError::Failed => "registration-failed",
        }
    }
}

/// Where one browser looks for the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Browser {
    /// For display: "Google Chrome", "Chromium".
    pub name: &'static str,
    pub manifest: PathBuf,
}

/// Where this platform's browsers look for the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locations {
    pub browsers: Vec<Browser>,
    /// Windows: the `HKEY_CURRENT_USER` key whose default value names the
    /// (first) manifest.
    pub registry_key: Option<String>,
    /// macOS and Linux: a manifest is only written for a browser whose
    /// folder exists (`<browser>/NativeMessagingHosts/<manifest>`), so
    /// nothing is created for browsers that are not installed.
    pub browser_folders: bool,
}

/// `(name, folder)` pairs below `base`.
#[cfg(not(windows))]
fn browser_locations(base: &Path, browsers: &[(&'static str, &str)]) -> Locations {
    Locations {
        browsers: browsers
            .iter()
            .map(|(name, folder)| Browser {
                name,
                manifest: base
                    .join(folder)
                    .join("NativeMessagingHosts")
                    .join(MANIFEST_FILE),
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
    Some(browser_locations(
        &base,
        &[("Google Chrome", "Google/Chrome"), ("Chromium", "Chromium")],
    ))
}

#[cfg(target_os = "linux")]
pub fn locations() -> Option<Locations> {
    // `$XDG_CONFIG_HOME`, `~/.config` by default
    let base = dirs::config_dir()?;
    Some(browser_locations(
        &base,
        &[("Google Chrome", "google-chrome"), ("Chromium", "chromium")],
    ))
}

#[cfg(windows)]
pub fn locations() -> Option<Locations> {
    let manifest = paths::app_data_dir()?
        .join("native-messaging")
        .join(MANIFEST_FILE);
    Some(Locations {
        browsers: vec![Browser {
            name: "Google Chrome",
            manifest,
        }],
        registry_key: Some(REGISTRY_KEY.to_owned()),
        browser_folders: false,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn locations() -> Option<Locations> {
    None
}

/// The browsers to write manifests for: installed ones, where that matters.
fn installed(locations: &Locations) -> Vec<&Browser> {
    locations
        .browsers
        .iter()
        .filter(|browser| {
            !locations.browser_folders
                || browser
                    .manifest
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

/// Refuses registrations that could not work or would not be safe (see
/// [`paths::safe_location`]), before the user is asked.
pub fn check_can_register(locations: &Locations, exe: &Path) -> Result<(), RegistrationError> {
    check(locations, exe, paths::safe_location).map(drop)
}

/// The path to register for `exe`: the one `safe_location` checked.
fn check(
    locations: &Locations,
    exe: &Path,
    safe_location: fn(&Path) -> Option<PathBuf>,
) -> Result<PathBuf, RegistrationError> {
    if paths::is_translocated(exe) {
        return Err(RegistrationError::Translocated);
    }
    let checked = safe_location(exe).ok_or(RegistrationError::UnsafeLocation)?;
    if installed(locations).is_empty() {
        return Err(RegistrationError::BrowserNotFound);
    }
    Ok(checked)
}

/// Whether Chrome would start `exe`, from which browsers and for which
/// official extensions.
pub fn status(locations: &Locations, exe: &Path) -> Status {
    let mut status = Status::default();
    for (index, browser) in locations.browsers.iter().enumerate() {
        let Some(manifest) = read_manifest(&browser.manifest) else {
            continue;
        };
        let reachable = match &locations.registry_key {
            // Chrome reads the manifest the registry names.
            Some(key) => {
                index == 0
                    && registry::get(key).is_some_and(|named| same_file(&named, &browser.manifest))
            }
            None => true,
        };
        if !reachable || !manifest.belongs_to(exe) {
            continue;
        }
        status.registered = true;
        status.browsers.push(browser.name);
        for id in manifest.extension_ids() {
            if is_official(&id) && !status.extension_ids.contains(&id) {
                status.extension_ids.push(id);
            }
        }
    }
    status
}

/// Writes the manifests (for installed browsers) and on Windows the registry
/// value, so Chrome starts `exe` for the official extension. The manifests
/// name the canonical path that was checked, not `exe` as given, so a link
/// on the way cannot be changed afterwards to point somewhere else. Returns
/// the browsers it was registered with. Call only after the user agreed.
pub fn register(locations: &Locations, exe: &Path) -> Result<Vec<&'static str>, RegistrationError> {
    register_checked(locations, exe, paths::safe_location)
}

fn register_checked(
    locations: &Locations,
    exe: &Path,
    safe_location: fn(&Path) -> Option<PathBuf>,
) -> Result<Vec<&'static str>, RegistrationError> {
    let checked = check(locations, exe, safe_location)?;
    let manifest = serde_json::to_vec_pretty(&Manifest::new(&checked, OFFICIAL_EXTENSION_IDS))
        .map_err(|_| RegistrationError::Failed)?;
    let mut browsers = Vec::new();
    for browser in installed(locations) {
        let folder = browser.manifest.parent().ok_or(RegistrationError::Failed)?;
        paths::create_private_dir(folder).map_err(|_| RegistrationError::Failed)?;
        paths::write_atomically(&browser.manifest, &manifest)
            .map_err(|_| RegistrationError::Failed)?;
        browsers.push(browser.name);
    }
    if let (Some(key), Some(first)) = (&locations.registry_key, locations.browsers.first()) {
        registry::set(key, &first.manifest).map_err(|_| RegistrationError::Failed)?;
    }
    Ok(browsers)
}

/// Removes what this copy of Folio registered: manifests that point to
/// `exe` and the registry value when it names such a manifest.
/// Registrations of other copies are left alone.
pub fn unregister(locations: &Locations, exe: &Path) -> Result<(), RegistrationError> {
    let mut failed = false;
    for (index, browser) in locations.browsers.iter().enumerate() {
        let path = &browser.manifest;
        if !read_manifest(path).is_some_and(|manifest| manifest.belongs_to(exe)) {
            continue;
        }
        if let (0, Some(key)) = (index, &locations.registry_key) {
            if registry::get(key).is_some_and(|named| same_file(&named, path)) {
                failed |= registry::remove(key).is_err();
            }
        }
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed = true,
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
    }

    /// Chrome is installed (its folder exists), Chromium is not.
    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("google-chrome")).unwrap();
        let locations = Locations {
            browsers: [("Google Chrome", "google-chrome"), ("Chromium", "chromium")]
                .iter()
                .map(|(name, folder)| Browser {
                    name,
                    manifest: dir
                        .path()
                        .join(folder)
                        .join("NativeMessagingHosts")
                        .join(MANIFEST_FILE),
                })
                .collect(),
            registry_key: None,
            browser_folders: true,
        };
        let exe = dir.path().join("folio-desktop");
        std::fs::write(&exe, b"").unwrap();
        Setup {
            dir,
            locations,
            exe,
        }
    }

    impl Setup {
        fn manifest(&self, index: usize) -> &Path {
            &self.locations.browsers[index].manifest
        }
    }

    /// The test executables live in a temporary folder, which is not a safe
    /// location; these tests are about the manifests.
    fn register(locations: &Locations, exe: &Path) -> Result<Vec<&'static str>, RegistrationError> {
        register_checked(locations, exe, |exe| Some(exe.to_path_buf()))
    }

    #[test]
    fn validates_extension_ids_and_origins() {
        assert!(is_valid_extension_id(EXTENSION));
        assert!(OFFICIAL_EXTENSION_IDS
            .iter()
            .all(|id| is_valid_extension_id(id)));
        assert!(is_official(OFFICIAL));
        assert!(!is_official(EXTENSION));
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
    }

    #[test]
    fn writes_the_manifest_chrome_expects() {
        let manifest = Manifest::new(
            Path::new("/Applications/Folio.app/Contents/MacOS/folio-desktop"),
            OFFICIAL_EXTENSION_IDS,
        );
        assert_eq!(
            serde_json::to_value(&manifest).unwrap(),
            serde_json::json!({
                "name": "io.github.albird97.folio",
                "description": DESCRIPTION,
                "path": "/Applications/Folio.app/Contents/MacOS/folio-desktop",
                "type": "stdio",
                "allowed_origins": ["chrome-extension://ghfckfnleaidabfhaplbnfknipajedan/"]
            })
        );
        assert_eq!(manifest.extension_ids(), [OFFICIAL]);
        // The host name is the one the host answers to.
        assert_eq!(HOST_NAME, crate::paths::IDENTIFIER);
    }

    #[test]
    fn registers_the_official_extension_for_installed_browsers_and_unregisters() {
        let setup = setup();
        let (locations, exe) = (&setup.locations, &setup.exe);
        assert_eq!(status(locations, exe), Status::default());

        assert_eq!(register(locations, exe), Ok(vec!["Google Chrome"]));
        let manifest = read_manifest(setup.manifest(0)).unwrap();
        assert_eq!(&manifest.path, exe);
        assert_eq!(manifest.allowed_origins, [origin(OFFICIAL)]);
        // Nothing is created for Chromium, which is not installed.
        assert!(!setup.dir.path().join("chromium").exists());
        assert_eq!(
            status(locations, exe),
            Status {
                registered: true,
                extension_ids: vec![OFFICIAL.to_owned()],
                browsers: vec!["Google Chrome"],
            }
        );
        // The browsers are Folio's own business, not the page's.
        assert_eq!(
            serde_json::to_value(status(locations, exe)).unwrap(),
            serde_json::json!({ "registered": true, "extensionIds": [OFFICIAL] })
        );

        // Both browsers once Chromium is installed too.
        std::fs::create_dir(setup.dir.path().join("chromium")).unwrap();
        assert_eq!(
            register(locations, exe),
            Ok(vec!["Google Chrome", "Chromium"])
        );
        assert_eq!(
            status(locations, exe).browsers,
            ["Google Chrome", "Chromium"]
        );

        unregister(locations, exe).unwrap();
        unregister(locations, exe).unwrap();
        assert!(!setup.manifest(0).exists() && !setup.manifest(1).exists());
        assert_eq!(status(locations, exe), Status::default());
    }

    #[test]
    fn only_reports_official_extensions() {
        let setup = setup();
        let (locations, exe) = (&setup.locations, &setup.exe);
        register(locations, exe).unwrap();
        // Someone adds an extension to Chrome's manifest behind Folio's back.
        let edited = Manifest::new(exe, &[OFFICIAL, OTHER]);
        std::fs::write(setup.manifest(0), serde_json::to_vec(&edited).unwrap()).unwrap();
        assert_eq!(status(locations, exe).extension_ids, [OFFICIAL]);
        // Registering again writes the official extension only.
        register(locations, exe).unwrap();
        assert_eq!(
            read_manifest(setup.manifest(0)).unwrap().extension_ids(),
            [OFFICIAL]
        );
    }

    #[test]
    fn registers_the_path_that_was_checked() {
        let setup = setup();
        let (locations, exe) = (&setup.locations, &setup.exe);
        // Started through a link; the check resolved it.
        let link = setup.dir.path().join("folio-link");
        register_checked(locations, &link, |_| {
            Some(PathBuf::from("/opt/Folio/folio-desktop"))
        })
        .unwrap();
        assert_eq!(
            read_manifest(setup.manifest(0)).unwrap().path,
            Path::new("/opt/Folio/folio-desktop")
        );
        assert_eq!(
            register_checked(locations, exe, |_| None),
            Err(RegistrationError::UnsafeLocation)
        );
    }

    #[test]
    fn leaves_other_copies_registrations_alone() {
        let setup = setup();
        let locations = &setup.locations;
        let elsewhere = setup.dir.path().join("old-folio");
        register(locations, &elsewhere).unwrap();
        assert!(!status(locations, &setup.exe).registered);
        unregister(locations, &setup.exe).unwrap();
        assert!(setup.manifest(0).exists());
    }

    #[test]
    fn refuses_registrations_that_cannot_work() {
        let setup = setup();
        let (locations, exe) = (&setup.locations, &setup.exe);
        let translocated = Path::new(
            "/private/var/folders/x/T/AppTranslocation/ABC/d/Folio.app/Contents/MacOS/folio-desktop",
        );
        assert_eq!(
            check_can_register(locations, translocated),
            Err(RegistrationError::Translocated)
        );
        assert_eq!(
            register(locations, translocated),
            Err(RegistrationError::Translocated)
        );
        // A copy in the temporary folder (where `exe` is) is refused before
        // anything is written, also when registering directly.
        assert_eq!(
            check_can_register(locations, exe),
            Err(RegistrationError::UnsafeLocation)
        );
        assert_eq!(
            super::register(locations, exe),
            Err(RegistrationError::UnsafeLocation)
        );
        assert_eq!(
            check(locations, exe, |_| None),
            Err(RegistrationError::UnsafeLocation)
        );
        assert!(!setup.manifest(0).exists());
        std::fs::remove_dir(setup.dir.path().join("google-chrome")).unwrap();
        assert_eq!(
            check(locations, exe, |exe| Some(exe.to_path_buf())),
            Err(RegistrationError::BrowserNotFound)
        );
        assert_eq!(
            register(locations, exe),
            Err(RegistrationError::BrowserNotFound)
        );
        assert!(locations
            .browsers
            .iter()
            .all(|browser| !browser.manifest.exists()));
    }

    #[test]
    fn ignores_damaged_manifests() {
        let setup = setup();
        let first = setup.manifest(0);
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::write(first, b"{").unwrap();
        assert_eq!(status(&setup.locations, &setup.exe), Status::default());
    }

    #[cfg(not(windows))]
    #[test]
    fn manifests_go_where_the_browsers_look() {
        let locations = browser_locations(
            Path::new("/home/alice/.config"),
            &[("Google Chrome", "google-chrome"), ("Chromium", "chromium")],
        );
        assert_eq!(
            locations.browsers,
            [
                Browser {
                    name: "Google Chrome",
                    manifest: PathBuf::from(
                        "/home/alice/.config/google-chrome/NativeMessagingHosts/io.github.albird97.folio.json"
                    ),
                },
                Browser {
                    name: "Chromium",
                    manifest: PathBuf::from(
                        "/home/alice/.config/chromium/NativeMessagingHosts/io.github.albird97.folio.json"
                    ),
                },
            ]
        );
        assert_eq!(locations.registry_key, None);
        assert!(locations.browser_folders);
    }
}

/// Extension ids, origins and manifests from anywhere: only the official
/// extension is ever reported, and only another copy's registration is left
/// alone.
#[cfg(test)]
mod properties {
    use super::*;
    use crate::fuzz;
    use proptest::prelude::*;
    use serde_json::{json, Value};

    fn id_like() -> impl Strategy<Value = String> {
        prop_oneof![
            Just(OFFICIAL_EXTENSION_IDS[0].to_owned()),
            "[a-p]{32}",
            "[a-q]{31,33}",
            "[A-Pa-p]{32}",
            fuzz::text(),
        ]
    }

    /// What a manifest file holds: a manifest, as Folio writes it or as
    /// someone may have edited it (`path: None` names this copy of Folio),
    /// or anything else.
    #[derive(Debug, Clone)]
    enum Content {
        Manifest {
            name: String,
            path: Option<String>,
            origins: Vec<String>,
        },
        Junk(Vec<u8>),
    }

    impl Content {
        fn bytes(&self, exe: &Path) -> Vec<u8> {
            match self {
                Content::Manifest {
                    name,
                    path,
                    origins,
                } => serde_json::to_vec(&json!({
                    "name": name,
                    "description": DESCRIPTION,
                    "path": path.clone().map_or_else(|| json!(exe), Value::from),
                    "type": "stdio",
                    "allowed_origins": origins,
                }))
                .unwrap(),
                Content::Junk(bytes) => bytes.clone(),
            }
        }
    }

    fn content() -> impl Strategy<Value = Content> {
        let name = prop_oneof![3 => Just(HOST_NAME.to_owned()), 1 => fuzz::text()];
        let path = prop_oneof![3 => Just(None), 1 => fuzz::text().prop_map(Some)];
        let origins = prop::collection::vec(
            prop_oneof![id_like().prop_map(|id| origin(&id)), fuzz::text()],
            0..4,
        );
        prop_oneof![
            3 => (name, path, origins).prop_map(|(name, path, origins)| Content::Manifest {
                name,
                path,
                origins,
            }),
            1 => fuzz::bytes().prop_map(Content::Junk),
        ]
    }

    proptest! {
        #![proptest_config(fuzz::config(1024))]

        #[test]
        fn extension_ids_are_32_letters_from_a_to_p(id in id_like()) {
            let letters = id.bytes().all(|byte| (b'a'..=b'p').contains(&byte));
            prop_assert_eq!(is_valid_extension_id(&id), id.len() == 32 && letters);
            prop_assert_eq!(is_official(&id), id == OFFICIAL_EXTENSION_IDS[0]);
        }

        #[test]
        fn origins_name_exactly_one_valid_id(
            prefix in prop_oneof![3 => Just(ORIGIN_PREFIX.to_owned()), 1 => fuzz::text()],
            id in id_like(),
            suffix in prop_oneof![3 => Just("/".to_owned()), 1 => fuzz::text()],
        ) {
            let text = format!("{prefix}{id}{suffix}");
            match extension_id_from_origin(&text) {
                Some(found) => {
                    prop_assert!(is_valid_extension_id(found));
                    prop_assert_eq!(origin(found), text.clone());
                }
                None => prop_assert!(
                    !(prefix == ORIGIN_PREFIX && suffix == "/" && is_valid_extension_id(&id))
                ),
            }
        }
    }

    /// Chrome's folder with this copy of Folio in it.
    fn setup() -> (tempfile::TempDir, Locations, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir
            .path()
            .join("google-chrome")
            .join("NativeMessagingHosts")
            .join(MANIFEST_FILE);
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        let locations = Locations {
            browsers: vec![Browser {
                name: "Google Chrome",
                manifest,
            }],
            registry_key: None,
            browser_folders: true,
        };
        let exe = dir.path().join("folio-desktop");
        std::fs::write(&exe, b"").unwrap();
        (dir, locations, exe)
    }

    proptest! {
        #![proptest_config(fuzz::config(128))]

        /// Anyone who can write to Chrome's folder can change the manifest:
        /// Folio still reports only the official extension, only for a
        /// manifest that starts this copy, and removes nothing else.
        #[test]
        fn trusts_no_manifest_beyond_the_official_extension(content in content()) {
            let (_dir, locations, exe) = setup();
            let path = &locations.browsers[0].manifest;
            let content = content.bytes(&exe);
            std::fs::write(path, &content).unwrap();
            let status = status(&locations, &exe);
            prop_assert!(status.extension_ids.iter().all(|id| is_official(id)));
            let ours = serde_json::from_slice::<Manifest>(&content).is_ok_and(|manifest| {
                manifest.name == HOST_NAME && same_file(&manifest.path, &exe)
            });
            prop_assert_eq!(status.registered, ours);
            if !status.registered {
                prop_assert!(status.extension_ids.is_empty());
            }
            // Disconnecting removes only a manifest of this copy's.
            unregister(&locations, &exe).unwrap();
            prop_assert_eq!(path.exists(), !ours);
        }
    }
}
