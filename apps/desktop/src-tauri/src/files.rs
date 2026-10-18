//! User-granted file access.
//!
//! The webview never receives or sends filesystem paths. A path becomes
//! readable only after the user chose it (dialog, drag and drop, launch
//! arguments, Finder/Explorer), at which point it is registered here under an
//! unguessable token. Commands accept tokens, never paths, so script running
//! in the webview cannot read arbitrary files.

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Largest file Folio will load into the webview.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantedFile {
    pub token: String,
    /// File name only, for display. Never the full path.
    pub name: String,
    pub size: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FileError {
    #[error("This file is no longer available to Folio.")]
    UnknownToken,
    #[error("Only PDF files can be opened.")]
    NotPdf,
    #[error("The file could not be found.")]
    NotFound,
    #[error("This file is larger than Folio can open.")]
    TooLarge,
    #[error("The file could not be read.")]
    Unreadable,
}

impl FileError {
    pub fn code(&self) -> &'static str {
        match self {
            FileError::UnknownToken => "unknown-token",
            FileError::NotPdf => "not-pdf",
            FileError::NotFound => "not-found",
            FileError::TooLarge => "too-large",
            FileError::Unreadable => "unreadable",
        }
    }
}

/// Mirrors the frontend rule (`isLikelyPdfName`): `.pdf` files, plus
/// extensionless files that content sniffing will accept or reject.
pub fn is_likely_pdf(path: &Path) -> bool {
    match path.extension() {
        None => true,
        Some(extension) => extension.eq_ignore_ascii_case("pdf"),
    }
}

/// Picks file arguments out of a command line (file associations on Windows
/// and Linux pass the document path as an argument).
pub fn paths_from_args(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|arg| !arg.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .filter(|path| path.is_file())
        .collect()
}

#[derive(Debug)]
struct Grant {
    path: PathBuf,
}

#[derive(Debug, Default)]
pub struct FileGrants {
    grants: Mutex<HashMap<String, Grant>>,
}

impl FileGrants {
    /// Registers a user-chosen file and returns its token.
    pub fn grant(&self, path: &Path) -> Result<GrantedFile, FileError> {
        if !is_likely_pdf(path) {
            return Err(FileError::NotPdf);
        }
        let canonical = std::fs::canonicalize(path).map_err(|_| FileError::NotFound)?;
        let metadata = std::fs::metadata(&canonical).map_err(|_| FileError::NotFound)?;
        if !metadata.is_file() {
            return Err(FileError::NotFound);
        }
        let name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled.pdf".to_owned());
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.lock().insert(token.clone(), Grant { path: canonical });
        Ok(GrantedFile {
            token,
            name,
            size: metadata.len(),
        })
    }

    pub fn path(&self, token: &str) -> Result<PathBuf, FileError> {
        self.lock()
            .get(token)
            .map(|grant| grant.path.clone())
            .ok_or(FileError::UnknownToken)
    }

    pub fn release(&self, token: &str) -> bool {
        self.lock().remove(token).is_some()
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Grant>> {
        // A poisoned lock only means another command panicked mid-update; the
        // map itself is still consistent.
        self.grants
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Reads a granted file, enforcing the size limit on the current file size.
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, FileError> {
    let metadata = std::fs::metadata(path).map_err(|_| FileError::NotFound)?;
    if !metadata.is_file() {
        return Err(FileError::NotFound);
    }
    if metadata.len() > limit {
        return Err(FileError::TooLarge);
    }
    std::fs::read(path).map_err(|_| FileError::Unreadable)
}

#[derive(Debug, Default)]
struct LaunchState {
    frontend_ready: bool,
    files: Vec<GrantedFile>,
    skipped: Vec<String>,
}

/// Holds files opened before the UI is listening (launch arguments, Finder
/// open events at startup). Once the UI has drained the queue, new files are
/// delivered as events instead.
#[derive(Debug, Default)]
pub struct LaunchQueue {
    state: Mutex<LaunchState>,
}

impl LaunchQueue {
    /// Returns the batch to emit now, or `None` if it was queued for later.
    pub fn offer(
        &self,
        files: Vec<GrantedFile>,
        skipped: Vec<String>,
    ) -> Option<(Vec<GrantedFile>, Vec<String>)> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.frontend_ready {
            return Some((files, skipped));
        }
        state.files.extend(files);
        state.skipped.extend(skipped);
        None
    }

    /// Drains queued files and switches to event delivery.
    pub fn drain(&self) -> (Vec<GrantedFile>, Vec<String>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.frontend_ready = true;
        (
            std::mem::take(&mut state.files),
            std::mem::take(&mut state.skipped),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PDF: &[u8] = b"%PDF-1.7\n%test\n";

    fn temp_pdf(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, PDF).unwrap();
        path
    }

    #[test]
    fn grants_pdf_files_and_reads_them_by_token() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        let granted = grants.grant(&temp_pdf(dir.path(), "Report.PDF")).unwrap();
        assert_eq!(granted.name, "Report.PDF");
        assert_eq!(granted.size, PDF.len() as u64);
        assert_eq!(granted.token.len(), 32);
        let path = grants.path(&granted.token).unwrap();
        assert_eq!(read_limited(&path, MAX_FILE_BYTES).unwrap(), PDF);
    }

    #[test]
    fn never_exposes_paths_in_granted_files() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        let granted = grants.grant(&temp_pdf(dir.path(), "a.pdf")).unwrap();
        let json = serde_json::to_string(&granted).unwrap();
        assert!(!json.contains(&dir.path().to_string_lossy().to_string()));
    }

    #[test]
    fn rejects_other_file_types_directories_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        let image = dir.path().join("photo.png");
        fs::write(&image, b"png").unwrap();
        assert_eq!(grants.grant(&image), Err(FileError::NotPdf));
        assert_eq!(
            grants.grant(&dir.path().join("missing.pdf")),
            Err(FileError::NotFound)
        );
        let folder = dir.path().join("folder.pdf");
        fs::create_dir(&folder).unwrap();
        assert_eq!(grants.grant(&folder), Err(FileError::NotFound));
        assert!(grants.is_empty());
    }

    #[test]
    fn accepts_extensionless_files_for_content_sniffing() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        assert!(grants.grant(&temp_pdf(dir.path(), "download")).is_ok());
    }

    #[test]
    fn unknown_and_released_tokens_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        let granted = grants.grant(&temp_pdf(dir.path(), "a.pdf")).unwrap();
        assert_eq!(grants.path("not-a-token"), Err(FileError::UnknownToken));
        assert!(grants.release(&granted.token));
        assert!(!grants.release(&granted.token));
        assert_eq!(grants.path(&granted.token), Err(FileError::UnknownToken));
    }

    #[test]
    fn tokens_are_unique_per_grant() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        let path = temp_pdf(dir.path(), "a.pdf");
        let first = grants.grant(&path).unwrap();
        let second = grants.grant(&path).unwrap();
        assert_ne!(first.token, second.token);
        assert_eq!(grants.len(), 2);
    }

    #[test]
    fn enforces_the_size_limit_at_read_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_pdf(dir.path(), "a.pdf");
        assert_eq!(read_limited(&path, 4), Err(FileError::TooLarge));
        fs::remove_file(&path).unwrap();
        assert_eq!(
            read_limited(&path, MAX_FILE_BYTES),
            Err(FileError::NotFound)
        );
    }

    #[test]
    fn picks_existing_file_arguments_and_resolves_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        temp_pdf(dir.path(), "a.pdf");
        let args = ["--flag", "a.pdf", "missing.pdf", "-psn_0_12345"].map(OsString::from);
        let paths = paths_from_args(args, dir.path());
        assert_eq!(paths, vec![dir.path().join("a.pdf")]);
    }

    #[test]
    fn launch_queue_buffers_until_the_frontend_drains_it() {
        let queue = LaunchQueue::default();
        let file = GrantedFile {
            token: "t".into(),
            name: "a.pdf".into(),
            size: 1,
        };
        assert_eq!(queue.offer(vec![file.clone()], vec!["b.png".into()]), None);
        let (files, skipped) = queue.drain();
        assert_eq!(files, vec![file.clone()]);
        assert_eq!(skipped, vec!["b.png".to_string()]);
        assert_eq!(
            queue.offer(vec![file.clone()], vec![]),
            Some((vec![file], vec![]))
        );
        assert_eq!(queue.drain(), (vec![], vec![]));
    }
}
