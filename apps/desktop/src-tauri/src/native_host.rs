//! The native messaging host the Folio Chrome extension talks to
//! (`io.github.albird97.folio`). It is the desktop binary itself: Chrome
//! starts it with the caller's origin (`chrome-extension://<id>/`) as the
//! first argument, and `main` then runs [`run_stdio`] instead of the app.
//!
//! Messages are UTF-8 JSON preceded by their length as a 32-bit integer in
//! native byte order (little-endian on every platform Folio supports), in
//! both directions. Only these messages are understood:
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
//! and verified (size, SHA-256, PDF header) before the app is started with
//! `--incoming <transfer>` to ask the user whether to open it. Anything that
//! goes wrong deletes what was received so far.

use crate::incoming::{self, IncomingMeta};
use crate::{paths, save};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::path::PathBuf;

pub const PROTOCOL: u32 = 1;
/// Longest message accepted from Chrome.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// Chrome refuses messages from a host of 1 MiB or more.
pub const MAX_REPLY_BYTES: usize = 1024 * 1024;
pub const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;
/// Largest decoded chunk.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// `1` spools transfers without starting the app (tests).
pub const NO_LAUNCH_ENV: &str = "FOLIO_NATIVE_HOST_NO_LAUNCH";
const ORIGIN_PREFIX: &str = "chrome-extension://";
/// PDF readers accept the header anywhere in the first 1024 bytes.
const HEADER_WINDOW: usize = 1024;

/// Whether the process was started by Chrome as a native messaging host.
pub fn is_host_invocation(first_arg: Option<&OsStr>) -> bool {
    first_arg
        .and_then(OsStr::to_str)
        .is_some_and(|arg| arg.starts_with(ORIGIN_PREFIX))
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
    host_error("message-too-large", "The message is larger than 64 MB.");

fn error_reply(error: &HostError, transfer: Option<&str>) -> Value {
    let mut reply = json!({ "type": "error", "code": error.code, "message": error.message });
    if let Some(transfer) = transfer {
        reply["transfer"] = json!(transfer);
    }
    reply
}

#[derive(Deserialize)]
struct Begin {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
struct Chunk {
    transfer: String,
    index: u64,
    data: String,
}

#[derive(Deserialize)]
struct End {
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

/// Starts the app to ask the user about a transfer.
pub type Launch = Box<dyn FnMut(&str) -> io::Result<()>>;

pub struct Host {
    /// `<app data>/incoming`, if there is a data directory.
    incoming: Option<PathBuf>,
    launch: Option<Launch>,
    active: Option<Transfer>,
}

impl Host {
    /// `launch: None` spools documents without telling the app.
    pub fn new(incoming: Option<PathBuf>, launch: Option<Launch>) -> Self {
        Host {
            incoming,
            launch,
            active: None,
        }
    }

    /// Answers one message.
    pub fn handle(&mut self, message: &[u8]) -> Value {
        // Objects only (serde would also read a struct from an array).
        let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(message) else {
            return error_reply(&INVALID_MESSAGE, None);
        };
        let Some(kind) = fields
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return error_reply(&INVALID_MESSAGE, None);
        };
        let message = Value::Object(fields);
        match kind.as_str() {
            "hello" => json!({
                "type": "hello",
                "protocol": PROTOCOL,
                "version": env!("CARGO_PKG_VERSION"),
            }),
            "begin" => match serde_json::from_value::<Begin>(message) {
                Ok(begin) => self.begin(begin),
                Err(_) => {
                    self.abort();
                    error_reply(&INVALID_MESSAGE, None)
                }
            },
            "chunk" => match serde_json::from_value::<Chunk>(message) {
                Ok(chunk) => self.chunk(chunk),
                Err(_) => self.fail(&INVALID_MESSAGE),
            },
            "end" => match serde_json::from_value::<End>(message) {
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
        let Some(base) = &self.incoming else {
            return error_reply(&UNAVAILABLE, None);
        };
        let id = incoming::new_id();
        let dir = base.join(&id);
        let file = paths::create_private_dir(&dir).and_then(|()| {
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
        if let Some(launch) = &mut self.launch {
            if launch(&id).is_err() {
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

/// Starts the app with `--incoming <id>`, detached from the host (which
/// Chrome stops when the extension disconnects). A running app receives the
/// arguments through the single-instance plugin and the new process exits.
pub fn launch_app(id: &str) -> io::Result<()> {
    use std::process::{Command, Stdio};
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg(crate::files::INCOMING_ARG)
        .arg(id)
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

/// Host mode: serves Chrome on stdin/stdout. Returns the exit code.
pub fn run_stdio() -> i32 {
    let incoming = paths::app_data_dir().map(|dir| dir.join(incoming::INCOMING_DIR));
    let launch = match std::env::var(NO_LAUNCH_ENV) {
        Ok(value) if value == "1" => None,
        _ => Some(Box::new(launch_app) as Launch),
    };
    let mut host = Host::new(incoming, launch);
    let served = host.serve(&mut io::stdin().lock(), &mut io::stdout().lock());
    drop(host);
    i32::from(served.is_err())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const PDF: &[u8] = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";

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
        let launch: Launch = Box::new(move |id: &str| {
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

        fn incoming(&self) -> PathBuf {
            self.dir.path().join("incoming")
        }

        fn spooled(&self) -> Vec<String> {
            std::fs::read_dir(self.incoming())
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
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
        assert!(!is_host_invocation(Some(OsStr::new("Report.pdf"))));
        assert!(!is_host_invocation(Some(OsStr::new("--incoming"))));
        assert!(!is_host_invocation(None));
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
        let huge = serde_json::json!({ "type": "error", "message": "x".repeat(MAX_REPLY_BYTES) });
        assert!(write_message(&mut Vec::new(), &huge).is_err());
    }

    #[test]
    fn says_hello() {
        let mut fixture = fixture();
        let reply = fixture.send(json!({ "type": "hello" }));
        assert_eq!(
            reply,
            json!({ "type": "hello", "protocol": 1, "version": env!("CARGO_PKG_VERSION") })
        );
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
        assert_error(&fixture.host.handle(b"not json"), "invalid-message");
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
        let launch: Launch = Box::new(|_| Err(io::Error::other("no app")));
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
            INVALID_MESSAGE,
            UNKNOWN_TYPE,
            TOO_LARGE,
            SHA256_MISMATCH,
            MESSAGE_TOO_LARGE,
        ] {
            let reply = error_reply(&error, Some(&incoming::new_id()));
            assert!(serde_json::to_vec(&reply).unwrap().len() < 1024);
        }
    }
}
