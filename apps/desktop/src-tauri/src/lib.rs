pub mod close_guard;
mod commands;
pub mod files;
pub mod incoming;
pub mod menu;
pub mod native_host;
pub mod native_messaging;
pub mod paths;
pub mod recent;
pub mod recovery;
pub mod save;
pub mod time;

use close_guard::{CloseGuard, CloseIntent};
use files::{FileError, FileGrants, LaunchArgs, LaunchQueue, OpenedFiles};
use incoming::TransferQueue;
use recent::RecentFiles;
use recovery::RecoveryStore;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::menu::{MenuEvent, Submenu};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WebviewWindow, WindowEvent, Wry,
};
use tauri_plugin_window_state::StateFlags;

pub const FILES_OPENED_EVENT: &str = "folio://files-opened";
pub const MENU_EVENT: &str = "folio://menu";
/// `true` while files are dragged over the window. Carries no paths.
pub const DRAG_HOVER_EVENT: &str = "folio://drag-hover";
/// The recent files changed. No payload: the UI asks for the list.
pub const RECENT_CHANGED_EVENT: &str = "folio://recent-changed";
/// The user wants to close the window or quit while work is unsaved. No
/// payload; the UI answers with `confirm_close`.
pub const CLOSE_REQUESTED_EVENT: &str = "folio://close-requested";
/// The Chrome extension sent a document: `{ id, name, size }`.
pub const TRANSFER_REQUEST_EVENT: &str = "folio://transfer-request";
const MAIN_WINDOW: &str = "main";

/// Folio's own data in the app data directory (see `paths`).
pub struct Storage {
    /// `None` without a data directory: crash recovery is then unavailable.
    pub recovery: Option<RecoveryStore>,
    pub recent: RecentFiles,
    /// Where the native messaging host spools documents from Chrome.
    pub incoming: Option<PathBuf>,
}

impl Storage {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Storage {
            recovery: data_dir
                .as_ref()
                .map(|dir| RecoveryStore::new(dir.join("recovery"))),
            recent: RecentFiles::load(data_dir.as_ref().map(|dir| dir.join("recent.json"))),
            incoming: data_dir.map(|dir| dir.join(incoming::INCOMING_DIR)),
        }
    }
}

/// The File ▸ Open Recent submenu, refilled when the recent files change.
struct RecentMenu(Mutex<Option<Submenu<Wry>>>);

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Grants user-chosen paths and remembers them as recent files.
pub(crate) fn grant_paths(app: &AppHandle, paths: &[PathBuf]) -> OpenedFiles {
    let opened = app.state::<FileGrants>().grant_all(paths);
    let grants = app.state::<FileGrants>();
    let storage = app.state::<Storage>();
    let mut changed = false;
    for file in &opened.files {
        if let Ok(grant) = grants.lookup(&file.token) {
            changed |= storage.recent.record(&grant.path, &file.name);
        }
    }
    if changed {
        recent_changed(app);
    }
    opened
}

/// Tells the UI and refills the Open Recent menu.
pub(crate) fn recent_changed(app: &AppHandle) {
    let _ = app.emit(RECENT_CHANGED_EVENT, ());
    // Later on the main thread, also when a recent item's own click caused it.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let entries = handle.state::<Storage>().recent.menu_entries();
        let submenu = handle
            .state::<RecentMenu>()
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(submenu) = submenu {
            let _ = menu::fill_recent(&handle, &submenu, &entries);
        }
    });
}

/// Delivers files to the UI now, or once it is ready.
fn deliver(app: &AppHandle, opened: OpenedFiles) {
    if opened.is_empty() {
        return;
    }
    if let Some(opened) = app.state::<LaunchQueue>().offer(opened) {
        let _ = app.emit(FILES_OPENED_EVENT, opened);
    }
    focus_main_window(app);
}

/// Grants user-provided paths and delivers them to the UI.
fn open_paths(app: &AppHandle, paths: &[PathBuf]) {
    let opened = grant_paths(app, paths);
    deliver(app, opened);
}

/// Grants a recent file again (as a new token), or reports it by name if it
/// is gone.
pub(crate) fn open_recent(app: &AppHandle, id: &str) -> OpenedFiles {
    let storage = app.state::<Storage>();
    let mut opened = OpenedFiles::default();
    let Some((path, name)) = storage.recent.lookup(id) else {
        return opened;
    };
    match app.state::<FileGrants>().grant(&path) {
        Ok(file) => {
            if storage.recent.record(&path, &file.name) {
                recent_changed(app);
            }
            opened.files.push(file);
        }
        Err(FileError::NotPdf) => opened.skipped.push(name),
        Err(_) => opened.unavailable.push(name),
    }
    opened
}

/// Asks the user about documents the Chrome extension sent (`--incoming`).
fn offer_transfers(app: &AppHandle, ids: &[String]) {
    let Some(base) = app.state::<Storage>().incoming.clone() else {
        return;
    };
    let queue = app.state::<TransferQueue>();
    let mut offered = false;
    for id in ids {
        let Some(request) = incoming::request_for(&base, id) else {
            continue;
        };
        offered = true;
        if let Some(request) = queue.offer(request) {
            let _ = app.emit(TRANSFER_REQUEST_EVENT, request);
        }
    }
    if offered {
        focus_main_window(app);
    }
}

fn handle_launch(app: &AppHandle, launch: LaunchArgs) {
    open_paths(app, &launch.paths);
    offer_transfers(app, &launch.incoming);
}

/// Folio was started again (a file opened from Explorer or a file manager,
/// a document from Chrome): the new process hands its arguments to this one
/// and exits.
fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let args = argv.into_iter().skip(1).map(OsString::from);
    handle_launch(app, files::parse_launch_args(args, Path::new(&cwd)));
    focus_main_window(app);
}

/// Holds back a close or quit while work is unsaved and asks the UI.
/// Returns whether it was held back.
fn hold_close(app: &AppHandle, intent: CloseIntent) -> bool {
    if !app.state::<CloseGuard>().intercept(intent) {
        return false;
    }
    let _ = app.emit(CLOSE_REQUESTED_EVENT, ());
    focus_main_window(app);
    true
}

/// Carries out a close or quit the UI confirmed.
pub(crate) fn carry_out_close(app: &AppHandle, intent: CloseIntent) {
    match intent {
        CloseIntent::Window => match main_window(app) {
            Some(window) => {
                let _ = window.close();
            }
            None => app.exit(0),
        },
        CloseIntent::Quit => app.exit(0),
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == menu::CLOSE_WINDOW.0 {
        // Goes through `CloseRequested` like the window's close button.
        if let Some(window) = main_window(app) {
            let _ = window.close();
        }
    } else if id == menu::QUIT.0 {
        if !hold_close(app, CloseIntent::Quit) {
            app.exit(0);
        }
    } else if id == menu::CLEAR_RECENT.0 {
        if app.state::<Storage>().recent.clear() {
            recent_changed(app);
        }
    } else if let Some(recent) = menu::recent_file_for(id) {
        let opened = open_recent(app, recent);
        deliver(app, opened);
    } else if let Some(command) = menu::command_for(id) {
        let _ = app.emit(MENU_EVENT, command);
    }
}

/// Whether files are being dragged over the window once `event` happened.
fn is_drag_hovering(event: &DragDropEvent) -> bool {
    matches!(
        event,
        DragDropEvent::Enter { .. } | DragDropEvent::Over { .. }
    )
}

fn window_state_plugin(data_dir: Option<&Path>) -> tauri::plugin::TauriPlugin<Wry> {
    let builder = tauri_plugin_window_state::Builder::new()
        .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
    match data_dir {
        // Tests keep everything Folio stores in one temporary folder (an
        // absolute file name replaces the plugin's config folder).
        Some(dir) if paths::data_dir_is_overridden() => builder
            .with_filename(dir.join("window-state.json").to_string_lossy())
            .build(),
        _ => builder.build(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = paths::app_data_dir();
    tauri::Builder::default()
        // First: a second launch hands over its arguments and exits before
        // anything else starts.
        .plugin(tauri_plugin_single_instance::init(on_second_instance))
        .plugin(window_state_plugin(data_dir.as_deref()))
        .plugin(tauri_plugin_dialog::init())
        .manage(FileGrants::default())
        .manage(LaunchQueue::default())
        .manage(TransferQueue::default())
        .manage(CloseGuard::default())
        .manage(RecentMenu(Mutex::new(None)))
        .manage(Storage::new(data_dir))
        .setup(|app| {
            let handle = app.handle();
            let entries = handle.state::<Storage>().recent.menu_entries();
            let (menu, recent) = menu::build(handle, &entries)?;
            app.set_menu(menu)?;
            *handle
                .state::<RecentMenu>()
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(recent);
            app.on_menu_event(on_menu_event);
            // Accepted documents from Chrome whose grants were never released
            // (Folio quit) and ones nobody answered for a day.
            if let Some(base) = &handle.state::<Storage>().incoming {
                incoming::purge(base, SystemTime::now());
            }
            // Windows and Linux pass files opened from the file manager as
            // arguments; the native messaging host passes `--incoming <id>`.
            let cwd = std::env::current_dir().unwrap_or_default();
            handle_launch(
                handle,
                files::parse_launch_args(std::env::args_os().skip(1), &cwd),
            );
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::DragDrop(event) => {
                // Tauri's own drag events carry the paths of everything dragged
                // across the window, so the UI does not listen to them and only
                // learns whether a drag is in progress.
                let _ = window.emit(DRAG_HOVER_EVENT, is_drag_hovering(event));
                if let DragDropEvent::Drop { paths, .. } = event {
                    open_paths(window.app_handle(), paths);
                }
            }
            // Held back (and the UI asked) while work is unsaved.
            WindowEvent::CloseRequested { api, .. }
                if hold_close(window.app_handle(), CloseIntent::Window) =>
            {
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_pdf_files,
            commands::read_granted_file,
            commands::release_file,
            commands::take_pending_files,
            commands::save_pdf_as,
            commands::write_granted_file,
            commands::print_window,
            commands::app_info,
            commands::recovery_list,
            commands::recovery_save_snapshot,
            commands::recovery_save_file,
            commands::recovery_has_file,
            commands::recovery_load_snapshot,
            commands::recovery_load_file,
            commands::recovery_file_keys,
            commands::recovery_remove,
            commands::recent_list,
            commands::recent_open,
            commands::recent_remove,
            commands::recent_clear,
            commands::set_close_guard,
            commands::confirm_close,
            commands::cancel_close,
            commands::take_pending_transfers,
            commands::answer_transfer,
            commands::native_messaging_status,
            commands::register_native_messaging,
            commands::unregister_native_messaging,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Folio")
        .run(|app, event| match event {
            // macOS delivers Finder "Open With" requests as events, also at launch.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                let paths: Vec<PathBuf> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                open_paths(app, &paths);
            }
            // An exit the user asked for while the window is still open
            // (programmatic exits, after the UI confirmed, carry a code).
            RunEvent::ExitRequested {
                code: None, api, ..
            } if main_window(app).is_some() && hold_close(app, CloseIntent::Quit) => {
                api.prevent_exit();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::PhysicalPosition;

    #[test]
    fn drag_hover_is_only_set_while_a_drag_is_over_the_window() {
        let position = PhysicalPosition::new(10.0, 20.0);
        let paths = vec![PathBuf::from("/Users/alice/a.pdf")];
        assert!(is_drag_hovering(&DragDropEvent::Enter {
            paths: paths.clone(),
            position,
        }));
        assert!(is_drag_hovering(&DragDropEvent::Over { position }));
        assert!(!is_drag_hovering(&DragDropEvent::Leave));
        assert!(!is_drag_hovering(&DragDropEvent::Drop { paths, position }));
    }

    #[test]
    fn storage_lives_in_the_data_directory() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(Some(dir.path().to_path_buf()));
        assert_eq!(storage.incoming, Some(dir.path().join("incoming")));
        storage
            .recovery
            .as_ref()
            .unwrap()
            .save_snapshot("doc", "t", b"{}")
            .unwrap();
        assert!(dir.path().join("recovery").join("doc").is_dir());
        let without = Storage::new(None);
        assert!(without.recovery.is_none() && without.incoming.is_none());
    }
}
