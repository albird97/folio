//! Saving: "Save As" and "Save a Copy" write PDF data from the webview to a
//! file the user chose in the native save dialog; "Save" writes it back to a
//! file the user granted before (by token). The webview never names a path;
//! it proposes a file name and gets the chosen file's name back.

use crate::files::MAX_FILE_BYTES;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;

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
const MAX_NAME_CHARS: usize = 200;

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
}

impl SaveError {
    pub fn code(&self) -> &'static str {
        match self {
            SaveError::NotPdf => "not-pdf",
            SaveError::TooLarge => "too-large",
            SaveError::InvalidRequest => "invalid-request",
            SaveError::WriteFailed => "write-failed",
            SaveError::ReadOnly => "read-only",
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

/// A plain file name for `name`: its last path component, without characters
/// file systems reject, at most 200 characters before the `.pdf` it ends in.
pub fn sanitize_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let stem = if trimmed.is_empty() {
        FALLBACK_NAME.to_string()
    } else {
        trimmed.chars().take(MAX_NAME_CHARS).collect()
    };
    if stem.to_lowercase().ends_with(".pdf") {
        stem
    } else {
        format!("{stem}.pdf")
    }
}

/// Writes `bytes` to `target` through a temporary file in the same folder
/// and a rename, so an interrupted or failed save never leaves a truncated
/// file. A file that is replaced keeps its permissions; read-only files are
/// refused. The temporary file is removed when anything fails.
pub fn write_atomically(target: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    let directory = target.parent().ok_or(SaveError::WriteFailed)?;
    let existing = std::fs::metadata(target).ok();
    if let Some(metadata) = &existing {
        if metadata.is_dir() {
            return Err(SaveError::WriteFailed);
        }
        if metadata.permissions().readonly() {
            return Err(SaveError::ReadOnly);
        }
    }
    // Short and fixed-length, so any name the file system accepts for the
    // target also works here.
    let temporary = directory.join(format!(".folio-{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Some(metadata) = &existing {
            std::fs::set_permissions(&temporary, metadata.permissions())?;
        }
        std::fs::rename(&temporary, target)?;
        // Make the rename itself durable.
        #[cfg(unix)]
        if let Ok(folder) = std::fs::File::open(directory) {
            let _ = folder.sync_all();
        }
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(SaveError::WriteFailed);
    }
    Ok(())
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
/// confirm overwriting it. Writes go through [`write_atomically`].
pub fn write_back(
    path: &Path,
    bytes: &[u8],
    expected_sha256: Option<&str>,
    overwrite: bool,
) -> WriteOutcome {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return WriteOutcome::unavailable(MISSING_MESSAGE),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return WriteOutcome::unavailable(MISSING_MESSAGE)
        }
        Err(_) => return WriteOutcome::unavailable(UNWRITABLE_MESSAGE),
    }
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
    }
    match write_atomically(path, bytes) {
        Ok(()) => WriteOutcome::Saved,
        Err(SaveError::ReadOnly) => WriteOutcome::unavailable(READ_ONLY_MESSAGE),
        Err(_) => WriteOutcome::unavailable(UNWRITABLE_MESSAGE),
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
        assert!(suggested_file_name(Some(&"x".repeat(500))).chars().count() <= 204);
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
