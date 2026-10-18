//! Native application menus. Custom items emit `folio://menu` with a
//! command name the frontend understands; nothing else is forwarded.

use tauri::menu::{Menu, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// (command id, label, accelerator)
pub const MENU_COMMANDS: &[(&str, &str, Option<&str>)] = &[
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

/// Maps a menu event id to a frontend command, ignoring anything unknown.
pub fn command_for(id: &str) -> Option<&'static str> {
    MENU_COMMANDS
        .iter()
        .find(|(command, _, _)| *command == id)
        .map(|(command, _, _)| *command)
}

fn item<R: Runtime>(app: &AppHandle<R>, id: &str) -> tauri::Result<MenuItem<R>> {
    let (command, label, accelerator) = MENU_COMMANDS
        .iter()
        .find(|(command, _, _)| *command == id)
        .expect("menu command is declared");
    let builder = MenuItemBuilder::with_id(*command, *label);
    match accelerator {
        Some(accelerator) => builder.accelerator(*accelerator).build(app),
        None => builder.build(app),
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
            .close_window()
            .build()?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
    }

    #[cfg(not(target_os = "macos"))]
    {
        let help = SubmenuBuilder::new(app, "Help").about(None).build()?;
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
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MENU_COMMANDS.len());
    }
}
