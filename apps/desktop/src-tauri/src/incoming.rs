//! Documents the Chrome extension sent through the native messaging host,
//! waiting for the user to accept them in the app.
//!
//! ```text
//! incoming/.lock                      held while a host checks and claims room
//! incoming/<uuid>/announced           the size the extension announced
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
//! a time. Several hosts can run at once (one per extension connection), so
//! a host checks the limits and creates its transfer folder while it holds
//! [`lock`], and a transfer that is still arriving counts with the size its
//! extension announced.
//!
//! Entries are deleted when declined, when their grant is released, once
//! older than a day, and (unfinished ones) once nothing was written to them
//! for a quarter of an hour; the app also deletes accepted ones at startup.

use crate::{paths, save};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

pub const INCOMING_DIR: &str = "incoming";
pub const DOCUMENT_FILE: &str = "document.pdf";
pub const PART_FILE: &str = "document.pdf.part";
pub const META_FILE: &str = "meta.json";
/// The size announced for a transfer that is arriving, in decimal.
pub const ANNOUNCED_FILE: &str = "announced";
/// Taken by hosts while they check the limits and claim room.
pub const LOCK_FILE: &str = ".lock";
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
    let mut meta: IncomingMeta = serde_json::from_slice(&bytes).ok()?;
    // As plain as the host wrote it, even if the file was changed since.
    meta.name = save::sanitize_file_name(&meta.name);
    Some(meta)
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

/// Records the size the extension announced, before the host answers
/// `ready`, so other hosts count the whole transfer from the start.
pub fn write_announced(dir: &Path, size: u64) -> std::io::Result<()> {
    std::fs::write(dir.join(ANNOUNCED_FILE), size.to_string())
}

fn read_announced(dir: &Path) -> Option<u64> {
    let bytes = paths::read_limited(&dir.join(ANNOUNCED_FILE), 32).ok()?;
    std::str::from_utf8(&bytes).ok()?.trim().parse().ok()
}

/// Exclusive access to the spool's limits, across processes: an advisory
/// lock on [`LOCK_FILE`] (`flock` on Unix, `LockFileEx` on Windows),
/// released when this is dropped.
#[derive(Debug)]
pub struct SpoolLock {
    _file: std::fs::File,
}

/// Waits for the spool lock, creating the spool folder if needed.
pub fn lock(base: &Path) -> std::io::Result<SpoolLock> {
    paths::create_private_dir(base)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(base.join(LOCK_FILE))?;
    file.lock()?;
    Ok(SpoolLock { _file: file })
}

/// Transfers waiting for an answer or still arriving.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub count: usize,
    /// Their sizes: as announced, or what is on disk if that is more.
    pub bytes: u64,
    /// What transfers that are still arriving will add to the disk.
    pub arriving: u64,
}

/// What the spool holds or has promised room for that has not been answered
/// yet, to keep it bounded.
pub fn usage(base: &Path) -> Usage {
    let mut usage = Usage::default();
    for (_, dir) in entries(base) {
        if is_accepted(&dir) {
            continue;
        }
        usage.count += 1;
        if let Some(meta) = read_meta(&dir) {
            usage.bytes = usage.bytes.saturating_add(meta.size);
            continue;
        }
        let size = |name: &str| std::fs::metadata(dir.join(name)).map(|m| m.len()).ok();
        let on_disk = size(PART_FILE).or_else(|| size(DOCUMENT_FILE)).unwrap_or(0);
        let announced = read_announced(&dir).unwrap_or(0);
        usage.bytes = usage.bytes.saturating_add(on_disk.max(announced));
        usage.arriving = usage
            .arriving
            .saturating_add(announced.saturating_sub(on_disk));
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

/// Whether `path` has the shape of a spooled document of any Folio:
/// `…/incoming/<uuid>/document.pdf` (or its `.part`).
pub fn looks_like_spool_document(path: &Path) -> bool {
    let name = path.file_name();
    let dir = path.parent();
    let id = dir.and_then(Path::file_name).and_then(|id| id.to_str());
    let spool = dir.and_then(Path::parent).and_then(Path::file_name);
    (name == Some(DOCUMENT_FILE.as_ref()) || name == Some(PART_FILE.as_ref()))
        && id.is_some_and(is_valid_id)
        && spool == Some(INCOMING_DIR.as_ref())
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

    /// Found by the property tests below: the meta file may have been
    /// changed since the host wrote it.
    #[test]
    fn offers_edited_names_as_plain_file_names() {
        let dir = tempfile::tempdir().unwrap();
        let mut edited = meta(8, SystemTime::now());
        for (name, shown) in [
            ("../../\u{202E}fdp.exe", "fdp.exe.pdf"),
            ("", "Document.pdf"),
            ("nul", "_nul.pdf"),
        ] {
            edited.name = name.to_owned();
            let id = spool(dir.path(), Some(&edited), b"%PDF-1.7");
            assert_eq!(request_for(dir.path(), &id).unwrap().name, shown);
        }
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
                bytes: 14,
                arriving: 0,
            }
        );
    }

    #[test]
    fn counts_arriving_transfers_with_their_announced_size() {
        let dir = tempfile::tempdir().unwrap();
        // 6 of 1000 announced bytes have arrived.
        let arriving = partial(dir.path(), b"%PDF-1");
        write_announced(&dir.path().join(&arriving), 1000).unwrap();
        // Announced, nothing received yet.
        let announced = new_id();
        std::fs::create_dir(dir.path().join(&announced)).unwrap();
        write_announced(&dir.path().join(&announced), 300).unwrap();
        assert_eq!(
            usage(dir.path()),
            Usage {
                count: 2,
                bytes: 1300,
                arriving: 994 + 300,
            }
        );
        // More on disk than announced counts as what is on disk.
        let grown = partial(dir.path(), &[b'x'; 50]);
        write_announced(&dir.path().join(&grown), 10).unwrap();
        assert_eq!(usage(dir.path()).bytes, 1350);
        assert_eq!(usage(dir.path()).arriving, 1294);
        // Folio's lock file is not a transfer.
        drop(lock(dir.path()).unwrap());
        assert!(dir.path().join(LOCK_FILE).is_file());
        assert_eq!(usage(dir.path()).count, 3);
    }

    #[test]
    fn the_spool_lock_is_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("incoming");
        let held = lock(&base).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let waiting = {
            let base = base.clone();
            std::thread::spawn(move || {
                let second = lock(&base).unwrap();
                sender.send(()).unwrap();
                drop(second);
            })
        };
        // The second taker waits while the lock is held.
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err());
        drop(held);
        receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        waiting.join().unwrap();
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
    fn recognizes_the_shape_of_spooled_documents() {
        let id = new_id();
        let base = Path::new("/somewhere/io.github.albird97.folio/incoming");
        for name in [DOCUMENT_FILE, PART_FILE] {
            assert!(looks_like_spool_document(&base.join(&id).join(name)));
        }
        assert!(looks_like_spool_document(
            &Path::new("/other/incoming").join(&id).join(DOCUMENT_FILE)
        ));
        for path in [
            base.join(&id).join(META_FILE),
            base.join("not-a-uuid").join(DOCUMENT_FILE),
            Path::new("/somewhere/outgoing")
                .join(&id)
                .join(DOCUMENT_FILE),
            base.join(DOCUMENT_FILE),
            PathBuf::from(DOCUMENT_FILE),
        ] {
            assert!(!looks_like_spool_document(&path), "{}", path.display());
        }
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

/// Transfer ids from the webview, and whatever the spool holds: only
/// canonical ids name folders, only complete documents of the announced size
/// are offered, under a plain name, and only Folio's own folders are purged.
#[cfg(test)]
mod properties {
    use super::*;
    use crate::{fuzz, save};
    use proptest::prelude::*;

    fn id_like() -> impl Strategy<Value = String> {
        let uuid = || any::<u128>().prop_map(uuid::Uuid::from_u128);
        prop_oneof![
            3 => uuid().prop_map(|id| id.hyphenated().to_string()),
            1 => uuid().prop_map(|id| id.hyphenated().to_string().to_uppercase()),
            1 => uuid().prop_map(|id| id.simple().to_string()),
            1 => uuid().prop_map(|id| id.braced().to_string()),
            1 => uuid().prop_map(|id| id.urn().to_string()),
            1 => "[0-9a-f-]{36}",
            1 => fuzz::text(),
        ]
    }

    /// The canonical form, spelled out: 8-4-4-4-12 lowercase hex digits.
    fn is_canonical(id: &str) -> bool {
        id.len() == 36
            && id.char_indices().all(|(at, c)| match at {
                8 | 13 | 18 | 23 => c == '-',
                _ => matches!(c, '0'..='9' | 'a'..='f'),
            })
    }

    /// One folder in the spool: Folio's or not, complete or not, damaged or
    /// edited.
    #[derive(Debug, Clone)]
    struct Entry {
        name: String,
        meta: Option<Vec<u8>>,
        document: Option<Vec<u8>>,
        part: Option<Vec<u8>>,
        announced: Option<String>,
        accepted: bool,
    }

    /// A complete transfer as the host leaves it, but with any name in its
    /// meta file (it may have been edited), or anything else.
    fn entry() -> impl Strategy<Value = Entry> {
        let complete = (
            any::<u128>(),
            fuzz::text(),
            prop::collection::vec(any::<u8>(), 0..64),
            prop::option::of(fuzz::text()),
            prop::bool::weighted(0.25),
        )
            .prop_map(|(id, name, document, created_at, accepted)| Entry {
                name: uuid::Uuid::from_u128(id).hyphenated().to_string(),
                meta: Some(
                    serde_json::to_vec(&IncomingMeta {
                        name,
                        size: document.len() as u64,
                        created_at: created_at.unwrap_or_else(crate::time::now),
                    })
                    .unwrap(),
                ),
                document: Some(document),
                part: None,
                announced: None,
                accepted,
            });
        prop_oneof![complete, any_entry()]
    }

    fn any_entry() -> impl Strategy<Value = Entry> {
        let meta = prop_oneof![
            fuzz::bytes(),
            (fuzz::text(), 0u64..64, fuzz::text()).prop_map(|(name, size, created_at)| {
                serde_json::to_vec(&IncomingMeta {
                    name,
                    size,
                    created_at,
                })
                .unwrap()
            }),
            (fuzz::text(), 0u64..64).prop_map(|(name, size)| serde_json::to_vec(&IncomingMeta {
                name,
                size,
                created_at: crate::time::now(),
            })
            .unwrap()),
        ];
        let bytes = || prop::option::of(prop::collection::vec(any::<u8>(), 0..64));
        (
            id_like(),
            prop::option::of(meta),
            bytes(),
            bytes(),
            prop::option::of(prop_oneof!["[0-9]{1,25}", fuzz::text()]),
            any::<bool>(),
        )
            .prop_map(|(name, meta, document, part, announced, accepted)| Entry {
                name,
                meta,
                document,
                part,
                announced,
                accepted,
            })
    }

    /// A name that is one plain folder name here.
    fn is_one_component(name: &str) -> bool {
        let mut components = Path::new(name).components();
        matches!(
            (components.next(), components.next()),
            (Some(std::path::Component::Normal(_)), None)
        )
    }

    proptest! {
        #![proptest_config(fuzz::config(1024))]

        #[test]
        fn only_canonical_uuids_name_transfers(id in id_like()) {
            prop_assert_eq!(is_valid_id(&id), is_canonical(&id));
            let base = Path::new("incoming");
            match entry_dir(base, &id) {
                Some(dir) => {
                    prop_assert!(is_canonical(&id));
                    prop_assert_eq!(dir.parent(), Some(base));
                }
                None => prop_assert!(!is_canonical(&id)),
            }
        }

        #[test]
        fn recognizes_spooled_documents_by_their_shape(
            parts in prop::collection::vec(
                prop_oneof![
                    Just(INCOMING_DIR.to_owned()),
                    Just(DOCUMENT_FILE.to_owned()),
                    Just(PART_FILE.to_owned()),
                    id_like(),
                ],
                0..5,
            ),
        ) {
            let path: PathBuf = parts.iter().collect();
            if looks_like_spool_document(&path) {
                let names: Vec<_> = path.iter().rev().take(3).map(|name| name.to_str().unwrap()).collect();
                prop_assert!(names[0] == DOCUMENT_FILE || names[0] == PART_FILE);
                prop_assert!(is_canonical(names[1]));
                prop_assert_eq!(names[2], INCOMING_DIR);
            }
        }
    }

    proptest! {
        #![proptest_config(fuzz::config(96))]

        /// The app is asked about complete documents of the announced size
        /// only, under a plain name; purging deletes only Folio's folders.
        #[test]
        fn offers_only_complete_documents_from_any_spool(
            entries in prop::collection::vec(entry(), 0..6),
        ) {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().join(INCOMING_DIR);
            std::fs::create_dir(&base).unwrap();
            for entry in &entries {
                let folder = base.join(&entry.name);
                // Names the file system refuses cannot be there.
                if !is_one_component(&entry.name) || std::fs::create_dir_all(&folder).is_err() {
                    continue;
                }
                let files = [
                    (META_FILE, entry.meta.clone()),
                    (DOCUMENT_FILE, entry.document.clone()),
                    (PART_FILE, entry.part.clone()),
                    (ANNOUNCED_FILE, entry.announced.clone().map(String::into_bytes)),
                ];
                for (name, content) in files {
                    if let Some(content) = content {
                        std::fs::write(folder.join(name), content).unwrap();
                    }
                }
                if entry.accepted {
                    mark_accepted(&folder);
                }
            }
            let requests = pending_requests(&base);
            for request in &requests {
                prop_assert!(is_canonical(&request.id));
                let folder = base.join(&request.id);
                prop_assert!(!folder.join(ACCEPTED_MARKER).exists());
                let document = std::fs::metadata(folder.join(DOCUMENT_FILE)).unwrap();
                prop_assert_eq!(document.len(), request.size);
                prop_assert_eq!(&save::sanitize_file_name(&request.name), &request.name);
                prop_assert_eq!(request_for(&base, &request.id), Some(request.clone()));
            }
            let usage = usage(&base);
            prop_assert!(usage.count >= requests.len());
            // Accepted and stale transfers go; everything else stays.
            let others: Vec<_> = std::fs::read_dir(&base)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| !is_valid_id(name))
                .collect();
            purge(&base, SystemTime::now() + MAX_AGE * 2, true);
            for name in others {
                prop_assert!(base.join(&name).exists(), "{name}");
            }
            prop_assert!(pending_requests(&base).is_empty());
        }
    }
}
