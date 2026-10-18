//! Saving: "Save As" and "Save a Copy" write PDF data from the webview to a
//! file the user chose in the native save dialog; "Save" writes it back to a
//! file the user granted before (by token). The webview never names a path;
//! it proposes a file name and gets the chosen file's name back.

use crate::files::MAX_FILE_BYTES;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::Metadata;
use std::io::{Read, Write};
use std::path::Path;
use std::time::SystemTime;

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
/// File systems count names in bytes (usually 255); this leaves room.
const MAX_NAME_BYTES: usize = 200;

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

/// Invisible formatting characters (Unicode category Cf) that can disguise a
/// name, such as the right-to-left override (U+202E) that makes
/// `report<U+202E>fdp.exe` read as `reportexe.pdf`. The joiners U+200C and
/// U+200D stay: scripts and emoji need them.
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
    )
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
    let cleaned: String = last
        .chars()
        .filter(|&c| {
            !c.is_control()
                && !is_hidden_format_character(c)
                && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
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
    /// The target no longer matches the stamp it was checked against.
    Changed,
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
fn finish_permissions(
    temporary: &Path,
    target: &Path,
    existing: Option<&Metadata>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = match existing {
            Some(metadata) => metadata.permissions().mode() & 0o7777,
            None => default_file_mode(),
        };
        std::fs::set_permissions(temporary, std::fs::Permissions::from_mode(mode))?;
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

/// Moves the temporary file over the target. Windows replaces existing
/// files with `ReplaceFileW`, which keeps their attributes and ACL.
#[cfg(windows)]
fn swap_into_place(temporary: &Path, target: &Path, replacing: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS};
    if !replacing {
        return std::fs::rename(temporary, target);
    }
    let wide =
        |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (target_wide, temporary_wide) = (wide(target), wide(temporary));
    // SAFETY: both paths are NUL-terminated; the optional arguments are null.
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_IGNORE_MERGE_ERRORS,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    // The old file is gone but the new one kept its temporary name.
    if error.raw_os_error() == Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT as i32) && !target.exists() {
        return std::fs::rename(temporary, target);
    }
    Err(error)
}

#[cfg(not(windows))]
fn swap_into_place(temporary: &Path, target: &Path, _replacing: bool) -> std::io::Result<()> {
    std::fs::rename(temporary, target)
}

/// Writes `bytes` over `target` through a private temporary file in the same
/// folder. With `unchanged`, the target must still match that stamp right
/// before it is replaced.
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
        swap_into_place(&temporary, target, existing.is_some())?;
        // Make the rename itself durable.
        #[cfg(unix)]
        if let Ok(folder) = std::fs::File::open(directory) {
            let _ = folder.sync_all();
        }
        Ok(())
    })();
    // Never delete the only remaining copy of the document.
    if written.is_err() && (target.exists() || existing.is_none()) {
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
