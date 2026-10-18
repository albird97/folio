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

use files::{FileError, FileGrants, LaunchQueue, OpenedFiles};
use recent::RecentFiles;
use recovery::RecoveryStore;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{MenuEvent, Submenu};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WebviewWindow, WindowEvent, Wry};

pub const FILES_OPENED_EVENT: &str = "folio://files-opened";
pub const MENU_EVENT: &str = "folio://menu";
/// `true` while files are dragged over the window. Carries no paths.
pub const DRAG_HOVER_EVENT: &str = "folio://drag-hover";
/// The recent files changed. No payload: the UI asks for the list.
pub const RECENT_CHANGED_EVENT: &str = "folio://recent-changed";
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

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == menu::CLOSE_WINDOW.0 {
        if let Some(window) = main_window(app) {
            let _ = window.close();
        }
    } else if id == menu::QUIT.0 {
        app.exit(0);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(FileGrants::default())
        .manage(LaunchQueue::default())
        .manage(RecentMenu(Mutex::new(None)))
        .manage(Storage::new(paths::app_data_dir()))
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
            // Windows and Linux pass files opened from the file manager as arguments.
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = files::paths_from_args(std::env::args_os().skip(1), &cwd);
            open_paths(handle, &paths);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(event) = event {
                // Tauri's own drag events carry the paths of everything dragged
                // across the window, so the UI does not listen to them and only
                // learns whether a drag is in progress.
                let _ = window.emit(DRAG_HOVER_EVENT, is_drag_hovering(event));
                if let DragDropEvent::Drop { paths, .. } = event {
                    open_paths(window.app_handle(), paths);
                }
            }
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
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Folio")
        .run(|app, event| {
            // macOS delivers Finder "Open With" requests as events, also at launch.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let paths: Vec<PathBuf> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                open_paths(app, &paths);
            }
            let _ = (app, event);
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
