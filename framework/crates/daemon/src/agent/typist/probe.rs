//! A probe of an input whose first row may be a hint or a draft: a space typed where the input
//! starts, the input read once drawn still, then Backspace and the input read again.

use std::time::Duration;

use facade_base::model::terminal::InputState;
use facade_rules::{
    BoxReading, InputLine, LineCell, ProbeVerdict, restored, shape_of, space_taken, verdict_of,
};
use tokio::time::Instant;

/// How often a probe reads the input while it waits for it to be drawn still.
pub(super) const PROBE_READ: Duration = Duration::from_millis(100);
/// How long to establish a verdict for an echo after its key reached the terminal.
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
    pressed: Pressed,
    /// When its last key was written.
    since: Instant,
    /// The space echo deadline.
    echo_deadline: Instant,
    /// A complete input frame already showed the space, even if an offered erase was revoked.
    space_seen: bool,
    /// The last reading and when it was taken.
    last: Option<(Instant, BoxReading)>,
    /// A complete frame that drew its input after this key's write boundary.
    frame: Option<BoxReading>,
    verdict: ProbeVerdict,
}

/// What a probe does next.
pub(super) enum Next {
    /// Reads the input again then, or when another frame arrives.
    Wait(Instant),
    /// Presses Backspace.
    Backspace,
    /// It found what the row was, and presses nothing more.
    Done(ProbeVerdict),
}

impl Probe {
    /// A probe of `line`, whose space is queued now.
    pub(super) fn new(line: InputLine, now: Instant) -> Probe {
        Probe {
            before: line,
            pressed: Pressed::Space,
            since: now,
            echo_deadline: now + PROBE_STILL,
            space_seen: false,
            last: None,
            frame: None,
            verdict: ProbeVerdict::Other,
        }
    }

    /// The row it probes.
    pub(super) fn row(&self) -> &[LineCell] {
        &self.before.cells
    }

    #[cfg(test)]
    pub(super) fn echo_deadline(&self) -> Instant {
        self.echo_deadline
    }

    /// Begins the echo budget when the terminal takes the key.
    pub(super) fn wrote_key(&mut self, now: Instant) {
        if self.pressed == Pressed::Space {
            self.echo_deadline = now + PROBE_STILL;
        }
        self.since = now;
    }

    pub(super) fn saw_frame(&mut self, reading: BoxReading, startup_redraw: bool) {
        // The first redraw after Space can put the unchanged startup composer on another row.
        // Use that position only when a complete redraw shows the whole original line before
        // the echo. The echo itself still has to prove that Space was taken there.
        if startup_redraw
            && self.pressed == Pressed::Space
            && !self.space_seen
            && self.frame.is_none()
            && reading.unsure
            && let Some(line) = &reading.line
            && line.row != self.before.row
            && self.before.cursor.1 == self.before.row
        {
            let mut shifted = self.before.clone();
            shifted.row = line.row;
            shifted.cursor.1 = line.row;
            if &shifted == line {
                self.before = shifted;
            }
        }
        self.frame = Some(reading);
    }

    pub(super) fn erasing(&self) -> bool {
        self.pressed == Pressed::Backspace
    }

    /// The space still belongs at the input that prompted the probe.
    pub(super) fn can_write_space(&self, reading: &BoxReading) -> bool {
        reading.unsure && reading.line.as_ref() == Some(&self.before)
    }

    /// Rechecks a pending erase with the complete current frame. If it cannot go now,
    /// resume watching for our space at the original echo deadline.
    pub(super) fn recheck_erase(&mut self, reading: Option<&BoxReading>) -> bool {
        let allowed = reading.is_some_and(|reading| space_taken(&self.before, reading));
        if allowed {
            self.frame = None;
        } else {
            self.pressed = Pressed::Space;
            self.last = None;
        }
        allowed
    }

    /// A verdict needs two matching complete readings. Backspace needs a current reading that
    /// shows the space at its original position. An unconfirmed key ends the probe at its deadline.
    pub(super) fn next(
        &mut self,
        agent: &str,
        now: Instant,
        read_screen: &dyn Fn() -> BoxReading,
    ) -> Next {
        let deadline = match self.pressed {
            Pressed::Space => self.echo_deadline,
            Pressed::Backspace => self.since + PROBE_STILL,
        };
        let due = self.last.as_ref().map_or(self.since, |(at, _)| *at) + PROBE_READ;
        if now < due.min(deadline) {
            return Next::Wait(due.min(deadline));
        }
        let reading = read_screen();
        let ordinary = reading.info.state != InputState::Interaction
            && !reading.is_unread()
            && self.frame.as_ref().is_some_and(|frame| {
                frame.info.state == reading.info.state && frame.line == reading.line
            });
        let still = now >= due
            && self.last.as_ref().is_some_and(|(_, last)| {
                last.info.state == reading.info.state && last.line == reading.line
            });
        let ready = ordinary && (still || now >= deadline);
        let shows_space = space_taken(&self.before, &reading);
        if self.pressed == Pressed::Space && ready && shows_space {
            self.verdict = if still {
                verdict_of(&self.before, &reading)
            } else {
                ProbeVerdict::Other
            };
            self.space_seen = true;
            self.pressed = Pressed::Backspace;
            self.since = now;
            self.last = None;
            self.frame = None;
            return Next::Backspace;
        }
        let empty_after_space =
            ordinary && self.space_seen && !shows_space && reading.info.state == InputState::Usable;
        let put_back = self.pressed == Pressed::Backspace
            && ready
            && !shows_space
            && restored(self.verdict, &self.before, &reading);
        if (empty_after_space && still) || (!empty_after_space && put_back) {
            let verdict = if put_back && still {
                self.verdict
            } else {
                ProbeVerdict::Other
            };
            let what = match verdict {
                ProbeVerdict::Hint => "a hint",
                ProbeVerdict::Draft => "a draft",
                ProbeVerdict::Other => "neither a hint nor a draft for sure",
            };
            let before = shape_of(Some(&self.before));
            log(
                agent,
                "info",
                &format!("a probe found the input's row {what}: {before}"),
            );
            return Next::Done(verdict);
        }
        if now >= deadline {
            let pending = match self.pressed {
                Pressed::Space => "the probe space did not show at its input position",
                Pressed::Backspace => "the probe backspace did not visibly restore the input",
            };
            let before = shape_of(Some(&self.before));
            let after = shape_of(reading.line.as_ref());
            log(
                agent,
                "info",
                &format!("{pending}; before {before}; after {after}"),
            );
            return Next::Done(ProbeVerdict::Other);
        }
        if empty_after_space && now < due && self.last.is_some() {
            return Next::Wait(due.min(deadline));
        }
        if ordinary {
            self.last = Some((now, reading));
        }
        Next::Wait((now + PROBE_READ).min(deadline))
    }
}

fn log(agent: &str, level: &str, message: &str) {
    facade_base::log::write("daemon", level, &format!("#{agent}: {message}"));
}
