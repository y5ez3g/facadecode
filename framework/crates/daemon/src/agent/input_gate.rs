//! Whether delivery may write into the current run's input.

use facade_base::model::{agent::WaitKind, terminal::InputState};

#[derive(Default)]
pub(super) struct InputGate {
    /// A native wait was seen. Its withdrawal needs a later ordinary frame.
    needs_composer: bool,
    /// The last complete frame that decided this showed a menu.
    menu: bool,
    /// Output position of the last complete redraw of that menu.
    menu_redraw: Option<u64>,
    /// After recovery the last logged frame can precede a native report's withdrawal.
    needs_fresh_frame: bool,
}

impl InputGate {
    pub(super) fn recover(&mut self, has_reports: bool) {
        self.needs_fresh_frame = has_reports;
    }

    pub(super) fn report(&mut self, native_wait: Option<WaitKind>) {
        self.needs_composer |= native_wait.is_some();
    }

    pub(super) fn frame(
        &mut self,
        state: InputState,
        own_draft: bool,
        native_wait: Option<WaitKind>,
    ) {
        if state == InputState::Interaction {
            self.menu = true;
        } else if state == InputState::Usable || (state == InputState::Draft && own_draft) {
            self.menu = false;
            self.menu_redraw = None;
            if native_wait.is_none() {
                self.needs_composer = false;
                self.needs_fresh_frame = false;
            }
        }
    }

    pub(super) fn note_menu_redraw(&mut self, start: u64) {
        self.menu_redraw = Some(start);
    }

    pub(super) fn menu_redraw(&self) -> Option<u64> {
        self.menu_redraw
    }

    pub(super) fn blocked(&self) -> bool {
        self.needs_composer || self.menu
    }

    pub(super) fn blocks_delivery(&self) -> bool {
        self.blocked() || self.needs_fresh_frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withdrawal_needs_an_ordinary_frame_in_that_order() {
        let mut gate = InputGate::default();
        let wait = Some(WaitKind::Question);
        gate.report(wait);
        gate.frame(InputState::Usable, false, wait);
        gate.report(None);
        assert!(gate.blocked());

        gate.frame(InputState::Unknown, false, None);
        gate.frame(InputState::Draft, false, None);
        assert!(gate.blocked());

        gate.frame(InputState::Draft, true, None);
        assert!(!gate.blocked());
    }

    #[test]
    fn a_complete_menu_blocks_even_without_native_reports() {
        let mut gate = InputGate::default();
        gate.frame(InputState::Interaction, false, None);
        gate.frame(InputState::Unknown, false, None);
        assert!(gate.blocked());

        gate.frame(InputState::Usable, false, None);
        assert!(!gate.blocked());
    }
}
