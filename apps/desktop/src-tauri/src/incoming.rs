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
//! The host starts (or wakes, through the single-instance plugin) the app
//! with `--incoming <uuid>`; the app asks the user before opening anything.
//! Entries are deleted when declined, when their grant is released, and at
//! startup once accepted or older than a day.

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
/// Unanswered transfers are deleted at startup after this long.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

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

fn created_at(dir: &Path) -> Option<SystemTime> {
    if let Some(meta) = read_meta(dir) {
        return crate::time::parse_iso8601(&meta.created_at);
    }
    // Interrupted transfers have no meta file; their folder dates them.
    std::fs::metadata(dir).and_then(|m| m.modified()).ok()
}

/// Deletes accepted transfers and those older than [`MAX_AGE`], including
/// interrupted ones. Returns how many were deleted.
pub fn purge(base: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(base) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        // Only folders Folio could have made are touched.
        let ours = entry.file_type().is_ok_and(|kind| kind.is_dir())
            && entry.file_name().to_str().is_some_and(is_valid_id);
        if !ours {
            continue;
        }
        let dir = entry.path();
        let expired = created_at(&dir)
            .is_none_or(|created| now.duration_since(created).unwrap_or_default() > MAX_AGE);
        if expired || dir.join(ACCEPTED_MARKER).exists() {
            remove(&dir);
            removed += 1;
        }
    }
    removed
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

    #[test]
    fn purges_accepted_old_and_interrupted_transfers() {
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
        // An interrupted transfer: its folder's age decides.
        let interrupted = spool(dir.path(), None, b"%PDF");
        // Something else in the folder is left alone.
        std::fs::create_dir(dir.path().join("keep-me")).unwrap();

        assert_eq!(purge(dir.path(), now), 2);
        let exists = |id: &str| dir.path().join(id).exists();
        assert!(exists(&fresh));
        assert!(!exists(&old));
        assert!(!exists(&accepted));
        assert!(exists(&interrupted));
        assert!(exists("keep-me"));

        assert_eq!(
            purge(dir.path(), now + MAX_AGE + Duration::from_secs(60)),
            2
        );
        assert!(!exists(&fresh));
        assert!(!exists(&interrupted));
        assert!(exists("keep-me"));
        assert_eq!(purge(&dir.path().join("missing"), now), 0);
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
