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

use files::{FileGrants, LaunchQueue};
use std::path::PathBuf;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WindowEvent};

pub const FILES_OPENED_EVENT: &str = "folio://files-opened";
pub const MENU_EVENT: &str = "folio://menu";
/// `true` while files are dragged over the window. Carries no paths.
pub const DRAG_HOVER_EVENT: &str = "folio://drag-hover";

/// Grants user-provided paths and delivers them to the UI (now or once it is ready).
fn open_paths(app: &AppHandle, paths: &[PathBuf]) {
    let opened = app.state::<FileGrants>().grant_all(paths);
    if opened.is_empty() {
        return;
    }
    if let Some(opened) = app.state::<LaunchQueue>().offer(opened) {
        let _ = app.emit(FILES_OPENED_EVENT, opened);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
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
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(menu::build(handle)?)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == menu::CLOSE_WINDOW.0 {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.close();
                    }
                } else if let Some(command) = menu::command_for(id) {
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
}
