//! Saving: "Save As" and "Save a Copy" write PDF data from the webview to a
//! file the user chose in the native save dialog; "Save" writes it back to a
//! file the user granted before (by token). The webview never names a path;
//! it proposes a file name and gets the chosen file's name back.

use crate::files::MAX_FILE_BYTES;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::Metadata;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Header carrying the proposed file name, percent-encoded (headers are ASCII).
pub const NAME_HEADER: &str = "x-folio-name";
/// `1` asks `save_pdf_as` to keep write access to the chosen file (Save As).
pub const KEEP_ACCESS_HEADER: &str = "x-folio-keep-access";
/// The grant token of the file `write_granted_file` overwrites.
pub const TOKEN_HEADER: &str = "x-folio-token";
/// SHA-256 (hex) of what Folio last read from or wrote to that file.
pub const EXPECTED_SHA256_HEADER: &str = "x-folio-expected-sha256";
/// `1` writes even though the file changed on disk (the user confirmed).
pub const OVERWRITE_HEADER: &str = "x-folio-overwrite";
const FALLBACK_NAME: &str = "Document";
/// File systems count names in bytes (usually 255); this leaves room. Also
/// the limit for other names Folio shows, such as recovery titles.
pub const MAX_NAME_BYTES: usize = 200;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SaveError {
    #[error("Only PDF data can be saved.")]
    NotPdf,
    #[error("This file is larger than Folio can save.")]
    TooLarge,
    #[error("The request was not understood.")]
    InvalidRequest,
    #[error("The file could not be saved there.")]
    WriteFailed,
    #[error("This file is read-only.")]
    ReadOnly,
    #[error("Folio keeps its own data in this folder. Choose another folder.")]
    Reserved,
    /// The new version could not take the file's place, and its previous
    /// version could not be put back: that version was kept under this
    /// name, in the same folder.
    #[error("Folio could not replace the file or put its previous version back. That version was kept as \u{201c}{0}\u{201d} in the same folder.")]
    KeptCopy(String),
}

impl SaveError {
    pub fn code(&self) -> &'static str {
        match self {
            SaveError::NotPdf => "not-pdf",
            SaveError::TooLarge => "too-large",
            SaveError::InvalidRequest => "invalid-request",
            SaveError::WriteFailed => "write-failed",
            SaveError::ReadOnly => "read-only",
            SaveError::Reserved => "reserved-location",
            SaveError::KeptCopy(_) => "kept-copy",
        }
    }
}

/// PDF readers accept the `%PDF-` header anywhere in the first 1024 bytes.
pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|window| window == b"%PDF-")
}

/// Accepts only PDF data within the size limit, so the save dialog cannot be
/// used to write arbitrary files.
pub fn check_pdf(bytes: &[u8]) -> Result<(), SaveError> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(SaveError::TooLarge);
    }
    if !looks_like_pdf(bytes) {
        return Err(SaveError::NotPdf);
    }
    Ok(())
}

/// The name to propose in the dialog: the last component of the decoded
/// header, without characters file systems reject, ending in `.pdf`.
pub fn suggested_file_name(header: Option<&str>) -> String {
    let decoded = header.map(decode_header).unwrap_or_default();
    sanitize_file_name(&decoded)
}

/// Decodes a percent-encoded header value (headers are ASCII).
pub fn decode_header(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8_lossy()
        .into_owned()
}

/// Characters that can disguise a name without being seen: formatting
/// characters (Unicode category Cf) such as the right-to-left override
/// (U+202E) that makes `report<U+202E>fdp.exe` read as `reportexe.pdf`, the
/// line and paragraph separators, and fillers that show as blank space
/// (Hangul fillers, the braille blank). The joiners U+200C and U+200D stay:
/// scripts and emoji need them.
fn is_hidden_format_character(c: char) -> bool {
    matches!(c,
        '\u{00AD}'
        | '\u{0600}'..='\u{0605}'
        | '\u{061C}'
        | '\u{06DD}'
        | '\u{070F}'
        | '\u{0890}'..='\u{0891}'
        | '\u{08E2}'
        | '\u{180E}'
        | '\u{200B}'
        | '\u{200E}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{206F}'
        | '\u{FEFF}'
        | '\u{FFF9}'..='\u{FFFB}'
        | '\u{110BD}'
        | '\u{110CD}'
        | '\u{13430}'..='\u{1343F}'
        | '\u{1BCA0}'..='\u{1BCA3}'
        | '\u{1D173}'..='\u{1D17A}'
        | '\u{E0001}'
        | '\u{E0020}'..='\u{E007F}'
        // Line and paragraph separators.
        | '\u{2028}'..='\u{2029}'
        // Fillers: Hangul choseong and jungseong fillers, Hangul filler,
        // halfwidth Hangul filler, braille pattern blank.
        | '\u{115F}'..='\u{1160}'
        | '\u{3164}'
        | '\u{FFA0}'
        | '\u{2800}'
    )
}

/// `text` without control characters and characters that cannot be seen
/// ([`is_hidden_format_character`]).
fn visible_characters(text: &str) -> impl Iterator<Item = char> + '_ {
    text.chars()
        .filter(|&c| !c.is_control() && !is_hidden_format_character(c))
}

/// A name to show that is not a file name (recovery titles): the characters
/// [`sanitize_file_name`] keeps visible, trimmed, and at most `max_bytes` of
/// UTF-8, cut between characters.
pub fn clean_display_text(text: &str, max_bytes: usize) -> String {
    let visible: String = visible_characters(text).collect();
    truncate_to_bytes(visible.trim(), max_bytes)
        .trim_end()
        .to_owned()
}

/// The longest prefix of `text` that fits in `max` bytes, cut between
/// characters.
fn truncate_to_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// A plain file name for `name`: its last path component, without characters
/// file systems reject or invisible formatting characters, ending in `.pdf`
/// and at most 200 bytes long (UTF-8).
pub fn sanitize_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = visible_characters(last)
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    // Keep the extension (and its case) when there is one.
    let (stem, extension) = match trimmed.len().checked_sub(4) {
        Some(at) if trimmed.is_char_boundary(at) && trimmed[at..].eq_ignore_ascii_case(".pdf") => {
            (&trimmed[..at], &trimmed[at..])
        }
        _ => (trimmed, ".pdf"),
    };
    let stem = truncate_to_bytes(stem, MAX_NAME_BYTES - extension.len());
    // Windows refuses names that end in a dot or a space.
    let stem = stem.trim_end_matches(['.', ' ']).trim_end();
    let stem = if stem.is_empty() { FALLBACK_NAME } else { stem };
    format!("{stem}{extension}")
}

/// What changes when a file is edited or replaced: its size, modification
/// time and identity (device and inode on Unix, volume and file index on
/// Windows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    identity: Option<(u64, u64)>,
}

impl FileStamp {
    pub fn of(path: &Path) -> std::io::Result<FileStamp> {
        let metadata = std::fs::metadata(path)?;
        Ok(FileStamp::from_metadata(path, &metadata))
    }

    fn from_metadata(path: &Path, metadata: &Metadata) -> FileStamp {
        FileStamp {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            identity: file_identity(path, metadata),
        }
    }
}

#[cfg(unix)]
fn file_identity(_path: &Path, metadata: &Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(path: &Path, _metadata: &Metadata) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let file = std::fs::File::open(path).ok()?;
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: the handle stays open for the call and `info` is writable.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) } == 0 {
        return None;
    }
    // SAFETY: the call succeeded, so it filled in `info`.
    let info = unsafe { info.assume_init() };
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Some((u64::from(info.dwVolumeSerialNumber), index))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &Path, _metadata: &Metadata) -> Option<(u64, u64)> {
    None
}

#[derive(Debug, PartialEq, Eq)]
enum ReplaceError {
    Failed(SaveError),
    /// The target no longer matches the stamp it was checked against, or it
    /// is gone.
    Changed,
    /// The target is gone and its previous version was kept under this name
    /// in the same folder (the only copy of that version).
    KeptCopy(String),
}

impl From<std::io::Error> for ReplaceError {
    fn from(_: std::io::Error) -> Self {
        ReplaceError::Failed(SaveError::WriteFailed)
    }
}

/// Refuses targets Folio may not write to. Opening the file for writing
/// (without truncating it) is the real test: permission bits alone miss
/// ACLs, read-only mounts and files owned by someone else.
fn check_writable(target: &Path, metadata: &Metadata) -> Result<(), SaveError> {
    if metadata.permissions().readonly() {
        return Err(SaveError::ReadOnly);
    }
    match std::fs::OpenOptions::new().write(true).open(target) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(SaveError::ReadOnly)
        }
        Err(_) => Err(SaveError::WriteFailed),
    }
}

/// Creates the temporary file so that only the user can read it while the
/// document is written (other users may share the folder).
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// The mode a new file gets from the process umask (`0o666 & !umask`).
#[cfg(unix)]
fn default_file_mode() -> u32 {
    // Read once: the umask can only be read by setting it, and two threads
    // doing that at the same time could leave the temporary value behind.
    static MODE: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *MODE.get_or_init(|| {
        // The stricter mask set for this instant could only make files other
        // threads create more private.
        // SAFETY: umask has no memory-safety requirements.
        let mask = unsafe { libc::umask(0o077) };
        // SAFETY: as above; this restores the previous mask.
        unsafe { libc::umask(mask) };
        #[allow(clippy::useless_conversion)] // mode_t is u16 on macOS.
        let mask = u32::from(mask);
        0o666 & !mask
    })
}

/// Gives the finished temporary file the permissions the target has (or a
/// new file would get) and, on macOS, its ACL and extended attributes
/// (Finder tags, quarantine). Windows keeps them through `ReplaceFileW`.
/// For a new file this is best effort: it is already private (0600).
fn finish_permissions(
    temporary: &Path,
    target: &Path,
    existing: Option<&Metadata>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match existing {
            Some(metadata) => {
                let mode = metadata.permissions().mode() & 0o7777;
                std::fs::set_permissions(temporary, std::fs::Permissions::from_mode(mode))?;
            }
            None => {
                let mode = std::fs::Permissions::from_mode(default_file_mode());
                let _ = std::fs::set_permissions(temporary, mode);
            }
        }
    }
    #[cfg(target_os = "macos")]
    if existing.is_some() {
        copy_acl_and_attributes(target, temporary);
    }
    #[cfg(not(any(unix, windows)))]
    if let Some(metadata) = existing {
        std::fs::set_permissions(temporary, metadata.permissions())?;
    }
    let _ = (temporary, target, existing);
    Ok(())
}

/// Best effort: a save should not fail over metadata.
#[cfg(target_os = "macos")]
fn copy_acl_and_attributes(from: &Path, to: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let (Ok(from), Ok(to)) = (
        std::ffi::CString::new(from.as_os_str().as_bytes()),
        std::ffi::CString::new(to.as_os_str().as_bytes()),
    ) else {
        return;
    };
    // Not COPYFILE_STAT: that would also copy the old modification time.
    // SAFETY: both paths are NUL-terminated; no copy state is used.
    unsafe {
        libc::copyfile(
            from.as_ptr(),
            to.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        );
    }
}

/// Why the new version did not take the target's place.
#[derive(Debug)]
// Only Windows replaces a file in more than one step.
#[cfg_attr(not(windows), allow(dead_code))]
enum SwapError {
    /// Nothing changed: the target is as it was.
    Failed,
    /// The target was gone before the swap.
    TargetMissing,
    /// The target is gone; its previous version only exists in this file.
    KeptCopy(PathBuf),
}

/// Moves the temporary file over the target. Windows replaces existing
/// files with `ReplaceFileW`, which keeps their attributes and ACL, through
/// a backup file: if the new version cannot be moved in, the previous one
/// is put back from the backup instead of being lost.
#[cfg(windows)]
fn swap_into_place(temporary: &Path, target: &Path, replacing: bool) -> Result<(), SwapError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS};
    if !replacing {
        return std::fs::rename(temporary, target).map_err(|_| SwapError::Failed);
    }
    let backup = temporary.with_extension("bak");
    let wide =
        |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (target_wide, temporary_wide, backup_wide) = (wide(target), wide(temporary), wide(&backup));
    // SAFETY: the three paths are NUL-terminated; the reserved arguments are
    // null.
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            backup_wide.as_ptr(),
            REPLACEFILE_IGNORE_MERGE_ERRORS,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced != 0 {
        // The previous version, no longer needed.
        remove_backup(&backup);
        return Ok(());
    }
    if target.exists() {
        // Both files kept their names (ERROR_UNABLE_TO_MOVE_REPLACEMENT with a
        // backup name, and most other failures).
        let _ = std::fs::remove_file(&backup);
        return Err(SwapError::Failed);
    }
    if backup.exists() {
        // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: the previous version has the
        // backup name and the new one its temporary name.
        return match std::fs::rename(&backup, target) {
            Ok(()) => Err(SwapError::Failed),
            Err(_) => Err(SwapError::KeptCopy(backup)),
        };
    }
    Err(SwapError::TargetMissing)
}

/// Deletes the previous version once the new one took its place. Antivirus
/// software may still hold it open for a moment, so the delete is tried a
/// few more times; if it still fails, the file is marked as disposable
/// (`FILE_ATTRIBUTE_TEMPORARY`, which only needs attribute access and so
/// works on a file someone holds open) for a later save into the folder to
/// delete (see [`remove_stale_files`]). A previous version Folio had to
/// keep because it could not be put back is never marked.
#[cfg(windows)]
fn remove_backup(backup: &Path) {
    for delay in [0, 50, 100, 200, 400] {
        std::thread::sleep(std::time::Duration::from_millis(delay));
        match std::fs::remove_file(backup) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => {}
        }
    }
    mark_disposable(backup);
}

#[cfg(windows)]
fn mark_disposable(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_TEMPORARY, INVALID_FILE_ATTRIBUTES,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated.
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attributes != INVALID_FILE_ATTRIBUTES {
        // SAFETY: as above. Best effort: the file only stays behind longer.
        unsafe { SetFileAttributesW(wide.as_ptr(), attributes | FILE_ATTRIBUTE_TEMPORARY) };
    }
}

/// How old a leftover of an earlier save must be before a later save into
/// the same folder deletes it: no save takes that long, so it cannot belong
/// to one that is still running (in this or another copy of Folio).
const STALE_AGE: Duration = Duration::from_secs(60 * 60);

/// What an earlier save may have left in the folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leftover {
    /// `.folio-<uuid>.tmp`: the new version of a save that was interrupted.
    Temporary,
    /// `.folio-<uuid>.bak` (Windows): a previous version.
    Backup,
}

/// Which leftover `name` is, if it is exactly one of Folio's own names: a
/// dot, `folio-`, 32 lowercase hex digits (a uuid) and `.tmp` or `.bak`.
fn leftover_kind(name: &str) -> Option<Leftover> {
    let rest = name.strip_prefix(".folio-")?;
    let (id, extension) = rest.split_at_checked(32)?;
    if !id
        .bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    match extension {
        ".tmp" => Some(Leftover::Temporary),
        ".bak" => Some(Leftover::Backup),
        _ => None,
    }
}

/// Deletes what earlier saves into `directory` left behind once it is an
/// hour old: temporary files of saves that were interrupted, and on Windows
/// previous versions that could not be deleted right after a replace (only
/// those [`remove_backup`] marked). A previous version Folio had to keep is
/// left alone, and so are temporary files while one is there: an
/// interrupted replace may have left the new version only there. Only
/// regular files with exactly Folio's names are deleted; links (and other
/// reparse points) are never followed or deleted. Best effort.
fn remove_stale_files(directory: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut stale = Vec::new();
    let mut kept_backup = false;
    for entry in entries.flatten() {
        let Some(kind) = entry.file_name().to_str().and_then(leftover_kind) else {
            continue;
        };
        let path = entry.path();
        // Describes the entry itself, never what a link points to.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            continue;
        }
        if kind == Leftover::Backup && !is_disposable_backup(&metadata) {
            kept_backup = true;
            continue;
        }
        let old = metadata
            .modified()
            .is_ok_and(|modified| now.duration_since(modified).unwrap_or_default() > STALE_AGE);
        if old {
            stale.push((kind, path));
        }
    }
    for (kind, path) in stale {
        if kind == Leftover::Temporary && kept_backup {
            continue;
        }
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &Metadata) -> bool {
    false
}

/// A backup [`remove_backup`] could not delete. Only Windows saves through
/// backups; elsewhere a file with that name is not Folio's to delete.
#[cfg(windows)]
fn is_disposable_backup(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_TEMPORARY;
    metadata.file_attributes() & FILE_ATTRIBUTE_TEMPORARY != 0
}

#[cfg(not(windows))]
fn is_disposable_backup(_metadata: &Metadata) -> bool {
    false
}

/// Moves the temporary file over the target: `rename` replaces it in one
/// step, so after a failure the target is as it was.
#[cfg(not(windows))]
fn swap_into_place(temporary: &Path, target: &Path, _replacing: bool) -> Result<(), SwapError> {
    std::fs::rename(temporary, target).map_err(|_| SwapError::Failed)
}

/// Writes `bytes` over `target` through a private temporary file in the same
/// folder. With `unchanged`, the target must still match that stamp right
/// before it is replaced (a target that is gone by then counts as changed).
///
/// Every failure deletes the temporary file: the new version is still in
/// the app. The only file left behind is a previous version that could not
/// be put back after a failed swap ([`ReplaceError::KeptCopy`]).
fn replace_file(
    target: &Path,
    bytes: &[u8],
    unchanged: Option<&FileStamp>,
) -> Result<(), ReplaceError> {
    let directory = target
        .parent()
        .ok_or(ReplaceError::Failed(SaveError::WriteFailed))?;
    let existing = std::fs::metadata(target).ok();
    if let Some(metadata) = &existing {
        if metadata.is_dir() {
            return Err(ReplaceError::Failed(SaveError::WriteFailed));
        }
        check_writable(target, metadata).map_err(ReplaceError::Failed)?;
    }
    // Short and fixed-length, so any name the file system accepts for the
    // target also works here.
    let temporary = directory.join(format!(".folio-{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| -> Result<(), ReplaceError> {
        let mut file = create_private_file(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        finish_permissions(&temporary, target, existing.as_ref())?;
        if let Some(stamp) = unchanged {
            if FileStamp::of(target).ok().as_ref() != Some(stamp) {
                return Err(ReplaceError::Changed);
            }
        }
        match swap_into_place(&temporary, target, existing.is_some()) {
            Ok(()) => {}
            Err(SwapError::Failed) => return Err(ReplaceError::Failed(SaveError::WriteFailed)),
            // Save must not bring back a file someone removed.
            Err(SwapError::TargetMissing) if unchanged.is_some() => {
                return Err(ReplaceError::Changed)
            }
            // Save As: the chosen place is free now.
            Err(SwapError::TargetMissing) => std::fs::rename(&temporary, target)?,
            Err(SwapError::KeptCopy(kept)) => {
                let name = kept
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                return Err(ReplaceError::KeptCopy(name));
            }
        }
        // Make the rename itself durable.
        #[cfg(unix)]
        if let Ok(folder) = std::fs::File::open(directory) {
            let _ = folder.sync_all();
        }
        remove_stale_files(directory, SystemTime::now());
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

/// Writes `bytes` to `target` through a temporary file in the same folder
/// and a rename, so an interrupted or failed save never leaves a truncated
/// file, and nobody else can read the document while it is written. A file
/// that is replaced keeps its permissions (and on Windows its attributes and
/// ACL, on macOS its ACL and extended attributes); files Folio cannot open
/// for writing are refused as read-only.
pub fn write_atomically(target: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    replace_file(target, bytes, None).map_err(|error| match error {
        ReplaceError::Failed(error) => error,
        ReplaceError::Changed => SaveError::WriteFailed,
        ReplaceError::KeptCopy(name) => SaveError::KeptCopy(name),
    })
}

/// Whether `value` is a SHA-256 digest in hex.
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// Hashes a file without loading it into memory.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

pub const MISSING_MESSAGE: &str = "The file could not be found. It may have been moved, renamed or deleted. Use Save As to save the document.";
pub const READ_ONLY_MESSAGE: &str =
    "The file is read-only. Use Save As to save the document under another name.";
pub const UNWRITABLE_MESSAGE: &str =
    "Folio could not write to the file. Use Save As to save the document somewhere else.";
pub const SPOOLED_MESSAGE: &str =
    "This document has no file on this computer yet. Use Save As to choose where to save it.";

/// The outcome of writing back to a granted file (`WriteFileResult` in the
/// frontend). Messages are shown to the user and never contain paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum WriteOutcome {
    Saved,
    /// The file no longer has the expected content; nothing was written.
    ChangedOnDisk,
    /// The file cannot be written (moved, deleted, read-only).
    Unavailable {
        message: String,
    },
    /// The file could not be replaced and its previous version could not be
    /// put back: that version was kept as `name` in the same folder. The
    /// document is still unsaved.
    KeptCopy {
        name: String,
        message: String,
    },
}

impl WriteOutcome {
    pub fn unavailable(message: &str) -> Self {
        WriteOutcome::Unavailable {
            message: message.to_owned(),
        }
    }
}

/// Save: replaces the file at `path` with `bytes`, unless it no longer has
/// the content Folio expects (`expected_sha256`, hex) and the user did not
/// confirm overwriting it. The file must also stay unchanged (size,
/// modification time, identity) while it is hashed and until the new
/// version takes its place; otherwise nothing is written.
pub fn write_back(
    path: &Path,
    bytes: &[u8],
    expected_sha256: Option<&str>,
    overwrite: bool,
) -> WriteOutcome {
    let stamp = match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => FileStamp::from_metadata(path, &metadata),
        Ok(_) => return WriteOutcome::unavailable(MISSING_MESSAGE),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return WriteOutcome::unavailable(MISSING_MESSAGE)
        }
        Err(_) => return WriteOutcome::unavailable(UNWRITABLE_MESSAGE),
    };
    if !overwrite {
        let Some(expected) = expected_sha256 else {
            return WriteOutcome::ChangedOnDisk;
        };
        match sha256_file(path) {
            Ok(actual) if actual.eq_ignore_ascii_case(expected) => {}
            Ok(_) => return WriteOutcome::ChangedOnDisk,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return WriteOutcome::unavailable(MISSING_MESSAGE)
            }
            Err(_) => return WriteOutcome::unavailable(UNWRITABLE_MESSAGE),
        }
        if FileStamp::of(path).ok().as_ref() != Some(&stamp) {
            return WriteOutcome::ChangedOnDisk;
        }
    }
    match replace_file(path, bytes, Some(&stamp)) {
        Ok(()) => WriteOutcome::Saved,
        Err(ReplaceError::Changed) => WriteOutcome::ChangedOnDisk,
        Err(ReplaceError::KeptCopy(name)) => WriteOutcome::KeptCopy {
            message: SaveError::KeptCopy(name.clone()).to_string(),
            name,
        },
        Err(ReplaceError::Failed(SaveError::ReadOnly)) => {
            WriteOutcome::unavailable(READ_ONLY_MESSAGE)
        }
        Err(ReplaceError::Failed(_)) => WriteOutcome::unavailable(UNWRITABLE_MESSAGE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    const PDF: &[u8] = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n";

    #[test]
    fn accepts_pdf_data_only() {
        assert_eq!(check_pdf(PDF), Ok(()));
        let mut prefixed = b"garbage before the header\n".to_vec();
        prefixed.extend_from_slice(PDF);
        assert_eq!(check_pdf(&prefixed), Ok(()));
        assert_eq!(check_pdf(b"#!/bin/sh\nrm -rf ~\n"), Err(SaveError::NotPdf));
        assert_eq!(check_pdf(b""), Err(SaveError::NotPdf));
        let mut late = vec![b' '; 1100];
        late.extend_from_slice(PDF);
        assert_eq!(check_pdf(&late), Err(SaveError::NotPdf));
    }

    #[test]
    fn proposes_a_plain_pdf_file_name() {
        assert_eq!(suggested_file_name(Some("Report.pdf")), "Report.pdf");
        assert_eq!(suggested_file_name(Some("Report.PDF")), "Report.PDF");
        assert_eq!(suggested_file_name(Some("Report")), "Report.pdf");
        assert_eq!(
            suggested_file_name(Some("Rapport%20annuel%20%C3%A9t%C3%A9.pdf")),
            "Rapport annuel été.pdf"
        );
        assert_eq!(
            suggested_file_name(Some("..%2F..%2F.ssh%2Fauthorized_keys")),
            "authorized_keys.pdf"
        );
        assert_eq!(
            suggested_file_name(Some("C:%5CWindows%5Cevil.exe")),
            "evil.exe.pdf"
        );
        assert_eq!(suggested_file_name(Some("a%3Cb%3E%7C%00c.pdf")), "abc.pdf");
        assert_eq!(suggested_file_name(Some("...")), "Document.pdf");
        assert_eq!(suggested_file_name(None), "Document.pdf");
    }

    #[test]
    fn limits_names_to_200_bytes_and_keeps_the_extension() {
        let ascii = sanitize_file_name(&"x".repeat(500));
        assert_eq!(ascii.len(), 200);
        assert!(ascii.ends_with(".pdf"));
        // Two bytes per character: the cut falls between characters.
        let accented = sanitize_file_name(&format!("{}.PDF", "é".repeat(300)));
        assert!(accented.len() <= 200);
        assert!(accented.ends_with("é.PDF"));
        // Four bytes per character.
        let emoji = sanitize_file_name(&"📄".repeat(100));
        assert!(emoji.len() <= 200 && emoji.ends_with(".pdf"));
        assert!(emoji.trim_end_matches(".pdf").chars().all(|c| c == '📄'));
        // A cut must not leave a trailing dot or space before the extension.
        let dotted = sanitize_file_name(&format!("{}. x", "a".repeat(195)));
        assert_eq!(dotted, format!("{}.pdf", "a".repeat(195)));
    }

    #[test]
    fn drops_invisible_formatting_characters() {
        // The right-to-left override would show "reportexe.pdf".
        assert_eq!(
            sanitize_file_name("report\u{202E}fdp.exe"),
            "reportfdp.exe.pdf"
        );
        assert_eq!(
            sanitize_file_name("\u{FEFF}a\u{200B}b\u{200E}\u{2066}c\u{2069}.pdf"),
            "abc.pdf"
        );
        // Line breaks of any kind, and fillers that only look like space.
        assert_eq!(
            sanitize_file_name(
                "a\u{2028}b\u{2029}c\u{115F}\u{1160}d\u{3164}e\u{FFA0}f\u{2800}.pdf"
            ),
            "abcdef.pdf"
        );
        assert_eq!(sanitize_file_name("\u{3164}\u{2800}"), "Document.pdf");
        // Joiners are part of scripts and emoji.
        let family = "👨\u{200D}👩\u{200D}👧.pdf";
        assert_eq!(sanitize_file_name(family), family);
        assert_eq!(sanitize_file_name("\u{202E}\u{202E}"), "Document.pdf");
    }

    #[test]
    fn writes_through_a_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("copy.pdf");
        std::fs::write(&target, b"old contents").unwrap();
        write_atomically(&target, PDF).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), PDF);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, vec![OsString::from("copy.pdf")]);
    }

    #[test]
    fn recognizes_only_folios_own_leftover_names() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            leftover_kind(&format!(".folio-{id}.tmp")),
            Some(Leftover::Temporary)
        );
        assert_eq!(
            leftover_kind(&format!(".folio-{id}.bak")),
            Some(Leftover::Backup)
        );
        for name in [
            format!(".folio-{}.tmp", id.to_uppercase()),
            format!(".folio-{id}.tmp.pdf"),
            format!(".folio-{id}.TMP"),
            format!(".folio-{id}0.tmp"),
            format!(".folio-{}.tmp", &id[1..]),
            format!("folio-{id}.tmp"),
            format!(".folio-{}g.tmp", &id[1..]),
            ".folio-.tmp".to_owned(),
            ".tmp-0123".to_owned(),
            "Report.pdf".to_owned(),
        ] {
            assert_eq!(leftover_kind(&name), None, "{name}");
        }
    }

    /// Sets a file's modification time `age` into the past.
    fn age(path: &Path, age: Duration) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn later_saves_delete_only_folios_old_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = |name: &str| dir.path().join(name);
        let id = |n: u8| format!("{:032x}", u128::from(n));
        let two_hours = Duration::from_secs(2 * 60 * 60);
        let stale = path(&format!(".folio-{}.tmp", id(1)));
        let fresh = path(&format!(".folio-{}.tmp", id(2)));
        let unlike = [
            path(&format!(".folio-{}.tmp.pdf", id(3))),
            path(&format!(
                ".folio-{}.tmp",
                id(4).to_uppercase().replace('0', "A")
            )),
            path("Report.pdf"),
        ];
        for file in [&stale, &fresh].into_iter().chain(&unlike) {
            std::fs::write(file, b"x").unwrap();
        }
        for file in [&stale].into_iter().chain(&unlike) {
            age(file, two_hours);
        }
        // A folder with Folio's name, and a link to someone's file.
        let folder = path(&format!(".folio-{}.tmp", id(5)));
        std::fs::create_dir(&folder).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("important.pdf");
        std::fs::write(&target, b"keep").unwrap();
        age(&target, two_hours);
        #[cfg(unix)]
        let link = {
            let link = path(&format!(".folio-{}.tmp", id(6)));
            std::os::unix::fs::symlink(&target, &link).unwrap();
            Some(link)
        };
        #[cfg(not(unix))]
        let link: Option<PathBuf> = None;

        // Saving something else into the folder.
        write_atomically(&path("saved.pdf"), PDF).unwrap();
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(unlike.iter().all(|file| file.exists()));
        assert!(folder.is_dir());
        // Even once everything is old.
        remove_stale_files(dir.path(), SystemTime::now() + two_hours);
        assert!(!fresh.exists());
        assert!(unlike.iter().all(|file| file.exists()));
        assert!(folder.is_dir());
        if let Some(link) = link {
            assert!(std::fs::symlink_metadata(&link).is_ok());
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    }

    #[test]
    fn keeps_previous_versions_folio_had_to_keep() {
        let dir = tempfile::tempdir().unwrap();
        let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);
        // Not marked as disposable: the only copy of a previous version
        // (and on Unix not Folio's at all). An interrupted replace may have
        // left the new version in the temporary file next to it.
        let kept = dir.path().join(format!(".folio-{:032x}.bak", 7));
        let temporary = dir.path().join(format!(".folio-{:032x}.tmp", 8));
        std::fs::write(&kept, b"previous").unwrap();
        std::fs::write(&temporary, b"new").unwrap();
        remove_stale_files(dir.path(), later);
        assert!(kept.exists() && temporary.exists());
        #[cfg(windows)]
        {
            // A backup that could not be deleted after a replace.
            mark_disposable(&kept);
            remove_stale_files(dir.path(), later);
            assert!(!kept.exists() && !temporary.exists());
        }
    }

    #[test]
    fn reports_and_cleans_up_failed_writes() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing").join("copy.pdf");
        assert_eq!(write_atomically(&missing, PDF), Err(SaveError::WriteFailed));
        // A directory where the file should go cannot be replaced.
        let blocked = dir.path().join("blocked.pdf");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("inside"), b"keep").unwrap();
        assert_eq!(write_atomically(&blocked, PDF), Err(SaveError::WriteFailed));
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("blocked.pdf")]);
    }

    #[test]
    fn keeps_permissions_and_refuses_read_only_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("private.pdf");
        std::fs::write(&target, b"old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
            write_atomically(&target, PDF).unwrap();
            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let mut permissions = std::fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&target, permissions).unwrap();
        let before = std::fs::read(&target).unwrap();
        assert_eq!(
            write_atomically(&target, b"%PDF-2.0 new"),
            Err(SaveError::ReadOnly)
        );
        assert_eq!(std::fs::read(&target).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn writes_privately_and_gives_new_files_the_usual_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let temporary = dir.path().join(".probe");
        drop(create_private_file(&temporary).unwrap());
        let mode = std::fs::metadata(&temporary).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        let mode = default_file_mode();
        // Reading the umask leaves it as it was.
        assert_eq!(default_file_mode(), mode);
        let target = dir.path().join("new.pdf");
        write_atomically(&target, PDF).unwrap();
        let written = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(written & 0o777, mode);
    }

    #[test]
    fn keeps_a_file_that_changes_while_it_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.pdf");
        std::fs::write(&target, b"%PDF-1.4 old").unwrap();
        let stamp = FileStamp::of(&target).unwrap();
        std::fs::write(&target, b"%PDF-1.4 edited meanwhile").unwrap();
        assert_eq!(
            replace_file(&target, PDF, Some(&stamp)),
            Err(ReplaceError::Changed)
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"%PDF-1.4 edited meanwhile"
        );
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("a.pdf")]);
        // An unchanged file is replaced.
        let stamp = FileStamp::of(&target).unwrap();
        assert_eq!(replace_file(&target, PDF, Some(&stamp)), Ok(()));
        assert_eq!(std::fs::read(&target).unwrap(), PDF);
    }

    #[test]
    fn leaves_nothing_behind_when_the_file_goes_away_while_it_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.pdf");
        std::fs::write(&target, b"%PDF-1.4 old").unwrap();
        let stamp = FileStamp::of(&target).unwrap();
        std::fs::remove_file(&target).unwrap();
        assert_eq!(
            replace_file(&target, PDF, Some(&stamp)),
            Err(ReplaceError::Changed)
        );
        // Save does not bring the file back, nor leave its temporary file.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        assert_eq!(
            write_back(&target, PDF, Some(&sha256_hex(b"%PDF-1.4 old")), false),
            WriteOutcome::unavailable(MISSING_MESSAGE)
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_new_file_keeps_its_private_mode_when_it_cannot_get_the_usual_one() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let temporary = dir.path().join(".probe");
        drop(create_private_file(&temporary).unwrap());
        // A missing temporary file cannot be changed: still no error.
        finish_permissions(
            &dir.path().join(".missing"),
            &dir.path().join("new.pdf"),
            None,
        )
        .unwrap();
        finish_permissions(&temporary, &dir.path().join("new.pdf"), None).unwrap();
        let mode = std::fs::metadata(&temporary).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, default_file_mode());
        // The mode of a file that is replaced must carry over.
        let existing = std::fs::metadata(&temporary).unwrap();
        assert!(
            finish_permissions(&dir.path().join(".missing"), &temporary, Some(&existing)).is_err()
        );
    }

    #[test]
    fn notices_a_file_replaced_by_one_of_the_same_size_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.pdf");
        std::fs::write(&target, b"%PDF-1.4 one").unwrap();
        let stamp = FileStamp::of(&target).unwrap();
        let other = dir.path().join("b.pdf");
        std::fs::write(&other, b"%PDF-1.4 two").unwrap();
        let modified = std::fs::metadata(&target).unwrap().modified().unwrap();
        std::fs::File::options()
            .write(true)
            .open(&other)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        std::fs::rename(&other, &target).unwrap();
        assert_ne!(FileStamp::of(&target).unwrap(), stamp);
    }

    #[test]
    fn sanitizes_names_without_decoding_them() {
        assert_eq!(sanitize_file_name("100%25 done"), "100%25 done.pdf");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd.pdf");
        assert_eq!(sanitize_file_name("a\u{0}b|c.pdf"), "abc.pdf");
        assert_eq!(sanitize_file_name(""), "Document.pdf");
    }

    #[test]
    fn hashes_files_like_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        std::fs::write(&path, PDF).unwrap();
        assert_eq!(sha256_file(&path).unwrap(), sha256_hex(PDF));
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert!(is_sha256_hex(&sha256_hex(b"abc")));
        assert!(is_sha256_hex(&sha256_hex(b"abc").to_uppercase()));
        assert!(!is_sha256_hex("abc"));
        assert!(!is_sha256_hex(&"g".repeat(64)));
    }

    #[test]
    fn writes_back_when_the_file_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        std::fs::write(&path, b"%PDF-1.4 old").unwrap();
        let expected = sha256_hex(b"%PDF-1.4 old").to_uppercase();
        assert_eq!(
            write_back(&path, PDF, Some(&expected), false),
            WriteOutcome::Saved
        );
        assert_eq!(std::fs::read(&path).unwrap(), PDF);
    }

    #[test]
    fn refuses_to_write_back_over_changes_made_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        std::fs::write(&path, b"%PDF-1.4 old").unwrap();
        let stale = sha256_hex(b"%PDF-1.4 old");
        std::fs::write(&path, b"%PDF-1.4 edited elsewhere").unwrap();
        assert_eq!(
            write_back(&path, PDF, Some(&stale), false),
            WriteOutcome::ChangedOnDisk
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4 edited elsewhere");
        assert_eq!(
            write_back(&path, PDF, None, false),
            WriteOutcome::ChangedOnDisk
        );
        // The user confirmed overwriting the other changes.
        assert_eq!(
            write_back(&path, PDF, Some(&stale), true),
            WriteOutcome::Saved
        );
        assert_eq!(std::fs::read(&path).unwrap(), PDF);
    }

    #[test]
    fn reports_files_that_cannot_be_written_back() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("moved.pdf");
        assert_eq!(
            write_back(&missing, PDF, Some(&sha256_hex(b"")), false),
            WriteOutcome::unavailable(MISSING_MESSAGE)
        );
        assert!(!missing.exists());
        let folder = dir.path().join("folder.pdf");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            write_back(&folder, PDF, None, true),
            WriteOutcome::unavailable(MISSING_MESSAGE)
        );

        let locked = dir.path().join("locked.pdf");
        std::fs::write(&locked, b"%PDF-1.4 locked").unwrap();
        let mut permissions = std::fs::metadata(&locked).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&locked, permissions).unwrap();
        let expected = sha256_hex(b"%PDF-1.4 locked");
        assert_eq!(
            write_back(&locked, PDF, Some(&expected), false),
            WriteOutcome::unavailable(READ_ONLY_MESSAGE)
        );
        assert_eq!(std::fs::read(&locked).unwrap(), b"%PDF-1.4 locked");
        for message in [MISSING_MESSAGE, READ_ONLY_MESSAGE, UNWRITABLE_MESSAGE] {
            assert!(!message.contains(&*dir.path().to_string_lossy()));
        }
    }

    #[test]
    fn write_outcomes_match_the_frontend_contract() {
        let json = |outcome: WriteOutcome| serde_json::to_value(outcome).unwrap();
        assert_eq!(
            json(WriteOutcome::Saved),
            serde_json::json!({ "status": "saved" })
        );
        assert_eq!(
            json(WriteOutcome::ChangedOnDisk),
            serde_json::json!({ "status": "changed-on-disk" })
        );
        assert_eq!(
            json(WriteOutcome::unavailable("Gone.")),
            serde_json::json!({ "status": "unavailable", "message": "Gone." })
        );
        let kept = SaveError::KeptCopy(".folio-0123.bak".into());
        assert_eq!(kept.code(), "kept-copy");
        assert!(kept.to_string().contains("\u{201c}.folio-0123.bak\u{201d}"));
        assert_eq!(
            json(WriteOutcome::KeptCopy {
                name: ".folio-0123.bak".into(),
                message: kept.to_string(),
            }),
            serde_json::json!({
                "status": "kept-copy",
                "name": ".folio-0123.bak",
                "message": kept.to_string(),
            })
        );
    }

    #[test]
    fn saves_under_the_longest_names_the_file_system_allows() {
        let dir = tempfile::tempdir().unwrap();
        // 251 bytes plus ".pdf" is the usual 255-byte limit for a file name.
        let target = dir.path().join(format!("{}.pdf", "a".repeat(251)));
        write_atomically(&target, PDF).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), PDF);
    }
}
