//! Where Folio keeps its own data (crash recovery, recent files, documents
//! received from the Chrome extension). The app and the native messaging
//! host, which runs without Tauri, must agree on it, so it is derived from
//! the bundle identifier exactly like Tauri's `app_local_data_dir`.

use std::ffi::OsString;
use std::fs::TryLockError;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The bundle identifier from `tauri.conf.json` (a test keeps them in step).
pub const IDENTIFIER: &str = "io.github.albird97.folio";
/// Replaces the data directory, for tests. Only absolute paths are used.
pub const DATA_DIR_ENV: &str = "FOLIO_DATA_DIR";
/// Held (shared) by every running copy of the app, see [`lock_instance`].
pub const INSTANCE_LOCK_FILE: &str = "instance.lock";
/// Held for a moment by a copy that is starting, see [`lock_instance`].
pub const INSTANCE_GATE_FILE: &str = "instance.gate";

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

/// Creates Folio's data folder if needed; on Unix only the user can enter
/// the folders Folio creates. An existing folder is only made private when
/// it is Folio's own folder below the system data directory, never a folder
/// named through [`DATA_DIR_ENV`], which Folio did not create.
pub fn prepare_data_dir(dir: &Path) -> std::io::Result<()> {
    prepare(dir, !data_dir_is_overridden())
}

fn prepare(dir: &Path, own: bool) -> std::io::Result<()> {
    let existed = std::fs::symlink_metadata(dir).is_ok();
    create_private_dir(dir)?;
    #[cfg(unix)]
    if existed && own {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = std::fs::symlink_metadata(dir)?;
        // SAFETY: geteuid has no preconditions.
        let user = unsafe { libc::geteuid() };
        // A real folder of this user's, not a link to somewhere else.
        if metadata.is_dir() && metadata.uid() == user && metadata.mode() & 0o777 != 0o700 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    #[cfg(not(unix))]
    let _ = (existed, own);
    Ok(())
}

/// This copy's place among the running copies of Folio (see
/// [`lock_instance`]), kept for as long as it runs.
#[derive(Debug)]
pub struct Instance {
    /// Holds the shared lock on [`INSTANCE_LOCK_FILE`]; `None` when it could
    /// not be taken.
    _lock: Option<std::fs::File>,
    /// No other copy was running when this one started.
    pub alone: bool,
}

impl Instance {
    /// Without a data folder there is nothing another copy could share.
    pub fn without_data_dir() -> Self {
        Instance {
            _lock: None,
            alone: true,
        }
    }
}

/// How long a starting copy waits for one that is quitting, or that is
/// starting at the same moment, before it counts as not alone.
pub const INSTANCE_LOCK_WAIT: Duration = Duration::from_millis(1500);

/// Every running copy of Folio holds a shared lock on [`INSTANCE_LOCK_FILE`]
/// in the data folder for as long as it runs. A starting copy runs alone,
/// and may delete what another copy could still be using (accepted
/// transfers, abandoned recovery records), only if it can take that lock
/// exclusively, retrying for up to `wait` so a copy that is quitting does
/// not count. It then keeps a shared lock like every other copy, so a copy
/// started later is never alone while this one runs, also after the copy
/// that started first has quit.
///
/// Turning the exclusive lock into a shared one is not atomic everywhere:
/// BSD `flock` (macOS) may let another process in between, and on Windows
/// the two are separate locks (`File::unlock` releases both). So starting
/// copies take turns: each holds [`INSTANCE_GATE_FILE`] exclusively while it
/// tries the exclusive lock, releases it and takes the shared one. Nobody
/// can take the exclusive lock in between, because nobody else holds the
/// gate. A copy that cannot get the gate in time is not alone (another copy
/// is starting) and only takes the shared lock.
///
/// The files are opened like every file Rust opens (`O_CLOEXEC`, handles
/// that are not inherited), so programs Folio starts never hold the locks.
pub fn lock_instance(data_dir: &Path, wait: Duration) -> Instance {
    let not_alone = |lock| Instance {
        _lock: lock,
        alone: false,
    };
    let Ok(file) = open_lock_file(&data_dir.join(INSTANCE_LOCK_FILE)) else {
        return not_alone(None);
    };
    let gate = open_lock_file(&data_dir.join(INSTANCE_GATE_FILE))
        .ok()
        .filter(|gate| retry_lock(wait, || gate.try_lock()));
    let mut alone = false;
    if gate.is_some() && retry_lock(wait, || file.try_lock()) {
        if file.unlock().is_err() {
            // Still held exclusively: no other copy is ever alone while this
            // one runs, which is safe.
            return not_alone(Some(file));
        }
        alone = true;
    }
    // Only a copy holding the gate holds the exclusive lock, and only for a
    // moment; waiting is for that moment.
    let shared = retry_lock(wait, || file.try_lock_shared());
    drop(gate);
    Instance {
        alone: alone && shared,
        _lock: shared.then_some(file),
    }
}

fn open_lock_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Tries `lock` until it succeeds or `wait` has passed.
fn retry_lock(wait: Duration, mut lock: impl FnMut() -> Result<(), TryLockError>) -> bool {
    let start = Instant::now();
    loop {
        match lock() {
            Ok(()) => return true,
            Err(TryLockError::WouldBlock) if start.elapsed() < wait => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    }
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

/// Where Chrome may be told to start `executable`: its canonical path (the
/// one that was checked, and so the one to register), or `None` when
/// someone else could replace it or it may disappear:
///
/// - it is in the temporary folder;
/// - Unix: it or a folder above it belongs to another user (only root and
///   the user are trusted), or others can change it (see
///   [`unix_entry_is_trusted`]), or it is on a temporary or removable
///   volume (disk images and external drives on macOS);
/// - Windows: it is on a network share or a drive that is not a fixed
///   local disk, or it or a folder above it lets Everyone, Users or
///   Authenticated Users write to it (see [`windows::others_can_write`]).
pub fn safe_location(executable: &Path) -> Option<PathBuf> {
    let path = std::fs::canonicalize(executable).ok()?;
    let temporary = std::fs::canonicalize(std::env::temp_dir());
    if temporary.is_ok_and(|temporary| path.starts_with(temporary)) {
        return None;
    }
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        let user = unsafe { libc::geteuid() };
        if !unix_path_is_trusted(&path, user, is_private_group)
            || on_removable_or_temporary_volume(&path)
        {
            return None;
        }
    }
    #[cfg(windows)]
    let path = {
        if !windows::on_fixed_local_drive(&path) || path.ancestors().any(windows::others_can_write)
        {
            return None;
        }
        windows::plain_path(path)
    };
    Some(path)
}

/// What an entry on the way to the executable is to it.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    Executable,
    /// The folder the executable is in.
    OwnFolder,
    /// A folder further up.
    Ancestor,
}

/// Whether nobody but root and `user` can replace the executable at the
/// canonical `path`, judging it and every folder above it.
#[cfg(unix)]
fn unix_path_is_trusted(path: &Path, user: u32, private_group: fn(u32, u32) -> bool) -> bool {
    use std::os::unix::fs::MetadataExt;
    // The path is canonical, so these are the real folders above it.
    path.ancestors().enumerate().all(|(index, ancestor)| {
        let entry = match index {
            0 => Entry::Executable,
            1 => Entry::OwnFolder,
            _ => Entry::Ancestor,
        };
        std::fs::symlink_metadata(ancestor).is_ok_and(|metadata| {
            unix_entry_is_trusted(entry, metadata.uid(), metadata.mode(), user, || {
                private_group(metadata.gid(), user)
            })
        })
    })
}

/// The rules for one entry, owned by `owner`, with permission bits `mode`:
///
/// - It must belong to root or to `user`.
/// - The executable must not be writable by others, nor by its group,
///   unless that group is the user's own private group (Debian and Ubuntu
///   give each user one, and their default umask lets it write).
/// - A folder writable by its group must belong to root (`/Applications`
///   is `root:admin`, mode 0775), or the group must be the user's private
///   group.
/// - Otherwise a folder others can write to (everyone, or another group)
///   must be sticky, like `/tmp`, where nobody can rename or delete what
///   belongs to someone else, and may not be the executable's own folder:
///   others could put files next to it there.
#[cfg(unix)]
fn unix_entry_is_trusted(
    entry: Entry,
    owner: u32,
    mode: u32,
    user: u32,
    private_group: impl FnOnce() -> bool,
) -> bool {
    let (group_writable, world_writable, sticky) =
        (mode & 0o020 != 0, mode & 0o002 != 0, mode & 0o1000 != 0);
    if owner != 0 && owner != user {
        return false;
    }
    let others_can_write = world_writable
        || group_writable
            && !match entry {
                Entry::Executable => owner == user && private_group(),
                Entry::OwnFolder | Entry::Ancestor => {
                    owner == 0 || (owner == user && private_group())
                }
            };
    !others_can_write || (entry == Entry::Ancestor && sticky)
}

/// Whether `group` is `user`'s private group: the user's primary group,
/// named like the user, with no other members listed.
#[cfg(unix)]
fn is_private_group(group: u32, user: u32) -> bool {
    use std::ffi::CStr;
    let mut user_buffer = vec![0 as libc::c_char; 16 * 1024];
    let mut passwd = std::mem::MaybeUninit::<libc::passwd>::zeroed();
    let mut found = std::ptr::null_mut();
    // SAFETY: the buffers are valid for the lengths given; `found` is set to
    // `passwd` or null.
    let failed = unsafe {
        libc::getpwuid_r(
            user,
            passwd.as_mut_ptr(),
            user_buffer.as_mut_ptr(),
            user_buffer.len(),
            &mut found,
        )
    };
    if failed != 0 || found.is_null() {
        return false;
    }
    // SAFETY: getpwuid_r found the user and filled in `passwd`, whose
    // strings point into `user_buffer`.
    let passwd = unsafe { passwd.assume_init() };
    if passwd.pw_gid != group || passwd.pw_name.is_null() {
        return false;
    }
    let mut group_buffer = vec![0 as libc::c_char; 16 * 1024];
    let mut entry = std::mem::MaybeUninit::<libc::group>::zeroed();
    let mut found = std::ptr::null_mut();
    // SAFETY: as above.
    let failed = unsafe {
        libc::getgrgid_r(
            group,
            entry.as_mut_ptr(),
            group_buffer.as_mut_ptr(),
            group_buffer.len(),
            &mut found,
        )
    };
    if failed != 0 || found.is_null() {
        return false;
    }
    // SAFETY: getgrgid_r found the group and filled in `entry`, whose
    // pointers point into `group_buffer`.
    let entry = unsafe { entry.assume_init() };
    if entry.gr_name.is_null() {
        return false;
    }
    // SAFETY: both names are NUL-terminated strings in the buffers, and
    // `gr_mem` is a null-terminated array of them (or null).
    unsafe {
        CStr::from_ptr(entry.gr_name) == CStr::from_ptr(passwd.pw_name)
            && (entry.gr_mem.is_null() || (*entry.gr_mem).is_null())
    }
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

/// `\\?\C:\…` as `C:\…`, and `\\?\UNC\server\share\…` as
/// `\\server\share\…`. Canonical paths on Windows carry the verbatim prefix
/// `\\?\`, which other programs (Chrome reads the manifest's path) may not
/// expect. `None` when the plain spelling could mean something else (a
/// name with a trailing dot or space, a device name such as `NUL`) or is
/// too long for programs without long path support: the verbatim path is
/// then kept.
#[cfg(any(windows, test))]
fn strip_verbatim(path: &str) -> Option<String> {
    let (plain, rest) = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        let mut parts = rest.splitn(3, '\\');
        let (server, share) = (parts.next()?, parts.next()?);
        if [server, share].iter().any(|part| !is_plain_component(part)) {
            return None;
        }
        (format!(r"\\{rest}"), parts.next().unwrap_or_default())
    } else {
        let rest = path.strip_prefix(r"\\?\")?;
        let drive = rest.get(..3)?.as_bytes();
        if !drive[0].is_ascii_alphabetic() || &drive[1..] != br":\" {
            return None;
        }
        (rest.to_owned(), &rest[3..])
    };
    // MAX_PATH (260) counts the terminating NUL.
    let plain_enough = plain.encode_utf16().count() < 260
        && (rest.is_empty() || rest.split('\\').all(is_plain_component));
    plain_enough.then_some(plain)
}

/// A path component that means the same with or without `\\?\`.
#[cfg(any(windows, test))]
fn is_plain_component(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or_default().trim_end();
    let mut device = stem.chars().map(|c| c.to_ascii_uppercase());
    let prefix: String = device.by_ref().take(3).collect();
    let numbered = matches!(prefix.as_str(), "COM" | "LPT")
        && matches!(
            (device.next(), device.next()),
            (Some('0'..='9' | '¹' | '²' | '³'), None)
        );
    let named = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
        .iter()
        .any(|name| stem.eq_ignore_ascii_case(name));
    !part.is_empty()
        && !part.ends_with(['.', ' '])
        && !part.contains(['/', ':'])
        && !numbered
        && !named
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Path, PathBuf, Prefix};
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS, GENERIC_ALL, GENERIC_WRITE};
    use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AclSizeInformation, CreateWellKnownSid, EqualSid, GetAce, GetAclInformation,
        WinAuthenticatedUserSid, WinBuiltinUsersSid, WinWorldSid, ACCESS_ALLOWED_ACE, ACE_HEADER,
        ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE,
        PSECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE, WELL_KNOWN_SID_TYPE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, DELETE, FILE_DELETE_CHILD, FILE_WRITE_DATA, WRITE_DAC, WRITE_OWNER,
    };

    /// `GetDriveTypeW`'s answer for a fixed local disk.
    const DRIVE_FIXED: u32 = 3;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_ALLOWED_CALLBACK_ACE_TYPE: u8 = 9;
    /// Rights that let someone replace a file or folder, put files in a
    /// folder (`FILE_WRITE_DATA` is `FILE_ADD_FILE` there), remove what is
    /// in it, or give themselves any of these.
    const WRITE_RIGHTS: u32 = FILE_WRITE_DATA
        | FILE_DELETE_CHILD
        | DELETE
        | WRITE_DAC
        | WRITE_OWNER
        | GENERIC_WRITE
        | GENERIC_ALL;
    const SID_WORDS: usize = SECURITY_MAX_SID_SIZE as usize / 4;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// Whether the canonical `path` is on a fixed local disk: not on a
    /// network share (canonical paths spell mapped drives as UNC paths),
    /// a removable or optical drive or a RAM disk. External USB disks that
    /// report themselves as fixed cannot be told apart.
    pub fn on_fixed_local_drive(path: &Path) -> bool {
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return false;
        };
        let letter = match prefix.kind() {
            Prefix::VerbatimDisk(letter) | Prefix::Disk(letter) => letter,
            // UNC paths and devices.
            _ => return false,
        };
        let root = wide(Path::new(&format!("{}:\\", char::from(letter))));
        // SAFETY: `root` is NUL-terminated.
        unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_FIXED }
    }

    /// Frees memory the system allocated with `LocalAlloc`.
    struct LocalMemory(*mut c_void);

    impl Drop for LocalMemory {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: the pointer came from the system and is freed once.
                unsafe { LocalFree(self.0) };
            }
        }
    }

    fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> Option<[u32; SID_WORDS]> {
        let mut sid = [0u32; SID_WORDS];
        let mut size = SECURITY_MAX_SID_SIZE;
        // SAFETY: `sid` holds `size` bytes, aligned for a SID.
        let created = unsafe {
            CreateWellKnownSid(
                kind,
                std::ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut size,
            )
        };
        (created != 0).then_some(sid)
    }

    /// Whether the file or folder's access list lets Everyone, Users or
    /// Authenticated Users write to it (see [`WRITE_RIGHTS`]), judged by the
    /// entries that allow access and apply to it. Entries that deny access
    /// are not weighed against them, and an access list that cannot be read
    /// counts as writable: both err on the side of refusing.
    pub fn others_can_write(path: &Path) -> bool {
        let broad = [WinWorldSid, WinAuthenticatedUserSid, WinBuiltinUsersSid].map(well_known_sid);
        if broad.iter().any(Option::is_none) {
            return true;
        }
        let name = wide(path);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `name` is NUL-terminated; only the DACL is asked for, and
        // the descriptor holding it is freed below.
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        let _descriptor = LocalMemory(descriptor);
        // A missing DACL allows everyone everything.
        if status != ERROR_SUCCESS || dacl.is_null() {
            return true;
        }
        let mut size = ACL_SIZE_INFORMATION::default();
        // SAFETY: `dacl` points into the descriptor, alive until the end of
        // the function; `size` is writable for the length given.
        let read = unsafe {
            GetAclInformation(
                dacl,
                std::ptr::addr_of_mut!(size).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        if read == 0 {
            return true;
        }
        (0..size.AceCount).any(|index| {
            let mut ace: *mut c_void = std::ptr::null_mut();
            // SAFETY: `index` is below the ACL's entry count.
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
                return true;
            }
            // SAFETY: every entry starts with a header.
            let header = unsafe { *ace.cast::<ACE_HEADER>() };
            let allows = matches!(
                header.AceType,
                ACCESS_ALLOWED_ACE_TYPE | ACCESS_ALLOWED_CALLBACK_ACE_TYPE
            );
            // Entries only passed on to what is created inside do not apply.
            if !allows || u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 {
                return false;
            }
            let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
            // SAFETY: both entry types are laid out like ACCESS_ALLOWED_ACE,
            // with the SID starting at `SidStart`.
            let (mask, sid) = unsafe {
                (
                    (*allowed).Mask,
                    std::ptr::addr_of_mut!((*allowed).SidStart).cast::<c_void>(),
                )
            };
            mask & WRITE_RIGHTS != 0
                && broad.iter().flatten().any(|known| {
                    // SAFETY: both are valid SIDs; EqualSid only reads them.
                    unsafe { EqualSid(sid, known.as_ptr() as *mut c_void) != 0 }
                })
        })
    }

    /// The canonical `path` as other programs expect it (see
    /// [`super::strip_verbatim`]).
    pub fn plain_path(path: PathBuf) -> PathBuf {
        match path.to_str().and_then(super::strip_verbatim) {
            Some(plain) => PathBuf::from(plain),
            None => path,
        }
    }
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
    fn makes_only_its_own_data_folder_private() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        // Folio's folder below the system data directory, from an older build.
        let own = dir.path().join("own");
        std::fs::create_dir(&own).unwrap();
        std::fs::set_permissions(&own, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare(&own, true).unwrap();
        assert_eq!(mode(&own), 0o700);
        // A folder named through FOLIO_DATA_DIR is left as it is...
        let named = dir.path().join("named");
        std::fs::create_dir(&named).unwrap();
        std::fs::set_permissions(&named, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare(&named, false).unwrap();
        assert_eq!(mode(&named), 0o755);
        // ...unless Folio creates it, parents included.
        let created = dir.path().join("new").join("data");
        prepare(&created, false).unwrap();
        assert_eq!(mode(&created), 0o700);
        assert_eq!(mode(&dir.path().join("new")), 0o700);
        // A link is not followed.
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&named, &link).unwrap();
        prepare(&link, true).unwrap();
        assert_eq!(mode(&named), 0o755);
    }

    // Each `lock_instance` opens the files anew, which locks them like
    // another process would.
    #[test]
    fn only_a_copy_that_starts_alone_is_alone() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_instance(dir.path(), Duration::ZERO);
        assert!(first.alone && first._lock.is_some());
        let second = lock_instance(dir.path(), Duration::ZERO);
        assert!(!second.alone);
        assert!(second._lock.is_some(), "it still counts for later copies");
        // The first copy quits; a third must not delete what the second
        // still uses.
        drop(first);
        let third = lock_instance(dir.path(), Duration::ZERO);
        assert!(!third.alone);
        drop((second, third));
        assert!(lock_instance(dir.path(), Duration::ZERO).alone);
        // The gate is only held while a copy starts.
        let gate = open_lock_file(&dir.path().join(INSTANCE_GATE_FILE)).unwrap();
        assert!(gate.try_lock().is_ok());
        let missing = lock_instance(&dir.path().join("missing"), Duration::ZERO);
        assert!(!missing.alone && missing._lock.is_none());
        assert!(Instance::without_data_dir().alone);
    }

    #[test]
    fn waits_briefly_for_a_copy_that_is_quitting() {
        let dir = tempfile::tempdir().unwrap();
        let quitting = lock_instance(dir.path(), Duration::ZERO);
        let quit = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(quitting);
        });
        let next = lock_instance(dir.path(), Duration::from_secs(10));
        quit.join().unwrap();
        assert!(next.alone);
    }

    #[test]
    fn a_copy_that_cannot_get_the_gate_is_not_alone() {
        let dir = tempfile::tempdir().unwrap();
        // Another copy is deciding right now.
        let gate = open_lock_file(&dir.path().join(INSTANCE_GATE_FILE)).unwrap();
        gate.lock().unwrap();
        let starting = lock_instance(dir.path(), Duration::ZERO);
        assert!(!starting.alone && starting._lock.is_some());
        drop(gate);
        // Its shared lock keeps the next copy from being alone.
        assert!(!lock_instance(dir.path(), Duration::ZERO).alone);
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
        assert_eq!(safe_location(&exe), None);
        assert_eq!(safe_location(&dir.path().join("missing")), None);
    }

    #[test]
    fn registers_the_canonical_path_that_was_checked() {
        // An installed program, where one exists, through another spelling.
        #[cfg(unix)]
        let installed = Path::new("/usr/bin/../bin/env");
        #[cfg(windows)]
        let installed = Path::new(r"C:\Windows\System32\..\System32\notepad.exe");
        if installed.is_file() {
            let checked = safe_location(installed).expect("an installed program is safe");
            assert_eq!(checked.file_name(), installed.file_name());
            assert!(!checked.to_string_lossy().contains(".."));
            assert!(!checked.to_string_lossy().starts_with(r"\\?\"));
        }
    }

    #[test]
    fn strips_the_verbatim_prefix_only_where_it_changes_nothing() {
        let strip = |path: &str| strip_verbatim(path);
        assert_eq!(
            strip(r"\\?\C:\Program Files\Folio\folio-desktop.exe").as_deref(),
            Some(r"C:\Program Files\Folio\folio-desktop.exe")
        );
        assert_eq!(strip(r"\\?\d:\").as_deref(), Some(r"d:\"));
        assert_eq!(
            strip(r"\\?\UNC\server\share\Folio\folio-desktop.exe").as_deref(),
            Some(r"\\server\share\Folio\folio-desktop.exe")
        );
        assert_eq!(
            strip(r"\\?\UNC\server\share").as_deref(),
            Some(r"\\server\share")
        );
        for kept in [
            r"C:\Folio\folio-desktop.exe",
            r"\\?\Volume{0b1c}\Folio\folio-desktop.exe",
            r"\\?\GLOBALROOT\Device\Folio.exe",
            r"\\?\UNC\server",
            r"\\?\UNC\\share\x.exe",
            r"\\?\C:",
            r"\\?\C:\Folio.\folio-desktop.exe",
            r"\\?\C:\Folio \folio-desktop.exe",
            r"\\?\C:\Folio\..\folio-desktop.exe",
            r"\\?\C:\Folio\.\folio-desktop.exe",
            r"\\?\C:\Folio\\folio-desktop.exe",
            r"\\?\C:\Folio\NUL",
            r"\\?\C:\Folio\nul.exe",
            r"\\?\C:\Folio\com1.exe",
            r"\\?\C:\Folio\LPT¹\x.exe",
            r"\\?\C:\Folio\CONOUT$\x.exe",
            r"\\?\C:\Folio\a:stream",
        ] {
            assert_eq!(strip(kept), None, "{kept}");
        }
        // Allowed: names that only start like device names.
        assert!(strip(r"\\?\C:\Console\COM10\Nullsoft\folio.exe").is_some());
        let long = format!(r"\\?\C:\{}\folio-desktop.exe", "a".repeat(250));
        assert_eq!(strip(&long), None);
    }

    /// The current user, for the rule tests.
    #[cfg(unix)]
    const ALICE: u32 = 501;

    #[cfg(unix)]
    fn trusted(entry: Entry, owner: u32, mode: u32, private_group: bool) -> bool {
        unix_entry_is_trusted(entry, owner, mode, ALICE, || private_group)
    }

    #[cfg(unix)]
    #[test]
    fn only_root_and_the_user_may_own_the_way_to_the_executable() {
        for entry in [Entry::Executable, Entry::OwnFolder, Entry::Ancestor] {
            assert!(trusted(entry, 0, 0o755, false));
            assert!(trusted(entry, ALICE, 0o755, false));
            assert!(trusted(entry, ALICE, 0o700, false));
            assert!(!trusted(entry, 502, 0o755, false), "{entry:?}");
            assert!(!trusted(entry, 502, 0o700, false), "{entry:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn others_may_not_change_the_way_to_the_executable() {
        use Entry::{Ancestor, Executable, OwnFolder};
        // Writable by everyone.
        for entry in [Executable, OwnFolder, Ancestor] {
            assert!(!trusted(entry, 0, 0o777, true), "{entry:?}");
            assert!(!trusted(entry, ALICE, 0o757, true), "{entry:?}");
        }
        // Sticky like /tmp: fine further up, where nobody can rename what
        // belongs to someone else, but not the executable's own folder,
        // where others could put files next to it.
        assert!(trusted(Ancestor, 0, 0o1777, false));
        assert!(trusted(Ancestor, ALICE, 0o1777, false));
        assert!(trusted(Ancestor, ALICE, 0o1775, false));
        assert!(!trusted(Ancestor, 502, 0o1777, false));
        assert!(!trusted(OwnFolder, 0, 0o1777, false));
        assert!(!trusted(OwnFolder, ALICE, 0o1775, false));
        assert!(!trusted(Executable, ALICE, 0o1777, true));
        // Sticky alone changes nothing.
        assert!(trusted(OwnFolder, ALICE, 0o1755, false));
        // Writable by the group: root's folders (/Applications is
        // root:admin 0775), and the user's own private group.
        assert!(trusted(Ancestor, 0, 0o775, false));
        assert!(trusted(OwnFolder, 0, 0o775, false));
        assert!(!trusted(Ancestor, ALICE, 0o775, false));
        assert!(!trusted(OwnFolder, ALICE, 0o770, false));
        assert!(trusted(OwnFolder, ALICE, 0o775, true));
        assert!(trusted(Ancestor, ALICE, 0o775, true));
        // The executable itself: never by another group, also root's.
        assert!(!trusted(Executable, 0, 0o775, false));
        assert!(!trusted(Executable, 0, 0o775, true));
        assert!(!trusted(Executable, ALICE, 0o775, false));
        assert!(trusted(Executable, ALICE, 0o775, true));
    }

    #[cfg(unix)]
    #[test]
    fn checks_every_folder_above_the_executable() {
        use std::os::unix::fs::PermissionsExt;
        let set_mode = |path: &Path, mode: u32| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        let no_private_group: fn(u32, u32) -> bool = |_, _| false;
        // SAFETY: geteuid has no preconditions.
        let user = unsafe { libc::geteuid() };
        // The temporary folder is sticky and writable by everyone, which is
        // fine above the executable's folder. (`safe_location` refuses it
        // anyway.)
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let place = |folders: &[(&str, u32)], exe_mode: u32| {
            let mut folder = root.clone();
            for (name, _) in folders {
                folder.push(name);
            }
            std::fs::create_dir_all(&folder).unwrap();
            let mut path = root.clone();
            for (name, mode) in folders {
                path.push(name);
                set_mode(&path, *mode);
            }
            let exe = folder.join("folio-desktop");
            std::fs::write(&exe, b"").unwrap();
            set_mode(&exe, exe_mode);
            exe
        };
        let ok = place(&[("ok", 0o755)], 0o755);
        assert!(unix_path_is_trusted(&ok, user, no_private_group));
        let open = place(&[("open", 0o777), ("Folio", 0o755)], 0o755);
        assert!(!unix_path_is_trusted(&open, user, no_private_group));
        let sticky_above = place(&[("shared", 0o1777), ("Folio", 0o755)], 0o755);
        assert!(unix_path_is_trusted(&sticky_above, user, no_private_group));
        let sticky_own = place(&[("drop", 0o1777)], 0o755);
        assert!(!unix_path_is_trusted(&sticky_own, user, no_private_group));
        let writable_exe = place(&[("exe", 0o755)], 0o775);
        assert!(!unix_path_is_trusted(&writable_exe, user, no_private_group));
        let world_exe = place(&[("world", 0o755)], 0o757);
        assert!(!unix_path_is_trusted(&world_exe, user, no_private_group));
        // A folder of the user's that the group can write to: refused unless
        // root owns it (as when these tests run as root).
        let group = place(&[("group", 0o775)], 0o755);
        assert_eq!(
            unix_path_is_trusted(&group, user, no_private_group),
            user == 0
        );
        assert!(unix_path_is_trusted(&group, user, |_, _| true));
        assert!(!unix_path_is_trusted(
            &root.join("missing"),
            user,
            no_private_group
        ));
        // Someone else's folder (only root can give one away).
        if user == 0 {
            let theirs = place(&[("theirs", 0o755)], 0o755);
            std::os::unix::fs::chown(root.join("theirs"), Some(4242), None).unwrap();
            assert!(!unix_path_is_trusted(&theirs, user, no_private_group));
        }
    }

    #[cfg(unix)]
    #[test]
    fn recognizes_private_groups() {
        // SAFETY: getegid and geteuid have no preconditions.
        let (user, group) = unsafe { (libc::geteuid(), libc::getegid()) };
        // Root's group (gid 0) is named like root and has no other members
        // on most systems, but that is the system's business; a group that
        // is not the user's primary group never is.
        assert!(!is_private_group(group.wrapping_add(4242), user));
        assert!(!is_private_group(group, 4_000_000_000));
    }

    #[cfg(unix)]
    #[test]
    fn installed_programs_are_safe_locations() {
        let installed = Path::new("/usr/bin/env");
        if installed.is_file() {
            assert_eq!(
                safe_location(installed),
                Some(std::fs::canonicalize(installed).unwrap())
            );
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
