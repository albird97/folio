//! Where Folio keeps its own data (crash recovery, recent files, documents
//! received from the Chrome extension). The app and the native messaging
//! host, which runs without Tauri, must agree on it, so it is derived from
//! the bundle identifier exactly like Tauri's `app_local_data_dir`.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The bundle identifier from `tauri.conf.json` (a test keeps them in step).
pub const IDENTIFIER: &str = "io.github.albird97.folio";
/// Replaces the data directory, for tests. Only absolute paths are used.
pub const DATA_DIR_ENV: &str = "FOLIO_DATA_DIR";

/// `<local data dir>/io.github.albird97.folio`: `~/Library/Application
/// Support` on macOS, `%LOCALAPPDATA%` on Windows (recovery data and
/// documents from Chrome must not roam with the profile) and
/// `$XDG_DATA_HOME` (`~/.local/share`) on Linux, unless [`DATA_DIR_ENV`]
/// names another folder.
pub fn app_data_dir() -> Option<PathBuf> {
    resolve_data_dir(std::env::var_os(DATA_DIR_ENV), dirs::data_local_dir())
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

/// Creates Folio's data folder if needed and, on Unix, makes sure only the
/// user can enter it, also when it already existed with looser permissions.
pub fn prepare_data_dir(dir: &Path) -> std::io::Result<()> {
    create_private_dir(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Space available to the user on the volume holding `path`, if the system
/// says.
#[cfg(unix)]
pub fn available_space(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: `path` is NUL-terminated and `stats` is valid for writes.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statvfs succeeded, so it filled in `stats`.
    let stats = unsafe { stats.assume_init() };
    #[allow(clippy::useless_conversion)] // The field types differ between systems.
    let available = u64::from(stats.f_bavail).saturating_mul(u64::from(stats.f_frsize));
    Some(available)
}

/// Space available to the user on the volume holding `path`, if the system
/// says.
#[cfg(windows)]
pub fn available_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated; the other outputs are optional.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(available)
}

/// The program to register with Chrome and to start: the AppImage when Folio
/// runs from one (its own executable lives in a temporary mount), otherwise
/// the executable itself.
pub fn executable() -> std::io::Result<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        if appimage.is_absolute() && appimage.is_file() {
            return Ok(appimage);
        }
    }
    std::env::current_exe()
}

/// macOS runs apps opened from their download location from a randomized,
/// read-only copy ("App Translocation") that disappears later, so nothing
/// may point to it.
pub fn is_translocated(executable: &Path) -> bool {
    executable.to_string_lossy().contains("/AppTranslocation/")
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

    #[cfg(unix)]
    #[test]
    fn tightens_an_existing_data_folder() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir(&data).unwrap();
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare_data_dir(&data).unwrap();
        let mode = std::fs::metadata(&data).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn reports_free_space() {
        let dir = tempfile::tempdir().unwrap();
        assert!(available_space(dir.path()).is_some_and(|free| free > 0));
        assert_eq!(available_space(&dir.path().join("missing")), None);
    }

    #[test]
    fn recognizes_translocated_apps() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/x/AppTranslocation/1234/d/Folio.app/Contents/MacOS/folio-desktop"
        )));
        assert!(!is_translocated(Path::new(
            "/Applications/Folio.app/Contents/MacOS/folio-desktop"
        )));
        assert!(executable().unwrap().is_absolute());
    }
}
