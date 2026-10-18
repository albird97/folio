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

/// Items forwarded to the frontend as commands.
pub const MENU_COMMANDS: &[MenuEntry] = &[
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("close-tab", "Close Document", Some("CmdOrCtrl+W")),
    ("next-tab", "Next Document", Some("Ctrl+Tab")),
    ("previous-tab", "Previous Document", Some("Ctrl+Shift+Tab")),
    ("toggle-left-panel", "Pages Panel", Some("CmdOrCtrl+Alt+1")),
    (
        "toggle-right-panel",
        "Properties Panel",
        Some("CmdOrCtrl+Alt+2"),
    ),
    ("cycle-theme", "Switch Theme", None),
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
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
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
    fn switching_theme_has_no_shortcut() {
        let theme = MENU_COMMANDS.iter().find(|(id, _, _)| *id == "cycle-theme");
        assert_eq!(theme.map(|(_, _, accelerator)| *accelerator), Some(None));
    }
}
