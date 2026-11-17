//! A probe of an input whose first row may be a hint or a draft: a space typed where the input
//! starts, the input read once drawn still, then Backspace and the input read again. The typist
//! runs it and types nothing else meanwhile.

use std::time::Duration;

use facade_base::daemon::InputState;
use facade_rules::{
    BoxReading, InputLine, LineCell, ProbeVerdict, restored, shape_of, space_taken, verdict_of,
};
use tokio::time::Instant;

/// How often a probe reads the input while it waits for it to be drawn still.
pub(super) const PROBE_READ: Duration = Duration::from_millis(100);
/// How long a probe waits for the input to be drawn still after each key.
const PROBE_STILL: Duration = Duration::from_secs(1);

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
    /// When its last key was written.
    since: Instant,
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
    pub(super) fn new(line: InputLine, now: Instant, typed: u64) -> Probe {
        Probe {
            before: line,
            typed,
            pressed: Pressed::Space,
            since: now,
            last: None,
            verdict: ProbeVerdict::Other,
        }
    }

    /// The row it probes.
    pub(super) fn row(&self) -> &[LineCell] {
        &self.before.cells
    }

    /// One step at `now`. The input is read every [`PROBE_READ`] until two readings in a row show
    /// the same row and cursor, for at most [`PROBE_STILL`]: a draft read half drawn after the
    /// space could pass for a hint, so a verdict waits for the input to be still.
    pub(super) fn next(
        &mut self,
        agent: &str,
        now: Instant,
        typed: u64,
        read_screen: &dyn Fn() -> BoxReading,
    ) -> Next {
        let due = self.last.as_ref().map_or(self.since, |(at, _)| *at) + PROBE_READ;
        if now < due {
            return Next::Wait(due);
        }
        let reading = read_screen();
        // A reading with no row, as one taken inside a synchronized update, is never still: the
        // probe waits for the whole frame.
        let still = reading.line.is_some()
            && self.last.as_ref().is_some_and(|(_, last)| {
                last.info.state == reading.info.state && last.line == reading.line
            });
        if !still && now < self.since + PROBE_STILL {
            self.last = Some((now, reading));
            return Next::Wait(now + PROBE_READ);
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
                self.since = now;
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
