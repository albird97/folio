pub mod ai;
pub mod close_guard;
mod commands;
mod connect;
pub mod files;
#[cfg(test)]
mod fuzz;
pub mod incoming;
pub mod menu;
pub mod native_host;
pub mod native_messaging;
pub mod paths;
pub mod recent;
pub mod recovery;
pub mod save;
pub mod time;
mod updates;

use close_guard::{CloseGuard, CloseIntent};
use files::{FileError, FileGrants, LaunchArgs, LaunchQueue, OpenedFiles};
use incoming::TransferQueue;
use recent::RecentFiles;
use recovery::RecoveryStore;
#[cfg(not(target_os = "macos"))]
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
    /// Whether Folio checks for updates by itself, and when it last checked.
    pub updates: updates::UpdateSettings,
}

impl Storage {
    /// `alone`: no other copy of Folio uses the data directory (see
    /// [`paths::lock_instance`]). Otherwise nothing that copy could still
    /// be using is deleted.
    pub fn new(data_dir: Option<PathBuf>, alone: bool) -> Self {
        Storage {
            recovery: data_dir.as_ref().map(|dir| {
                let store = RecoveryStore::new(dir.join("recovery"));
                if alone {
                    store
                } else {
                    store.without_orphan_sweep()
                }
            }),
            recent: RecentFiles::load(data_dir.as_ref().map(|dir| dir.join("recent.json"))),
            updates: updates::UpdateSettings::load(
                data_dir
                    .as_ref()
                    .map(|dir| dir.join(updates::SETTINGS_FILE)),
            ),
            incoming: data_dir.map(|dir| dir.join(incoming::INCOMING_DIR)),
        }
    }
}

/// Takes this copy's instance lock (see [`paths::lock_instance`]) and opens
/// Folio's storage accordingly. Both are managed until Folio quits.
fn start_instance(data_dir: Option<PathBuf>) -> (paths::Instance, Storage) {
    let instance = match &data_dir {
        Some(dir) => paths::lock_instance(dir, paths::INSTANCE_LOCK_WAIT),
        None => paths::Instance::without_data_dir(),
    };
    let storage = Storage::new(data_dir, instance.alone);
    (instance, storage)
}

/// The File ▸ Open Recent submenu, refilled when the recent files change.
struct RecentMenu(Mutex<Option<Submenu<Wry>>>);

pub(crate) fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

pub(crate) fn focus_main_window(app: &AppHandle) {
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

/// Grants user-provided paths and delivers them to the UI. A document of a
/// transfer waiting in Folio's own spool (macOS hands them over through
/// LaunchServices) is offered as that transfer, so the user is asked first.
/// Anything else in Folio's data folder or shaped like a spooled document
/// is refused with a notice and never granted (see `files::is_reserved_path`).
fn open_paths(app: &AppHandle, paths: &[PathBuf]) {
    let base = app.state::<Storage>().incoming.clone();
    let mut requests = Vec::new();
    let mut files = Vec::new();
    for path in paths {
        let request = base.as_deref().and_then(|base| {
            let id = incoming::transfer_for_document(base, path)?;
            incoming::request_for(base, &id)
        });
        match request {
            Some(request) => requests.push(request),
            None => files.push(path.clone()),
        }
    }
    offer_requests(app, requests);
    let opened = grant_paths(app, &files);
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
        Err(FileError::Reserved) => opened.refused.push(name),
        Err(_) => opened.unavailable.push(name),
    }
    opened
}

/// Asks the user about documents the Chrome extension sent.
fn offer_requests(app: &AppHandle, requests: Vec<incoming::TransferRequest>) {
    let queue = app.state::<TransferQueue>();
    let offered = !requests.is_empty();
    for request in requests {
        if let Some(request) = queue.offer(request) {
            let _ = app.emit(TRANSFER_REQUEST_EVENT, request);
        }
    }
    if offered {
        focus_main_window(app);
    }
}

/// Asks the user about the transfers with these ids (`--incoming`).
fn offer_transfers(app: &AppHandle, ids: &[String]) {
    let Some(base) = app.state::<Storage>().incoming.clone() else {
        return;
    };
    let requests = ids
        .iter()
        .filter_map(|id| incoming::request_for(&base, id))
        .collect();
    offer_requests(app, requests);
}

fn handle_launch(app: &AppHandle, launch: LaunchArgs) {
    open_paths(app, &launch.paths);
    offer_transfers(app, &launch.incoming);
}

/// Folio was started again (a file opened from Explorer or a file manager,
/// a document from Chrome): the new process hands its arguments to this one
/// and exits. macOS routes such requests to the running app itself.
#[cfg(not(target_os = "macos"))]
fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let args = argv.into_iter().skip(1).map(OsString::from);
    handle_launch(app, files::parse_launch_args(args, Path::new(&cwd)));
    focus_main_window(app);
}

/// Holds back a close or quit while work is unsaved and asks the UI.
/// Returns whether it was held back.
pub(crate) fn hold_close(app: &AppHandle, intent: CloseIntent) -> bool {
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
        CloseIntent::Update => updates::install(app),
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
    } else if id == menu::CONNECT_CHROME.0 {
        connect::start(app);
    } else if id == menu::CHECK_FOR_UPDATES.0 {
        updates::check_now(app);
    } else if id == menu::CHECK_UPDATES_AUTOMATICALLY.0 {
        updates::toggle_automatic(app);
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
    if let Some(dir) = &data_dir {
        // Only the user may enter Folio's data folder, also an older one.
        let _ = paths::prepare_data_dir(dir);
    }
    let builder = tauri::Builder::default();
    // First: a second launch hands over its arguments and exits before
    // anything else starts. macOS needs no plugin: LaunchServices routes
    // files opened later to the running app (`RunEvent::Opened`).
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(on_second_instance));
    // Another copy may run next to this one, notably on macOS, where several
    // copies can run. Only a copy that runs alone deletes what another could
    // still be using (accepted transfers, abandoned recovery records) and
    // offers waiting transfers at startup (see `paths::lock_instance`).
    // Elsewhere the single-instance plugin decides which process runs while
    // the app is built, so only that one takes the lock, in `setup`. macOS
    // takes it now: files opened at launch may arrive before `setup` and
    // need the storage.
    #[cfg(target_os = "macos")]
    let builder = {
        let (instance, storage) = start_instance(data_dir.clone());
        builder.manage(instance).manage(storage)
    };
    builder
        .plugin(window_state_plugin(data_dir.as_deref()))
        .plugin(tauri_plugin_dialog::init())
        // Used from Rust only (see `updates`): the capability grants the
        // webview none of its commands.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(FileGrants::new(data_dir.clone()))
        .manage(LaunchQueue::default())
        .manage(TransferQueue::default())
        .manage(CloseGuard::default())
        .manage(RecentMenu(Mutex::new(None)))
        .manage(updates::Updates::default())
        .manage(ai::AiProxy::new(ai::platform_store(data_dir.as_deref())))
        .setup(move |app| {
            // Only the process the single-instance plugin kept gets here.
            #[cfg(not(target_os = "macos"))]
            {
                let (instance, storage) = start_instance(data_dir);
                app.manage(instance);
                app.manage(storage);
            }
            let alone = app.state::<paths::Instance>().alone;
            let handle = app.handle();
            let entries = handle.state::<Storage>().recent.menu_entries();
            let automatic = handle.state::<Storage>().updates.get().check_automatically;
            let (menu, recent, automatic_updates) = menu::build(handle, &entries, automatic)?;
            app.set_menu(menu)?;
            *handle
                .state::<RecentMenu>()
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(recent);
            handle
                .state::<updates::Updates>()
                .set_menu_item(automatic_updates);
            app.on_menu_event(on_menu_event);
            // Documents from Chrome: accepted ones whose grants were never
            // released (Folio quit), ones nobody answered for a day and
            // leftovers of interrupted transfers are deleted. The others
            // still need the user's answer, so they are offered again.
            match handle.state::<Storage>().incoming.clone() {
                Some(base) if alone => {
                    incoming::purge(&base, SystemTime::now(), true);
                    offer_requests(handle, incoming::pending_requests(&base));
                }
                _ => {}
            }
            // Windows and Linux pass files opened from the file manager as
            // arguments; the native messaging host passes `--incoming <id>`.
            let cwd = std::env::current_dir().unwrap_or_default();
            handle_launch(
                handle,
                files::parse_launch_args(std::env::args_os().skip(1), &cwd),
            );
            // Only once the user turned automatic checks on.
            updates::check_if_due(handle);
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
            commands::ai_key_status,
            commands::ai_set_key,
            commands::ai_forget_key,
            commands::ai_request,
            commands::ai_cancel,
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
        let storage = Storage::new(Some(dir.path().to_path_buf()), true);
        assert_eq!(storage.incoming, Some(dir.path().join("incoming")));
        storage
            .recovery
            .as_ref()
            .unwrap()
            .save_snapshot("doc", "t", b"{}")
            .unwrap();
        assert!(dir.path().join("recovery").join("doc").is_dir());
        storage.updates.set_check_automatically(true);
        assert!(dir.path().join("updates.json").is_file());
        let without = Storage::new(None, true);
        assert!(without.recovery.is_none() && without.incoming.is_none());
    }
}
