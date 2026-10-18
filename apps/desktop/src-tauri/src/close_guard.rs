//! Asks the UI before unsaved work is lost. While the UI reports unsaved
//! changes (`set_close_guard`), closing the window or quitting is held back
//! and the UI is asked through `folio://close-requested`; it answers with
//! `confirm_close` once the user saved or chose to discard the changes. When
//! nothing is unsaved, closing works as if the guard did not exist.

use std::sync::{Mutex, MutexGuard};

/// What the user asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseIntent {
    /// Close the window (title bar button, Window ▸ Close Window).
    Window,
    /// Quit Folio (Quit menu item, ⌘Q).
    Quit,
}

#[derive(Debug, Default)]
struct State {
    enabled: bool,
    /// A request the UI has been asked about and has not answered yet.
    pending: Option<CloseIntent>,
}

#[derive(Debug, Default)]
pub struct CloseGuard {
    state: Mutex<State>,
}

impl CloseGuard {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.lock();
        state.enabled = enabled;
        if !enabled {
            state.pending = None;
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.lock().enabled
    }

    /// A close or quit was requested. Returns `true` when it must be held
    /// back while the UI asks the user; the newest request is the one a
    /// confirmation carries out.
    pub fn intercept(&self, intent: CloseIntent) -> bool {
        let mut state = self.lock();
        if !state.enabled {
            return false;
        }
        // Quitting covers closing the window, not the other way around.
        if state.pending != Some(CloseIntent::Quit) {
            state.pending = Some(intent);
        }
        true
    }

    /// The UI confirmed: returns what to carry out, or `None` if nothing was
    /// requested (a confirmation cannot close the window on its own).
    pub fn confirm(&self) -> Option<CloseIntent> {
        let mut state = self.lock();
        let intent = state.pending.take()?;
        // The work is saved or discarded; nothing holds the window any more.
        state.enabled = false;
        Some(intent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_is_not_held_while_nothing_is_unsaved() {
        let guard = CloseGuard::default();
        assert!(!guard.intercept(CloseIntent::Window));
        assert!(!guard.intercept(CloseIntent::Quit));
        assert_eq!(guard.confirm(), None);
    }

    #[test]
    fn holds_closing_until_the_ui_confirms() {
        let guard = CloseGuard::default();
        guard.set_enabled(true);
        assert!(guard.intercept(CloseIntent::Window));
        assert!(guard.intercept(CloseIntent::Window));
        assert_eq!(guard.confirm(), Some(CloseIntent::Window));
        // Confirming carries out one request and lifts the guard.
        assert_eq!(guard.confirm(), None);
        assert!(!guard.is_enabled());
        assert!(!guard.intercept(CloseIntent::Window));
    }

    #[test]
    fn a_confirmation_without_a_request_does_nothing() {
        let guard = CloseGuard::default();
        guard.set_enabled(true);
        assert_eq!(guard.confirm(), None);
        assert!(guard.is_enabled());
    }

    #[test]
    fn quitting_wins_over_closing_the_window() {
        let guard = CloseGuard::default();
        guard.set_enabled(true);
        assert!(guard.intercept(CloseIntent::Window));
        assert!(guard.intercept(CloseIntent::Quit));
        assert!(guard.intercept(CloseIntent::Window));
        assert_eq!(guard.confirm(), Some(CloseIntent::Quit));
    }

    #[test]
    fn saving_everything_drops_a_pending_request() {
        let guard = CloseGuard::default();
        guard.set_enabled(true);
        assert!(guard.intercept(CloseIntent::Quit));
        // The user cancelled the prompt, saved, and the UI lifted the guard.
        guard.set_enabled(false);
        guard.set_enabled(true);
        assert_eq!(guard.confirm(), None);
    }
}
