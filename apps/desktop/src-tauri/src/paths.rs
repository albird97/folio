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
    let current = std::env::current_exe()?;
    #[cfg(target_os = "linux")]
    if let Some(appimage) = appimage_for(
        &current,
        std::env::var_os("APPIMAGE"),
        std::env::var_os("APPDIR"),
    ) {
        return Ok(appimage);
    }
    Ok(current)
}

/// `$APPIMAGE`, but only when Folio really runs from that AppImage: its
/// runtime mounts the image at `$APPDIR`, which then holds the running
/// executable. Otherwise the variables were inherited or set by someone
/// else, and naming them to Chrome would start another program.
#[cfg(any(target_os = "linux", test))]
fn appimage_for(
    current: &Path,
    appimage: Option<OsString>,
    appdir: Option<OsString>,
) -> Option<PathBuf> {
    let (appimage, appdir) = (PathBuf::from(appimage?), PathBuf::from(appdir?));
    if !appimage.is_absolute() || !appdir.is_absolute() || !appimage.is_file() {
        return None;
    }
    let current = std::fs::canonicalize(current).ok()?;
    let appdir = std::fs::canonicalize(appdir).ok()?;
    current.starts_with(&appdir).then_some(appimage)
}

/// macOS runs apps opened from their download location from a randomized,
/// read-only copy ("App Translocation") that disappears later, so nothing
/// may point to it.
pub fn is_translocated(executable: &Path) -> bool {
    executable.to_string_lossy().contains("/AppTranslocation/")
}

/// Whether Chrome should not be told to start `executable`: someone else
/// could replace it, or it may disappear. That is the case when it or a
/// folder above it is writable by others or sticky (shared folders such as
/// `/tmp`), when it is in the temporary folder, and when it lives on a
/// temporary or removable volume (disk images and external drives on
/// macOS). Windows only checks the temporary folder.
pub fn is_unsafe_location(executable: &Path) -> bool {
    let Ok(path) = std::fs::canonicalize(executable) else {
        return true;
    };
    let temporary = std::fs::canonicalize(std::env::temp_dir());
    if temporary.is_ok_and(|temporary| path.starts_with(temporary)) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // The path is canonical, so these are the real folders above it.
        for ancestor in path.ancestors() {
            match std::fs::metadata(ancestor) {
                Ok(metadata) if !is_shared_mode(metadata.mode()) => {}
                _ => return true,
            }
        }
        if on_removable_or_temporary_volume(&path) {
            return true;
        }
    }
    false
}

/// Writable by others, or sticky: other users can put files there.
#[cfg(unix)]
fn is_shared_mode(mode: u32) -> bool {
    mode & 0o002 != 0 || mode & 0o1000 != 0
}

#[cfg(target_os = "linux")]
fn on_removable_or_temporary_volume(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    const TMPFS_MAGIC: i64 = 0x0102_1994;
    const RAMFS_MAGIC: i64 = 0x8584_58f6;
    // Where desktops mount USB drives and SD cards.
    if path.starts_with("/media") || path.starts_with("/run/media") {
        return true;
    }
    let Ok(name) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return true;
    };
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::zeroed();
    // SAFETY: `name` is NUL-terminated and `stats` is valid for writes.
    if unsafe { libc::statfs(name.as_ptr(), stats.as_mut_ptr()) } == 0 {
        // SAFETY: statfs succeeded, so it filled in `stats`.
        let stats = unsafe { stats.assume_init() };
        #[allow(clippy::unnecessary_cast)] // The field type differs between systems.
        let kind = stats.f_type as i64;
        if kind == TMPFS_MAGIC || kind == RAMFS_MAGIC {
            return true;
        }
    }
    std::fs::metadata(path).is_ok_and(|metadata| is_removable_device(metadata.dev()))
}

/// Whether the block device (or the disk a partition is on) says it is
/// removable.
#[cfg(target_os = "linux")]
fn is_removable_device(device: u64) -> bool {
    let (major, minor) = (libc::major(device), libc::minor(device));
    let Ok(sysfs) = std::fs::canonicalize(format!("/sys/dev/block/{major}:{minor}")) else {
        return false;
    };
    let says_removable = |folder: &Path| {
        std::fs::read_to_string(folder.join("removable"))
            .is_ok_and(|removable| removable.trim() == "1")
    };
    says_removable(&sysfs) || sysfs.parent().is_some_and(says_removable)
}

/// Disk images and external drives are mounted below `/Volumes`; the system
/// and its data volume are not.
#[cfg(target_os = "macos")]
fn on_removable_or_temporary_volume(path: &Path) -> bool {
    path.starts_with("/Volumes")
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn on_removable_or_temporary_volume(_path: &Path) -> bool {
    false
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

    #[test]
    fn uses_appimage_only_for_the_running_appimage() {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("Folio.AppImage");
        std::fs::write(&appimage, b"").unwrap();
        // The runtime mounts the image and runs the executable inside it.
        let mount = dir.path().join(".mount_Folio");
        std::fs::create_dir_all(mount.join("usr/bin")).unwrap();
        let inside = mount.join("usr/bin/folio-desktop");
        std::fs::write(&inside, b"").unwrap();
        let variables = |appimage: &Path, appdir: &Path| {
            (
                Some(appimage.as_os_str().to_owned()),
                Some(appdir.as_os_str().to_owned()),
            )
        };

        let (image, appdir) = variables(&appimage, &mount);
        assert_eq!(appimage_for(&inside, image, appdir), Some(appimage.clone()));
        // Inherited or planted variables do not redirect anything.
        let elsewhere = dir.path().join("folio-desktop");
        std::fs::write(&elsewhere, b"").unwrap();
        let (image, appdir) = variables(&appimage, &mount);
        assert_eq!(appimage_for(&elsewhere, image, appdir), None);
        assert_eq!(
            appimage_for(&inside, Some(appimage.as_os_str().to_owned()), None),
            None
        );
        let (image, appdir) = variables(Path::new("Folio.AppImage"), &mount);
        assert_eq!(appimage_for(&inside, image, appdir), None);
        let (image, appdir) = variables(&dir.path().join("missing.AppImage"), &mount);
        assert_eq!(appimage_for(&inside, image, appdir), None);
    }

    #[test]
    fn temporary_folders_are_unsafe_locations() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("folio-desktop");
        std::fs::write(&exe, b"").unwrap();
        assert!(is_unsafe_location(&exe));
        assert!(is_unsafe_location(&dir.path().join("missing")));
    }

    #[cfg(unix)]
    #[test]
    fn shared_folders_are_unsafe_locations() {
        assert!(is_shared_mode(0o40777));
        assert!(is_shared_mode(0o41777));
        assert!(is_shared_mode(0o41755));
        assert!(is_shared_mode(0o100666));
        assert!(!is_shared_mode(0o40755));
        assert!(!is_shared_mode(0o40700));
        // Group-writable folders are fine (`/Applications` is admin-writable).
        assert!(!is_shared_mode(0o40775));
        // An installed program, where one exists.
        let installed = Path::new("/usr/bin/env");
        if installed.is_file() {
            assert!(!is_unsafe_location(installed));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn removable_media_mounts_are_unsafe_locations() {
        assert!(on_removable_or_temporary_volume(Path::new(
            "/media/alice/USB/Folio.AppImage"
        )));
        assert!(on_removable_or_temporary_volume(Path::new(
            "/run/media/alice/USB/Folio.AppImage"
        )));
        // /dev/shm is a tmpfs on Linux systems that have it.
        let shm = Path::new("/dev/shm");
        if shm.is_dir() {
            assert!(on_removable_or_temporary_volume(shm));
        }
    }
}
