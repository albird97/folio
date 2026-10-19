use crate::ai::{AiError, AiProxy, ProxyRequest, RelayEvent, RelayMessage};
use crate::close_guard::CloseGuard;
use crate::files::{self, FileError, FileGrants, LaunchQueue, OpenedFiles, MAX_FILE_BYTES};
use crate::incoming::{self, IncomingError, TransferQueue, TransferRequest};
use crate::native_messaging::{self, RegistrationError, Status};
use crate::recent::RecentFile;
use crate::recovery::{self, RecoveryError, RecoveryRecord, RecoveryStore};
use crate::save::{self, SaveError, WriteOutcome};
use crate::{paths, Storage};
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::task::block_in_place;

/// Errors cross the IPC boundary as `{ code, message }`. Messages never
/// contain paths or document content.
#[derive(Debug, Serialize)]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    fn new(code: &'static str, message: &str) -> Self {
        CommandError {
            code,
            message: message.to_owned(),
        }
    }
}

macro_rules! command_error_from {
    ($($error:ty),*) => {
        $(impl From<$error> for CommandError {
            fn from(error: $error) -> Self {
                CommandError {
                    code: error.code(),
                    message: error.to_string(),
                }
            }
        })*
    };
}

command_error_from!(
    FileError,
    SaveError,
    RecoveryError,
    IncomingError,
    RegistrationError,
    AiError
);

#[derive(Debug, Serialize)]
pub struct SavedFile {
    /// File name only, for display. Never the full path.
    name: String,
    /// A grant for the new file when write access was asked for (Save As).
    token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: &'static str,
    arch: &'static str,
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

fn flag(request: &Request<'_>, name: &str) -> bool {
    header(request, name) == Some("1")
}

/// Commands with a data body take it raw, never as JSON.
fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], CommandError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(SaveError::InvalidRequest.into());
    };
    Ok(bytes)
}

/// Shows the native open dialog. The selection is granted on the Rust side;
/// the webview only receives tokens and file names.
#[tauri::command]
pub async fn pick_pdf_files(
    app: AppHandle,
    window: WebviewWindow,
    multiple: bool,
) -> Result<OpenedFiles, CommandError> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Vec<PathBuf>>();
    let dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Open PDF")
        .add_filter("PDF documents", &["pdf", "PDF"]);
    if multiple {
        dialog.pick_files(move |paths| {
            let paths = paths
                .unwrap_or_default()
                .into_iter()
                .filter_map(|path| path.into_path().ok())
                .collect();
            let _ = sender.send(paths);
        });
    } else {
        dialog.pick_file(move |path| {
            let paths = path
                .and_then(|path| path.into_path().ok())
                .into_iter()
                .collect();
            let _ = sender.send(paths);
        });
    }
    let paths = receiver.await.unwrap_or_default();
    // The filter is only a hint (Windows accepts any typed file name), and a
    // file can disappear between picking and granting. Such files are reported
    // by name, like drops, instead of failing or silently shrinking the
    // selection.
    Ok(block_in_place(|| crate::grant_paths(&app, &paths)))
}

/// Returns the bytes of a granted file as a binary IPC response.
#[tauri::command]
pub async fn read_granted_file(
    grants: State<'_, FileGrants>,
    token: String,
) -> Result<Response, CommandError> {
    let path = grants.path(&token)?;
    let bytes =
        tauri::async_runtime::spawn_blocking(move || files::read_limited(&path, MAX_FILE_BYTES))
            .await
            .map_err(|_| FileError::Unreadable)??;
    Ok(Response::new(bytes))
}

/// Gives up a grant. Documents received from Chrome are deleted with it.
#[tauri::command]
pub fn release_file(grants: State<'_, FileGrants>, token: String) -> bool {
    grants.release(&token)
}

/// Hands over files opened before the UI was listening and switches to events.
#[tauri::command]
pub fn take_pending_files(queue: State<'_, LaunchQueue>) -> OpenedFiles {
    queue.drain()
}

/// "Save As" and "Save a Copy": shows the native save dialog and writes the
/// PDF data sent as the raw request body to the file the user chose. The
/// proposed name comes in the `x-folio-name` header; `x-folio-keep-access: 1`
/// (Save As) also grants the new file, so later saves can write to it.
/// Anything that is not PDF data is refused before a dialog appears.
/// Resolves to `null` when the user cancels; the webview only ever learns
/// the chosen file's name and token.
#[tauri::command]
pub async fn save_pdf_as(
    app: AppHandle,
    window: WebviewWindow,
    grants: State<'_, FileGrants>,
    storage: State<'_, Storage>,
    request: Request<'_>,
) -> Result<Option<SavedFile>, CommandError> {
    let bytes = raw_body(&request)?;
    save::check_pdf(bytes)?;
    let keep_access = flag(&request, save::KEEP_ACCESS_HEADER);
    let proposed = save::suggested_file_name(header(&request, save::NAME_HEADER));
    let (sender, receiver) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title(if keep_access {
            "Save As"
        } else {
            "Save a Copy"
        })
        .set_file_name(&proposed)
        .add_filter("PDF document", &["pdf"])
        .save_file(move |path| {
            let _ = sender.send(path.and_then(|path| path.into_path().ok()));
        });
    let Some(target) = receiver.await.ok().flatten() else {
        return Ok(None);
    };
    // Never into Folio's own data: the file would be granted and listed.
    if block_in_place(|| grants.is_reserved(&target)) {
        return Err(SaveError::Reserved.into());
    }
    // Writing borrows the request body, so it happens on this worker thread
    // (without blocking other tasks) instead of copying the data to another.
    block_in_place(|| save::write_atomically(&target, bytes))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or(proposed);
    let token = if keep_access {
        grants.grant(&target).ok().map(|granted| granted.token)
    } else {
        None
    };
    if block_in_place(|| storage.recent.record(&target, &name)) {
        crate::recent_changed(&app);
    }
    Ok(Some(SavedFile { name, token }))
}

/// "Save": writes the PDF data in the raw request body back to the file a
/// token grants (`x-folio-token`), unless the file no longer has the content
/// whose SHA-256 is in `x-folio-expected-sha256`. `x-folio-overwrite: 1`
/// writes anyway (the user confirmed). Outcomes the user can act on (changed
/// on disk, moved, read-only) are results, not errors.
#[tauri::command]
pub async fn write_granted_file(
    grants: State<'_, FileGrants>,
    request: Request<'_>,
) -> Result<WriteOutcome, CommandError> {
    let bytes = raw_body(&request)?;
    let token = header(&request, save::TOKEN_HEADER).ok_or(SaveError::InvalidRequest)?;
    let overwrite = flag(&request, save::OVERWRITE_HEADER);
    let expected = header(&request, save::EXPECTED_SHA256_HEADER);
    if expected.is_some_and(|hash| !save::is_sha256_hex(hash)) || (expected.is_none() && !overwrite)
    {
        return Err(SaveError::InvalidRequest.into());
    }
    let grant = grants.lookup(token)?;
    save::check_pdf(bytes)?;
    if !grant.writable {
        return Ok(WriteOutcome::unavailable(save::SPOOLED_MESSAGE));
    }
    Ok(block_in_place(|| {
        save::write_back(&grant.path, bytes, expected, overwrite)
    }))
}

/// Opens the print dialog for the window's contents. Resolves once the
/// dialog was shown; on Linux, once it is closed.
#[tauri::command]
pub async fn print_window(window: WebviewWindow) -> Result<(), CommandError> {
    let failed = || CommandError::new("print-failed", "The print dialog could not be opened.");
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    // On the main thread, outside the IPC handler: Linux runs the dialog in
    // a nested main loop until it is closed.
    window
        .run_on_main_thread(move || {
            let _ = sender.send(target.print().is_ok());
        })
        .map_err(|_| failed())?;
    match receiver.await {
        Ok(true) => Ok(()),
        _ => Err(failed()),
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

fn recovery_store(storage: &Storage) -> Result<&RecoveryStore, CommandError> {
    storage
        .recovery
        .as_ref()
        .ok_or_else(|| RecoveryError::Unavailable.into())
}

#[tauri::command]
pub async fn recovery_list(
    storage: State<'_, Storage>,
) -> Result<Vec<RecoveryRecord>, CommandError> {
    let store = recovery_store(&storage)?;
    Ok(block_in_place(|| store.list())?)
}

/// Body: the snapshot (UTF-8 JSON). Headers: `x-folio-recovery-id` and the
/// percent-encoded `x-folio-recovery-title`.
#[tauri::command]
pub async fn recovery_save_snapshot(
    storage: State<'_, Storage>,
    request: Request<'_>,
) -> Result<(), CommandError> {
    let store = recovery_store(&storage)?;
    let snapshot = raw_body(&request)?;
    let id = header(&request, recovery::ID_HEADER).ok_or(RecoveryError::InvalidRequest)?;
    let title = header(&request, recovery::TITLE_HEADER)
        .map(save::decode_header)
        .unwrap_or_default();
    Ok(block_in_place(|| {
        store.save_snapshot(id, &title, snapshot)
    })?)
}

/// Body: the file. Headers: `x-folio-recovery-id`, `x-folio-recovery-key`.
#[tauri::command]
pub async fn recovery_save_file(
    storage: State<'_, Storage>,
    request: Request<'_>,
) -> Result<(), CommandError> {
    let store = recovery_store(&storage)?;
    let bytes = raw_body(&request)?;
    let id = header(&request, recovery::ID_HEADER).ok_or(RecoveryError::InvalidRequest)?;
    let key = header(&request, recovery::KEY_HEADER).ok_or(RecoveryError::InvalidRequest)?;
    Ok(block_in_place(|| store.save_file(id, key, bytes))?)
}

#[tauri::command]
pub async fn recovery_has_file(
    storage: State<'_, Storage>,
    id: String,
    key: String,
) -> Result<bool, CommandError> {
    let store = recovery_store(&storage)?;
    Ok(block_in_place(|| store.has_file(&id, &key))?)
}

/// The snapshot, or `null` if there is no such record.
#[tauri::command]
pub async fn recovery_load_snapshot(
    storage: State<'_, Storage>,
    id: String,
) -> Result<Option<String>, CommandError> {
    let store = recovery_store(&storage)?;
    Ok(block_in_place(|| store.load_snapshot(&id))?)
}

#[tauri::command]
pub async fn recovery_load_file(
    storage: State<'_, Storage>,
    id: String,
    key: String,
) -> Result<Response, CommandError> {
    let store = recovery_store(&storage)?;
    let bytes = block_in_place(|| store.load_file(&id, &key))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn recovery_file_keys(
    storage: State<'_, Storage>,
    id: String,
) -> Result<Vec<String>, CommandError> {
    let store = recovery_store(&storage)?;
    Ok(block_in_place(|| store.file_keys(&id))?)
}

#[tauri::command]
pub async fn recovery_remove(storage: State<'_, Storage>, id: String) -> Result<(), CommandError> {
    let store = recovery_store(&storage)?;
    Ok(block_in_place(|| store.remove(&id))?)
}

/// Recent files, newest first. Names and dates only.
#[tauri::command]
pub fn recent_list(storage: State<'_, Storage>) -> Vec<RecentFile> {
    storage.recent.list()
}

/// Grants a recent file again. A file that is gone is reported by name.
#[tauri::command]
pub async fn recent_open(app: AppHandle, id: String) -> Result<OpenedFiles, CommandError> {
    Ok(block_in_place(|| crate::open_recent(&app, &id)))
}

#[tauri::command]
pub async fn recent_remove(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> Result<(), CommandError> {
    if block_in_place(|| storage.recent.remove(&id)) {
        crate::recent_changed(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn recent_clear(app: AppHandle, storage: State<'_, Storage>) -> Result<(), CommandError> {
    if block_in_place(|| storage.recent.clear()) {
        crate::recent_changed(&app);
    }
    Ok(())
}

/// The UI has unsaved work (`true`) or not. While it has, closing the window
/// or quitting asks it first (`folio://close-requested`).
#[tauri::command]
pub fn set_close_guard(guard: State<'_, CloseGuard>, enabled: bool) {
    guard.set_enabled(enabled);
}

/// Closes the window or quits, as requested, after the UI asked the user.
/// Does nothing (and returns `false`) when nothing was requested.
#[tauri::command]
pub fn confirm_close(app: AppHandle, guard: State<'_, CloseGuard>) -> bool {
    match guard.confirm() {
        Some(intent) => {
            crate::carry_out_close(&app, intent);
            true
        }
        None => false,
    }
}

/// The user chose to keep the window open: forgets the request, so a later
/// close is asked about (and carried out) on its own, and does not install
/// an update that was waiting for this answer. Returns whether there was a
/// request.
#[tauri::command]
pub fn cancel_close(app: AppHandle, guard: State<'_, CloseGuard>) -> bool {
    crate::updates::kept_working(&app);
    guard.cancel()
}

/// Hands over transfer requests that arrived before the UI was listening and
/// switches to `folio://transfer-request` events.
#[tauri::command]
pub fn take_pending_transfers(queue: State<'_, TransferQueue>) -> Vec<TransferRequest> {
    queue.drain()
}

/// Opens (accept) or deletes (decline) a document the Chrome extension sent.
/// Only transfers the user was asked about can be answered, once.
#[tauri::command]
pub async fn answer_transfer(
    grants: State<'_, FileGrants>,
    queue: State<'_, TransferQueue>,
    storage: State<'_, Storage>,
    id: String,
    accept: bool,
) -> Result<OpenedFiles, CommandError> {
    let base = storage
        .incoming
        .as_ref()
        .ok_or(IncomingError::Unavailable)?;
    let dir = incoming::entry_dir(base, &id).ok_or(IncomingError::UnknownTransfer)?;
    if !queue.take(&id) {
        return Err(IncomingError::UnknownTransfer.into());
    }
    block_in_place(|| {
        if !accept {
            incoming::remove(&dir);
            return Ok(OpenedFiles::default());
        }
        let Some(meta) = incoming::read_meta(&dir) else {
            incoming::remove(&dir);
            return Err(IncomingError::UnknownTransfer.into());
        };
        let mut opened = OpenedFiles::default();
        match grants.grant_spooled(&dir.join(incoming::DOCUMENT_FILE), &meta.name, &dir) {
            Ok(file) => {
                incoming::mark_accepted(&dir);
                opened.files.push(file);
            }
            Err(_) => {
                incoming::remove(&dir);
                opened.unavailable.push(meta.name);
            }
        }
        Ok(opened)
    })
}

/// Whether Chrome can reach this copy of Folio, and for which official
/// extensions. Registering and unregistering happen natively only, through
/// File ▸ Connect to Chrome… (see `connect.rs`).
#[tauri::command]
pub async fn native_messaging_status() -> Result<Status, CommandError> {
    let locations = native_messaging::locations().ok_or(RegistrationError::Unavailable)?;
    // The AppImage, not its temporary mount, when Folio runs from one.
    let exe = paths::executable().map_err(|_| RegistrationError::Unavailable)?;
    Ok(block_in_place(|| {
        native_messaging::status(&locations, &exe)
    }))
}

/// Ask Claude: whether the user's API key is stored (never the key itself).
#[tauri::command]
pub async fn ai_key_status(proxy: State<'_, AiProxy>) -> Result<bool, CommandError> {
    Ok(block_in_place(|| proxy.has_key())?)
}

/// Stores the user's API key in the OS credential store.
#[tauri::command]
pub async fn ai_set_key(proxy: State<'_, AiProxy>, key: String) -> Result<(), CommandError> {
    Ok(block_in_place(|| proxy.set_key(&key))?)
}

/// Deletes the stored API key.
#[tauri::command]
pub async fn ai_forget_key(proxy: State<'_, AiProxy>) -> Result<(), CommandError> {
    Ok(block_in_place(|| proxy.forget_key())?)
}

/// Sends one request of the webview's Anthropic SDK to Anthropic's API with
/// the stored key (see `ai.rs` for what is allowed) and streams the answer
/// back on `events`: a JSON head (`{type: "head", status, headers}`), the
/// body in binary chunks, then `{type: "end"}` or `{type: "error"}`.
/// Requests that are refused, or fail before an answer starts, reject.
#[tauri::command]
pub async fn ai_request(
    proxy: State<'_, AiProxy>,
    id: String,
    request: ProxyRequest,
    events: Channel<Response>,
) -> Result<(), CommandError> {
    let json = |message: RelayMessage<'_>| {
        let text = serde_json::to_string(&message).unwrap_or_default();
        events
            .send(Response::new(InvokeResponseBody::Json(text)))
            .is_ok()
    };
    proxy
        .relay(&id, request, |event| match event {
            RelayEvent::Head { status, headers } => json(RelayMessage::Head {
                status,
                headers: &headers,
            }),
            RelayEvent::Chunk(bytes) => events.send(Response::new(bytes)).is_ok(),
            RelayEvent::End => json(RelayMessage::End),
            RelayEvent::Failed => json(RelayMessage::Error {
                code: AiError::Network.code(),
            }),
        })
        .await?;
    Ok(())
}

/// Stops a request started with `ai_request` (the SDK aborted it).
#[tauri::command]
pub fn ai_cancel(proxy: State<'_, AiProxy>, id: String) {
    proxy.cancel(&id);
}
