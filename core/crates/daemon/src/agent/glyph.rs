//! The glyph shown for one run's reported Agent State.

use std::time::Duration;

use facade_base::model::agent::ManagedAgentState;
use facade_rules::StatusGlyph;

#[derive(PartialEq, Eq)]
enum Appearance {
    Hidden,
    Working,
    Resting,
}

pub(super) struct Glyph {
    rule: Option<&'static StatusGlyph>,
    appearance: Appearance,
    current_frame: usize,
}

impl Glyph {
    pub(super) fn new(rule: Option<&'static StatusGlyph>) -> Self {
        Self {
            rule,
            appearance: Appearance::Hidden,
            current_frame: 0,
        }
    }

    /// The resumed run uses the same rule and starts with no glyph.
    pub(super) fn restart(&mut self) {
        *self = Self::new(self.rule);
    }

    /// Returns a glyph to set, or a clear, when what the state calls for changes.
    pub(super) fn update(
        &mut self,
        state: &ManagedAgentState,
        has_report: bool,
    ) -> Option<Option<String>> {
        let rule = self.rule?;
        let appearance = match (has_report, state) {
            (true, ManagedAgentState::Working) => Appearance::Working,
            (
                true,
                ManagedAgentState::Starting
                | ManagedAgentState::Idle
                | ManagedAgentState::JustDone
                | ManagedAgentState::WaitingForYou
                | ManagedAgentState::Error,
            ) => Appearance::Resting,
            _ => Appearance::Hidden,
        };
        if self.appearance == appearance {
            return None;
        }
        self.appearance = appearance;
        Some(match self.appearance {
            Appearance::Hidden => None,
            Appearance::Working => Some(rule.working[self.current_frame].clone()),
            Appearance::Resting => Some(rule.resting.clone()),
        })
    }

    pub(super) fn frame_interval(&self) -> Option<Duration> {
        let rule = self.rule?;
        (self.appearance == Appearance::Working).then(|| Duration::from_millis(rule.frame_ms))
    }

    pub(super) fn advance(&mut self) -> Option<String> {
        let rule = self.rule?;
        self.current_frame = (self.current_frame + 1) % rule.working.len();
        Some(rule.working[self.current_frame].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ManagedAgentState::*;

    fn glyph() -> Glyph {
        let rule = facade_rules::find("claude").unwrap().unwrap();
        Glyph::new(rule.status_glyph.as_ref())
    }

    #[test]
    fn only_reported_states_show_a_glyph() {
        for state in [Starting, Idle, JustDone, WaitingForYou, Error] {
            assert_eq!(glyph().update(&state, false), None);
            assert_eq!(glyph().update(&state, true), Some(Some("✳".into())));
        }
        for state in [Ended, Unknown] {
            let mut glyph = glyph();
            assert_eq!(glyph.update(&state, true), None);
            assert_eq!(glyph.update(&Idle, true), Some(Some("✳".into())));
            assert_eq!(glyph.update(&state, true), Some(None));
        }
        let mut glyph = glyph();
        assert_eq!(glyph.update(&Working, false), None);
        assert_eq!(glyph.update(&Working, true), Some(Some("◐".into())));
        assert_eq!(glyph.update(&Working, false), Some(None));
        assert_eq!(Glyph::new(None).update(&Working, true), None);
    }

    #[test]
    fn working_continues_with_the_last_glyph_frame() {
        let mut glyph = glyph();
        assert_eq!(glyph.frame_interval(), None);
        assert_eq!(glyph.update(&Working, true), Some(Some("◐".into())));
        assert_eq!(glyph.update(&Working, true), None);
        assert_eq!(glyph.frame_interval(), Some(Duration::from_millis(960)));
        assert_eq!(glyph.advance().as_deref(), Some("◑"));
        assert_eq!(glyph.update(&Idle, true), Some(Some("✳".into())));
        assert_eq!(glyph.frame_interval(), None);
        assert_eq!(glyph.update(&Working, true), Some(Some("◑".into())));
        assert_eq!(glyph.advance().as_deref(), Some("◐"));
    }
}
