//! Registers the desktop binary as Chrome's native messaging host
//! `io.github.albird97.folio` for the Folio extension ids the user enters in
//! the desktop settings. Chrome finds the host through a manifest file:
//!
//! - macOS: `~/Library/Application Support/{Google/Chrome,Chromium}/NativeMessagingHosts/`
//! - Linux: `~/.config/{google-chrome,chromium}/NativeMessagingHosts/`
//! - Windows: a manifest in Folio's data directory, named by the default value
//!   of `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio`
//!
//! Only the registration state and extension ids reach the webview, never
//! the manifest locations or the executable path.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "io.github.albird97.folio";
pub const MANIFEST_FILE: &str = "io.github.albird97.folio.json";
const DESCRIPTION: &str = "Folio desktop app: opens PDFs sent from the Folio Chrome extension.";
const MAX_EXTENSIONS: usize = 16;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
#[cfg(windows)]
const REGISTRY_KEY: &str = r"Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio";

/// Chrome extension ids: 32 letters from `a` to `p`.
pub fn is_valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn origin(id: &str) -> String {
    format!("chrome-extension://{id}/")
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
            .filter_map(|origin| {
                origin
                    .strip_prefix("chrome-extension://")?
                    .strip_suffix('/')
                    .filter(|id| is_valid_extension_id(id))
                    .map(str::to_owned)
            })
            .collect()
    }
}

/// `native_messaging_status` in the frontend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Chrome would start this copy of Folio.
    pub registered: bool,
    pub extension_ids: Vec<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistrationError {
    #[error("Enter the ID of the Folio extension: 32 letters from a to p.")]
    InvalidExtensionId,
    #[error("Enter at least one and at most 16 extension IDs.")]
    InvalidRequest,
    #[error("Chrome integration is not available on this computer.")]
    Unavailable,
    #[error("Folio could not register itself with Chrome.")]
    Failed,
}

impl RegistrationError {
    pub fn code(&self) -> &'static str {
        match self {
            RegistrationError::InvalidExtensionId => "invalid-extension-id",
            RegistrationError::InvalidRequest => "invalid-request",
            RegistrationError::Unavailable => "unavailable",
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
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn locations() -> Option<Locations> {
    None
}

fn read_manifest(path: &Path) -> Option<Manifest> {
    let bytes = paths::read_limited(path, MAX_MANIFEST_BYTES).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Validates and de-duplicates extension ids, keeping their order.
pub fn clean_extension_ids(ids: &[String]) -> Result<Vec<String>, RegistrationError> {
    let mut cleaned: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim();
        if !is_valid_extension_id(id) {
            return Err(RegistrationError::InvalidExtensionId);
        }
        if !cleaned.iter().any(|known| known == id) {
            cleaned.push(id.to_owned());
        }
    }
    if cleaned.is_empty() || cleaned.len() > MAX_EXTENSIONS {
        return Err(RegistrationError::InvalidRequest);
    }
    Ok(cleaned)
}

/// Whether Chrome would start `exe` for the extensions in the manifests.
pub fn status(locations: &Locations, exe: &Path) -> Status {
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
        if !reachable || manifest.name != HOST_NAME || !same_file(&manifest.path, exe) {
            continue;
        }
        status.registered = true;
        for id in manifest.extension_ids() {
            if !status.extension_ids.contains(&id) {
                status.extension_ids.push(id);
            }
        }
    }
    status
}

/// Writes the manifests (and on Windows the registry value) so Chrome starts
/// `exe` for the given extensions.
pub fn register(
    locations: &Locations,
    exe: &Path,
    extension_ids: &[String],
) -> Result<(), RegistrationError> {
    let ids = clean_extension_ids(extension_ids)?;
    let manifest = serde_json::to_vec_pretty(&Manifest::new(exe, &ids))
        .map_err(|_| RegistrationError::Failed)?;
    if locations.manifests.is_empty() {
        return Err(RegistrationError::Unavailable);
    }
    for path in &locations.manifests {
        let folder = path.parent().ok_or(RegistrationError::Failed)?;
        paths::create_private_dir(folder).map_err(|_| RegistrationError::Failed)?;
        paths::write_atomically(path, &manifest).map_err(|_| RegistrationError::Failed)?;
    }
    if let Some(key) = &locations.registry_key {
        registry::set(key, &locations.manifests[0]).map_err(|_| RegistrationError::Failed)?;
    }
    Ok(())
}

/// Removes the manifests and the registry value.
pub fn unregister(locations: &Locations) -> Result<(), RegistrationError> {
    let mut failed = false;
    for path in &locations.manifests {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed = true,
        }
    }
    if let Some(key) = &locations.registry_key {
        failed |= registry::remove(key).is_err();
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

    const EXTENSION: &str = "abcdefghijklmnopabcdefghijklmnop";
    const OTHER: &str = "ppppppppppppppppaaaaaaaaaaaaaaaa";

    fn temp_locations(dir: &Path) -> Locations {
        Locations {
            manifests: vec![
                dir.join("chrome").join(MANIFEST_FILE),
                dir.join("chromium").join(MANIFEST_FILE),
            ],
            registry_key: None,
        }
    }

    fn exe(dir: &Path) -> PathBuf {
        let exe = dir.join("folio-desktop");
        std::fs::write(&exe, b"").unwrap();
        exe
    }

    #[test]
    fn validates_extension_ids() {
        assert!(is_valid_extension_id(EXTENSION));
        assert!(!is_valid_extension_id(&EXTENSION.to_uppercase()));
        assert!(!is_valid_extension_id("abcdefghijklmnopabcdefghijklmnoq"));
        assert!(!is_valid_extension_id("abc"));
        assert!(!is_valid_extension_id(&format!("{EXTENSION}a")));
        assert!(!is_valid_extension_id("../../../../../../../../../../.."));
        assert_eq!(
            clean_extension_ids(&[EXTENSION.into(), format!(" {EXTENSION} "), OTHER.into()]),
            Ok(vec![EXTENSION.to_owned(), OTHER.to_owned()])
        );
        assert_eq!(
            clean_extension_ids(&[]),
            Err(RegistrationError::InvalidRequest)
        );
        assert_eq!(
            clean_extension_ids(&["chrome-extension://abc/".into()]),
            Err(RegistrationError::InvalidExtensionId)
        );
    }

    #[test]
    fn writes_the_manifest_chrome_expects() {
        let manifest = Manifest::new(
            Path::new("/Applications/Folio.app/Contents/MacOS/folio-desktop"),
            &[EXTENSION.to_owned(), OTHER.to_owned()],
        );
        assert_eq!(
            serde_json::to_value(&manifest).unwrap(),
            serde_json::json!({
                "name": "io.github.albird97.folio",
                "description": DESCRIPTION,
                "path": "/Applications/Folio.app/Contents/MacOS/folio-desktop",
                "type": "stdio",
                "allowed_origins": [
                    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
                    "chrome-extension://ppppppppppppppppaaaaaaaaaaaaaaaa/"
                ]
            })
        );
        assert_eq!(manifest.extension_ids(), [EXTENSION, OTHER]);
        // The host name is the one the host answers to.
        assert_eq!(HOST_NAME, crate::paths::IDENTIFIER);
    }

    #[test]
    fn registers_and_unregisters() {
        let dir = tempfile::tempdir().unwrap();
        let locations = temp_locations(dir.path());
        let exe = exe(dir.path());
        assert_eq!(status(&locations, &exe), Status::default());

        register(&locations, &exe, &[EXTENSION.to_owned()]).unwrap();
        for path in &locations.manifests {
            let manifest = read_manifest(path).unwrap();
            assert_eq!(manifest.path, exe);
            assert_eq!(manifest.allowed_origins, [origin(EXTENSION)]);
        }
        assert_eq!(
            status(&locations, &exe),
            Status {
                registered: true,
                extension_ids: vec![EXTENSION.to_owned()]
            }
        );

        // Registering again replaces the extension list.
        register(&locations, &exe, &[OTHER.to_owned()]).unwrap();
        assert_eq!(status(&locations, &exe).extension_ids, [OTHER]);

        unregister(&locations).unwrap();
        unregister(&locations).unwrap();
        assert!(locations.manifests.iter().all(|path| !path.exists()));
        assert_eq!(status(&locations, &exe), Status::default());
    }

    #[test]
    fn another_copy_of_folio_is_not_this_registration() {
        let dir = tempfile::tempdir().unwrap();
        let locations = temp_locations(dir.path());
        let elsewhere = dir.path().join("old-folio");
        register(&locations, &elsewhere, &[EXTENSION.to_owned()]).unwrap();
        assert!(!status(&locations, &exe(dir.path())).registered);
    }

    #[test]
    fn refuses_invalid_ids_without_writing_anything() {
        let dir = tempfile::tempdir().unwrap();
        let locations = temp_locations(dir.path());
        assert_eq!(
            register(&locations, &exe(dir.path()), &["nope".to_owned()]),
            Err(RegistrationError::InvalidExtensionId)
        );
        assert!(locations.manifests.iter().all(|path| !path.exists()));
    }

    #[test]
    fn ignores_damaged_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let locations = temp_locations(dir.path());
        let first = &locations.manifests[0];
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::write(first, b"{").unwrap();
        assert_eq!(status(&locations, &exe(dir.path())), Status::default());
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
                PathBuf::from("/home/alice/.config/google-chrome/NativeMessagingHosts/io.github.albird97.folio.json"),
                PathBuf::from("/home/alice/.config/chromium/NativeMessagingHosts/io.github.albird97.folio.json"),
            ]
        );
        assert_eq!(locations.registry_key, None);
    }
}
