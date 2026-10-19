//! The native messaging host the Folio Chrome extension talks to
//! (`io.github.albird97.folio`). It is the desktop binary itself: Chrome
//! starts it with the caller's origin (`chrome-extension://<id>/`) as the
//! first argument, and `main` then runs [`run_stdio`] instead of the app.
//! The host only answers the official Folio extension
//! ([`native_messaging::OFFICIAL_EXTENSION_IDS`]); anyone else gets
//! `origin-not-allowed` and the host exits.
//!
//! Messages are UTF-8 JSON objects preceded by their length as a 32-bit
//! integer in native byte order (little-endian on every platform Folio
//! supports), in both directions. Only these messages are understood:
//!
//! ```text
//! → { type: "hello" }                          ← { type: "hello", protocol: 1, version }
//! → { type: "begin", name, size, sha256 }      ← { type: "ready", transfer }
//! → { type: "chunk", transfer, index, data }   ← { type: "ack", index }
//! → { type: "end", transfer }                  ← { type: "done", transfer }
//!                                 on any problem ← { type: "error", code, message[, transfer] }
//! ```
//!
//! A transfer is spooled into `incoming/<transfer>/` (see [`crate::incoming`])
//! and verified (size, SHA-256, PDF header) before the app is asked to offer
//! it to the user. Anything that goes wrong deletes what was received so far.

use crate::incoming::{self, IncomingMeta};
use crate::{native_messaging, paths, save};
use base64::Engine as _;
use serde::de::IgnoredAny;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const PROTOCOL: u32 = 1;
/// Longest message accepted from Chrome: a chunk (8 MiB of data, base64
/// encoded) and its envelope.
pub const MAX_MESSAGE_BYTES: usize = 12 * 1024 * 1024;
/// Chrome refuses messages from a host of 1 MiB or more.
pub const MAX_REPLY_BYTES: usize = 1024 * 1024;
pub const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;
/// Largest decoded chunk.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// `1` spools transfers without starting the app, in debug builds only
/// (tests); release builds ignore it.
pub const NO_LAUNCH_ENV: &str = "FOLIO_NATIVE_HOST_NO_LAUNCH";
const ORIGIN_PREFIX: &str = "chrome-extension://";
/// PDF readers accept the header anywhere in the first 1024 bytes.
const HEADER_WINDOW: usize = 1024;
/// Free space left on the disk besides an incoming document.
const DISK_RESERVE: u64 = 64 * 1024 * 1024;

// A full chunk message must fit in a frame.
const _: () = assert!(MAX_CHUNK_BYTES.div_ceil(3) * 4 + 64 * 1024 <= MAX_MESSAGE_BYTES);

/// Whether the process was started by Chrome as a native messaging host.
pub fn is_host_invocation(first_arg: Option<&OsStr>) -> bool {
    first_arg
        .and_then(OsStr::to_str)
        .is_some_and(|arg| arg.starts_with(ORIGIN_PREFIX))
}

/// Whether `origin` is exactly `chrome-extension://<id>/` for the official
/// Folio extension.
pub fn origin_allowed(origin: Option<&OsStr>) -> bool {
    origin
        .and_then(OsStr::to_str)
        .and_then(native_messaging::extension_id_from_origin)
        .is_some_and(native_messaging::is_official)
}

#[derive(Debug)]
pub enum FrameError {
    /// The announced length exceeds [`MAX_MESSAGE_BYTES`].
    TooLarge(u64),
    Io(io::Error),
}

/// Reads one message. `Ok(None)` means Chrome closed the connection.
pub fn read_message(reader: &mut impl Read) -> Result<Option<Vec<u8>>, FrameError> {
    let mut length = [0u8; 4];
    let mut filled = 0;
    while filled < length.len() {
        match reader.read(&mut length[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(FrameError::Io(io::ErrorKind::UnexpectedEof.into())),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(FrameError::Io(error)),
        }
    }
    let length = u32::from_ne_bytes(length) as usize;
    if length > MAX_MESSAGE_BYTES {
        return Err(FrameError::TooLarge(length as u64));
    }
    let mut message = vec![0; length];
    reader.read_exact(&mut message).map_err(FrameError::Io)?;
    Ok(Some(message))
}

/// Writes one message, refusing (as Chrome would) anything of 1 MiB or more.
pub fn write_message(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(message).map_err(io::Error::other)?;
    if bytes.len() >= MAX_REPLY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "reply too large",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}

/// A problem reported to the extension. Messages never contain paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub code: &'static str,
    pub message: &'static str,
}

const fn host_error(code: &'static str, message: &'static str) -> HostError {
    HostError { code, message }
}

const ORIGIN_NOT_ALLOWED: HostError = host_error(
    "origin-not-allowed",
    "This extension may not send documents to Folio.",
);
const INVALID_MESSAGE: HostError = host_error("invalid-message", "The message was not understood.");
const UNKNOWN_TYPE: HostError =
    host_error("unknown-type", "This kind of message is not supported.");
const INVALID_SIZE: HostError = host_error("invalid-size", "The document is empty.");
const TOO_LARGE: HostError = host_error(
    "too-large",
    "The document is larger than Folio accepts (512 MB).",
);
const CHUNK_TOO_LARGE: HostError =
    host_error("too-large", "A part of the document is larger than 8 MB.");
const INVALID_SHA256: HostError = host_error(
    "invalid-sha256",
    "The document's checksum is not a SHA-256 digest.",
);
const BUSY: HostError = host_error(
    "busy",
    "Documents sent earlier are still waiting in Folio. Open or decline them there first.",
);
const DISK_FULL: HostError = host_error(
    "busy",
    "There is not enough free disk space to receive this document.",
);
const UNKNOWN_TRANSFER: HostError =
    host_error("unknown-transfer", "There is no such transfer in progress.");
const OUT_OF_ORDER: HostError = host_error(
    "out-of-order",
    "A part of the document arrived out of order.",
);
const INVALID_CHUNK: HostError = host_error(
    "invalid-chunk",
    "A part of the document was not valid base64.",
);
const SIZE_MISMATCH: HostError = host_error(
    "size-mismatch",
    "The document's size does not match what was announced.",
);
const SHA256_MISMATCH: HostError = host_error(
    "sha256-mismatch",
    "The document was damaged in transit (checksum mismatch).",
);
const NOT_PDF: HostError = host_error("not-pdf", "Only PDF documents can be sent to Folio.");
const UNAVAILABLE: HostError = host_error(
    "unavailable",
    "Folio cannot receive documents on this computer.",
);
const STORAGE_FAILED: HostError =
    host_error("storage-failed", "Folio could not store the document.");
const LAUNCH_FAILED: HostError = host_error("launch-failed", "The Folio app could not be started.");
const MESSAGE_TOO_LARGE: HostError =
    host_error("message-too-large", "The message is larger than 12 MB.");

/// An error reply. The transfer is only echoed when it is a valid id, so a
/// long bogus value cannot push the reply over Chrome's limit.
fn error_reply(error: &HostError, transfer: Option<&str>) -> Value {
    let mut reply = json!({ "type": "error", "code": error.code, "message": error.message });
    if let Some(transfer) = transfer.filter(|transfer| incoming::is_valid_id(transfer)) {
        reply["transfer"] = json!(transfer);
    }
    reply
}

/// The type of a message. Everything else in it is skipped, not buffered.
#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(rename = "type", borrow)]
    kind: Cow<'a, str>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Begin {
    #[serde(rename = "type")]
    _kind: IgnoredAny,
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    #[serde(rename = "type")]
    _kind: IgnoredAny,
    transfer: String,
    index: u64,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct End {
    #[serde(rename = "type")]
    _kind: IgnoredAny,
    transfer: String,
}

struct Transfer {
    id: String,
    dir: PathBuf,
    /// The part file, until the document is complete.
    file: Option<std::fs::File>,
    name: String,
    size: u64,
    sha256: String,
    hasher: Sha256,
    received: u64,
    next_index: u64,
    /// The first bytes, to check for the PDF header.
    head: Vec<u8>,
}

/// Asks the app to offer a transfer: `(transfer folder, transfer id)`.
pub type Launch = Box<dyn FnMut(&Path, &str) -> io::Result<()>>;

pub struct Host {
    /// `<app data>/incoming`, if there is a data directory.
    incoming: Option<PathBuf>,
    launch: Option<Launch>,
    free_space: fn(&Path) -> Option<u64>,
    active: Option<Transfer>,
}

impl Host {
    /// `launch: None` spools documents without telling the app.
    pub fn new(incoming: Option<PathBuf>, launch: Option<Launch>) -> Self {
        Host {
            incoming,
            launch,
            free_space: paths::available_space,
            active: None,
        }
    }

    /// Answers one message.
    pub fn handle(&mut self, message: &[u8]) -> Value {
        // Objects only: serde would also read a struct from an array.
        if message.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
            return error_reply(&INVALID_MESSAGE, None);
        }
        let Ok(envelope) = serde_json::from_slice::<Envelope>(message) else {
            return error_reply(&INVALID_MESSAGE, None);
        };
        match envelope.kind.as_ref() {
            "hello" => json!({
                "type": "hello",
                "protocol": PROTOCOL,
                "version": env!("CARGO_PKG_VERSION"),
            }),
            "begin" => match serde_json::from_slice::<Begin>(message) {
                Ok(begin) => self.begin(begin),
                Err(_) => {
                    self.abort();
                    error_reply(&INVALID_MESSAGE, None)
                }
            },
            "chunk" => match serde_json::from_slice::<Chunk>(message) {
                Ok(chunk) => self.chunk(chunk),
                Err(_) => self.fail(&INVALID_MESSAGE),
            },
            "end" => match serde_json::from_slice::<End>(message) {
                Ok(end) => self.end(end),
                Err(_) => self.fail(&INVALID_MESSAGE),
            },
            _ => error_reply(&UNKNOWN_TYPE, None),
        }
    }

    /// Reports an error for the transfer in progress and deletes its data.
    fn fail(&mut self, error: &HostError) -> Value {
        let id = self.active.as_ref().map(|transfer| transfer.id.clone());
        self.abort();
        error_reply(error, id.as_deref())
    }

    /// Deletes the data of the transfer in progress.
    fn abort(&mut self) {
        if let Some(transfer) = self.active.take() {
            // Closed first: Windows cannot delete open files.
            drop(transfer.file);
            incoming::remove(&transfer.dir);
        }
    }

    fn begin(&mut self, begin: Begin) -> Value {
        // A new transfer replaces one the extension gave up on.
        self.abort();
        if begin.size == 0 {
            return error_reply(&INVALID_SIZE, None);
        }
        if begin.size > MAX_TRANSFER_BYTES {
            return error_reply(&TOO_LARGE, None);
        }
        if !save::is_sha256_hex(&begin.sha256) {
            return error_reply(&INVALID_SHA256, None);
        }
        let Some(base) = self.incoming.clone() else {
            return error_reply(&UNAVAILABLE, None);
        };
        // Other hosts may be starting transfers at the same time: the limits
        // are checked and the room is claimed under one lock.
        let Ok(_spool) = incoming::lock(&base) else {
            return error_reply(&STORAGE_FAILED, None);
        };
        // The spool stays small: a few documents waiting for an answer.
        let usage = incoming::usage(&base);
        if usage.count >= incoming::MAX_PENDING
            || usage.bytes.saturating_add(begin.size) > incoming::MAX_PENDING_BYTES
        {
            return error_reply(&BUSY, None);
        }
        // Room for this document, for what other transfers have yet to
        // write, and some to spare.
        let needed = usage
            .arriving
            .saturating_add(begin.size)
            .saturating_add(DISK_RESERVE);
        if (self.free_space)(&base).is_some_and(|free| free < needed) {
            return error_reply(&DISK_FULL, None);
        }
        let id = incoming::new_id();
        let dir = base.join(&id);
        // The announced size first, so other hosts count all of it at once.
        let file = paths::create_private_dir(&dir)
            .and_then(|()| incoming::write_announced(&dir, begin.size))
            .and_then(|()| {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dir.join(incoming::PART_FILE))
            });
        let file = match file {
            Ok(file) => file,
            Err(_) => {
                incoming::remove(&dir);
                return error_reply(&STORAGE_FAILED, None);
            }
        };
        self.active = Some(Transfer {
            id: id.clone(),
            dir,
            file: Some(file),
            name: save::sanitize_file_name(&begin.name),
            size: begin.size,
            sha256: begin.sha256.to_ascii_lowercase(),
            hasher: Sha256::new(),
            received: 0,
            next_index: 0,
            head: Vec::with_capacity(HEADER_WINDOW),
        });
        json!({ "type": "ready", "transfer": id })
    }

    fn chunk(&mut self, chunk: Chunk) -> Value {
        let current = self.active.as_mut();
        let Some(transfer) = current.filter(|transfer| transfer.id == chunk.transfer) else {
            return error_reply(&UNKNOWN_TRANSFER, Some(&chunk.transfer));
        };
        if chunk.index != transfer.next_index {
            return self.fail(&OUT_OF_ORDER);
        }
        // Checked before decoding, so oversized chunks are not decoded.
        if chunk.data.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4 {
            return self.fail(&CHUNK_TOO_LARGE);
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(chunk.data.as_bytes())
        else {
            return self.fail(&INVALID_CHUNK);
        };
        if bytes.len() > MAX_CHUNK_BYTES {
            return self.fail(&CHUNK_TOO_LARGE);
        }
        if transfer.received + bytes.len() as u64 > transfer.size {
            return self.fail(&SIZE_MISMATCH);
        }
        let written = match transfer.file.as_mut() {
            Some(file) => file.write_all(&bytes).is_ok(),
            None => false,
        };
        if !written {
            return self.fail(&STORAGE_FAILED);
        }
        transfer.hasher.update(&bytes);
        transfer.received += bytes.len() as u64;
        transfer.next_index += 1;
        let missing = HEADER_WINDOW.saturating_sub(transfer.head.len());
        transfer
            .head
            .extend_from_slice(&bytes[..missing.min(bytes.len())]);
        // Junk is refused as soon as it is clear, not after 512 MB.
        if transfer.head.len() == HEADER_WINDOW && !save::looks_like_pdf(&transfer.head) {
            return self.fail(&NOT_PDF);
        }
        json!({ "type": "ack", "index": chunk.index })
    }

    fn end(&mut self, end: End) -> Value {
        let current = self.active.as_mut();
        let Some(transfer) = current.filter(|transfer| transfer.id == end.transfer) else {
            return error_reply(&UNKNOWN_TRANSFER, Some(&end.transfer));
        };
        if transfer.received != transfer.size {
            return self.fail(&SIZE_MISMATCH);
        }
        let digest = save::to_hex(&std::mem::take(&mut transfer.hasher).finalize());
        if digest != transfer.sha256 {
            return self.fail(&SHA256_MISMATCH);
        }
        if !save::looks_like_pdf(&transfer.head) {
            return self.fail(&NOT_PDF);
        }
        if finish(transfer).is_err() {
            return self.fail(&STORAGE_FAILED);
        }
        let id = transfer.id.clone();
        let dir = transfer.dir.clone();
        if let Some(launch) = &mut self.launch {
            if launch(&dir, &id).is_err() {
                return self.fail(&LAUNCH_FAILED);
            }
        }
        // Complete: the app owns it from here on.
        self.active = None;
        json!({ "type": "done", "transfer": id })
    }

    /// Answers messages until Chrome closes the connection.
    pub fn serve(&mut self, reader: &mut impl Read, writer: &mut impl Write) -> io::Result<()> {
        loop {
            let message = match read_message(reader) {
                Ok(Some(message)) => message,
                Ok(None) => return Ok(()),
                Err(FrameError::TooLarge(_)) => {
                    // The rest of the stream cannot be framed any more.
                    let reply = self.fail(&MESSAGE_TOO_LARGE);
                    write_message(writer, &reply)?;
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "message too large",
                    ));
                }
                Err(FrameError::Io(error)) => return Err(error),
            };
            let reply = self.handle(&message);
            write_message(writer, &reply)?;
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Makes a verified document visible to the app: the meta file is written
/// last, so the app never sees a partial document.
fn finish(transfer: &mut Transfer) -> io::Result<()> {
    let file = transfer
        .file
        .take()
        .ok_or_else(|| io::Error::other("already finished"))?;
    file.sync_all()?;
    // Closed before the rename, which Windows refuses for open files.
    drop(file);
    std::fs::rename(
        transfer.dir.join(incoming::PART_FILE),
        transfer.dir.join(incoming::DOCUMENT_FILE),
    )?;
    let meta = IncomingMeta {
        name: transfer.name.clone(),
        size: transfer.size,
        created_at: crate::time::now(),
    };
    let meta = serde_json::to_vec(&meta).map_err(io::Error::other)?;
    paths::write_atomically(&transfer.dir.join(incoming::META_FILE), &meta)
}

/// The `.app` bundle an executable belongs to
/// (`…/Folio.app/Contents/MacOS/folio-desktop`).
#[cfg(target_os = "macos")]
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}

/// Chrome's pipes to the host are inheritable; a process started with
/// inheritance would keep them open after the host is gone.
#[cfg(windows)]
fn keep_std_handles_private() {
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle has no preconditions, and SetHandleInformation
        // only clears a flag on a handle this process owns.
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// Asks the app to offer a transfer, starting it if needed, detached from
/// the host (which Chrome stops when the extension disconnects).
///
/// - macOS: LaunchServices (`/usr/bin/open -a <bundle> <document>`) brings
///   Folio to the front and hands it the spooled document, which the app
///   recognizes as a transfer.
/// - Windows and Linux: the app is started with `--incoming <id>`; a
///   running app receives it through the single-instance plugin and the new
///   process exits. From an AppImage, the AppImage is started.
pub fn launch_app(dir: &Path, id: &str) -> io::Result<()> {
    use std::process::{Command, Stdio};
    let exe = paths::executable()?;
    #[cfg(target_os = "macos")]
    let mut command = match app_bundle(&exe) {
        Some(bundle) => {
            let mut command = Command::new("/usr/bin/open");
            command
                .arg("-a")
                .arg(bundle)
                .arg(dir.join(incoming::DOCUMENT_FILE));
            command
        }
        // Not inside an app bundle (development builds).
        None => {
            let mut command = Command::new(&exe);
            command.arg(crate::files::INCOMING_ARG).arg(id);
            command
        }
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = {
        let _ = dir;
        let mut command = Command::new(&exe);
        command.arg(crate::files::INCOMING_ARG).arg(id);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    let child = {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        keep_std_handles_private();
        // Leaving Chrome's job object keeps the app alive when the host
        // ends; not every job allows it.
        command.creation_flags(
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
        match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                command.spawn()?
            }
        }
    };
    #[cfg(not(windows))]
    let child = command.spawn()?;
    // Reaps the process (it exits at once when the app is already running).
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

/// Whether [`NO_LAUNCH_ENV`] (with this value) turns starting the app off.
fn launch_disabled_by(value: Option<&OsStr>) -> bool {
    cfg!(debug_assertions) && value == Some(OsStr::new("1"))
}

/// Host mode: serves Chrome on stdin/stdout. `origin` is the first argument
/// Chrome passed. Returns the exit code.
pub fn run_stdio(origin: Option<&OsStr>) -> i32 {
    let mut stdout = io::stdout().lock();
    if !origin_allowed(origin) {
        let _ = write_message(&mut stdout, &error_reply(&ORIGIN_NOT_ALLOWED, None));
        return 1;
    }
    let data_dir = paths::app_data_dir();
    let incoming = data_dir.as_deref().map(|dir| {
        let _ = paths::prepare_data_dir(dir);
        dir.join(incoming::INCOMING_DIR)
    });
    // Leftovers of hosts that ended mid-transfer, and transfers nobody
    // answered for a day. Accepted ones are the app's to delete.
    if let Some(base) = &incoming {
        incoming::purge(base, SystemTime::now(), false);
    }
    let launch = if launch_disabled_by(std::env::var_os(NO_LAUNCH_ENV).as_deref()) {
        None
    } else {
        Some(Box::new(launch_app) as Launch)
    };
    let mut host = Host::new(incoming, launch);
    let served = host.serve(&mut io::stdin().lock(), &mut stdout);
    drop(host);
    i32::from(served.is_err())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const PDF: &[u8] = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";
    const OFFICIAL: &str = "ghfckfnleaidabfhaplbnfknipajedan";

    fn base64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    struct Fixture {
        dir: tempfile::TempDir,
        host: Host,
        launched: Rc<RefCell<Vec<String>>>,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let launched = Rc::new(RefCell::new(Vec::new()));
        let record = launched.clone();
        let launch: Launch = Box::new(move |folder: &Path, id: &str| {
            assert!(folder.join(incoming::DOCUMENT_FILE).is_file());
            record.borrow_mut().push(id.to_owned());
            Ok(())
        });
        let host = Host::new(Some(dir.path().join("incoming")), Some(launch));
        Fixture {
            dir,
            host,
            launched,
        }
    }

    impl Fixture {
        fn send(&mut self, message: Value) -> Value {
            self.host.handle(&serde_json::to_vec(&message).unwrap())
        }

        fn begin(&mut self, bytes: &[u8]) -> String {
            let reply = self.send(json!({
                "type": "begin",
                "name": "Report.pdf",
                "size": bytes.len(),
                "sha256": save::sha256_hex(bytes),
            }));
            assert_eq!(reply["type"], "ready", "{reply}");
            reply["transfer"].as_str().unwrap().to_owned()
        }

        fn chunk(&mut self, transfer: &str, index: u64, bytes: &[u8]) -> Value {
            self.send(json!({
                "type": "chunk",
                "transfer": transfer,
                "index": index,
                "data": base64(bytes),
            }))
        }

        fn complete(&mut self, bytes: &[u8]) -> String {
            let transfer = self.begin(bytes);
            assert_eq!(self.chunk(&transfer, 0, bytes)["type"], "ack");
            let done = self.send(json!({ "type": "end", "transfer": transfer }));
            assert_eq!(done["type"], "done", "{done}");
            transfer
        }

        fn incoming(&self) -> PathBuf {
            self.dir.path().join("incoming")
        }

        /// The transfer folders (not the spool's lock file).
        fn spooled(&self) -> Vec<String> {
            std::fs::read_dir(self.incoming())
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| !name.starts_with('.'))
                        .collect()
                })
                .unwrap_or_default()
        }
    }

    fn assert_error(reply: &Value, code: &str) {
        assert_eq!(reply["type"], "error", "{reply}");
        assert_eq!(reply["code"], code, "{reply}");
        assert!(reply["message"].as_str().is_some_and(|m| !m.is_empty()));
    }

    #[test]
    fn recognizes_chrome_launches() {
        assert!(is_host_invocation(Some(OsStr::new(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        ))));
        // Malformed origins still start the host, which then refuses them.
        assert!(is_host_invocation(Some(OsStr::new("chrome-extension://x"))));
        assert!(!is_host_invocation(Some(OsStr::new("Report.pdf"))));
        assert!(!is_host_invocation(Some(OsStr::new("--incoming"))));
        assert!(!is_host_invocation(None));
    }

    #[test]
    fn answers_the_official_extension_only() {
        let official = format!("chrome-extension://{OFFICIAL}/");
        assert!(origin_allowed(Some(OsStr::new(&official))));
        for origin in [
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_owned(),
            format!("chrome-extension://{OFFICIAL}"),
            format!("chrome-extension://{OFFICIAL}/extra"),
            format!("chrome-extension://{}/", OFFICIAL.to_uppercase()),
            "chrome-extension://".to_owned(),
        ] {
            assert!(!origin_allowed(Some(OsStr::new(&origin))), "{origin}");
        }
        assert!(!origin_allowed(None));
    }

    #[test]
    fn only_debug_builds_can_turn_starting_the_app_off() {
        assert_eq!(
            launch_disabled_by(Some(OsStr::new("1"))),
            cfg!(debug_assertions)
        );
        assert!(!launch_disabled_by(Some(OsStr::new("0"))));
        assert!(!launch_disabled_by(Some(OsStr::new("true"))));
        assert!(!launch_disabled_by(None));
    }

    #[test]
    fn frames_messages_with_a_native_endian_length() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, &json!({ "type": "hello" })).unwrap();
        assert_eq!(&buffer[..4], &16u32.to_ne_bytes());
        assert_eq!(&buffer[4..], br#"{"type":"hello"}"#);
        let mut reader = io::Cursor::new(buffer);
        assert_eq!(
            read_message(&mut reader).unwrap(),
            Some(br#"{"type":"hello"}"#.to_vec())
        );
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn rejects_truncated_and_oversized_frames() {
        let mut truncated = io::Cursor::new(vec![5, 0]);
        assert!(matches!(
            read_message(&mut truncated),
            Err(FrameError::Io(_))
        ));
        let mut short_body = io::Cursor::new([&10u32.to_ne_bytes()[..], b"abc"].concat());
        assert!(matches!(
            read_message(&mut short_body),
            Err(FrameError::Io(_))
        ));
        let too_long = (MAX_MESSAGE_BYTES as u32 + 1).to_ne_bytes();
        assert!(matches!(
            read_message(&mut io::Cursor::new(too_long)),
            Err(FrameError::TooLarge(_))
        ));
        assert_eq!(MAX_MESSAGE_BYTES, 12 * 1024 * 1024);
        let huge = serde_json::json!({ "type": "error", "message": "x".repeat(MAX_REPLY_BYTES) });
        assert!(write_message(&mut Vec::new(), &huge).is_err());
    }

    #[test]
    fn a_message_with_the_largest_chunk_fits_in_a_frame() {
        let message = json!({
            "type": "chunk",
            "transfer": incoming::new_id(),
            "index": u64::MAX,
            "data": base64(&vec![0xff; MAX_CHUNK_BYTES]),
        });
        assert!(serde_json::to_vec(&message).unwrap().len() <= MAX_MESSAGE_BYTES);
    }

    #[test]
    fn says_hello() {
        let mut fixture = fixture();
        let reply = fixture.send(json!({ "type": "hello" }));
        assert_eq!(
            reply,
            json!({ "type": "hello", "protocol": 1, "version": env!("CARGO_PKG_VERSION") })
        );
        // Hello tolerates additions from newer extensions.
        let reply = fixture.send(json!({ "type": "hello", "client": "folio-extension" }));
        assert_eq!(reply["type"], "hello");
    }

    #[test]
    fn spools_a_document_sent_in_chunks_and_starts_the_app() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        assert!(incoming::is_valid_id(&transfer));
        let (first, second) = PDF.split_at(10);
        assert_eq!(
            fixture.chunk(&transfer, 0, first),
            json!({ "type": "ack", "index": 0 })
        );
        // The app is not told about partial documents.
        assert_eq!(incoming::request_for(&fixture.incoming(), &transfer), None);
        assert_eq!(
            fixture.chunk(&transfer, 1, second),
            json!({ "type": "ack", "index": 1 })
        );
        let reply = fixture.send(json!({ "type": "end", "transfer": transfer }));
        assert_eq!(reply, json!({ "type": "done", "transfer": transfer }));

        let dir = fixture.incoming().join(&transfer);
        assert_eq!(
            std::fs::read(dir.join(incoming::DOCUMENT_FILE)).unwrap(),
            PDF
        );
        assert!(!dir.join(incoming::PART_FILE).exists());
        let meta = incoming::read_meta(&dir).unwrap();
        assert_eq!(meta.name, "Report.pdf");
        assert_eq!(meta.size, PDF.len() as u64);
        assert!(crate::time::parse_iso8601(&meta.created_at).is_some());
        assert_eq!(*fixture.launched.borrow(), vec![transfer.clone()]);
        let request = incoming::request_for(&fixture.incoming(), &transfer).unwrap();
        assert_eq!(request.name, "Report.pdf");

        // Finished transfers are not deleted when the host exits.
        drop(fixture.host);
        assert!(dir.join(incoming::DOCUMENT_FILE).exists());
    }

    #[test]
    fn sanitizes_the_document_name() {
        let mut fixture = fixture();
        let reply = fixture.send(json!({
            "type": "begin",
            "name": "../../.ssh/authorized_keys",
            "size": PDF.len(),
            "sha256": save::sha256_hex(PDF),
        }));
        let transfer = reply["transfer"].as_str().unwrap().to_owned();
        fixture.chunk(&transfer, 0, PDF);
        fixture.send(json!({ "type": "end", "transfer": transfer }));
        let meta = incoming::read_meta(&fixture.incoming().join(&transfer)).unwrap();
        assert_eq!(meta.name, "authorized_keys.pdf");
    }

    #[test]
    fn validates_the_announcement() {
        let mut fixture = fixture();
        let sha = save::sha256_hex(PDF);
        let begin = |name: Value, size: Value, sha256: Value| json!({ "type": "begin", "name": name, "size": size, "sha256": sha256 });
        assert_error(
            &fixture.send(begin(json!("a.pdf"), json!(0), json!(sha))),
            "invalid-size",
        );
        assert_error(
            &fixture.send(begin(
                json!("a.pdf"),
                json!(MAX_TRANSFER_BYTES + 1),
                json!(sha),
            )),
            "too-large",
        );
        assert_error(
            &fixture.send(begin(json!("a.pdf"), json!(10), json!("abc"))),
            "invalid-sha256",
        );
        assert_error(
            &fixture.send(begin(json!("a.pdf"), json!(-1), json!(sha))),
            "invalid-message",
        );
        assert_error(
            &fixture.send(begin(json!(42), json!(10), json!(sha))),
            "invalid-message",
        );
        assert_error(
            &fixture.send(json!({ "type": "begin", "name": "a.pdf" })),
            "invalid-message",
        );
        assert!(fixture.spooled().is_empty());
    }

    #[test]
    fn refuses_unknown_and_malformed_messages() {
        let mut fixture = fixture();
        assert_error(
            &fixture.send(json!({ "type": "delete-everything" })),
            "unknown-type",
        );
        assert_error(&fixture.send(json!({ "kind": "hello" })), "invalid-message");
        assert_error(&fixture.send(json!(["hello"])), "invalid-message");
        assert_error(
            &fixture.send(json!(["begin", "a.pdf", 8, "x"])),
            "invalid-message",
        );
        assert_error(&fixture.host.handle(b"not json"), "invalid-message");
        assert_error(&fixture.host.handle(b""), "invalid-message");
        assert_error(
            &fixture.host.handle(br#"{"type":"hello","type":"begin"}"#),
            "invalid-message",
        );
        // Fields the protocol does not have are refused.
        let sha = save::sha256_hex(PDF);
        assert_error(
            &fixture.send(json!({
                "type": "begin", "name": "a.pdf", "size": 8, "sha256": sha, "path": "/etc"
            })),
            "invalid-message",
        );
        assert_error(
            &fixture.chunk("0b3f2c1e-8c55-4a43-9c3c-6f0d2f8e9a10", 0, PDF),
            "unknown-transfer",
        );
        assert_error(
            &fixture.send(json!({ "type": "end", "transfer": "nope" })),
            "unknown-transfer",
        );
    }

    #[test]
    fn only_echoes_transfer_ids_that_are_valid() {
        let mut fixture = fixture();
        let bogus = "x".repeat(MAX_REPLY_BYTES * 2);
        let reply = fixture.send(json!({ "type": "end", "transfer": bogus }));
        assert_error(&reply, "unknown-transfer");
        assert!(reply.get("transfer").is_none());
        let mut out = Vec::new();
        write_message(&mut out, &reply).unwrap();
        let valid = "0b3f2c1e-8c55-4a43-9c3c-6f0d2f8e9a10";
        let reply = fixture.send(json!({ "type": "end", "transfer": valid }));
        assert_eq!(reply["transfer"], valid);
    }

    #[test]
    fn a_huge_array_is_skipped_without_building_it() {
        let mut fixture = fixture();
        // About 12 MB of tiny numbers: parsed into a JSON value, this would
        // take hundreds of megabytes.
        let mut message = br#"{"type":"nonsense","x":["#.to_vec();
        while message.len() < MAX_MESSAGE_BYTES - 16 {
            message.extend_from_slice(b"0,");
        }
        message.extend_from_slice(b"0]}");
        assert_error(&fixture.host.handle(&message), "unknown-type");
    }

    #[test]
    fn deletes_the_document_when_chunks_arrive_out_of_order() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        assert_eq!(fixture.chunk(&transfer, 0, &PDF[..5])["type"], "ack");
        let reply = fixture.chunk(&transfer, 2, &PDF[5..]);
        assert_error(&reply, "out-of-order");
        assert_eq!(reply["transfer"], transfer.as_str());
        assert!(fixture.spooled().is_empty());
        // The transfer is over.
        assert_error(&fixture.chunk(&transfer, 1, &PDF[5..]), "unknown-transfer");
    }

    #[test]
    fn deletes_the_document_when_more_arrives_than_announced() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        let mut longer = PDF.to_vec();
        longer.push(b'\n');
        assert_error(&fixture.chunk(&transfer, 0, &longer), "size-mismatch");
        assert!(fixture.spooled().is_empty());
    }

    #[test]
    fn deletes_the_document_when_it_ends_early() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        fixture.chunk(&transfer, 0, &PDF[..10]);
        assert_error(
            &fixture.send(json!({ "type": "end", "transfer": transfer })),
            "size-mismatch",
        );
        assert!(fixture.spooled().is_empty());
        assert!(fixture.launched.borrow().is_empty());
    }

    #[test]
    fn deletes_documents_damaged_in_transit() {
        let mut fixture = fixture();
        let reply = fixture.send(json!({
            "type": "begin",
            "name": "a.pdf",
            "size": PDF.len(),
            "sha256": save::sha256_hex(b"something else"),
        }));
        let transfer = reply["transfer"].as_str().unwrap().to_owned();
        fixture.chunk(&transfer, 0, PDF);
        assert_error(
            &fixture.send(json!({ "type": "end", "transfer": transfer })),
            "sha256-mismatch",
        );
        assert!(fixture.spooled().is_empty());
        assert!(fixture.launched.borrow().is_empty());
    }

    #[test]
    fn refuses_documents_that_are_not_pdfs() {
        let mut fixture = fixture();
        let script = b"#!/bin/sh\necho hi\n";
        let transfer = fixture.begin(script);
        fixture.chunk(&transfer, 0, script);
        assert_error(
            &fixture.send(json!({ "type": "end", "transfer": transfer })),
            "not-pdf",
        );
        // Long junk is refused once the header window is complete.
        let junk = vec![b'x'; 4096];
        let transfer = fixture.begin(&junk);
        assert_error(&fixture.chunk(&transfer, 0, &junk), "not-pdf");
        assert!(fixture.spooled().is_empty());
    }

    #[test]
    fn refuses_oversized_and_invalid_chunks() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        assert_error(
            &fixture.send(json!({
                "type": "chunk", "transfer": transfer, "index": 0, "data": "not base64!"
            })),
            "invalid-chunk",
        );
        assert!(fixture.spooled().is_empty());

        let big = vec![b'%'; MAX_CHUNK_BYTES + 1];
        let mut announced = big.clone();
        announced.extend_from_slice(b"padding");
        let transfer = fixture.begin(&announced);
        assert_error(&fixture.chunk(&transfer, 0, &big), "too-large");
        assert!(fixture.spooled().is_empty());

        let transfer = fixture.begin(PDF);
        let oversized = "A".repeat(MAX_CHUNK_BYTES.div_ceil(3) * 4 + 4);
        assert_error(
            &fixture.send(json!({
                "type": "chunk", "transfer": transfer, "index": 0, "data": oversized
            })),
            "too-large",
        );
        assert!(fixture.spooled().is_empty());
    }

    #[test]
    fn accepts_chunks_of_the_largest_size() {
        let mut fixture = fixture();
        let mut document = b"%PDF-1.7\n".to_vec();
        document.resize(MAX_CHUNK_BYTES + 10, b' ');
        let transfer = fixture.begin(&document);
        let (first, second) = document.split_at(MAX_CHUNK_BYTES);
        assert_eq!(fixture.chunk(&transfer, 0, first)["type"], "ack");
        assert_eq!(fixture.chunk(&transfer, 1, second)["type"], "ack");
        let reply = fixture.send(json!({ "type": "end", "transfer": transfer }));
        assert_eq!(reply["type"], "done", "{reply}");
    }

    fn announce(size: u64) -> Value {
        json!({ "type": "begin", "name": "a.pdf", "size": size, "sha256": save::sha256_hex(PDF) })
    }

    #[test]
    fn keeps_at_most_three_documents_waiting() {
        let mut fixture = fixture();
        for _ in 0..incoming::MAX_PENDING {
            fixture.complete(PDF);
        }
        assert_error(&fixture.send(announce(PDF.len() as u64)), "busy");
        assert_eq!(fixture.spooled().len(), incoming::MAX_PENDING);
    }

    #[test]
    fn keeps_what_waits_below_a_gigabyte() {
        let mut fixture = fixture();
        fixture.host.free_space = |_| None;
        // A document of 600 MiB waits for an answer.
        let waiting = fixture.incoming().join(incoming::new_id());
        std::fs::create_dir_all(&waiting).unwrap();
        let meta = IncomingMeta {
            name: "big.pdf".into(),
            size: 600 * 1024 * 1024,
            created_at: crate::time::now(),
        };
        std::fs::write(
            waiting.join(incoming::META_FILE),
            serde_json::to_vec(&meta).unwrap(),
        )
        .unwrap();
        assert_error(&fixture.send(announce(500 * 1024 * 1024)), "busy");
        assert_eq!(fixture.send(announce(400 * 1024 * 1024))["type"], "ready");
    }

    #[test]
    fn refuses_documents_the_disk_has_no_room_for() {
        let mut fixture = fixture();
        fixture.host.free_space = |_| Some(10 * 1024 * 1024);
        let reply = fixture.send(json!({
            "type": "begin", "name": "a.pdf", "size": 1024, "sha256": save::sha256_hex(PDF)
        }));
        assert_error(&reply, "busy");
        assert!(reply["message"].as_str().unwrap().contains("disk space"));
        assert!(fixture.spooled().is_empty());
        // When the system does not say, the host tries.
        fixture.host.free_space = |_| None;
        fixture.complete(PDF);
    }

    #[test]
    fn announces_the_size_before_answering_ready() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        let announced = fixture
            .incoming()
            .join(&transfer)
            .join(incoming::ANNOUNCED_FILE);
        assert_eq!(
            std::fs::read_to_string(announced).unwrap(),
            PDF.len().to_string()
        );
        // Counted at its full size while it arrives.
        assert_eq!(
            incoming::usage(&fixture.incoming()).arriving,
            PDF.len() as u64
        );
    }

    #[test]
    fn the_disk_must_hold_what_other_transfers_still_write() {
        let mut fixture = fixture();
        const MIB: u64 = 1024 * 1024;
        fixture.host.free_space = |_| Some(600 * MIB);
        // Another host announced 500 MiB and has written nothing yet.
        let other = fixture.incoming().join(incoming::new_id());
        std::fs::create_dir_all(&other).unwrap();
        incoming::write_announced(&other, 500 * MIB).unwrap();
        // 500 + 100 + the reserve do not fit in 600 MiB; 500 + 10 + 64 do.
        let reply = fixture.send(announce(100 * MIB));
        assert_error(&reply, "busy");
        assert!(reply["message"].as_str().unwrap().contains("disk space"));
        assert_eq!(fixture.send(announce(10 * MIB))["type"], "ready");
    }

    #[test]
    fn hosts_starting_at_once_stay_within_the_limits() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("incoming");
        let hosts = 8;
        let start = std::sync::Arc::new(std::sync::Barrier::new(hosts));
        let finish = std::sync::Arc::new(std::sync::Barrier::new(hosts));
        let threads: Vec<_> = (0..hosts)
            .map(|_| {
                let (base, start, finish) = (base.clone(), start.clone(), finish.clone());
                std::thread::spawn(move || {
                    let mut host = Host::new(Some(base), None);
                    host.free_space = |_| None;
                    let message = serde_json::to_vec(&announce(PDF.len() as u64)).unwrap();
                    start.wait();
                    let reply = host.handle(&message);
                    // Transfers stay in progress until every host answered.
                    finish.wait();
                    reply["type"].as_str().unwrap().to_owned()
                })
            })
            .collect();
        let replies: Vec<String> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        let ready = replies.iter().filter(|reply| *reply == "ready").count();
        assert_eq!(ready, incoming::MAX_PENDING, "{replies:?}");
        assert_eq!(
            replies.iter().filter(|reply| *reply == "error").count(),
            hosts - incoming::MAX_PENDING
        );
    }

    #[test]
    fn a_new_transfer_replaces_an_abandoned_one() {
        let mut fixture = fixture();
        let abandoned = fixture.begin(PDF);
        fixture.chunk(&abandoned, 0, &PDF[..5]);
        let current = fixture.begin(PDF);
        assert_eq!(fixture.spooled(), vec![current.clone()]);
        assert_error(&fixture.chunk(&abandoned, 1, &PDF[5..]), "unknown-transfer");
        assert_eq!(fixture.chunk(&current, 0, PDF)["type"], "ack");
    }

    #[test]
    fn deletes_unfinished_documents_when_chrome_disconnects() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        fixture.chunk(&transfer, 0, &PDF[..5]);
        drop(fixture.host);
        assert!(!fixture.dir.path().join("incoming").join(&transfer).exists());
    }

    #[test]
    fn deletes_the_document_when_the_app_cannot_be_started() {
        let dir = tempfile::tempdir().unwrap();
        let launch: Launch = Box::new(|_, _| Err(io::Error::other("no app")));
        let mut host = Host::new(Some(dir.path().join("incoming")), Some(launch));
        let send =
            |host: &mut Host, message: Value| host.handle(&serde_json::to_vec(&message).unwrap());
        let reply = send(
            &mut host,
            json!({ "type": "begin", "name": "a.pdf", "size": PDF.len(), "sha256": save::sha256_hex(PDF) }),
        );
        let transfer = reply["transfer"].as_str().unwrap().to_owned();
        send(
            &mut host,
            json!({ "type": "chunk", "transfer": transfer, "index": 0, "data": base64(PDF) }),
        );
        let reply = send(&mut host, json!({ "type": "end", "transfer": transfer }));
        assert_error(&reply, "launch-failed");
        assert!(!dir.path().join("incoming").join(&transfer).exists());
    }

    #[test]
    fn reports_a_missing_data_directory() {
        let mut host = Host::new(None, None);
        let reply = host.handle(
            &serde_json::to_vec(&json!({
                "type": "begin", "name": "a.pdf", "size": 10, "sha256": save::sha256_hex(b"x")
            }))
            .unwrap(),
        );
        assert_error(&reply, "unavailable");
    }

    #[test]
    fn serves_a_stream_of_messages_until_it_ends() {
        let mut fixture = fixture();
        let mut input = Vec::new();
        write_message(&mut input, &json!({ "type": "hello" })).unwrap();
        write_message(&mut input, &json!({ "type": "nonsense" })).unwrap();
        let mut output = Vec::new();
        fixture
            .host
            .serve(&mut io::Cursor::new(input), &mut output)
            .unwrap();
        let mut replies = io::Cursor::new(output);
        let first: Value =
            serde_json::from_slice(&read_message(&mut replies).unwrap().unwrap()).unwrap();
        assert_eq!(first["type"], "hello");
        let second: Value =
            serde_json::from_slice(&read_message(&mut replies).unwrap().unwrap()).unwrap();
        assert_error(&second, "unknown-type");
        assert_eq!(read_message(&mut replies).unwrap(), None);
    }

    #[test]
    fn stops_at_a_message_that_is_too_large() {
        let mut fixture = fixture();
        let transfer = fixture.begin(PDF);
        let input = (MAX_MESSAGE_BYTES as u32 + 1).to_ne_bytes().to_vec();
        let mut output = Vec::new();
        assert!(fixture
            .host
            .serve(&mut io::Cursor::new(input), &mut output)
            .is_err());
        let reply: Value =
            serde_json::from_slice(&read_message(&mut io::Cursor::new(output)).unwrap().unwrap())
                .unwrap();
        assert_error(&reply, "message-too-large");
        assert!(!fixture.incoming().join(&transfer).exists());
    }

    #[test]
    fn replies_stay_far_below_chromes_limit() {
        for error in [
            ORIGIN_NOT_ALLOWED,
            INVALID_MESSAGE,
            UNKNOWN_TYPE,
            TOO_LARGE,
            BUSY,
            DISK_FULL,
            SHA256_MISMATCH,
            MESSAGE_TOO_LARGE,
        ] {
            let reply = error_reply(&error, Some(&incoming::new_id()));
            assert!(serde_json::to_vec(&reply).unwrap().len() < 1024);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_the_app_bundle() {
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/Folio.app/Contents/MacOS/folio-desktop"
            )),
            Some(PathBuf::from("/Applications/Folio.app"))
        );
        assert_eq!(app_bundle(Path::new("/usr/local/bin/folio-desktop")), None);
    }
}

/// Whatever Chrome sends, the host answers with well-formed replies, and
/// keeps only documents that arrived whole, in order and as announced.
#[cfg(test)]
mod properties {
    use super::*;
    use crate::fuzz;
    use proptest::prelude::*;
    use std::collections::HashMap;
    use std::io::Cursor;

    fn base64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// A JSON object of a known type; an error with a code and a message; a
    /// transfer only when it is a valid id; far below Chrome's limit.
    fn assert_well_formed(reply: &Value) -> Result<(), TestCaseError> {
        let kind = reply["type"].as_str().unwrap_or_default();
        prop_assert!(
            ["hello", "ready", "ack", "done", "error"].contains(&kind),
            "{reply}"
        );
        if kind == "error" {
            for field in ["code", "message"] {
                prop_assert!(
                    reply[field].as_str().is_some_and(|text| !text.is_empty()),
                    "{reply}"
                );
            }
        }
        if let Some(transfer) = reply.get("transfer") {
            prop_assert!(
                transfer.as_str().is_some_and(incoming::is_valid_id),
                "{reply}"
            );
        }
        prop_assert!(serde_json::to_vec(reply).unwrap().len() < 1024, "{reply}");
        Ok(())
    }

    fn host(base: &Path) -> Host {
        let mut host = Host::new(Some(base.to_path_buf()), None);
        // The tests' documents are tiny; whether the disk has room is
        // tested on its own.
        host.free_space = |_| None;
        host
    }

    /// The transfer folders in the spool (not its lock file).
    fn spooled(base: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(base)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| name != incoming::LOCK_FILE)
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn uuid() -> impl Strategy<Value = String> {
        any::<u128>().prop_map(|bits| uuid::Uuid::from_u128(bits).hyphenated().to_string())
    }

    /// A PDF, junk, or junk long enough to be refused before it is complete.
    fn document() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            3 => prop::collection::vec(any::<u8>(), 0..300)
                .prop_map(|rest| [b"%PDF-1.7\n".as_slice(), &rest].concat()),
            1 => prop::collection::vec(any::<u8>(), 0..300),
            1 => prop::collection::vec(any::<u8>(), HEADER_WINDOW..HEADER_WINDOW + 600),
        ]
    }

    /// Frames with their true length, a wrong one or a huge one, and maybe
    /// a few stray bytes at the end.
    fn stream() -> impl Strategy<Value = Vec<u8>> {
        let length = prop_oneof![
            4 => Just(None),
            1 => (0u32..600).prop_map(Some),
            1 => any::<u32>().prop_map(Some),
            1 => Just(Some(MAX_MESSAGE_BYTES as u32 + 1)),
        ];
        let frame = (fuzz::bytes(), length).prop_map(|(payload, length)| {
            let length = length.unwrap_or(payload.len() as u32);
            [&length.to_ne_bytes()[..], &payload].concat()
        });
        (
            prop::collection::vec(frame, 0..5),
            prop::collection::vec(any::<u8>(), 0..4),
        )
            .prop_map(|(frames, tail)| [frames.concat(), tail].concat())
    }

    /// Mostly right (`None`), now and then `wrong`.
    fn sometimes<T: Clone + std::fmt::Debug>(
        wrong: impl Strategy<Value = T>,
    ) -> impl Strategy<Value = Option<T>> {
        prop_oneof![10 => Just(None), 1 => wrong.prop_map(Some)]
    }

    /// How much of the document a chunk carries.
    #[derive(Debug, Clone)]
    enum Length {
        /// Part of what is left.
        Part(prop::sample::Index),
        /// All that is left.
        Rest,
        /// All that is left and these bytes more.
        TooMuch(Vec<u8>),
    }

    /// What the extension sends next: right, unless an override says
    /// otherwise.
    #[derive(Debug, Clone)]
    enum Step {
        Hello,
        Begin {
            document: Vec<u8>,
            name: String,
            size: Option<u64>,
            sha256: Option<String>,
        },
        Chunk {
            length: Length,
            index: Option<u64>,
            transfer: Option<String>,
            data: Option<String>,
        },
        End {
            transfer: Option<String>,
        },
        /// Any message at all.
        Noise(Vec<u8>),
    }

    fn begin() -> impl Strategy<Value = Step> {
        let size = prop_oneof![
            Just(0u64),
            Just(MAX_TRANSFER_BYTES + 1),
            1u64..400,
            any::<u64>()
        ];
        let sha256 = prop_oneof!["[0-9a-f]{64}", "[0-9A-Fa-f]{0,70}", fuzz::text()];
        (document(), fuzz::text(), sometimes(size), sometimes(sha256)).prop_map(
            |(document, name, size, sha256)| Step::Begin {
                document,
                name,
                size,
                sha256,
            },
        )
    }

    fn transfer_claim() -> impl Strategy<Value = Option<String>> {
        sometimes(prop_oneof![uuid(), fuzz::text()])
    }

    fn chunk(rest: bool) -> impl Strategy<Value = Step> {
        let length = if rest {
            Just(Length::Rest).boxed()
        } else {
            prop_oneof![
                6 => any::<prop::sample::Index>().prop_map(Length::Part),
                1 => prop::collection::vec(any::<u8>(), 1..20).prop_map(Length::TooMuch),
            ]
            .boxed()
        };
        let index = prop_oneof![0u64..8, any::<u64>()];
        let data = prop_oneof![
            Just("not base64!".to_owned()),
            "[A-Za-z0-9+/=]{0,12}",
            fuzz::text()
        ];
        (length, sometimes(index), transfer_claim(), sometimes(data)).prop_map(
            |(length, index, transfer, data)| Step::Chunk {
                length,
                index,
                transfer,
                data,
            },
        )
    }

    fn noise() -> impl Strategy<Value = Vec<Step>> {
        prop_oneof![
            3 => Just(Vec::new()),
            1 => Just(vec![Step::Hello]),
            1 => fuzz::bytes().prop_map(|bytes| vec![Step::Noise(bytes)]),
        ]
    }

    /// A transfer from beginning to end, with mistakes and other messages
    /// mixed in.
    fn episode() -> impl Strategy<Value = Vec<Step>> {
        (
            begin(),
            prop::collection::vec((noise(), chunk(false)), 0..4),
            noise(),
            chunk(true),
            noise(),
            transfer_claim(),
        )
            .prop_map(|(begin, chunks, before_last, last, before_end, end)| {
                let mut steps = vec![begin];
                for (noise, chunk) in chunks {
                    steps.extend(noise);
                    steps.push(chunk);
                }
                steps.extend(before_last);
                steps.push(last);
                steps.extend(before_end);
                steps.push(Step::End { transfer: end });
                steps
            })
    }

    /// The extension's side, and what the host confirmed.
    #[derive(Default)]
    struct Extension {
        /// The transfer the last `ready` named, and its document.
        current: Option<String>,
        document: Vec<u8>,
        sent: usize,
        next_index: u64,
        /// Per transfer: the size and checksum announced, and the bytes the
        /// host acknowledged.
        announced: HashMap<String, (u64, String)>,
        acknowledged: HashMap<String, Vec<u8>>,
        done: Vec<String>,
    }

    impl Extension {
        /// The message for `step`, and the part of the document a chunk is
        /// meant to carry.
        fn message(&self, step: &Step) -> (Vec<u8>, Vec<u8>) {
            let current = || self.current.clone().unwrap_or_else(incoming::new_id);
            let message = match step {
                Step::Hello => json!({ "type": "hello" }),
                Step::Begin {
                    document,
                    name,
                    size,
                    sha256,
                } => json!({
                    "type": "begin",
                    "name": name,
                    "size": size.unwrap_or(document.len() as u64),
                    "sha256": sha256.clone().unwrap_or_else(|| save::sha256_hex(document)),
                }),
                Step::Chunk {
                    length,
                    index,
                    transfer,
                    data,
                } => {
                    let rest = &self.document[self.sent.min(self.document.len())..];
                    let bytes = match length {
                        Length::Part(part) => rest[..part.index(rest.len() + 1)].to_vec(),
                        Length::Rest => rest.to_vec(),
                        Length::TooMuch(more) => [rest, more].concat(),
                    };
                    let message = json!({
                        "type": "chunk",
                        "transfer": transfer.clone().unwrap_or_else(current),
                        "index": index.unwrap_or(self.next_index),
                        "data": data.clone().unwrap_or_else(|| base64(&bytes)),
                    });
                    return (serde_json::to_vec(&message).unwrap(), bytes);
                }
                Step::End { transfer } => json!({
                    "type": "end",
                    "transfer": transfer.clone().unwrap_or_else(current),
                }),
                Step::Noise(bytes) => return (bytes.clone(), Vec::new()),
            };
            (serde_json::to_vec(&message).unwrap(), Vec::new())
        }
    }

    /// Runs `steps` against a host and checks every reply and the spool.
    /// Returns the transfers that were done.
    fn run(steps: &[Step]) -> Result<Vec<String>, TestCaseError> {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("incoming");
        let mut host = host(&base);
        let mut extension = Extension::default();
        for step in steps {
            let (message, bytes) = extension.message(step);
            let reply = host.handle(&message);
            assert_well_formed(&reply)?;
            let sent: Value = serde_json::from_slice(&message).unwrap_or_default();
            match reply["type"].as_str().unwrap_or_default() {
                "ready" => {
                    let Step::Begin { document, .. } = step else {
                        return Err(TestCaseError::fail(format!("ready for {step:?}")));
                    };
                    let id = reply["transfer"].as_str().unwrap().to_owned();
                    let announced = (
                        sent["size"].as_u64().unwrap(),
                        sent["sha256"].as_str().unwrap().to_owned(),
                    );
                    extension.announced.insert(id.clone(), announced);
                    extension.acknowledged.insert(id.clone(), Vec::new());
                    extension.current = Some(id);
                    extension.document = document.clone();
                    extension.sent = 0;
                    extension.next_index = 0;
                }
                "ack" => {
                    prop_assert!(matches!(step, Step::Chunk { .. }), "ack for {step:?}");
                    // Only for the transfer in progress, in order.
                    prop_assert_eq!(&reply["index"], &sent["index"]);
                    prop_assert_eq!(&sent["index"], &json!(extension.next_index));
                    let transfer = sent["transfer"].as_str().unwrap().to_owned();
                    prop_assert_eq!(Some(&transfer), extension.current.as_ref());
                    let data = sent["data"].as_str().unwrap();
                    let data = base64::engine::general_purpose::STANDARD.decode(data);
                    prop_assert!(data.is_ok(), "ack for data that is not base64");
                    extension
                        .acknowledged
                        .entry(transfer)
                        .or_default()
                        .extend(data.unwrap());
                    extension.sent += bytes.len();
                    extension.next_index += 1;
                }
                "done" => {
                    let id = reply["transfer"].as_str().unwrap().to_owned();
                    prop_assert!(matches!(step, Step::End { .. }), "done for {step:?}");
                    prop_assert_eq!(sent["transfer"].as_str(), Some(id.as_str()));
                    // Exactly what was announced and acknowledged, a PDF.
                    let dir = base.join(&id);
                    let stored = std::fs::read(dir.join(incoming::DOCUMENT_FILE)).unwrap();
                    let (size, sha256) = &extension.announced[&id];
                    prop_assert_eq!(&stored, &extension.acknowledged[&id]);
                    prop_assert_eq!(stored.len() as u64, *size);
                    prop_assert!(save::sha256_hex(&stored).eq_ignore_ascii_case(sha256));
                    prop_assert!(save::looks_like_pdf(&stored));
                    let meta = incoming::read_meta(&dir).unwrap();
                    prop_assert_eq!(&save::sanitize_file_name(&meta.name), &meta.name);
                    prop_assert_eq!(meta.size, *size);
                    extension.done.push(id);
                }
                _ => {}
            }
            // A few documents at most, finished or arriving.
            prop_assert!(spooled(&base).len() <= incoming::MAX_PENDING);
        }
        // Chrome disconnects: only the finished documents are left.
        drop(host);
        let mut done = extension.done.clone();
        done.sort();
        prop_assert_eq!(spooled(&base), done);
        Ok(extension.done)
    }

    proptest! {
        #![proptest_config(fuzz::config(256))]

        #[test]
        fn answers_any_message_with_a_well_formed_reply(message in fuzz::bytes()) {
            let dir = tempfile::tempdir().unwrap();
            let mut host = host(&dir.path().join("incoming"));
            assert_well_formed(&host.handle(&message))?;
        }

        #[test]
        fn frames_read_back_as_written(values in prop::collection::vec(fuzz::json(), 0..5)) {
            let mut stream = Vec::new();
            let mut written = Vec::new();
            for value in &values {
                if write_message(&mut stream, value).is_ok() {
                    written.push(serde_json::to_vec(value).unwrap());
                }
            }
            let mut reader = Cursor::new(stream);
            for expected in written {
                prop_assert_eq!(read_message(&mut reader).unwrap(), Some(expected));
            }
            prop_assert_eq!(read_message(&mut reader).unwrap(), None);
        }

        /// A message is read whole, as long as its frame says, refused when
        /// too large, or reported as cut short; never misread.
        #[test]
        fn reads_any_stream_frame_by_frame(stream in stream()) {
            let mut reader = Cursor::new(&stream[..]);
            loop {
                let rest = &stream[reader.position() as usize..];
                let length = rest
                    .get(..4)
                    .map(|length| u32::from_ne_bytes(length.try_into().unwrap()) as usize);
                match read_message(&mut reader) {
                    Ok(None) => {
                        prop_assert!(rest.is_empty());
                        break;
                    }
                    Ok(Some(message)) => {
                        let length = length.unwrap();
                        prop_assert!(length <= MAX_MESSAGE_BYTES);
                        prop_assert_eq!(&message[..], &rest[4..4 + length]);
                    }
                    Err(FrameError::TooLarge(announced)) => {
                        prop_assert_eq!(Some(announced as usize), length);
                        prop_assert!(announced > MAX_MESSAGE_BYTES as u64);
                        break;
                    }
                    Err(FrameError::Io(_)) => {
                        prop_assert!(length.is_none_or(|length| rest.len() - 4 < length));
                        break;
                    }
                }
            }
        }

        /// Whatever arrives, every reply is a frame Chrome accepts.
        #[test]
        fn serves_any_stream_with_well_formed_replies(stream in stream()) {
            let dir = tempfile::tempdir().unwrap();
            let mut host = host(&dir.path().join("incoming"));
            let mut output = Vec::new();
            let _ = host.serve(&mut Cursor::new(stream), &mut output);
            let mut replies = Cursor::new(output);
            while let Some(reply) = read_message(&mut replies).unwrap() {
                prop_assert!(reply.len() < MAX_REPLY_BYTES);
                assert_well_formed(&serde_json::from_slice(&reply).unwrap())?;
            }
        }

        #[test]
        fn answers_only_the_official_extension(origin in prop_oneof![
            Just(format!("chrome-extension://{}/", native_messaging::OFFICIAL_EXTENSION_IDS[0])),
            "chrome-extension://[a-p]{32}/",
            "[Cc]hrome-extension://[a-q]{31,33}/{0,2}",
            fuzz::text(),
        ]) {
            let official = native_messaging::OFFICIAL_EXTENSION_IDS
                .iter()
                .any(|id| origin == format!("chrome-extension://{id}/"));
            prop_assert_eq!(origin_allowed(Some(OsStr::new(&origin))), official);
            prop_assert_eq!(
                is_host_invocation(Some(OsStr::new(&origin))),
                origin.starts_with("chrome-extension://")
            );
        }
    }

    #[cfg(unix)]
    proptest! {
        #![proptest_config(fuzz::config(256))]

        /// Chrome passes the origin as an argument, which need not be text.
        #[test]
        fn refuses_origins_that_are_not_text(
            text in fuzz::text(),
            stray in any::<prop::sample::Index>(),
        ) {
            use std::os::unix::ffi::OsStrExt;
            // A byte that is never valid UTF-8, anywhere in the text.
            let mut bytes = format!("chrome-extension://{text}").into_bytes();
            bytes.insert(stray.index(bytes.len() + 1), 0xff);
            let origin = OsStr::from_bytes(&bytes);
            prop_assert!(!origin_allowed(Some(origin)));
            prop_assert!(!is_host_invocation(Some(origin)));
        }
    }

    proptest! {
        #![proptest_config(fuzz::config(128))]

        /// Any PDF, split into chunks anywhere, with hellos in between,
        /// arrives byte for byte under a plain name.
        #[test]
        fn spools_documents_split_anywhere(
            document in prop::collection::vec(any::<u8>(), 0..3000)
                .prop_map(|rest| [b"%PDF-2.0\n".as_slice(), &rest].concat()),
            name in fuzz::text(),
            cuts in prop::collection::vec(any::<prop::sample::Index>(), 0..6),
            hellos in prop::collection::vec(any::<bool>(), 8),
        ) {
            let mut cuts: Vec<usize> = cuts.iter().map(|cut| cut.index(document.len() + 1)).collect();
            cuts.push(0);
            cuts.push(document.len());
            cuts.sort_unstable();
            let mut steps = vec![Step::Begin { document: document.clone(), name, size: None, sha256: None }];
            for (index, part) in cuts.windows(2).enumerate() {
                if hellos[index % hellos.len()] {
                    steps.push(Step::Hello);
                }
                // The part between two cuts.
                steps.push(Step::Chunk {
                    length: Length::Rest,
                    index: None,
                    transfer: None,
                    data: Some(base64(&document[part[0]..part[1]])),
                });
            }
            steps.push(Step::End { transfer: None });
            // Checked like any run, and it must have arrived.
            prop_assert_eq!(run(&steps)?.len(), 1);
        }

        /// Transfers with mistakes and other messages mixed in: the spool
        /// only ever keeps documents that arrived as announced.
        #[test]
        fn keeps_only_documents_that_arrived_as_announced(
            episodes in prop::collection::vec(episode(), 1..5),
        ) {
            run(&episodes.concat())?;
        }
    }
}
