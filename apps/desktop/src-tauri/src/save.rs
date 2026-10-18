//! "Save a copy": writing PDF data from the webview to a file the user chose
//! in the native save dialog. The webview never names a path; it proposes a
//! file name and gets the chosen file's name back.

use crate::files::MAX_FILE_BYTES;
use std::io::Write;
use std::path::Path;

/// Header carrying the proposed file name, percent-encoded (headers are ASCII).
pub const NAME_HEADER: &str = "x-folio-name";
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
    let decoded = header
        .map(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8_lossy()
                .into_owned()
        })
        .unwrap_or_default();
    let last = decoded.rsplit(['/', '\\']).next().unwrap_or_default();
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
    fn saves_under_the_longest_names_the_file_system_allows() {
        let dir = tempfile::tempdir().unwrap();
        // 251 bytes plus ".pdf" is the usual 255-byte limit for a file name.
        let target = dir.path().join(format!("{}.pdf", "a".repeat(251)));
        write_atomically(&target, PDF).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), PDF);
    }
}
