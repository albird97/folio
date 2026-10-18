//! Documents the Chrome extension sent through the native messaging host,
//! waiting for the user to accept them in the app.
//!
//! ```text
//! incoming/<uuid>/document.pdf.part   while the host receives it
//! incoming/<uuid>/document.pdf        complete and verified
//! incoming/<uuid>/meta.json           { name, size, createdAt }, written last
//! incoming/<uuid>/accepted            the user opened it (deleted on release)
//! ```
//!
//! The host starts (or wakes) the app, which asks the user before opening
//! anything: on Windows and Linux with `--incoming <uuid>` (a running app
//! receives it through the single-instance plugin), on macOS by opening the
//! spooled document with the app through LaunchServices. At startup the app
//! also offers every complete transfer nobody answered yet.
//!
//! At most [`MAX_PENDING`] transfers totalling [`MAX_PENDING_BYTES`] wait at
//! a time. Entries are deleted when declined, when their grant is released,
//! once older than a day, and (unfinished ones) once nothing was written to
//! them for a quarter of an hour; the app also deletes accepted ones at
//! startup.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

pub const INCOMING_DIR: &str = "incoming";
pub const DOCUMENT_FILE: &str = "document.pdf";
pub const PART_FILE: &str = "document.pdf.part";
pub const META_FILE: &str = "meta.json";
const ACCEPTED_MARKER: &str = "accepted";
const MAX_META_BYTES: u64 = 64 * 1024;
/// Unanswered transfers are deleted after this long.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Unfinished transfers nothing was written to for this long were left
/// behind by a host that ended (a host writes chunk after chunk).
pub const MAX_IDLE: Duration = Duration::from_secs(15 * 60);
/// Transfers that may wait for an answer (or arrive) at the same time.
pub const MAX_PENDING: usize = 3;
pub const MAX_PENDING_BYTES: u64 = 1024 * 1024 * 1024;

/// Written by the host once a document is complete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMeta {
    /// Display name, already sanitized.
    pub name: String,
    pub size: u64,
    /// ISO-8601.
    pub created_at: String,
}

/// `TransferRequest` in the frontend: what the user is asked about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub id: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IncomingError {
    #[error("This document is no longer available.")]
    UnknownTransfer,
    #[error("Documents from Chrome cannot be received on this computer.")]
    Unavailable,
}

impl IncomingError {
    pub fn code(&self) -> &'static str {
        match self {
            IncomingError::UnknownTransfer => "unknown-transfer",
            IncomingError::Unavailable => "unavailable",
        }
    }
}

/// Transfer ids are UUIDs in their canonical lowercase hyphenated form.
pub fn is_valid_id(id: &str) -> bool {
    uuid::Uuid::try_parse(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == id)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().hyphenated().to_string()
}

/// The folder of a transfer, for valid ids only.
pub fn entry_dir(base: &Path, id: &str) -> Option<PathBuf> {
    is_valid_id(id).then(|| base.join(id))
}

pub fn read_meta(dir: &Path) -> Option<IncomingMeta> {
    let bytes = paths::read_limited(&dir.join(META_FILE), MAX_META_BYTES).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The request to show for a complete transfer, after checking that its
/// document is still there with the announced size. Opened transfers are
/// not offered again.
pub fn request_for(base: &Path, id: &str) -> Option<TransferRequest> {
    let dir = entry_dir(base, id)?;
    if dir.join(ACCEPTED_MARKER).exists() {
        return None;
    }
    let meta = read_meta(&dir)?;
    let document = std::fs::symlink_metadata(dir.join(DOCUMENT_FILE)).ok()?;
    if !document.is_file() || document.len() != meta.size {
        return None;
    }
    Some(TransferRequest {
        id: id.to_owned(),
        name: meta.name,
        size: meta.size,
    })
}

/// Marks a transfer as opened, so the next startup deletes it even if its
/// grant was never released.
pub fn mark_accepted(dir: &Path) {
    let _ = std::fs::write(dir.join(ACCEPTED_MARKER), b"");
}

pub fn remove(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

fn is_accepted(dir: &Path) -> bool {
    dir.join(ACCEPTED_MARKER).exists()
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn older_than(time: Option<SystemTime>, now: SystemTime, age: Duration) -> bool {
    time.is_none_or(|time| now.duration_since(time).unwrap_or_default() > age)
}

/// Whether an entry is past keeping: complete ones after [`MAX_AGE`],
/// unfinished ones (no meta file yet) after [`MAX_IDLE`] without writes.
fn is_stale(dir: &Path, now: SystemTime) -> bool {
    match read_meta(dir) {
        Some(meta) => older_than(crate::time::parse_iso8601(&meta.created_at), now, MAX_AGE),
        None => {
            let written = modified(dir).max(modified(&dir.join(PART_FILE)));
            older_than(written, now, MAX_IDLE)
        }
    }
}

/// The transfer folders in `base` (only folders Folio could have made).
fn entries(base: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            is_valid_id(&id).then(|| (id, entry.path()))
        })
        .collect()
}

/// Deletes stale transfers (see [`MAX_AGE`] and [`MAX_IDLE`]) and, with
/// `accepted`, the ones the user opened. The host leaves accepted ones to
/// the app, whose tabs may still be reading them. Returns how many were
/// deleted.
pub fn purge(base: &Path, now: SystemTime, accepted: bool) -> usize {
    let mut removed = 0;
    for (_, dir) in entries(base) {
        let opened = is_accepted(&dir);
        if (accepted && opened) || (!opened && is_stale(&dir, now)) {
            remove(&dir);
            removed += 1;
        }
    }
    removed
}

/// Transfers waiting for an answer or still arriving.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub count: usize,
    pub bytes: u64,
}

/// What the spool holds that has not been answered yet, to keep it bounded.
pub fn usage(base: &Path) -> Usage {
    let mut usage = Usage::default();
    for (_, dir) in entries(base) {
        if is_accepted(&dir) {
            continue;
        }
        let size = |name: &str| std::fs::metadata(dir.join(name)).map(|m| m.len()).ok();
        usage.count += 1;
        usage.bytes += read_meta(&dir)
            .map(|meta| meta.size)
            .or_else(|| size(DOCUMENT_FILE))
            .or_else(|| size(PART_FILE))
            .unwrap_or(0);
    }
    usage
}

/// Complete transfers nobody answered yet, oldest first.
pub fn pending_requests(base: &Path) -> Vec<TransferRequest> {
    let mut pending: Vec<(Option<SystemTime>, TransferRequest)> = entries(base)
        .into_iter()
        .filter_map(|(id, dir)| {
            let request = request_for(base, &id)?;
            let created =
                read_meta(&dir).and_then(|meta| crate::time::parse_iso8601(&meta.created_at));
            Some((created, request))
        })
        .collect();
    pending.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    pending.into_iter().map(|(_, request)| request).collect()
}

/// The transfer whose spooled document `path` is (macOS hands the app the
/// document instead of `--incoming <uuid>`).
pub fn transfer_for_document(base: &Path, path: &Path) -> Option<String> {
    let base = std::fs::canonicalize(base).ok()?;
    let path = std::fs::canonicalize(path).ok()?;
    if path.file_name()? != DOCUMENT_FILE {
        return None;
    }
    let dir = path.parent()?;
    if dir.parent()? != base {
        return None;
    }
    let id = dir.file_name()?.to_str()?;
    is_valid_id(id).then(|| id.to_owned())
}

#[derive(Debug, Default)]
struct QueueState {
    frontend_ready: bool,
    pending: Vec<TransferRequest>,
    /// Ids the user was (or is about to be) asked about. Only these can be
    /// answered.
    offered: HashSet<String>,
}

/// Like `files::LaunchQueue`: holds requests until the UI is listening.
#[derive(Debug, Default)]
pub struct TransferQueue {
    state: Mutex<QueueState>,
}

impl TransferQueue {
    fn lock(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Returns the request to emit now, or `None` if it was queued (or
    /// offered already).
    pub fn offer(&self, request: TransferRequest) -> Option<TransferRequest> {
        let mut state = self.lock();
        if !state.offered.insert(request.id.clone()) {
            return None;
        }
        if state.frontend_ready {
            return Some(request);
        }
        state.pending.push(request);
        None
    }

    /// Drains queued requests and switches to event delivery.
    pub fn drain(&self) -> Vec<TransferRequest> {
        let mut state = self.lock();
        state.frontend_ready = true;
        std::mem::take(&mut state.pending)
    }

    /// Takes an offered id for answering; each can be answered once.
    pub fn take(&self, id: &str) -> bool {
        self.lock().offered.remove(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spool(base: &Path, meta: Option<&IncomingMeta>, document: &[u8]) -> String {
        let id = new_id();
        let dir = base.join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(DOCUMENT_FILE), document).unwrap();
        if let Some(meta) = meta {
            std::fs::write(dir.join(META_FILE), serde_json::to_vec(meta).unwrap()).unwrap();
        }
        id
    }

    fn meta(size: u64, created_at: SystemTime) -> IncomingMeta {
        IncomingMeta {
            name: "Report.pdf".into(),
            size,
            created_at: crate::time::iso8601(created_at),
        }
    }

    #[test]
    fn accepts_only_canonical_uuids() {
        let id = new_id();
        assert!(is_valid_id(&id));
        assert!(!is_valid_id(&id.to_uppercase()));
        assert!(!is_valid_id(&id.replace('-', "")));
        assert!(!is_valid_id(&format!("{{{id}}}")));
        assert!(!is_valid_id("../../etc/passwd"));
        assert!(!is_valid_id(""));
        assert_eq!(entry_dir(Path::new("/base"), ".."), None);
    }

    #[test]
    fn describes_complete_transfers_only() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let complete = spool(dir.path(), Some(&meta(8, now)), b"%PDF-1.7");
        assert_eq!(
            request_for(dir.path(), &complete),
            Some(TransferRequest {
                id: complete.clone(),
                name: "Report.pdf".into(),
                size: 8
            })
        );
        let truncated = spool(dir.path(), Some(&meta(9, now)), b"%PDF-1.7");
        assert_eq!(request_for(dir.path(), &truncated), None);
        let unfinished = spool(dir.path(), None, b"%PDF-1.7");
        assert_eq!(request_for(dir.path(), &unfinished), None);
        assert_eq!(request_for(dir.path(), &new_id()), None);
        // Opened once, never offered again.
        mark_accepted(&dir.path().join(&complete));
        assert_eq!(request_for(dir.path(), &complete), None);
    }

    /// A transfer the host is still receiving (or a dead host left behind).
    fn partial(base: &Path, bytes: &[u8]) -> String {
        let id = new_id();
        std::fs::create_dir_all(base.join(&id)).unwrap();
        std::fs::write(base.join(&id).join(PART_FILE), bytes).unwrap();
        id
    }

    #[test]
    fn purges_accepted_old_and_abandoned_transfers() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let fresh = spool(dir.path(), Some(&meta(8, now)), b"%PDF-1.7");
        let old = spool(
            dir.path(),
            Some(&meta(8, now - MAX_AGE - Duration::from_secs(60))),
            b"%PDF-1.7",
        );
        let accepted = spool(dir.path(), Some(&meta(8, now)), b"%PDF-1.7");
        mark_accepted(&dir.path().join(&accepted));
        let arriving = partial(dir.path(), b"%PDF");
        // Something else in the folder is left alone.
        std::fs::create_dir(dir.path().join("keep-me")).unwrap();
        let exists = |id: &str| dir.path().join(id).exists();

        // The host keeps accepted transfers for the app.
        assert_eq!(purge(dir.path(), now, false), 1);
        assert!(!exists(&old));
        assert!(exists(&accepted));
        assert_eq!(purge(dir.path(), now, true), 1);
        assert!(!exists(&accepted));
        assert!(exists(&fresh));
        assert!(exists(&arriving));
        assert!(exists("keep-me"));

        // A transfer nothing was written to for a quarter of an hour was
        // left behind by a host that ended.
        assert_eq!(
            purge(dir.path(), now + MAX_IDLE + Duration::from_secs(60), false),
            1
        );
        assert!(!exists(&arriving));
        assert!(exists(&fresh));

        assert_eq!(
            purge(dir.path(), now + MAX_AGE + Duration::from_secs(60), false),
            1
        );
        assert!(!exists(&fresh));
        assert!(exists("keep-me"));
        assert_eq!(purge(&dir.path().join("missing"), now, true), 0);
    }

    #[test]
    fn counts_what_waits_for_an_answer() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        assert_eq!(usage(dir.path()), Usage::default());
        spool(dir.path(), Some(&meta(8, now)), b"%PDF-1.7");
        partial(dir.path(), b"%PDF-1");
        let accepted = spool(dir.path(), Some(&meta(4, now)), b"%PDF");
        mark_accepted(&dir.path().join(&accepted));
        assert_eq!(
            usage(dir.path()),
            Usage {
                count: 2,
                bytes: 14
            }
        );
    }

    #[test]
    fn offers_pending_transfers_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let newer = spool(dir.path(), Some(&meta(8, now)), b"%PDF-1.7");
        let older = spool(
            dir.path(),
            Some(&meta(8, now - Duration::from_secs(60))),
            b"%PDF-1.7",
        );
        partial(dir.path(), b"%PDF");
        let accepted = spool(dir.path(), Some(&meta(4, now)), b"%PDF");
        mark_accepted(&dir.path().join(&accepted));
        let ids: Vec<_> = pending_requests(dir.path())
            .into_iter()
            .map(|request| request.id)
            .collect();
        assert_eq!(ids, [older, newer]);
    }

    #[test]
    fn recognizes_spooled_documents() {
        let dir = tempfile::tempdir().unwrap();
        let id = spool(dir.path(), Some(&meta(8, SystemTime::now())), b"%PDF-1.7");
        let document = dir.path().join(&id).join(DOCUMENT_FILE);
        assert_eq!(
            transfer_for_document(dir.path(), &document),
            Some(id.clone())
        );
        // Another spelling of the same path.
        let dotted = dir.path().join(".").join(&id).join(DOCUMENT_FILE);
        assert_eq!(transfer_for_document(dir.path(), &dotted), Some(id.clone()));
        assert_eq!(
            transfer_for_document(dir.path(), &dir.path().join(&id).join(META_FILE)),
            None
        );
        let elsewhere = tempfile::tempdir().unwrap();
        let other = elsewhere.path().join(&id);
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join(DOCUMENT_FILE), b"%PDF").unwrap();
        assert_eq!(
            transfer_for_document(dir.path(), &other.join(DOCUMENT_FILE)),
            None
        );
    }

    #[test]
    fn queues_requests_until_the_frontend_is_ready() {
        let queue = TransferQueue::default();
        let request = |id: &str| TransferRequest {
            id: id.into(),
            name: "a.pdf".into(),
            size: 1,
        };
        assert_eq!(queue.offer(request("a")), None);
        // Offering the same transfer twice asks once.
        assert_eq!(queue.offer(request("a")), None);
        assert_eq!(queue.drain(), vec![request("a")]);
        assert_eq!(queue.offer(request("b")), Some(request("b")));
        assert!(queue.drain().is_empty());
        assert!(queue.take("a"));
        assert!(!queue.take("a"));
        assert!(!queue.take("never-offered"));
        assert!(queue.take("b"));
    }
}
