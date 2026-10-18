mod commands;
pub mod files;
pub mod menu;

use commands::OpenedFiles;
use files::{FileGrants, LaunchQueue};
use std::path::PathBuf;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WindowEvent};

pub const FILES_OPENED_EVENT: &str = "folio://files-opened";
pub const MENU_EVENT: &str = "folio://menu";

/// Grants user-provided paths and delivers them to the UI (now or once it is ready).
fn open_paths(app: &AppHandle, paths: &[PathBuf]) {
    let grants = app.state::<FileGrants>();
    let mut opened = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        match grants.grant(path) {
            Ok(file) => opened.push(file),
            Err(files::FileError::NotPdf) => {
                if let Some(name) = path.file_name() {
                    skipped.push(name.to_string_lossy().into_owned());
                }
            }
            // Folders and vanished files are ignored silently.
            Err(_) => {}
        }
    }
    if opened.is_empty() && skipped.is_empty() {
        return;
    }
    if let Some((files, skipped)) = app.state::<LaunchQueue>().offer(opened, skipped) {
        let _ = app.emit(FILES_OPENED_EVENT, OpenedFiles { files, skipped });
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(FileGrants::default())
        .manage(LaunchQueue::default())
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(menu::build(handle)?)?;
            app.on_menu_event(|app, event| {
                if let Some(command) = menu::command_for(event.id().as_ref()) {
                    let _ = app.emit(MENU_EVENT, command);
                }
            });
            // Windows and Linux pass files opened from the file manager as arguments.
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = files::paths_from_args(std::env::args_os().skip(1), &cwd);
            open_paths(handle, &paths);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                open_paths(window.app_handle(), paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_pdf_files,
            commands::read_granted_file,
            commands::release_file,
            commands::take_pending_files,
            commands::app_info,
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
