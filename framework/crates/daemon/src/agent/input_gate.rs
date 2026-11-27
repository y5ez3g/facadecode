//! Whether delivery may write into the current run's input.

use facade_base::model::{agent::WaitKind, terminal::InputState};
use facade_rules::BoxReading;

#[derive(Default)]
pub(super) struct InputGate {
    /// A native wait was seen. Its withdrawal needs a later ordinary frame.
    needs_composer: bool,
    /// The last complete frame that decided this showed a menu.
    menu: bool,
    /// Output position of the last complete redraw of that menu.
    menu_redraw: Option<u64>,
    /// After recovery the last logged frame can precede a native report's withdrawal.
    recovery: RecoveryFrame,
    /// A fresh ordinary frame can authorize a probe after a native wait or startup menu.
    probe_after_wait: ProbeFrame,
}

#[derive(Default, PartialEq, Eq)]
enum ProbeFrame {
    #[default]
    Awaiting,
    /// A synchronized frame that was already open at the withdrawal.
    Earlier,
    Composer,
}

#[derive(Default, PartialEq, Eq)]
enum RecoveryFrame {
    #[default]
    None,
    InputRow,
    Composer,
}

impl InputGate {
    pub(super) fn recover(&mut self, has_reports: bool, answers_ask: bool) {
        self.recovery = match (has_reports, answers_ask) {
            (true, true) => RecoveryFrame::Composer,
            (true, false) => RecoveryFrame::InputRow,
            (false, _) => RecoveryFrame::None,
        };
    }

    pub(super) fn needs_recovery_redraw(&self) -> bool {
        self.recovery == RecoveryFrame::Composer
    }

    pub(super) fn report(&mut self, native_wait: Option<WaitKind>) {
        if native_wait.is_some() {
            self.needs_composer = true;
            self.probe_after_wait = ProbeFrame::Awaiting;
        }
    }

    pub(super) fn withdrew_in_sync(&mut self) {
        self.probe_after_wait = ProbeFrame::Earlier;
    }

    /// Records a complete frame for probing. Delivery still needs its own evidence.
    pub(super) fn probe_frame(
        &mut self,
        reading: &BoxReading,
        input_written: bool,
        native_wait: Option<WaitKind>,
    ) {
        if !self.needs_composer || native_wait.is_some() {
            return;
        }
        if self.probe_after_wait == ProbeFrame::Earlier {
            self.probe_after_wait = ProbeFrame::Awaiting;
        } else if input_written
            || reading.is_unread()
            || reading.info.state == InputState::Interaction
        {
            self.probe_after_wait = if reading.line.is_some()
                && (reading.unsure
                    || matches!(reading.info.state, InputState::Usable | InputState::Draft)
                    // The probe's own echoed space can make an ordinary box ambiguous again.
                    || self.probe_after_wait == ProbeFrame::Composer)
            {
                ProbeFrame::Composer
            } else {
                ProbeFrame::Awaiting
            };
        }
    }

    pub(super) fn has_post_wait_composer(&self) -> bool {
        self.blocked() && self.probe_after_wait == ProbeFrame::Composer
    }

    pub(super) fn waits_for_startup_composer(&self) -> bool {
        self.menu && !self.needs_composer && self.recovery == RecoveryFrame::None
    }

    /// A complete redraw replaced the startup menu. The probe can establish whether it is empty.
    pub(super) fn startup_composer(&mut self, reading: &BoxReading) {
        if self.waits_for_startup_composer()
            && matches!(reading.info.state, InputState::Usable | InputState::Draft)
        {
            self.probe_after_wait = ProbeFrame::Composer;
        }
    }

    pub(super) fn permits_probe(&self) -> bool {
        !self.blocks_delivery() || self.has_post_wait_composer()
    }

    pub(super) fn frame(
        &mut self,
        state: InputState,
        own_draft: bool,
        native_wait: Option<WaitKind>,
    ) {
        if state == InputState::Interaction {
            self.menu = true;
            if self.probe_after_wait == ProbeFrame::Composer {
                self.probe_after_wait = ProbeFrame::Awaiting;
            }
        } else if state == InputState::Usable || (state == InputState::Draft && own_draft) {
            self.menu = false;
            self.menu_redraw = None;
            if native_wait.is_none() {
                self.needs_composer = false;
                self.recovery = RecoveryFrame::None;
                self.probe_after_wait = ProbeFrame::Awaiting;
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
        self.blocked() || self.recovery != RecoveryFrame::None
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
