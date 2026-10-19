//! File ▸ Connect to Chrome…: registers this copy of Folio as the native
//! messaging host for the official Folio extension, or removes that
//! registration. It all happens in native dialogs on the Rust side; the
//! webview can neither start, see nor answer them.
//!
//! The question that changes something always has a safe default: Return,
//! Enter and Escape keep things as they are, and only a click on the action
//! button (or Tab to it) goes ahead. Updates (`updates`) ask and tell through
//! the same dialogs.

use crate::native_messaging::{self, RegistrationError, Status};
use crate::paths;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Set while the dialogs are up, so a second click does not stack them.
static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Connect,
    Disconnect,
}

/// A question whose default answer (`safe`) leaves everything as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub title: String,
    pub text: String,
    /// The default button: Return, Enter and Escape choose it.
    pub safe: &'static str,
    pub action: &'static str,
}

/// A message with an OK button.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub level: Level,
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Ask(Question, Action),
    Tell(Notice),
}

/// "Google Chrome", "Google Chrome and Chromium".
fn browser_list(browsers: &[&str]) -> String {
    match browsers {
        [] => "Chrome".to_owned(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// What to show first: the registration and a way to remove it, the
/// question whether to connect, or why connecting cannot work here.
pub fn first_step(status: &Status, can_register: Result<(), RegistrationError>) -> Step {
    if status.registered {
        return Step::Ask(
            Question {
                title: "Folio is connected to Chrome".to_owned(),
                text: format!(
                    "The Folio extension in {} can send PDF documents to this copy of \
                     Folio. Folio asks you before it opens each one.\n\n\
                     Disconnect to stop this.",
                    browser_list(&status.browsers)
                ),
                safe: "Close",
                action: "Disconnect",
            },
            Action::Disconnect,
        );
    }
    if let Err(error) = can_register {
        return Step::Tell(error_notice(&error, Action::Connect));
    }
    Step::Ask(
        Question {
            title: "Connect Folio to Chrome?".to_owned(),
            text: format!(
                "The Folio extension for Chrome will be able to send PDF documents to \
                 this copy of Folio. Folio asks you before it opens each one.\n\n\
                 Only the official Folio extension can connect (ID {}).",
                native_messaging::OFFICIAL_EXTENSION_IDS.join(", ")
            ),
            safe: "Cancel",
            action: "Connect",
        },
        Action::Connect,
    )
}

pub fn connected_notice(browsers: &[&str]) -> Notice {
    Notice {
        level: Level::Info,
        title: "Folio is connected to Chrome".to_owned(),
        text: format!(
            "The Folio extension in {} can now send PDF documents to this copy of \
             Folio. Folio asks you before it opens each one.",
            browser_list(browsers)
        ),
    }
}

pub fn disconnected_notice() -> Notice {
    Notice {
        level: Level::Info,
        title: "Folio is disconnected from Chrome".to_owned(),
        text: "The Folio extension can no longer send documents to this copy of Folio.".to_owned(),
    }
}

/// Why Folio will not connect from where it is, and where to put it (see
/// `paths::safe_location`).
#[cfg(target_os = "macos")]
const UNSAFE_LOCATION_TEXT: &str = "Chrome would start Folio from where it is now, and \
     other users or apps could change or replace it there, or it may go away (a shared \
     or temporary folder, a disk image or an external drive). Move Folio to the \
     Applications folder, open it from there and try again.";
#[cfg(windows)]
const UNSAFE_LOCATION_TEXT: &str = "Chrome would start Folio from where it is now, and \
     other users or apps could change or replace it there, or it may go away (a folder \
     other users can write to, such as one created directly on C:\\, a temporary folder, \
     a network share or a removable drive). Install Folio in Program Files or in your own \
     user folder, open it from there and try again.";
#[cfg(not(any(target_os = "macos", windows)))]
const UNSAFE_LOCATION_TEXT: &str = "Chrome would start Folio from where it is now, and \
     other users or apps could change or replace it there, or it may go away (a folder \
     that belongs to or can be changed by other users, a temporary folder or a removable \
     drive). Move Folio into a folder only you can change, such as ~/Applications, make \
     sure only you can write to it, open it from there and try again.";

pub fn error_notice(error: &RegistrationError, action: Action) -> Notice {
    let (level, title, text) = match error {
        RegistrationError::BrowserNotFound => (
            Level::Warning,
            "Chrome was not found",
            "Folio could not find Google Chrome or Chromium for this user. Open Chrome \
             once, then try again.",
        ),
        RegistrationError::Translocated => (
            Level::Warning,
            "Move Folio to the Applications folder first",
            "macOS runs Folio from a temporary copy, which Chrome could not start later. \
             Move Folio to the Applications folder, open it from there and try again.",
        ),
        RegistrationError::UnsafeLocation => (
            Level::Warning,
            "Move Folio to a safe place first",
            UNSAFE_LOCATION_TEXT,
        ),
        RegistrationError::Unavailable => (
            Level::Error,
            "Chrome integration is not available",
            "Folio cannot connect to Chrome on this computer.",
        ),
        RegistrationError::Failed => (
            Level::Error,
            match action {
                Action::Connect => "Folio could not connect to Chrome",
                Action::Disconnect => "Folio could not disconnect from Chrome",
            },
            "Folio could not change Chrome's settings for it. Try again, or restart \
             Folio first.",
        ),
    };
    Notice {
        level,
        title: title.to_owned(),
        text: text.to_owned(),
    }
}

/// Clears [`RUNNING`] however the dialogs end.
struct Running;

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

/// Handles the menu item: the dialogs run on their own thread, never on
/// the main thread that draws them.
pub fn start(app: &AppHandle) {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _running = Running;
        run(&app);
    });
}

fn run(app: &AppHandle) {
    let (Some(locations), Ok(exe)) = (native_messaging::locations(), paths::executable()) else {
        tell(
            app,
            &error_notice(&RegistrationError::Unavailable, Action::Connect),
        );
        return;
    };
    let status = native_messaging::status(&locations, &exe);
    let can_register = native_messaging::check_can_register(&locations, &exe);
    let (question, action) = match first_step(&status, can_register) {
        Step::Tell(notice) => return tell(app, &notice),
        Step::Ask(question, action) => (question, action),
    };
    if !ask(app, &question) {
        return;
    }
    let notice = match action {
        Action::Connect => match native_messaging::register(&locations, &exe) {
            Ok(browsers) => connected_notice(&browsers),
            Err(error) => error_notice(&error, action),
        },
        Action::Disconnect => match native_messaging::unregister(&locations, &exe) {
            Ok(()) => disconnected_notice(),
            Err(error) => error_notice(&error, action),
        },
    };
    tell(app, &notice);
}

/// Shows a notice and waits until it is closed.
pub(crate) fn tell(app: &AppHandle, notice: &Notice) {
    let kind = match notice.level {
        Level::Info => MessageDialogKind::Info,
        Level::Warning => MessageDialogKind::Warning,
        Level::Error => MessageDialogKind::Error,
    };
    let mut dialog = app
        .dialog()
        .message(&notice.text)
        .title(&notice.title)
        .kind(kind)
        .buttons(MessageDialogButtons::Ok);
    if let Some(window) = crate::main_window(app) {
        dialog = dialog.parent(&window);
    }
    let _ = dialog.blocking_show();
}

/// Asks `question` and waits for the answer: `true` only when the action
/// button was chosen.
///
/// The dialog plugin reports Escape as its second button, and macOS and
/// Windows make the first button the default, so the dialog is shown
/// through `rfd` directly with the safe button first: Return picks it,
/// Escape reads as cancelled, and only `Custom(action)` goes ahead.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn ask(app: &AppHandle, question: &Question) -> bool {
    use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
    let (sender, receiver) = std::sync::mpsc::channel();
    let window = crate::main_window(app);
    let shown = question.clone();
    let scheduled = app.run_on_main_thread(move || {
        let mut dialog = AsyncMessageDialog::new()
            .set_level(MessageLevel::Info)
            .set_title(&shown.title)
            .set_description(&shown.text)
            .set_buttons(MessageButtons::OkCancelCustom(
                shown.safe.to_owned(),
                shown.action.to_owned(),
            ));
        if let Some(window) = &window {
            dialog = dialog.set_parent(window);
        }
        let answer = dialog.show();
        std::thread::spawn(move || {
            let _ = sender.send(tauri::async_runtime::block_on(answer));
        });
    });
    if scheduled.is_err() {
        return false;
    }
    matches!(receiver.recv(), Ok(MessageDialogResult::Custom(label)) if label == question.action)
}

/// Asks `question` and waits for the answer: `true` only when the action
/// button was chosen.
///
/// GTK dialogs built by `rfd` cannot tell their second button from Escape
/// and have no default button, so the dialog is built here with an
/// explicit default (and focus) on the safe button.
#[cfg(target_os = "linux")]
pub(crate) fn ask(app: &AppHandle, question: &Question) -> bool {
    use gtk::prelude::*;
    let (sender, receiver) = std::sync::mpsc::channel();
    let window = crate::main_window(app);
    let shown = question.clone();
    let scheduled = app.run_on_main_thread(move || {
        let parent = window.and_then(|window| window.gtk_window().ok());
        let dialog = gtk::MessageDialog::new(
            parent.as_ref(),
            gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
            gtk::MessageType::Question,
            gtk::ButtonsType::None,
            &shown.title,
        );
        dialog.set_title(&shown.title);
        dialog.set_secondary_text(Some(shown.text.as_str()));
        let safe = dialog.add_button(shown.safe, gtk::ResponseType::Cancel);
        dialog.add_button(shown.action, gtk::ResponseType::Accept);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        // Answered once: closing the dialog reports a response of its own.
        let sender = std::cell::RefCell::new(Some(sender));
        dialog.connect_response(move |dialog, response| {
            let Some(sender) = sender.borrow_mut().take() else {
                return;
            };
            let _ = sender.send(response == gtk::ResponseType::Accept);
            // Escape and the close button are closing it already.
            if response != gtk::ResponseType::DeleteEvent {
                dialog.close();
            }
        });
        dialog.show_all();
        safe.grab_focus();
    });
    if scheduled.is_err() {
        return false;
    }
    // A dialog destroyed without an answer drops the sender: not confirmed.
    receiver.recv().unwrap_or(false)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn ask(_app: &AppHandle, _question: &Question) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registered(browsers: Vec<&'static str>) -> Status {
        Status {
            registered: true,
            extension_ids: native_messaging::OFFICIAL_EXTENSION_IDS
                .iter()
                .map(|id| (*id).to_owned())
                .collect(),
            browsers,
        }
    }

    #[test]
    fn asks_before_connecting_with_cancel_as_the_default() {
        let Step::Ask(question, action) = first_step(&Status::default(), Ok(())) else {
            panic!("expected a question");
        };
        assert_eq!(action, Action::Connect);
        assert_eq!((question.safe, question.action), ("Cancel", "Connect"));
        assert!(question.title.ends_with('?'));
        assert!(question
            .text
            .contains(native_messaging::OFFICIAL_EXTENSION_IDS[0]));
        assert!(question.text.contains("asks you before it opens each one"));
    }

    #[test]
    fn shows_the_registration_with_close_as_the_default() {
        let status = registered(vec!["Google Chrome", "Chromium"]);
        let Step::Ask(question, action) = first_step(&status, Ok(())) else {
            panic!("expected a question");
        };
        assert_eq!(action, Action::Disconnect);
        assert_eq!((question.safe, question.action), ("Close", "Disconnect"));
        assert!(question.text.contains("Google Chrome and Chromium"));
        // Problems with registering again do not hide the way out.
        let Step::Ask(_, action) = first_step(&status, Err(RegistrationError::BrowserNotFound))
        else {
            panic!("expected a question");
        };
        assert_eq!(action, Action::Disconnect);
    }

    #[test]
    fn explains_why_connecting_cannot_work_before_asking() {
        for (error, phrase) in [
            (RegistrationError::BrowserNotFound, "Open Chrome once"),
            (RegistrationError::Translocated, "Applications folder"),
            (
                RegistrationError::UnsafeLocation,
                "other users or apps could change or replace it",
            ),
            (RegistrationError::Unavailable, "cannot connect"),
        ] {
            let Step::Tell(notice) = first_step(&Status::default(), Err(error)) else {
                panic!("expected a notice");
            };
            assert!(notice.text.contains(phrase), "{}", notice.text);
            assert_ne!(notice.level, Level::Info);
        }
    }

    #[test]
    fn reports_the_outcome() {
        let notice = connected_notice(&["Google Chrome"]);
        assert_eq!(notice.level, Level::Info);
        assert!(notice.text.contains("Google Chrome can now send"));
        assert!(connected_notice(&["Google Chrome", "Chromium"])
            .text
            .contains("Google Chrome and Chromium"));
        assert!(disconnected_notice().text.contains("no longer"));
        let failed = error_notice(&RegistrationError::Failed, Action::Disconnect);
        assert_eq!(failed.level, Level::Error);
        assert!(failed.title.contains("disconnect"));
        assert!(error_notice(&RegistrationError::Failed, Action::Connect)
            .title
            .contains("could not connect"));
    }

    #[test]
    fn lists_browsers_in_words() {
        assert_eq!(browser_list(&[]), "Chrome");
        assert_eq!(browser_list(&["Chromium"]), "Chromium");
        assert_eq!(
            browser_list(&["Google Chrome", "Chromium", "Brave"]),
            "Google Chrome, Chromium and Brave"
        );
    }
}
