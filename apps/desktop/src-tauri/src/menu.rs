//! Native application menus. Custom items emit `folio://menu` with a
//! command name the frontend understands; nothing else is forwarded. Closing
//! the window, quitting, the Open Recent submenu and Connect to Chrome are
//! handled natively.
//!
//! macOS: Folio, File, Edit, View, Pages, Tools and Window menus. Windows and
//! Linux: File, Edit, View, Pages, Tools and Help menus.

use crate::recent;
#[cfg(not(target_os = "macos"))]
use tauri::menu::AboutMetadata;
use tauri::menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// (id, label, accelerator)
pub type MenuEntry = (&'static str, &'static str, Option<&'static str>);

/// Items forwarded to the frontend as commands. The ids are also listed in
/// `apps/desktop/src/platform/menu-commands.json`, which the frontend accepts
/// (a test keeps both in step). Shortcuts match `packages/editor/src/commands.ts`.
pub const MENU_COMMANDS: &[MenuEntry] = &[
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("save", "Save", Some("CmdOrCtrl+S")),
    ("save-as", "Save As…", Some("CmdOrCtrl+Shift+S")),
    ("save-copy", "Save a Copy…", Some("CmdOrCtrl+Alt+S")),
    ("print", "Print…", Some("CmdOrCtrl+P")),
    ("close-tab", "Close Document", Some("CmdOrCtrl+W")),
    ("next-tab", "Next Document", Some("Ctrl+Tab")),
    ("previous-tab", "Previous Document", Some("Ctrl+Shift+Tab")),
    ("undo", "Undo", Some("CmdOrCtrl+Z")),
    ("redo", "Redo", Some("CmdOrCtrl+Shift+Z")),
    ("toggle-left-panel", "Sidebar", Some("CmdOrCtrl+Alt+1")),
    (
        "toggle-right-panel",
        "Properties Panel",
        Some("CmdOrCtrl+Alt+2"),
    ),
    ("cycle-theme", "Switch Theme", None),
    ("zoom-in", "Zoom In", Some("CmdOrCtrl+=")),
    ("zoom-out", "Zoom Out", Some("CmdOrCtrl+-")),
    ("zoom-actual-size", "Actual Size", Some("CmdOrCtrl+0")),
    ("zoom-fit-width", "Fit Width", None),
    ("zoom-fit-page", "Fit Page", None),
    ("rotate-clockwise", "Rotate Clockwise", Some("CmdOrCtrl+R")),
    (
        "rotate-counterclockwise",
        "Rotate Counterclockwise",
        Some("CmdOrCtrl+L"),
    ),
    ("go-to-page", "Go to Page…", Some("CmdOrCtrl+Alt+G")),
    ("find", "Find…", Some("CmdOrCtrl+F")),
    ("find-next", "Find Next", Some("CmdOrCtrl+G")),
    ("find-previous", "Find Previous", Some("CmdOrCtrl+Shift+G")),
    ("insert-pages", "Insert Pages from File…", None),
    ("insert-blank-page", "Insert Blank Page", None),
    ("rotate-pages-clockwise", "Rotate Pages Clockwise", None),
    (
        "rotate-pages-counterclockwise",
        "Rotate Pages Counterclockwise",
        None,
    ),
    ("delete-pages", "Delete Pages", None),
    ("extract-pages", "Extract Pages…", None),
    ("sign", "Add Signature…", None),
    ("page-numbers", "Page Numbers…", None),
    ("watermark", "Watermark…", None),
    ("recognize-text", "Recognize Text (OCR)…", None),
    ("export-images", "Export Pages as Images…", None),
    ("export-text", "Export Text…", None),
    ("reduce-file-size", "Reduce File Size…", None),
    ("protect", "Password Protection…", None),
    ("ask-ai", "Ask Claude…", None),
];

/// macOS Window > Close Window, handled in Rust rather than forwarded. ⌘W
/// closes the current document, so the predefined item (also ⌘W) cannot be
/// used: its shortcut would never reach it. It closes the window like its
/// close button, so unsaved work is asked about first.
pub const CLOSE_WINDOW: MenuEntry = ("close-window", "Close Window", Some("CmdOrCtrl+Shift+W"));

/// Quits Folio, asking about unsaved work first. The predefined Quit item
/// terminates the app directly (macOS `terminate:`, Windows
/// `PostQuitMessage`), past any check.
#[cfg(target_os = "macos")]
pub const QUIT: MenuEntry = ("quit", "Quit Folio", Some("CmdOrCtrl+Q"));
#[cfg(windows)]
pub const QUIT: MenuEntry = ("quit", "Exit", Some("CmdOrCtrl+Q"));
#[cfg(not(any(target_os = "macos", windows)))]
pub const QUIT: MenuEntry = ("quit", "Quit", Some("CmdOrCtrl+Q"));

/// File > Connect to Chrome…, handled entirely in Rust (see `connect`): the
/// webview can neither start nor answer it.
pub const CONNECT_CHROME: MenuEntry = ("connect-chrome", "Connect to Chrome…", None);

/// File > Open Recent, filled from the recent files.
pub const OPEN_RECENT: &str = "open-recent";
pub const CLEAR_RECENT: MenuEntry = ("clear-recent", "Clear Menu", None);
const RECENT_PREFIX: &str = "recent:";

/// Maps a menu event id to a frontend command, ignoring anything unknown.
pub fn command_for(id: &str) -> Option<&'static str> {
    MENU_COMMANDS
        .iter()
        .find(|(command, _, _)| *command == id)
        .map(|(command, _, _)| *command)
}

/// The recent file an Open Recent item opens.
pub fn recent_file_for(id: &str) -> Option<&str> {
    id.strip_prefix(RECENT_PREFIX)
        .filter(|id| recent::is_valid_id(id))
}

/// Whether an accelerator combines Control (or ⌘ on macOS) with Alt.
fn uses_control_alt(accelerator: &str) -> bool {
    let keys: Vec<String> = accelerator
        .split('+')
        .map(|key| key.trim().to_ascii_lowercase())
        .collect();
    let control = keys.iter().any(|key| {
        matches!(
            key.as_str(),
            "cmdorctrl" | "commandorcontrol" | "cmdorcontrol" | "ctrl" | "control"
        )
    });
    let alt = keys
        .iter()
        .any(|key| matches!(key.as_str(), "alt" | "option"));
    control && alt
}

/// The accelerator to register natively. On Windows and Linux, AltGr reports
/// Ctrl+Alt, so Ctrl+Alt accelerators would swallow characters typed with
/// AltGr (such as `@` or `{` on many layouts) before the webview sees them.
/// The webview's own shortcut handler, which tells AltGr apart, covers those
/// shortcuts instead. macOS uses ⌘ and has no AltGr.
pub fn native_accelerator(accelerator: Option<&'static str>, macos: bool) -> Option<&'static str> {
    accelerator.filter(|accelerator| macos || !uses_control_alt(accelerator))
}

fn entry_item<R: Runtime>(app: &AppHandle<R>, entry: &MenuEntry) -> tauri::Result<MenuItem<R>> {
    let (id, label, accelerator) = *entry;
    let builder = MenuItemBuilder::with_id(id, label);
    match native_accelerator(accelerator, cfg!(target_os = "macos")) {
        Some(accelerator) => builder.accelerator(accelerator).build(app),
        None => builder.build(app),
    }
}

fn item<R: Runtime>(app: &AppHandle<R>, id: &str) -> tauri::Result<MenuItem<R>> {
    let entry = MENU_COMMANDS
        .iter()
        .find(|(command, _, _)| *command == id)
        .expect("menu command is declared");
    entry_item(app, entry)
}

/// Windows and Linux show nothing for an About item without metadata. (macOS
/// builds its standard panel from the app bundle.)
#[cfg(not(target_os = "macos"))]
fn about_metadata<R: Runtime>(app: &AppHandle<R>) -> AboutMetadata<'static> {
    let info = app.package_info();
    AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..AboutMetadata::default()
    }
}

/// Menu labels mark mnemonics with `&`; file names are shown literally.
fn literal_label(label: &str) -> String {
    label.replace('&', "&&")
}

/// Replaces the items of the Open Recent submenu.
pub fn fill_recent<R: Runtime>(
    app: &AppHandle<R>,
    submenu: &Submenu<R>,
    entries: &[recent::MenuEntry],
) -> tauri::Result<()> {
    for _ in 0..submenu.items()?.len() {
        submenu.remove_at(0)?;
    }
    for entry in entries {
        let id = format!("{RECENT_PREFIX}{}", entry.id);
        submenu.append(&MenuItemBuilder::with_id(id, literal_label(&entry.label)).build(app)?)?;
    }
    if !entries.is_empty() {
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let (id, label, _) = CLEAR_RECENT;
    submenu.append(
        &MenuItemBuilder::with_id(id, label)
            .enabled(!entries.is_empty())
            .build(app)?,
    )
}

/// Builds the menu bar. Returns the Open Recent submenu, which
/// [`fill_recent`] updates when the recent files change.
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    recent: &[recent::MenuEntry],
) -> tauri::Result<(Menu<R>, Submenu<R>)> {
    let open_recent = SubmenuBuilder::with_id(app, OPEN_RECENT, "Open Recent").build()?;
    fill_recent(app, &open_recent, recent)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "open")?)
        .item(&open_recent)
        .separator()
        .item(&item(app, "save")?)
        .item(&item(app, "save-as")?)
        .item(&item(app, "save-copy")?)
        .separator()
        .item(&item(app, "print")?)
        .separator()
        .item(&entry_item(app, &CONNECT_CHROME)?)
        .separator()
        .item(&item(app, "close-tab")?);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&entry_item(app, &QUIT)?);
    let file = file.build()?;

    // Undo and Redo act on the document, so they are forwarded; the
    // predefined clipboard items keep text fields working.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item(app, "undo")?)
        .item(&item(app, "redo")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, "find")?)
        .item(&item(app, "find-next")?)
        .item(&item(app, "find-previous")?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "zoom-in")?)
        .item(&item(app, "zoom-out")?)
        .item(&item(app, "zoom-actual-size")?)
        .item(&item(app, "zoom-fit-width")?)
        .item(&item(app, "zoom-fit-page")?)
        .separator()
        .item(&item(app, "rotate-clockwise")?)
        .item(&item(app, "rotate-counterclockwise")?)
        .separator()
        .item(&item(app, "go-to-page")?)
        .separator()
        .item(&item(app, "toggle-left-panel")?)
        .item(&item(app, "toggle-right-panel")?)
        .separator()
        .item(&item(app, "next-tab")?)
        .item(&item(app, "previous-tab")?)
        .separator()
        .item(&item(app, "cycle-theme")?);
    #[cfg(target_os = "macos")]
    let view = view.separator().fullscreen();
    let view = view.build()?;

    let pages = SubmenuBuilder::new(app, "Pages")
        .item(&item(app, "insert-pages")?)
        .item(&item(app, "insert-blank-page")?)
        .separator()
        .item(&item(app, "rotate-pages-clockwise")?)
        .item(&item(app, "rotate-pages-counterclockwise")?)
        .separator()
        .item(&item(app, "delete-pages")?)
        .item(&item(app, "extract-pages")?)
        .build()?;

    let tools = SubmenuBuilder::new(app, "Tools")
        .item(&item(app, "sign")?)
        .separator()
        .item(&item(app, "page-numbers")?)
        .item(&item(app, "watermark")?)
        .separator()
        .item(&item(app, "recognize-text")?)
        .separator()
        .item(&item(app, "export-images")?)
        .item(&item(app, "export-text")?)
        .item(&item(app, "reduce-file-size")?)
        .item(&item(app, "protect")?)
        .separator()
        .item(&item(app, "ask-ai")?)
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app, "Folio")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&entry_item(app, &QUIT)?)
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .item(&entry_item(app, &CLOSE_WINDOW)?)
            .build()?;
        Menu::with_items(
            app,
            &[&app_menu, &file, &edit, &view, &pages, &tools, &window],
        )?
    };

    #[cfg(not(target_os = "macos"))]
    let menu = {
        let about = format!("About {}", app.package_info().name);
        let help = SubmenuBuilder::new(app, "Help")
            .about_with_text(about, Some(about_metadata(app)))
            .build()?;
        Menu::with_items(app, &[&file, &edit, &view, &pages, &tools, &help])?
    };

    Ok((menu, open_recent))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Items handled natively rather than forwarded.
    const NATIVE: [MenuEntry; 4] = [CLOSE_WINDOW, QUIT, CLEAR_RECENT, CONNECT_CHROME];

    #[test]
    fn only_declared_commands_are_forwarded() {
        assert_eq!(command_for("open"), Some("open"));
        assert_eq!(
            command_for("toggle-right-panel"),
            Some("toggle-right-panel")
        );
        assert_eq!(command_for("save-as"), Some("save-as"));
        assert_eq!(command_for("extract-pages"), Some("extract-pages"));
        assert_eq!(command_for("quit"), None);
        assert_eq!(command_for(OPEN_RECENT), None);
        assert_eq!(command_for(""), None);
    }

    #[test]
    fn command_ids_are_unique() {
        let mut ids: Vec<_> = MENU_COMMANDS.iter().map(|(id, _, _)| *id).collect();
        ids.extend(NATIVE.iter().map(|(id, _, _)| *id));
        ids.push(OPEN_RECENT);
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }

    #[test]
    fn closing_quitting_recent_files_and_chrome_are_handled_natively() {
        for (id, _, _) in NATIVE {
            assert_eq!(command_for(id), None);
            assert_eq!(recent_file_for(id), None);
        }
    }

    #[test]
    fn recent_items_name_valid_recent_ids_only() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(recent_file_for(&format!("recent:{id}")), Some(id));
        assert_eq!(recent_file_for(id), None);
        assert_eq!(recent_file_for("recent:../../etc/passwd"), None);
        assert_eq!(recent_file_for("recent:"), None);
    }

    /// Predefined items bring their own shortcuts, which is why Close Window
    /// and Quit are custom items: the predefined Close Window also claims ⌘W.
    #[test]
    fn every_shortcut_belongs_to_one_item() {
        let mut accelerators: Vec<_> = MENU_COMMANDS
            .iter()
            .chain(NATIVE.iter())
            .filter_map(|(_, _, accelerator)| *accelerator)
            .map(str::to_ascii_lowercase)
            .collect();
        let count = accelerators.len();
        accelerators.sort_unstable();
        accelerators.dedup();
        assert_eq!(accelerators.len(), count);
    }

    #[test]
    fn the_frontend_accepts_exactly_these_commands() {
        let accepted: Vec<String> =
            serde_json::from_str(include_str!("../../src/platform/menu-commands.json")).unwrap();
        let declared: Vec<&str> = MENU_COMMANDS.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(accepted, declared);
        // Native items, Connect to Chrome among them, never reach the webview.
        for (id, _, _) in NATIVE {
            assert!(!accepted.iter().any(|command| command == id), "{id}");
        }
        assert!(!accepted.iter().any(|command| command.contains("chrome")));
    }

    #[test]
    fn connect_to_chrome_is_in_the_file_menu_everywhere() {
        let source = include_str!("menu.rs");
        let file_menu = &source[source.find("SubmenuBuilder::new(app, \"File\")").unwrap()..];
        let file_menu = &file_menu[..file_menu.find(".build()?").unwrap()];
        assert!(file_menu.contains("entry_item(app, &CONNECT_CHROME)?"));
        assert_eq!(CONNECT_CHROME.1, "Connect to Chrome…");
    }

    #[test]
    fn every_command_is_in_a_menu() {
        let source = include_str!("menu.rs");
        for (id, _, _) in MENU_COMMANDS {
            assert!(
                source.contains(&format!("item(app, \"{id}\")")),
                "{id} is declared but never added to a menu"
            );
        }
    }

    #[test]
    fn switching_theme_and_page_commands_have_no_shortcut() {
        for id in [
            "cycle-theme",
            "insert-pages",
            "insert-blank-page",
            "rotate-pages-clockwise",
            "rotate-pages-counterclockwise",
            "delete-pages",
            "extract-pages",
        ] {
            let entry = MENU_COMMANDS.iter().find(|(command, _, _)| *command == id);
            assert_eq!(
                entry.map(|(_, _, accelerator)| *accelerator),
                Some(None),
                "{id}"
            );
        }
    }

    #[test]
    fn save_shortcuts_follow_the_editor() {
        let shortcut = |id: &str| {
            MENU_COMMANDS
                .iter()
                .find(|(command, _, _)| *command == id)
                .and_then(|(_, _, accelerator)| *accelerator)
        };
        assert_eq!(shortcut("save"), Some("CmdOrCtrl+S"));
        assert_eq!(shortcut("save-as"), Some("CmdOrCtrl+Shift+S"));
        assert_eq!(shortcut("save-copy"), Some("CmdOrCtrl+Alt+S"));
        assert_eq!(shortcut("print"), Some("CmdOrCtrl+P"));
        assert_eq!(shortcut("undo"), Some("CmdOrCtrl+Z"));
        assert_eq!(shortcut("redo"), Some("CmdOrCtrl+Shift+Z"));
    }

    #[test]
    fn control_alt_shortcuts_are_left_to_the_webview_on_windows_and_linux() {
        for (id, _, accelerator) in MENU_COMMANDS.iter().chain(NATIVE.iter()) {
            let registered = native_accelerator(*accelerator, false);
            assert!(
                registered.is_none_or(|accelerator| !uses_control_alt(accelerator)),
                "{id} would register {registered:?} on Windows or Linux"
            );
            // macOS keeps every shortcut.
            assert_eq!(native_accelerator(*accelerator, true), *accelerator);
        }
        for id in [
            "save-copy",
            "toggle-left-panel",
            "toggle-right-panel",
            "go-to-page",
        ] {
            let entry = MENU_COMMANDS.iter().find(|(command, _, _)| *command == id);
            let accelerator = entry.and_then(|(_, _, accelerator)| *accelerator);
            assert!(accelerator.is_some(), "{id}");
            assert_eq!(native_accelerator(accelerator, false), None, "{id}");
        }
        // Everything else keeps its shortcut everywhere.
        assert_eq!(
            native_accelerator(Some("CmdOrCtrl+Shift+S"), false),
            Some("CmdOrCtrl+Shift+S")
        );
        assert_eq!(
            native_accelerator(Some("Ctrl+Tab"), false),
            Some("Ctrl+Tab")
        );
        assert!(uses_control_alt("Ctrl+Alt+Delete"));
        assert!(uses_control_alt("cmdorctrl+option+1"));
        assert!(!uses_control_alt("Alt+F4"));
        assert!(!uses_control_alt("CmdOrCtrl+Shift+Z"));
    }

    #[test]
    fn file_names_are_not_mnemonics() {
        assert_eq!(literal_label("Q&A.pdf"), "Q&&A.pdf");
        assert_eq!(literal_label("Report.pdf"), "Report.pdf");
    }
}

/// Menu events carry ids: only declared commands reach the webview, and
/// only a valid recent id opens a recent file.
#[cfg(test)]
mod properties {
    use super::*;
    use crate::fuzz;
    use proptest::prelude::*;

    fn id_like() -> impl Strategy<Value = String> {
        let native = [CLOSE_WINDOW, QUIT, CLEAR_RECENT, CONNECT_CHROME];
        let known: Vec<String> = MENU_COMMANDS
            .iter()
            .chain(native.iter())
            .map(|(id, _, _)| (*id).to_owned())
            .chain([OPEN_RECENT.to_owned()])
            .collect();
        prop_oneof![
            prop::sample::select(known),
            "recent:[0-9a-fA-F]{30,34}",
            fuzz::text(),
        ]
    }

    proptest! {
        #![proptest_config(fuzz::config(1024))]

        #[test]
        fn forwards_only_declared_commands(id in id_like()) {
            let declared = MENU_COMMANDS.iter().any(|(command, _, _)| *command == id);
            prop_assert_eq!(command_for(&id), declared.then_some(id.as_str()));
            if let Some(recent) = recent_file_for(&id) {
                prop_assert!(recent::is_valid_id(recent));
                prop_assert_eq!(format!("{RECENT_PREFIX}{recent}"), id.clone());
                prop_assert!(!declared);
            }
        }
    }
}
