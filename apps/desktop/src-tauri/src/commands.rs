use crate::files::{self, FileError, FileGrants, LaunchQueue, OpenedFiles, MAX_FILE_BYTES};
use crate::save::{self, SaveError};
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Errors cross the IPC boundary as `{ code, message }`. Messages never
/// contain paths or document content.
#[derive(Debug, Serialize)]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl From<FileError> for CommandError {
    fn from(error: FileError) -> Self {
        CommandError {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

impl From<SaveError> for CommandError {
    fn from(error: SaveError) -> Self {
        CommandError {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SavedFile {
    /// File name only, for display. Never the full path.
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: &'static str,
    arch: &'static str,
}

/// Shows the native open dialog. The selection is granted on the Rust side;
/// the webview only receives tokens and file names.
#[tauri::command]
pub async fn pick_pdf_files(
    app: AppHandle,
    window: WebviewWindow,
    grants: State<'_, FileGrants>,
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
    Ok(grants.grant_all(&paths))
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

#[tauri::command]
pub fn release_file(grants: State<'_, FileGrants>, token: String) -> bool {
    grants.release(&token)
}

/// Hands over files opened before the UI was listening and switches to events.
#[tauri::command]
pub fn take_pending_files(queue: State<'_, LaunchQueue>) -> OpenedFiles {
    queue.drain()
}

/// "Save a copy": shows the native save dialog and writes the PDF data sent as
/// the raw request body to the file the user chose. The proposed name comes
/// in the `x-folio-name` header. Anything that is not PDF data is refused
/// before a dialog appears. Resolves to `null` when the user cancels; the
/// webview only ever learns the chosen file's name.
#[tauri::command]
pub async fn save_pdf_as(
    app: AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<Option<SavedFile>, CommandError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(SaveError::InvalidRequest.into());
    };
    save::check_pdf(bytes)?;
    let proposed = save::suggested_file_name(
        request
            .headers()
            .get(save::NAME_HEADER)
            .and_then(|value| value.to_str().ok()),
    );
    let (sender, receiver) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Save a Copy")
        .set_file_name(&proposed)
        .add_filter("PDF document", &["pdf"])
        .save_file(move |path| {
            let _ = sender.send(path.and_then(|path| path.into_path().ok()));
        });
    let Some(target) = receiver.await.ok().flatten() else {
        return Ok(None);
    };
    // Writing borrows the request body, so it happens on this worker thread
    // (without blocking other tasks) instead of copying the data to another.
    tokio::task::block_in_place(|| save::write_atomically(&target, bytes))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or(proposed);
    Ok(Some(SavedFile { name }))
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}
