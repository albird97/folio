//! Native application menus. Custom items emit `folio://menu` with a
//! command name the frontend understands; nothing else is forwarded.
//!
//! macOS: Folio, File, Edit, View and Window menus. Windows and Linux: File,
//! Edit, View and Help menus.

#[cfg(not(target_os = "macos"))]
use tauri::menu::AboutMetadata;
use tauri::menu::{Menu, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// (id, label, accelerator)
pub type MenuEntry = (&'static str, &'static str, Option<&'static str>);

/// Items forwarded to the frontend as commands. The ids are also listed in
/// `apps/desktop/src/platform/menu-commands.json`, which the frontend accepts
/// (a test keeps both in step). Shortcuts match `packages/editor/src/commands.ts`.
pub const MENU_COMMANDS: &[MenuEntry] = &[
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("save-copy", "Save a Copy…", Some("CmdOrCtrl+Shift+S")),
    ("close-tab", "Close Document", Some("CmdOrCtrl+W")),
    ("next-tab", "Next Document", Some("Ctrl+Tab")),
    ("previous-tab", "Previous Document", Some("Ctrl+Shift+Tab")),
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
];

/// macOS Window > Close Window, handled in Rust rather than forwarded. ⌘W
/// closes the current document, so the predefined item (also ⌘W) cannot be
/// used: its shortcut would never reach it.
pub const CLOSE_WINDOW: MenuEntry = ("close-window", "Close Window", Some("CmdOrCtrl+Shift+W"));

/// Maps a menu event id to a frontend command, ignoring anything unknown.
pub fn command_for(id: &str) -> Option<&'static str> {
    MENU_COMMANDS
        .iter()
        .find(|(command, _, _)| *command == id)
        .map(|(command, _, _)| *command)
}

fn entry_item<R: Runtime>(app: &AppHandle<R>, entry: &MenuEntry) -> tauri::Result<MenuItem<R>> {
    let (id, label, accelerator) = *entry;
    let builder = MenuItemBuilder::with_id(id, label);
    match accelerator {
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

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "open")?)
        .item(&item(app, "save-copy")?)
        .separator()
        .item(&item(app, "close-tab")?);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit();
    let file = file.build()?;

    // Predefined edit items make clipboard shortcuts work in text fields.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
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

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Folio")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .item(&entry_item(app, &CLOSE_WINDOW)?)
            .build()?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
    }

    #[cfg(not(target_os = "macos"))]
    {
        let about = format!("About {}", app.package_info().name);
        let help = SubmenuBuilder::new(app, "Help")
            .about_with_text(about, Some(about_metadata(app)))
            .build()?;
        Menu::with_items(app, &[&file, &edit, &view, &help])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_declared_commands_are_forwarded() {
        assert_eq!(command_for("open"), Some("open"));
        assert_eq!(
            command_for("toggle-right-panel"),
            Some("toggle-right-panel")
        );
        assert_eq!(command_for("quit"), None);
        assert_eq!(command_for(""), None);
    }

    #[test]
    fn command_ids_are_unique() {
        let mut ids: Vec<_> = MENU_COMMANDS.iter().map(|(id, _, _)| *id).collect();
        ids.push(CLOSE_WINDOW.0);
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MENU_COMMANDS.len() + 1);
    }

    #[test]
    fn closing_the_window_is_handled_natively() {
        assert_eq!(command_for(CLOSE_WINDOW.0), None);
    }

    /// Predefined items bring their own shortcuts, which is why Close Window
    /// is a custom item: the predefined one also claims ⌘W.
    #[test]
    fn every_shortcut_belongs_to_one_item() {
        let mut accelerators: Vec<_> = MENU_COMMANDS
            .iter()
            .chain([&CLOSE_WINDOW])
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
    fn switching_theme_has_no_shortcut() {
        let theme = MENU_COMMANDS.iter().find(|(id, _, _)| *id == "cycle-theme");
        assert_eq!(theme.map(|(_, _, accelerator)| *accelerator), Some(None));
    }
}
