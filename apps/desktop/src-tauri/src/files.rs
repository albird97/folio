//! User-granted file access.
//!
//! A path becomes readable only after the user chose it (dialog, drag and
//! drop, launch arguments, Finder/Explorer), at which point it is registered
//! here under an unguessable token. Commands accept tokens, never paths, so
//! script running in the webview can never read a file it was not granted.
//! Folio's own commands and events only hand the webview tokens and file
//! names; it does not need or receive paths. (`core:event:allow-listen`
//! cannot be scoped by event name, so a compromised page could still
//! subscribe to Tauri's built-in `tauri://drag-*` events, which do carry
//! paths. It still could not read those files.)
//!
//! Folio's own data folder and documents in a Chrome spool are never
//! granted or remembered as ordinary files (see [`is_reserved_path`]): a
//! document from Chrome only opens after the user accepts its transfer.

use crate::incoming;
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

/// What the UI receives for a batch of user-chosen paths: tokens for the files
/// that were granted, and only the names of those that were not.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFiles {
    pub files: Vec<GrantedFile>,
    /// Names of files that are not PDFs.
    pub skipped: Vec<String>,
    /// Names of files that could no longer be found when they were granted.
    pub unavailable: Vec<String>,
    /// Names of files Folio does not open as ordinary files: its own data
    /// and documents in a Chrome spool (see [`is_reserved_path`]).
    pub refused: Vec<String>,
}

impl OpenedFiles {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
            && self.skipped.is_empty()
            && self.unavailable.is_empty()
            && self.refused.is_empty()
    }

    fn append(&mut self, other: OpenedFiles) {
        self.files.extend(other.files);
        self.skipped.extend(other.skipped);
        self.unavailable.extend(other.unavailable);
        self.refused.extend(other.refused);
    }
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
    #[error("Folio does not open files from its own data folder.")]
    Reserved,
}

impl FileError {
    pub fn code(&self) -> &'static str {
        match self {
            FileError::UnknownToken => "unknown-token",
            FileError::NotPdf => "not-pdf",
            FileError::NotFound => "not-found",
            FileError::TooLarge => "too-large",
            FileError::Unreadable => "unreadable",
            FileError::Reserved => "reserved",
        }
    }
}

/// Mirrors the frontend rule (`isLikelyPdfName` in `packages/editor`): a name
/// only counts as another file type when it ends in `.` plus 1 to 8 ASCII
/// letters or digits other than `pdf`. Everything else (no extension, or an
/// unusual one such as in `Invoice No. 4711` or `notes.v2_final`) is left to
/// content sniffing. Both rules are tested against the same table,
/// `apps/desktop/src/platform/pdf-name-cases.json`.
pub fn is_likely_pdf_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        None => true,
        Some((_, extension)) => {
            let typed = (1..=8).contains(&extension.len())
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric());
            !typed || extension.eq_ignore_ascii_case("pdf")
        }
    }
}

/// Applies [`is_likely_pdf_name`] to the chosen path's file name, which is also
/// the name the UI is given. Names that are not valid UTF-8 are compared in
/// their lossy form, as the UI gets them.
pub fn is_likely_pdf(path: &Path) -> bool {
    path.file_name()
        .is_none_or(|name| is_likely_pdf_name(&name.to_string_lossy()))
}

/// Whether Folio must not open, grant or remember `path` as an ordinary
/// file: it is inside Folio's data folder (`data_dir`), or it looks like a
/// document in a Chrome spool (`…/incoming/<uuid>/document.pdf`), whichever
/// Folio it belongs to. Both the path as given and where it really leads
/// count, so links do not get around it. Missing files are judged by where
/// they would be.
pub fn is_reserved_path(path: &Path, data_dir: Option<&Path>) -> bool {
    let resolved = std::fs::canonicalize(path).ok().or_else(|| {
        let folder = std::fs::canonicalize(path.parent()?).ok()?;
        Some(folder.join(path.file_name()?))
    });
    let spellings = [Some(path), resolved.as_deref()];
    if spellings
        .iter()
        .flatten()
        .any(|path| incoming::looks_like_spool_document(path))
    {
        return true;
    }
    let Some(data_dir) = data_dir else {
        return false;
    };
    let data_dir = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    spellings
        .iter()
        .flatten()
        .any(|path| path.starts_with(&data_dir))
}

/// Marks the id of a document the Chrome extension sent (see `incoming`). The
/// native messaging host starts Folio with it, and a running Folio receives
/// it through the single-instance plugin.
pub const INCOMING_ARG: &str = "--incoming";

/// What a command line asks Folio to open.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LaunchArgs {
    pub paths: Vec<PathBuf>,
    /// Ids following [`INCOMING_ARG`], unvalidated.
    pub incoming: Vec<String>,
}

/// Splits a command line (without the program name) into files to open and
/// transfers to offer.
pub fn parse_launch_args(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> LaunchArgs {
    let mut incoming = Vec::new();
    let mut rest = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == INCOMING_ARG {
            if let Some(id) = args.next() {
                incoming.push(id.to_string_lossy().into_owned());
            }
        } else {
            rest.push(arg);
        }
    }
    LaunchArgs {
        paths: paths_from_args(rest, cwd),
        incoming,
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
    /// Whether Save may write to the file. Documents received from the
    /// Chrome extension live in Folio's spool folder and are saved elsewhere.
    writable: bool,
    /// A folder Folio owns that is deleted once the grant is released.
    cleanup: Option<PathBuf>,
}

/// What a token gives access to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantInfo {
    pub path: PathBuf,
    pub writable: bool,
}

#[derive(Debug, Default)]
pub struct FileGrants {
    grants: Mutex<HashMap<String, Grant>>,
    /// Folio's data folder, whose files are never granted.
    data_dir: Option<PathBuf>,
}

impl FileGrants {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        FileGrants {
            grants: Mutex::default(),
            data_dir,
        }
    }

    /// See [`is_reserved_path`].
    pub fn is_reserved(&self, path: &Path) -> bool {
        is_reserved_path(path, self.data_dir.as_deref())
    }

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
        if self.is_reserved(path) {
            return Err(FileError::Reserved);
        }
        // The name the user chose (not the symlink target's), so the name the
        // UI shows is the one `is_likely_pdf` checked.
        let name = path
            .file_name()
            .or_else(|| canonical.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled.pdf".to_owned());
        Ok(self.insert(
            Grant {
                path: canonical,
                writable: true,
                cleanup: None,
            },
            name,
            metadata.len(),
        ))
    }

    /// Grants read access to a file in one of Folio's own folders under a
    /// display name, deleting `cleanup` when the grant is released. Such
    /// files cannot be written back to.
    pub fn grant_spooled(
        &self,
        path: &Path,
        name: &str,
        cleanup: &Path,
    ) -> Result<GrantedFile, FileError> {
        let metadata = std::fs::metadata(path).map_err(|_| FileError::NotFound)?;
        if !metadata.is_file() {
            return Err(FileError::NotFound);
        }
        Ok(self.insert(
            Grant {
                path: path.to_path_buf(),
                writable: false,
                cleanup: Some(cleanup.to_path_buf()),
            },
            name.to_owned(),
            metadata.len(),
        ))
    }

    fn insert(&self, grant: Grant, name: String, size: u64) -> GrantedFile {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.lock().insert(token.clone(), grant);
        GrantedFile { token, name, size }
    }

    /// Grants a batch of user-chosen paths. Everything that cannot be granted
    /// is reported by name so the UI can say why it did not open. Only folders
    /// with PDF-like names are left out; folders and packages with other
    /// typed names (`Photos.2024`, `Notes.rtfd`) are reported as skipped.
    pub fn grant_all(&self, paths: &[PathBuf]) -> OpenedFiles {
        let mut opened = OpenedFiles::default();
        for path in paths {
            let error = match self.grant(path) {
                Ok(file) => {
                    opened.files.push(file);
                    continue;
                }
                Err(error) => error,
            };
            let Some(name) = path.file_name() else {
                continue;
            };
            let name = name.to_string_lossy().into_owned();
            match error {
                FileError::NotPdf => opened.skipped.push(name),
                FileError::Reserved => opened.refused.push(name),
                _ if path.is_dir() => {}
                _ => opened.unavailable.push(name),
            }
        }
        opened
    }

    pub fn path(&self, token: &str) -> Result<PathBuf, FileError> {
        self.lookup(token).map(|grant| grant.path)
    }

    pub fn lookup(&self, token: &str) -> Result<GrantInfo, FileError> {
        self.lock()
            .get(token)
            .map(|grant| GrantInfo {
                path: grant.path.clone(),
                writable: grant.writable,
            })
            .ok_or(FileError::UnknownToken)
    }

    /// Forgets a token. Spooled files are deleted with their folder.
    pub fn release(&self, token: &str) -> bool {
        let Some(grant) = self.lock().remove(token) else {
            return false;
        };
        if let Some(folder) = grant.cleanup {
            let _ = std::fs::remove_dir_all(folder);
        }
        true
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

/// Reads a granted file, enforcing the size limit on what is actually read
/// (the file may grow after its size was checked).
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, FileError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => FileError::NotFound,
        _ => FileError::Unreadable,
    })?;
    let metadata = file.metadata().map_err(|_| FileError::Unreadable)?;
    if !metadata.is_file() {
        return Err(FileError::NotFound);
    }
    if metadata.len() > limit {
        return Err(FileError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FileError::Unreadable)?;
    if bytes.len() as u64 > limit {
        return Err(FileError::TooLarge);
    }
    Ok(bytes)
}

#[derive(Debug, Default)]
struct LaunchState {
    frontend_ready: bool,
    pending: OpenedFiles,
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
    pub fn offer(&self, opened: OpenedFiles) -> Option<OpenedFiles> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.frontend_ready {
            return Some(opened);
        }
        state.pending.append(opened);
        None
    }

    /// Drains queued files and switches to event delivery.
    pub fn drain(&self) -> OpenedFiles {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.frontend_ready = true;
        std::mem::take(&mut state.pending)
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
    fn never_grants_folios_own_files_or_spooled_documents() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        let grants = FileGrants::new(Some(data.clone()));
        // Folio's own data, also through a link.
        let own = temp_pdf(&data, "notes.pdf");
        assert_eq!(grants.grant(&own), Err(FileError::Reserved));
        #[cfg(unix)]
        {
            let link = dir.path().join("link.pdf");
            std::os::unix::fs::symlink(&own, &link).unwrap();
            assert_eq!(grants.grant(&link), Err(FileError::Reserved));
        }
        // A document in any Chrome spool, this Folio's or not.
        let spool = dir
            .path()
            .join("elsewhere")
            .join(incoming::INCOMING_DIR)
            .join(incoming::new_id());
        fs::create_dir_all(&spool).unwrap();
        let spooled = temp_pdf(&spool, incoming::DOCUMENT_FILE);
        assert_eq!(grants.grant(&spooled), Err(FileError::Reserved));
        assert!(grants.is_reserved(&data.join("missing.pdf")));
        let opened = grants.grant_all(&[own, spooled, temp_pdf(dir.path(), "ok.pdf")]);
        assert_eq!(opened.files.len(), 1);
        assert_eq!(opened.refused, ["notes.pdf", "document.pdf"]);
        assert!(opened.unavailable.is_empty() && opened.skipped.is_empty());
        // Ordinary files next to the data folder are fine.
        assert!(!grants.is_reserved(&dir.path().join("data-2").join("a.pdf")));
        assert!(!is_reserved_path(&dir.path().join("ok.pdf"), None));
    }

    #[test]
    fn accepts_extensionless_files_for_content_sniffing() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        assert!(grants.grant(&temp_pdf(dir.path(), "download")).is_ok());
    }

    #[test]
    fn leaves_unusual_extensions_to_content_sniffing() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        for name in [
            "Invoice No. 4711",
            "notes.v2_final",
            "report.20261018120000",
        ] {
            let granted = grants.grant(&temp_pdf(dir.path(), name));
            assert_eq!(granted.map(|file| file.name), Ok(name.to_owned()));
        }
    }

    /// The same table runs against `isLikelyPdfName` in the desktop unit tests.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NameCases {
        pdf: Vec<String>,
        not_pdf: Vec<String>,
    }

    #[test]
    fn pdf_name_rule_matches_the_frontend() {
        let cases: NameCases =
            serde_json::from_str(include_str!("../../src/platform/pdf-name-cases.json")).unwrap();
        for name in &cases.pdf {
            assert!(is_likely_pdf_name(name), "{name:?} should be tried");
            assert!(is_likely_pdf(Path::new(name)), "{name:?} should be tried");
        }
        for name in &cases.not_pdf {
            assert!(!is_likely_pdf_name(name), "{name:?} should be skipped");
            assert!(
                !is_likely_pdf(Path::new(name)),
                "{name:?} should be skipped"
            );
        }
    }

    #[test]
    fn reports_every_file_that_could_not_be_granted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        let image = dir.path().join("scan.tiff");
        fs::write(&image, b"tiff").unwrap();
        let folder = dir.path().join("Clients");
        fs::create_dir(&folder).unwrap();
        let typed_folder = dir.path().join("Photos.2024");
        fs::create_dir(&typed_folder).unwrap();
        let paths = [
            temp_pdf(dir.path(), "a.pdf"),
            image,
            dir.path().join("moved.pdf"),
            folder,
            typed_folder,
        ];
        let opened = grants.grant_all(&paths);
        let names: Vec<_> = opened.files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, ["a.pdf"]);
        assert_eq!(opened.skipped, ["scan.tiff", "Photos.2024"]);
        assert_eq!(opened.unavailable, ["moved.pdf"]);
        assert_eq!(grants.len(), 1);
        let json = serde_json::to_string(&opened).unwrap();
        assert!(!json.contains(&dir.path().to_string_lossy().to_string()));
        assert!(grants.grant_all(&[]).is_empty());
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
    fn spooled_grants_are_read_only_and_cleaned_up_on_release() {
        let dir = tempfile::tempdir().unwrap();
        let spool = dir.path().join("spool");
        fs::create_dir(&spool).unwrap();
        let path = temp_pdf(&spool, "document.pdf");
        let grants = FileGrants::default();
        let granted = grants
            .grant_spooled(&path, "Quarterly report.pdf", &spool)
            .unwrap();
        assert_eq!(granted.name, "Quarterly report.pdf");
        assert_eq!(granted.size, PDF.len() as u64);
        let info = grants.lookup(&granted.token).unwrap();
        assert!(!info.writable);
        assert_eq!(read_limited(&info.path, MAX_FILE_BYTES).unwrap(), PDF);
        assert!(grants.release(&granted.token));
        assert!(!spool.exists());
        assert_eq!(
            grants.grant_spooled(&path, "a.pdf", &spool),
            Err(FileError::NotFound)
        );
    }

    #[test]
    fn user_chosen_files_are_writable() {
        let dir = tempfile::tempdir().unwrap();
        let grants = FileGrants::default();
        let path = temp_pdf(dir.path(), "a.pdf");
        let granted = grants.grant(&path).unwrap();
        let info = grants.lookup(&granted.token).unwrap();
        assert!(info.writable);
        assert_eq!(info.path, fs::canonicalize(&path).unwrap());
        assert!(grants.release(&granted.token));
        assert!(path.exists());
    }

    #[test]
    fn separates_incoming_transfers_from_file_arguments() {
        let dir = tempfile::tempdir().unwrap();
        temp_pdf(dir.path(), "a.pdf");
        let id = "0b3f2c1e-8c55-4a43-9c3c-6f0d2f8e9a10";
        // A file named like the id must not be opened by accident.
        temp_pdf(dir.path(), id);
        let args = ["a.pdf", INCOMING_ARG, id, "--other"].map(OsString::from);
        let launch = parse_launch_args(args, dir.path());
        assert_eq!(launch.paths, vec![dir.path().join("a.pdf")]);
        assert_eq!(launch.incoming, vec![id.to_owned()]);
        let dangling = parse_launch_args([OsString::from(INCOMING_ARG)], dir.path());
        assert_eq!(dangling, LaunchArgs::default());
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
        let first = OpenedFiles {
            files: vec![file.clone()],
            skipped: vec!["b.png".into()],
            unavailable: vec![],
            refused: vec!["document.pdf".into()],
        };
        let second = OpenedFiles {
            unavailable: vec!["c.pdf".into()],
            ..OpenedFiles::default()
        };
        assert_eq!(queue.offer(first), None);
        assert_eq!(queue.offer(second), None);
        let drained = queue.drain();
        assert_eq!(drained.files, vec![file.clone()]);
        assert_eq!(drained.skipped, ["b.png"]);
        assert_eq!(drained.unavailable, ["c.pdf"]);
        assert_eq!(drained.refused, ["document.pdf"]);
        let later = OpenedFiles {
            files: vec![file],
            ..OpenedFiles::default()
        };
        assert_eq!(queue.offer(later.clone()), Some(later));
        assert!(queue.drain().is_empty());
    }
}
