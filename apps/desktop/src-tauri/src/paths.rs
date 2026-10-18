//! Where Folio keeps its own data (crash recovery, recent files, documents
//! received from the Chrome extension). The app and the native messaging
//! host, which runs without Tauri, must agree on it, so it is derived from
//! the bundle identifier exactly like Tauri's `app_data_dir`.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The bundle identifier from `tauri.conf.json` (a test keeps them in step).
pub const IDENTIFIER: &str = "io.github.albird97.folio";
/// Replaces the data directory, for tests. Only absolute paths are used.
pub const DATA_DIR_ENV: &str = "FOLIO_DATA_DIR";

/// `<data dir>/io.github.albird97.folio`: `~/Library/Application Support` on
/// macOS, `%APPDATA%` on Windows and `$XDG_DATA_HOME` (`~/.local/share`) on
/// Linux, unless [`DATA_DIR_ENV`] names another folder.
pub fn app_data_dir() -> Option<PathBuf> {
    resolve_data_dir(std::env::var_os(DATA_DIR_ENV), dirs::data_dir())
}

fn resolve_data_dir(overridden: Option<OsString>, system: Option<PathBuf>) -> Option<PathBuf> {
    match overridden.map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => Some(dir),
        _ => system.map(|dir| dir.join(IDENTIFIER)),
    }
}

/// Whether the data directory was replaced through [`DATA_DIR_ENV`].
pub fn data_dir_is_overridden() -> bool {
    std::env::var_os(DATA_DIR_ENV).is_some_and(|dir| Path::new(&dir).is_absolute())
}

/// Creates `dir` and any missing parents. On Unix, the folders Folio creates
/// can only be entered by the user.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Writes one of Folio's own data files through a temporary file in the same
/// folder and a rename, so readers never see a partly written file. The
/// temporary file starts with a dot, which no valid record name does.
pub fn write_atomically(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let directory = target
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent folder"))?;
    let temporary = directory.join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

/// Reads one of Folio's own files, refusing anything larger than `limit`.
pub fn read_limited(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file too large",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file too large",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_matches_the_bundle_configuration() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }

    #[test]
    fn data_dir_is_the_identifier_inside_the_system_data_dir() {
        let system = PathBuf::from("/home/alice/.local/share");
        assert_eq!(
            resolve_data_dir(None, Some(system.clone())),
            Some(system.join(IDENTIFIER))
        );
        assert_eq!(resolve_data_dir(None, None), None);
    }

    #[test]
    fn an_absolute_override_replaces_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let system = Some(PathBuf::from("/home/alice/.local/share"));
        assert_eq!(
            resolve_data_dir(Some(dir.path().into()), system.clone()),
            Some(dir.path().to_path_buf())
        );
        // Relative overrides would depend on the working directory (Chrome
        // decides it for the native messaging host), so they are ignored.
        assert_eq!(
            resolve_data_dir(Some("relative/dir".into()), system.clone()),
            system.map(|dir| dir.join(IDENTIFIER))
        );
    }

    #[test]
    fn writes_data_files_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("recent.json");
        write_atomically(&target, b"[1]").unwrap();
        write_atomically(&target, b"[2]").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"[2]");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("recent.json")]);
        assert!(write_atomically(&dir.path().join("missing").join("x"), b"x").is_err());
    }

    #[test]
    fn reads_only_within_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data");
        std::fs::write(&path, b"12345").unwrap();
        assert_eq!(read_limited(&path, 5).unwrap(), b"12345");
        assert!(read_limited(&path, 4).is_err());
        assert_eq!(
            read_limited(&dir.path().join("missing"), 5)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn creates_private_folders() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        create_private_dir(&nested).unwrap();
        create_private_dir(&nested).unwrap();
        for folder in [dir.path().join("a"), nested] {
            let mode = std::fs::metadata(folder).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }
}
