//! Runs the real binary the way Chrome starts a native messaging host and
//! sends a document through it.

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// The official Folio extension.
const ORIGIN: &str = "chrome-extension://ghfckfnleaidabfhaplbnfknipajedan/";

struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl Host {
    fn start(data_dir: &std::path::Path, extra_args: &[&str]) -> Host {
        Host::start_as(ORIGIN, data_dir, extra_args)
    }

    fn start_as(origin: &str, data_dir: &std::path::Path, extra_args: &[&str]) -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_folio-desktop"))
            .arg(origin)
            .args(extra_args)
            .env("FOLIO_DATA_DIR", data_dir)
            .env("FOLIO_NATIVE_HOST_NO_LAUNCH", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the desktop binary starts");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        Host {
            child,
            stdin,
            stdout,
        }
    }

    fn send(&mut self, message: &Value) {
        let bytes = serde_json::to_vec(message).unwrap();
        let stdin = self.stdin.as_mut().unwrap();
        stdin
            .write_all(&(bytes.len() as u32).to_ne_bytes())
            .unwrap();
        stdin.write_all(&bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut length = [0u8; 4];
        self.stdout.read_exact(&mut length).unwrap();
        let length = u32::from_ne_bytes(length) as usize;
        assert!(length < 1024 * 1024, "replies must stay below 1 MiB");
        let mut bytes = vec![0; length];
        self.stdout.read_exact(&mut bytes).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn ask(&mut self, message: Value) -> Value {
        self.send(&message);
        self.receive()
    }

    /// Closes stdin as Chrome does when the extension disconnects.
    fn finish(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        self.child.wait().unwrap()
    }
}

fn pdf() -> Vec<u8> {
    let mut bytes = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
    for index in 0..2000 {
        bytes.extend_from_slice(format!("% filler line {index}\n").as_bytes());
    }
    bytes.extend_from_slice(b"%%EOF\n");
    bytes
}

#[test]
fn transfers_a_document_in_host_mode() {
    let data = tempfile::tempdir().unwrap();
    let document = pdf();
    let sha256: String = Sha256::digest(&document)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    // Windows passes the parent window after the origin.
    let mut host = Host::start(data.path(), &["--parent-window=0"]);
    let hello = host.ask(json!({ "type": "hello" }));
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));

    let ready = host.ask(json!({
        "type": "begin",
        "name": "Quarterly report.pdf",
        "size": document.len(),
        "sha256": sha256,
    }));
    assert_eq!(ready["type"], "ready", "{ready}");
    let transfer = ready["transfer"].as_str().unwrap().to_owned();

    for (index, chunk) in document.chunks(16 * 1024).enumerate() {
        let ack = host.ask(json!({
            "type": "chunk",
            "transfer": transfer,
            "index": index,
            "data": base64::engine::general_purpose::STANDARD.encode(chunk),
        }));
        assert_eq!(ack, json!({ "type": "ack", "index": index }));
    }
    let done = host.ask(json!({ "type": "end", "transfer": transfer }));
    assert_eq!(done, json!({ "type": "done", "transfer": transfer }));

    let unknown = host.ask(json!({ "type": "open-a-shell" }));
    assert_eq!(unknown["type"], "error");
    assert_eq!(unknown["code"], "unknown-type");
    assert!(host.finish().success());

    let spool = data.path().join("incoming").join(&transfer);
    assert_eq!(std::fs::read(spool.join("document.pdf")).unwrap(), document);
    let meta: Value =
        serde_json::from_slice(&std::fs::read(spool.join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["name"], "Quarterly report.pdf");
    assert_eq!(meta["size"], document.len());
    assert!(meta["createdAt"].as_str().unwrap().ends_with('Z'));
}

#[test]
fn deletes_an_unfinished_transfer_when_chrome_disconnects() {
    let data = tempfile::tempdir().unwrap();
    let document = pdf();
    let mut host = Host::start(data.path(), &[]);
    let ready = host.ask(json!({
        "type": "begin",
        "name": "a.pdf",
        "size": document.len(),
        "sha256": "0".repeat(64),
    }));
    let transfer = ready["transfer"].as_str().unwrap().to_owned();
    let ack = host.ask(json!({
        "type": "chunk",
        "transfer": transfer,
        "index": 0,
        "data": base64::engine::general_purpose::STANDARD.encode(&document[..100]),
    }));
    assert_eq!(ack["type"], "ack");
    assert!(data.path().join("incoming").join(&transfer).exists());
    assert!(host.finish().success());
    assert!(!data.path().join("incoming").join(&transfer).exists());
}

#[test]
fn refuses_extensions_folio_does_not_know() {
    let data = tempfile::tempdir().unwrap();
    // A list of other extensions, as an earlier build kept, allows nothing.
    std::fs::write(
        data.path().join("native-messaging.json"),
        r#"{"extensionIds":["abcdefghijklmnopabcdefghijklmnop"]}"#,
    )
    .unwrap();
    for origin in [
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        "chrome-extension://ghfckfnleaidabfhaplbnfknipajedan",
        "chrome-extension://ghfckfnleaidabfhaplbnfknipajedan/../",
        "chrome-extension://x/",
    ] {
        let mut host = Host::start_as(origin, data.path(), &[]);
        // One answer, before anything is read, then the host exits.
        let reply = host.receive();
        assert_eq!(reply["type"], "error", "{origin}");
        assert_eq!(reply["code"], "origin-not-allowed", "{origin}");
        assert!(!host.finish().success(), "{origin}");
    }
    assert!(!data.path().join("incoming").exists());
}

#[cfg(unix)]
#[test]
fn clears_what_ended_hosts_left_behind() {
    use std::time::{Duration, SystemTime};
    let data = tempfile::tempdir().unwrap();
    // A transfer whose host was killed an hour ago.
    let dir = data
        .path()
        .join("incoming")
        .join("0b3f2c1e-8c55-4a43-9c3c-6f0d2f8e9a10");
    std::fs::create_dir_all(&dir).unwrap();
    let part = dir.join("document.pdf.part");
    std::fs::write(&part, b"%PDF-1.7 half").unwrap();
    let long_ago = SystemTime::now() - Duration::from_secs(3600);
    for path in [&part, &dir] {
        std::fs::File::open(path)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
    }
    let mut host = Host::start(data.path(), &[]);
    assert_eq!(host.ask(json!({ "type": "hello" }))["type"], "hello");
    assert!(!dir.exists());
    assert!(host.finish().success());
}

/// The transfer folders in the spool (not its lock file).
fn spooled(data: &std::path::Path) -> usize {
    std::fs::read_dir(data.join("incoming"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
                .count()
        })
        .unwrap_or(0)
}

#[test]
fn hosts_running_at_once_keep_the_spool_bounded() {
    let data = tempfile::tempdir().unwrap();
    let document = pdf();
    let begin = json!({
        "type": "begin",
        "name": "a.pdf",
        "size": document.len(),
        "sha256": "0".repeat(64),
    });
    // One host per extension connection, all up before any transfer starts.
    let mut hosts: Vec<Host> = (0..6).map(|_| Host::start(data.path(), &[])).collect();
    for host in &mut hosts {
        assert_eq!(host.ask(json!({ "type": "hello" }))["type"], "hello");
    }
    for host in &mut hosts {
        host.send(&begin);
    }
    let replies: Vec<Value> = hosts.iter_mut().map(Host::receive).collect();
    let ready = replies
        .iter()
        .filter(|reply| reply["type"] == "ready")
        .count();
    assert_eq!(ready, 3, "{replies:?}");
    for reply in replies.iter().filter(|reply| reply["type"] != "ready") {
        assert_eq!(reply["code"], "busy", "{reply}");
    }
    assert_eq!(spooled(data.path()), 3);
    for host in hosts {
        assert!(host.finish().success());
    }
    // Unfinished transfers go with their hosts.
    assert_eq!(spooled(data.path()), 0);
}
