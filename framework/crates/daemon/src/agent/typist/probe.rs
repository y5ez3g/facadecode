//! A probe of an input whose first row may be a hint or a draft: a space typed where the input
//! starts, the input read once drawn still, then Backspace and the input read again. The typist
//! runs it and types nothing else meanwhile.

use std::time::Duration;

use facade_base::model::terminal::InputState;
use facade_rules::{
    BoxReading, InputLine, LineCell, ProbeVerdict, restored, shape_of, space_taken, verdict_of,
};
use tokio::time::Instant;

/// How often a probe reads the input while it waits for it to be drawn still.
pub(super) const PROBE_READ: Duration = Duration::from_millis(100);
/// How long a probe waits for the input to be drawn still after each key.
const PROBE_STILL: Duration = Duration::from_secs(2);

/// The key a probe pressed last.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pressed {
    Space,
    Backspace,
}

/// A probe under way.
pub(super) struct Probe {
    before: InputLine,
    /// The person's writes when the probe read the input: Backspace goes only while they are this.
    typed: u64,
    pressed: Pressed,
    /// The last reading and when it was taken.
    last: Option<(Instant, BoxReading)>,
    verdict: ProbeVerdict,
}

/// What a probe does next.
pub(super) enum Next {
    /// Reads the input again then.
    Wait(Instant),
    /// Presses Backspace.
    Backspace,
    /// It found what the row was, and presses nothing more.
    Done(ProbeVerdict),
}

impl Probe {
    /// A probe of `line`, whose space is written now; `typed` counts the person's writes so far.
    pub(super) fn new(line: InputLine, typed: u64) -> Probe {
        Probe {
            before: line,
            typed,
            pressed: Pressed::Space,
            last: None,
            verdict: ProbeVerdict::Other,
        }
    }

    /// The row it probes.
    pub(super) fn row(&self) -> &[LineCell] {
        &self.before.cells
    }

    /// One step at `now`. The input is read every [`PROBE_READ`] after the key reached the terminal
    /// at `written_at`. Two agreeing readings settle the redraw. The frame before the key can stay
    /// on screen until its echo, so that frame keeps the probe waiting up to [`PROBE_STILL`].
    pub(super) fn next(
        &mut self,
        agent: &str,
        now: Instant,
        written_at: Instant,
        typed: u64,
        read_screen: &dyn Fn() -> BoxReading,
    ) -> Next {
        let deadline = written_at + PROBE_STILL;
        let after_space = self.pressed == Pressed::Space;
        let wake_at = |at: Instant| {
            if after_space { at.min(deadline) } else { at }
        };
        let due = self.last.as_ref().map_or(written_at, |(at, _)| *at) + PROBE_READ;
        let wake = wake_at(due);
        if now < wake {
            return Next::Wait(wake);
        }
        let reading = read_screen();
        // Still readings need a full read interval and a visible row. A synchronized update can
        // hide the row until the whole frame is drawn.
        let still = now >= due
            && reading.line.is_some()
            && self.last.as_ref().is_some_and(|(_, last)| {
                last.info.state == reading.info.state && last.line == reading.line
            });
        let waiting_for_echo = typed == self.typed
            && reading.info.state != InputState::Interaction
            && match self.pressed {
                Pressed::Space => reading.line.as_ref() == Some(&self.before),
                Pressed::Backspace => space_taken(&self.before, &reading),
            };
        if (!still || waiting_for_echo) && now < deadline {
            self.last = Some((now, reading));
            return Next::Wait(wake_at(now + PROBE_READ));
        }
        let before = shape_of(Some(&self.before));
        let after = shape_of(reading.line.as_ref());
        match self.pressed {
            Pressed::Space => {
                if typed != self.typed {
                    log(
                        agent,
                        &format!(
                            "a probe pressed no Backspace: the person typed after its space; before {before}; after {after}"
                        ),
                    );
                    return Next::Done(ProbeVerdict::Other);
                }
                if reading.info.state == InputState::Interaction
                    || !space_taken(&self.before, &reading)
                {
                    log(
                        agent,
                        &format!(
                            "a probe pressed no Backspace: its space did not show where the input starts, or a menu or question showed; before {before}; after {after}"
                        ),
                    );
                    return Next::Done(ProbeVerdict::Other);
                }
                self.verdict = if still {
                    verdict_of(&self.before, &reading)
                } else {
                    ProbeVerdict::Other
                };
                self.pressed = Pressed::Backspace;
                self.last = None;
                Next::Backspace
            }
            Pressed::Backspace => {
                if !still || !restored(self.verdict, &self.before, &reading) {
                    log(
                        agent,
                        &format!(
                            "a probe pressed nothing more: its Backspace did not put the input back as it was; before {before}; after {after}"
                        ),
                    );
                    return Next::Done(ProbeVerdict::Other);
                }
                let what = match self.verdict {
                    ProbeVerdict::Hint => "a hint",
                    ProbeVerdict::Draft => "a draft",
                    ProbeVerdict::Other => "neither a hint nor a draft for sure",
                };
                log(
                    agent,
                    &format!("a probe found the input's row {what}: {before}"),
                );
                Next::Done(self.verdict)
            }
        }
    }
}

fn log(agent: &str, message: &str) {
    facade_base::log::write("daemon", "info", &format!("#{agent}: {message}"));
}
