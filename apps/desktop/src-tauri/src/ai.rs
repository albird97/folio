//! Ask Claude (opt-in): the user's own Anthropic API key and the only way
//! Folio reaches Anthropic's API.
//!
//! The key is kept in the operating system's credential store (the macOS
//! Keychain, the Windows Credential Manager) and never returns to the
//! webview. The webview's Anthropic SDK sends its requests through
//! [`AiProxy::relay`], which only forwards `POST` requests to Anthropic's
//! messages and token counting endpoints on one fixed origin, keeps an
//! allow-list of headers, adds the key, caps the body and streams the answer
//! back. The webview's CSP still allows no remote connections, so a
//! compromised page can at most ask questions with the key, never read it or
//! send anything elsewhere.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

/// The one origin Folio talks to.
pub const API_ORIGIN: &str = "https://api.anthropic.com";
/// Messages (answers) and token counting.
const API_PATHS: [&str; 2] = ["/v1/messages", "/v1/messages/count_tokens"];
/// Request headers passed on; the SDK's others (user agent, platform
/// details, retry counters) are dropped, and the key is added here.
const REQUEST_HEADERS: [&str; 3] = ["anthropic-version", "anthropic-beta", "content-type"];
/// Response headers handed back: the body's type and the retry hints.
const RESPONSE_HEADERS: [&str; 5] = [
    "content-type",
    "request-id",
    "retry-after",
    "retry-after-ms",
    "x-should-retry",
];
/// Anthropic's own request size limit (32 MB).
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_HEADER_VALUE: usize = 1024;
/// Where the key is filed in the credential store.
const KEY_SERVICE: &str = "io.github.albird97.folio.anthropic";
const KEY_ACCOUNT: &str = "api-key";
/// Ids of cancellations that arrived before their request started.
const MAX_EARLY_CANCELS: usize = 64;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AiError {
    #[error("That is not an API key.")]
    InvalidKey,
    #[error("No API key is stored.")]
    NoKey,
    #[error("Folio does not send this request.")]
    Blocked,
    #[error("The request is too large to send.")]
    TooLarge,
    #[error("The API key could not be stored.")]
    Storage,
    #[error("Folio could not reach Anthropic.")]
    Network,
}

impl AiError {
    pub fn code(&self) -> &'static str {
        match self {
            AiError::InvalidKey => "invalid-key",
            AiError::NoKey => "no-key",
            AiError::Blocked => "blocked",
            AiError::TooLarge => "too-large",
            AiError::Storage => "storage",
            AiError::Network => "network",
        }
    }
}

/// A request as the webview's transport describes it.
#[derive(Debug, Deserialize)]
pub struct ProxyRequest {
    /// Path and query, e.g. `/v1/messages?beta=true`.
    pub path: String,
    pub headers: Vec<(String, String)>,
    /// The JSON body.
    pub body: String,
}

/// A request that passed [`check_request`].
#[derive(Debug, PartialEq, Eq)]
pub struct CheckedRequest {
    pub path: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

/// One of the two endpoints, optionally with the SDK's `?beta=true`.
pub fn is_allowed_path(path: &str) -> bool {
    let (path, query) = match path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path, None),
    };
    API_PATHS.contains(&path) && matches!(query, None | Some("beta=true"))
}

fn is_safe_header_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HEADER_VALUE
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// Keeps only what may be sent: an allowed path, the allowed headers (the
/// body must be JSON) and a body within Anthropic's limit.
pub fn check_request(request: ProxyRequest) -> Result<CheckedRequest, AiError> {
    if !is_allowed_path(&request.path) {
        return Err(AiError::Blocked);
    }
    if request.body.len() > MAX_BODY_BYTES {
        return Err(AiError::TooLarge);
    }
    let mut headers = Vec::new();
    for (name, value) in request.headers {
        let Some(allowed) = REQUEST_HEADERS
            .iter()
            .find(|allowed| allowed.eq_ignore_ascii_case(&name))
        else {
            continue;
        };
        if !is_safe_header_value(&value) {
            return Err(AiError::Blocked);
        }
        headers.push((*allowed, value));
    }
    let json = headers.iter().any(|(name, value)| {
        *name == "content-type" && value.to_ascii_lowercase().starts_with("application/json")
    });
    if !json {
        return Err(AiError::Blocked);
    }
    Ok(CheckedRequest {
        path: request.path,
        headers,
        body: request.body,
    })
}

/// Anthropic's keys are long strings of letters, digits, `-` and `_`
/// (`sk-ant-…`). Anything else never reaches the credential store or a
/// header.
pub fn normalize_key(raw: &str) -> Option<String> {
    let key = raw.trim();
    let valid = (16..=512).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    valid.then(|| key.to_owned())
}

/// Request ids come from the webview and only name a running request.
fn is_request_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Where the key is kept.
pub trait SecretStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, AiError>;
    fn set(&self, key: &str) -> Result<(), AiError>;
    fn delete(&self) -> Result<(), AiError>;
}

/// The operating system's credential store, through the `keyring` crate
/// (its mock in tests, and on Linux builds, which do not use it).
pub struct KeyringStore(keyring::Entry);

impl KeyringStore {
    pub fn new() -> Option<Self> {
        keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).ok().map(Self)
    }

    #[cfg(test)]
    fn mock() -> Self {
        Self(keyring::Entry::new_with_credential(Box::new(
            keyring::mock::MockCredential::default(),
        )))
    }
}

impl SecretStore for KeyringStore {
    fn get(&self) -> Result<Option<String>, AiError> {
        match self.0.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AiError::Storage),
        }
    }

    fn set(&self, key: &str) -> Result<(), AiError> {
        self.0.set_password(key).map_err(|_| AiError::Storage)
    }

    fn delete(&self) -> Result<(), AiError> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AiError::Storage),
        }
    }
}

/// Linux, where Folio is built only for testing: a file in Folio's data
/// folder (which only the user can enter) that only the user can read,
/// rather than a dependency on a running Secret Service.
#[cfg(any(not(any(target_os = "macos", windows)), test))]
pub struct FileStore(std::path::PathBuf);

#[cfg(any(not(any(target_os = "macos", windows)), test))]
impl FileStore {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self(path)
    }
}

#[cfg(any(not(any(target_os = "macos", windows)), test))]
impl SecretStore for FileStore {
    fn get(&self) -> Result<Option<String>, AiError> {
        match std::fs::read_to_string(&self.0) {
            Ok(text) => Ok(normalize_key(&text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(AiError::Storage),
        }
    }

    fn set(&self, key: &str) -> Result<(), AiError> {
        use std::io::Write;
        let parent = self.0.parent().ok_or(AiError::Storage)?;
        crate::paths::create_private_dir(parent).map_err(|_| AiError::Storage)?;
        // Written next to the file, then moved over it, so a crash never
        // leaves half a key; created readable by the user only.
        let temporary = self.0.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| AiError::Storage)?;
        file.write_all(key.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| AiError::Storage)?;
        std::fs::rename(&temporary, &self.0).map_err(|_| AiError::Storage)
    }

    fn delete(&self) -> Result<(), AiError> {
        match std::fs::remove_file(&self.0) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AiError::Storage),
        }
    }
}

/// When there is nowhere to keep a key.
struct NoStore;

impl SecretStore for NoStore {
    fn get(&self) -> Result<Option<String>, AiError> {
        Ok(None)
    }
    fn set(&self, _key: &str) -> Result<(), AiError> {
        Err(AiError::Storage)
    }
    fn delete(&self) -> Result<(), AiError> {
        Ok(())
    }
}

/// The credential store of this platform: the OS's on macOS and Windows.
#[cfg(any(target_os = "macos", windows))]
pub fn platform_store(_data_dir: Option<&std::path::Path>) -> Box<dyn SecretStore> {
    match KeyringStore::new() {
        Some(store) => Box::new(store),
        None => Box::new(NoStore),
    }
}

/// The credential store of this platform: a private file in the data folder.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn platform_store(data_dir: Option<&std::path::Path>) -> Box<dyn SecretStore> {
    match data_dir {
        Some(dir) => Box::new(FileStore::new(dir.join("anthropic-api-key"))),
        None => Box::new(NoStore),
    }
}

/// What a relayed request produces, in order: the head, body chunks, then
/// the end (or a failure part-way).
#[derive(Debug, PartialEq, Eq)]
pub enum RelayEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk(Vec<u8>),
    End,
    Failed,
}

/// The head of an answer as the webview receives it.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RelayMessage<'a> {
    Head {
        status: u16,
        headers: &'a [(String, String)],
    },
    End,
    Error {
        code: &'static str,
    },
}

/// Removes a request from the running ones when it finishes, however it ends.
struct Running<'a> {
    proxy: &'a AiProxy,
    id: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        lock(&self.proxy.running).remove(&self.id);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct AiProxy {
    store: Box<dyn SecretStore>,
    origin: String,
    client: OnceLock<Option<reqwest::Client>>,
    running: Mutex<HashMap<String, Arc<Notify>>>,
    cancelled_early: Mutex<HashSet<String>>,
}

impl AiProxy {
    pub fn new(store: Box<dyn SecretStore>) -> Self {
        AiProxy {
            store,
            origin: API_ORIGIN.to_owned(),
            client: OnceLock::new(),
            running: Mutex::new(HashMap::new()),
            cancelled_early: Mutex::new(HashSet::new()),
        }
    }

    /// Only tests send elsewhere (a local server, over plain HTTP).
    #[cfg(test)]
    fn with_origin(store: Box<dyn SecretStore>, origin: String) -> Self {
        AiProxy {
            origin,
            ..Self::new(store)
        }
    }

    pub fn has_key(&self) -> Result<bool, AiError> {
        Ok(self.store.get()?.is_some())
    }

    pub fn set_key(&self, raw: &str) -> Result<(), AiError> {
        let key = normalize_key(raw).ok_or(AiError::InvalidKey)?;
        self.store.set(&key)
    }

    pub fn forget_key(&self) -> Result<(), AiError> {
        self.store.delete()
    }

    /// Stops a running request; one that has not started yet will not.
    pub fn cancel(&self, id: &str) {
        if !is_request_id(id) {
            return;
        }
        if let Some(signal) = lock(&self.running).get(id) {
            // A permit is kept when nobody waits at this moment.
            signal.notify_one();
            return;
        }
        let mut early = lock(&self.cancelled_early);
        if early.len() >= MAX_EARLY_CANCELS {
            early.clear();
        }
        early.insert(id.to_owned());
    }

    /// One client for every request: TLS through rustls with the `ring`
    /// provider, certificates checked against the system's trust store, no
    /// redirects and no referrer. Answers can stream for many minutes, so
    /// only connecting and silences between chunks have short limits.
    fn client(&self) -> Option<&reqwest::Client> {
        self.client
            .get_or_init(|| {
                let _ = rustls::crypto::ring::default_provider().install_default();
                reqwest::Client::builder()
                    .https_only(self.origin == API_ORIGIN)
                    .redirect(reqwest::redirect::Policy::none())
                    .referer(false)
                    .connect_timeout(Duration::from_secs(30))
                    .read_timeout(Duration::from_secs(180))
                    .timeout(Duration::from_secs(30 * 60))
                    .build()
                    .ok()
            })
            .as_ref()
    }

    /// Sends a request with the stored key and relays the answer as it
    /// arrives. `send` returns false once nobody listens any more, which
    /// stops the request, as does [`AiProxy::cancel`]. Errors before the
    /// answer's head are returned; later ones are relayed as
    /// [`RelayEvent::Failed`].
    pub async fn relay(
        &self,
        id: &str,
        request: ProxyRequest,
        mut send: impl FnMut(RelayEvent) -> bool,
    ) -> Result<(), AiError> {
        if !is_request_id(id) {
            return Err(AiError::Blocked);
        }
        let request = check_request(request)?;
        let key = tokio::task::block_in_place(|| self.store.get())?.ok_or(AiError::NoKey)?;
        let signal = Arc::new(Notify::new());
        {
            let mut running = lock(&self.running);
            if running.contains_key(id) {
                return Err(AiError::Blocked);
            }
            if lock(&self.cancelled_early).remove(id) {
                return Ok(());
            }
            running.insert(id.to_owned(), signal.clone());
        }
        let _running = Running {
            proxy: self,
            id: id.to_owned(),
        };
        let client = self.client().ok_or(AiError::Network)?;
        let mut builder = client
            .post(format!("{}{}", self.origin, request.path))
            .header("x-api-key", key)
            .body(request.body);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        let mut response = tokio::select! {
            response = builder.send() => response.map_err(|_| AiError::Network)?,
            () = signal.notified() => return Ok(()),
        };
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| RESPONSE_HEADERS.contains(&name.as_str()))
            .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned())))
            .collect();
        let head = RelayEvent::Head {
            status: response.status().as_u16(),
            headers,
        };
        if !send(head) {
            return Ok(());
        }
        loop {
            tokio::select! {
                chunk = response.chunk() => match chunk {
                    Ok(Some(bytes)) => {
                        if !send(RelayEvent::Chunk(bytes.to_vec())) {
                            return Ok(());
                        }
                    }
                    Ok(None) => {
                        send(RelayEvent::End);
                        return Ok(());
                    }
                    Err(_) => {
                        send(RelayEvent::Failed);
                        return Ok(());
                    }
                },
                () = signal.notified() => return Ok(()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn request(path: &str, headers: &[(&str, &str)], body: &str) -> ProxyRequest {
        ProxyRequest {
            path: path.to_owned(),
            headers: headers
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
            body: body.to_owned(),
        }
    }

    const JSON: (&str, &str) = ("content-type", "application/json");
    const KEY: &str = "sk-ant-api03-test-key-0123456789";

    #[test]
    fn only_the_two_endpoints_are_allowed() {
        assert!(is_allowed_path("/v1/messages"));
        assert!(is_allowed_path("/v1/messages?beta=true"));
        assert!(is_allowed_path("/v1/messages/count_tokens?beta=true"));
        for path in [
            "/v1/models",
            "/v1/messages/batches",
            "/v1/messages?beta=true&x=1",
            "/v1/messages?other=1",
            "/v1/messages/",
            "/V1/messages",
            "//evil.example/v1/messages",
            "/v1/messages/../files",
            "",
        ] {
            assert!(!is_allowed_path(path), "{path}");
        }
        assert_eq!(
            check_request(request("/v1/files", &[JSON], "{}")),
            Err(AiError::Blocked)
        );
    }

    #[test]
    fn keeps_only_allowed_headers() {
        let checked = check_request(request(
            "/v1/messages?beta=true",
            &[
                ("Content-Type", "application/json"),
                ("anthropic-version", "2023-06-01"),
                ("anthropic-beta", "server-side-fallback-2026-07-01"),
                ("x-api-key", "from-the-page"),
                ("authorization", "Bearer stolen"),
                ("user-agent", "Anthropic/JS"),
                ("x-stainless-os", "MacOS"),
                ("host", "evil.example"),
            ],
            "{\"model\":\"claude-opus-5-5\"}",
        ))
        .unwrap();
        assert_eq!(
            checked.headers,
            vec![
                ("content-type", "application/json".to_owned()),
                ("anthropic-version", "2023-06-01".to_owned()),
                (
                    "anthropic-beta",
                    "server-side-fallback-2026-07-01".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn refuses_bodies_that_are_not_json_or_too_large() {
        assert_eq!(
            check_request(request("/v1/messages", &[], "{}")),
            Err(AiError::Blocked)
        );
        assert_eq!(
            check_request(request(
                "/v1/messages",
                &[("content-type", "text/plain")],
                "{}"
            )),
            Err(AiError::Blocked)
        );
        let large = "x".repeat(MAX_BODY_BYTES + 1);
        assert_eq!(
            check_request(request("/v1/messages", &[JSON], &large)),
            Err(AiError::TooLarge)
        );
        // Header values cannot smuggle in line breaks.
        assert_eq!(
            check_request(request(
                "/v1/messages",
                &[JSON, ("anthropic-beta", "a\r\nx-api-key: b")],
                "{}"
            )),
            Err(AiError::Blocked)
        );
    }

    #[test]
    fn keys_are_checked_before_they_are_stored() {
        assert_eq!(normalize_key(&format!("  {KEY}\n")), Some(KEY.to_owned()));
        assert_eq!(normalize_key("short"), None);
        assert_eq!(normalize_key("sk-ant key with spaces"), None);
        assert_eq!(normalize_key("sk-ant-api03-\r\nx-other: 1"), None);
        assert_eq!(normalize_key(&"k".repeat(513)), None);
    }

    #[test]
    fn the_keyring_store_keeps_and_forgets_the_key() {
        let proxy = AiProxy::new(Box::new(KeyringStore::mock()));
        assert_eq!(proxy.has_key(), Ok(false));
        assert_eq!(proxy.set_key("not a key"), Err(AiError::InvalidKey));
        assert_eq!(proxy.has_key(), Ok(false));
        proxy.set_key(KEY).unwrap();
        assert_eq!(proxy.has_key(), Ok(true));
        assert_eq!(proxy.store.get(), Ok(Some(KEY.to_owned())));
        proxy.forget_key().unwrap();
        assert_eq!(proxy.has_key(), Ok(false));
        // Forgetting twice is fine.
        proxy.forget_key().unwrap();
    }

    #[test]
    fn the_file_store_is_private_to_the_user() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data").join("anthropic-api-key");
        let store = FileStore::new(path.clone());
        assert_eq!(store.get(), Ok(None));
        store.set(KEY).unwrap();
        assert_eq!(store.get(), Ok(Some(KEY.to_owned())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let folder = std::fs::metadata(path.parent().unwrap()).unwrap();
            assert_eq!(folder.permissions().mode() & 0o777, 0o700);
        }
        store.delete().unwrap();
        assert_eq!(store.get(), Ok(None));
        store.delete().unwrap();
    }

    /// A one-shot HTTP server: answers the first request with `response`
    /// (written in parts, with `pause` between them) and reports what it
    /// received.
    fn serve(parts: Vec<Vec<u8>>, pause: Duration) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            // Headers, then the body by its length.
            loop {
                let read = stream.read(&mut buffer).unwrap();
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            sender
                .send(String::from_utf8_lossy(&received).to_string())
                .unwrap();
            for part in parts {
                if stream.write_all(&part).is_err() {
                    return;
                }
                let _ = stream.flush();
                std::thread::sleep(pause);
            }
        });
        (origin, receiver)
    }

    fn proxy_to(origin: String) -> AiProxy {
        let proxy = AiProxy::with_origin(Box::new(KeyringStore::mock()), origin);
        proxy.set_key(KEY).unwrap();
        proxy
    }

    /// One part of a chunked HTTP body.
    fn chunk(data: &str) -> Vec<u8> {
        format!("{:x}\r\n{data}\r\n", data.len()).into_bytes()
    }

    fn sse_answer() -> Vec<Vec<u8>> {
        vec![
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nrequest-id: req_1\r\nset-cookie: a=b\r\ntransfer-encoding: chunked\r\n\r\n".to_vec(),
            chunk("event: message_start\ndata: 1\n\n"),
            chunk("event: message_stop\ndata: 2\n\n"),
            b"0\r\n\r\n".to_vec(),
        ]
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn relays_the_answer_as_it_streams_with_the_key_added() {
        let (origin, received) = serve(sse_answer(), Duration::from_millis(20));
        let proxy = proxy_to(origin);
        let mut events = Vec::new();
        proxy
            .relay(
                "request-1",
                request(
                    "/v1/messages?beta=true",
                    &[
                        JSON,
                        ("anthropic-version", "2023-06-01"),
                        ("x-api-key", "page"),
                    ],
                    "{\"stream\":true}",
                ),
                |event| {
                    events.push(event);
                    true
                },
            )
            .await
            .unwrap();
        let sent = received.recv().unwrap();
        assert!(sent.starts_with("POST /v1/messages?beta=true HTTP/1.1\r\n"));
        let lower = sent.to_ascii_lowercase();
        assert!(lower.contains(&format!("x-api-key: {}", KEY.to_ascii_lowercase())));
        assert!(!lower.contains("x-api-key: page"));
        assert!(lower.contains("anthropic-version: 2023-06-01"));
        assert!(sent.ends_with("{\"stream\":true}"));
        assert_eq!(
            events.first(),
            Some(&RelayEvent::Head {
                status: 200,
                headers: vec![
                    ("content-type".to_owned(), "text/event-stream".to_owned()),
                    ("request-id".to_owned(), "req_1".to_owned()),
                ],
            })
        );
        assert_eq!(events.last(), Some(&RelayEvent::End));
        let body: Vec<u8> = events
            .iter()
            .filter_map(|event| match event {
                RelayEvent::Chunk(bytes) => Some(bytes.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(
            String::from_utf8(body).unwrap(),
            "event: message_start\ndata: 1\n\nevent: message_stop\ndata: 2\n\n"
        );
        // The parts arrived as they were written, not all at once.
        let chunks = events
            .iter()
            .filter(|event| matches!(event, RelayEvent::Chunk(_)))
            .count();
        assert!(chunks >= 2, "{chunks} chunks");
        assert!(lock(&proxy.running).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn relays_error_answers_with_their_status() {
        let body = "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}";
        let answer = format!(
            "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        let (origin, _received) = serve(vec![answer.into_bytes()], Duration::ZERO);
        let proxy = proxy_to(origin);
        let mut events = Vec::new();
        proxy
            .relay(
                "request-2",
                request("/v1/messages", &[JSON], "{}"),
                |event| {
                    events.push(event);
                    true
                },
            )
            .await
            .unwrap();
        assert!(matches!(events[0], RelayEvent::Head { status: 401, .. }));
        assert_eq!(events.last(), Some(&RelayEvent::End));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_request_stops_relaying() {
        let mut parts = sse_answer();
        // Long after the cancellation.
        parts.insert(2, vec![]);
        let (origin, _received) = serve(parts, Duration::from_millis(400));
        let proxy = Arc::new(proxy_to(origin));
        let events = Arc::new(Mutex::new(Vec::new()));
        let task = {
            let proxy = proxy.clone();
            let events = events.clone();
            tokio::spawn(async move {
                proxy
                    .relay(
                        "request-3",
                        request("/v1/messages", &[JSON], "{}"),
                        move |event| {
                            lock(&events).push(event);
                            true
                        },
                    )
                    .await
            })
        };
        // Wait for the head, then cancel.
        while lock(&events).is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        proxy.cancel("request-3");
        task.await.unwrap().unwrap();
        let events = lock(&events);
        assert!(!events.contains(&RelayEvent::End), "{events:?}");
        assert!(lock(&proxy.running).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_cancelled_before_it_started_never_starts() {
        let proxy = proxy_to("http://127.0.0.1:9".to_owned());
        proxy.cancel("request-4");
        let mut events = 0;
        proxy
            .relay("request-4", request("/v1/messages", &[JSON], "{}"), |_| {
                events += 1;
                true
            })
            .await
            .unwrap();
        assert_eq!(events, 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_requests_without_a_key_or_outside_the_rules() {
        let proxy = AiProxy::with_origin(
            Box::new(KeyringStore::mock()),
            "http://127.0.0.1:9".to_owned(),
        );
        let relay = |id: &'static str, path: &'static str| {
            let proxy = &proxy;
            async move {
                proxy
                    .relay(id, request(path, &[JSON], "{}"), |_| true)
                    .await
            }
        };
        assert_eq!(relay("a", "/v1/messages").await, Err(AiError::NoKey));
        proxy.set_key(KEY).unwrap();
        assert_eq!(relay("b", "/v1/files").await, Err(AiError::Blocked));
        assert_eq!(relay("../c", "/v1/messages").await, Err(AiError::Blocked));
        // Nothing listens on the discard port.
        assert_eq!(relay("d", "/v1/messages").await, Err(AiError::Network));
    }

    #[test]
    fn production_requests_go_to_anthropic_over_https_only() {
        let proxy = AiProxy::new(Box::new(KeyringStore::mock()));
        assert_eq!(proxy.origin, "https://api.anthropic.com");
        assert!(proxy.client().is_some());
    }

    #[test]
    fn relay_messages_have_a_stable_shape() {
        let headers = vec![("content-type".to_owned(), "text/event-stream".to_owned())];
        assert_eq!(
            serde_json::to_string(&RelayMessage::Head {
                status: 200,
                headers: &headers
            })
            .unwrap(),
            r#"{"type":"head","status":200,"headers":[["content-type","text/event-stream"]]}"#
        );
        assert_eq!(
            serde_json::to_string(&RelayMessage::End).unwrap(),
            r#"{"type":"end"}"#
        );
        assert_eq!(
            serde_json::to_string(&RelayMessage::Error { code: "network" }).unwrap(),
            r#"{"type":"error","code":"network"}"#
        );
    }
}
