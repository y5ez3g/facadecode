//! Combines run facts and CLI evidence into the state shown to clients, and saves the facts
//! that cannot be reconstructed from a screen after daemon recovery.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use facade_base::daemon::{
    AgentState, HowEnded, Said, StateDetail, StateReason, ToolsReason, ToolsState, WaitKind,
    display_line, display_name,
};
use facade_base::process::ProcessExit;
use facade_rules::{Rule, ScreenState, StateRule};
use facade_screen::{BlockKind, ReportedState, Screen, StatusEvent, StatusReport};
use serde::{Deserialize, Serialize};
use tokio::{sync::watch, time::Instant};

use super::{START_TIMEOUT, Submission};
use crate::ToolsGiven;

const WORK_HOLD: Duration = Duration::from_secs(1);
const SAID_CHARS: usize = 1024;
const WORDS_CHARS: usize = 2048;

/// Facts saved alongside a screen; the JSON names are part of recovery's file format.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Kept {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reported: Option<EvidenceState>,
    #[serde(default)]
    reports: bool,
    #[serde(default)]
    shown: bool,
    #[serde(default)]
    just_done: bool,
    #[serde(default)]
    counts_turns: bool,
    /// Whether Facade stopped the run.
    #[serde(default)]
    pub(crate) stopped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    said: Option<Said>,
    /// Installation version used to select screen evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(default)]
    tools: ToolsGiven,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    tools_not_started: bool,
}

impl Kept {
    /// Initial facts for a run, before its CLI has drawn or reported anything.
    pub(crate) fn new_run(version: Option<String>, tools: ToolsGiven) -> Kept {
        Self {
            tools,
            version,
            ..Default::default()
        }
    }
}

/// Whether a terminal shows the agent now.
pub(crate) enum Viewing {
    /// At least one terminal shows it.
    Watched,
    /// No terminal shows it.
    Unwatched,
}

/// State and tool availability, with the next deadline that can change them.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct StateReading {
    /// The single winning state.
    pub(crate) state: AgentState,
    /// Evidence or reason accompanying that state.
    pub(crate) detail: Option<StateDetail>,
    /// Whether the CLI can use Facade's tools.
    pub(crate) tools: ToolsState,
    /// Why tools are unavailable.
    pub(crate) tools_reason: Option<ToolsReason>,
    /// When the actor must read again without new output.
    pub(crate) wake: Option<Instant>,
}

/// Evidence, run lifecycle, turn progress and tool connection for one agent.
pub(crate) struct StateTracker {
    rule: Option<&'static Rule>,
    evidence: Evidence,
    progress: TurnProgress,
    question: Question,
    connection: Connection,
    started: Instant,
    tools_since: Instant,
    end: Option<Option<HowEnded>>,
    saved: Kept,
}

impl StateTracker {
    /// Reads the current state without publishing it; blockers and errors take priority at once.
    pub(crate) fn read(&mut self, now: Instant, viewing: Viewing) -> StateReading {
        let (tools, tools_reason) = self.tool_reading(now);
        let mut reading = StateReading {
            state: AgentState::Ended,
            detail: None,
            tools,
            tools_reason,
            wake: None,
        };
        if let Some(how) = self.end {
            reading.detail = how.map(|how| StateDetail {
                how: Some(how),
                ..Default::default()
            });
            return reading;
        }

        let current = self.evidence.current();
        let held_until = self
            .progress
            .advance(Turn::from(current), now, viewing, &mut self.saved);
        let start_deadline = self.question.deadline(self.started);
        let starting =
            now < start_deadline && (!self.evidence.shown || tools == ToolsState::Connecting);
        reading.wake = [
            held_until,
            starting.then_some(start_deadline),
            (tools == ToolsState::Connecting && !self.question.open)
                .then(|| self.question.deadline(self.tools_since)),
        ]
        .into_iter()
        .flatten()
        .min();

        let result = if let Some((state, detail)) = urgent(current) {
            (state, detail)
        } else if self.question.open {
            (
                AgentState::WaitingForYou,
                Some(StateDetail {
                    kind: Some(WaitKind::Unknown),
                    ..Default::default()
                }),
            )
        } else if tools == ToolsState::Unavailable {
            reasoned(AgentState::Error, StateReason::ToolsUnavailable)
        } else if self.saved.just_done {
            (AgentState::JustDone, None)
        } else if held_until.is_some() || matches!(current, Some(EvidenceState::Working)) {
            (AgentState::Working, None)
        } else if starting {
            (AgentState::Starting, None)
        } else if matches!(current, Some(EvidenceState::Idle | EvidenceState::Done)) {
            (AgentState::Idle, None)
        } else if self.rule.is_some() && !self.evidence.shown {
            reasoned(AgentState::Error, StateReason::NotReady)
        } else {
            let reason = match current {
                None => StateReason::NotShown,
                Some(EvidenceState::Asked) => StateReason::Asked,
                Some(EvidenceState::Unrecognized) => StateReason::Unrecognized,
                Some(_) => StateReason::TakenBack,
            };
            reasoned(AgentState::Unknown, reason)
        };
        (reading.state, reading.detail) = result;
        reading
    }

    /// Reconstructs a run from saved facts and, if available, its recovered screen and exit.
    pub(crate) fn new(
        rule: Option<&'static Rule>,
        started: Instant,
        kept: Kept,
        exit: Option<&ProcessExit>,
        screen: Option<&Screen>,
    ) -> StateTracker {
        let evidence = Evidence::new(rule, &kept);
        let mut value = Self {
            evidence,
            saved: kept,
            rule,
            progress: TurnProgress::default(),
            question: Question::default(),
            connection: Connection::Pending,
            started,
            tools_since: started,
            end: None,
        };
        if let Some(screen) = screen {
            value.observe(screen);
        }
        value.progress.previous = Turn::from(value.evidence.current());
        if let Some(exit) = exit {
            value.ended(exit, value.saved.stopped);
        }
        value
    }

    /// Begins another run while retaining the last line submitted to this agent.
    pub(crate) fn restarted(
        &mut self,
        started: Instant,
        version: Option<String>,
        tools: ToolsGiven,
    ) {
        let mut facts = Kept::new_run(version, tools);
        facts.said = self.saved.said.take();
        *self = Self::new(self.rule, started, facts, None, None);
    }

    /// Records an exit and whether Facade requested the stop.
    pub(crate) fn ended(&mut self, exit: &ProcessExit, stopped: bool) {
        self.saved.stopped = stopped;
        let how = if stopped {
            Some(HowEnded::Stopped)
        } else if exit.code == Some(0) {
            Some(HowEnded::Normal)
        } else if exit.code.is_some() || exit.signal.is_some() {
            Some(HowEnded::Crashed)
        } else {
            None
        };
        self.end = Some(how);
    }

    /// Captures the recoverable facts, excluding screen readings and corrections.
    pub(crate) fn kept(&self) -> Kept {
        let mut facts = self.saved.clone();
        facts.reported = matches!(self.evidence.source, Source::Reports)
            .then(|| self.evidence.base.clone())
            .flatten();
        facts.reports = matches!(self.evidence.source, Source::Reports);
        facts.shown = self.evidence.shown;
        facts
    }

    /// Accepts ordered state events parsed from CLI output.
    pub(crate) fn take(&mut self, events: Vec<StatusEvent>) {
        events
            .into_iter()
            .for_each(|event| self.evidence.event(event));
    }

    /// Whether the selected evidence calls for a screen reading now.
    pub(crate) fn reads_screen(&self) -> bool {
        self.evidence.reads_screen()
    }

    /// Reads a completed frame using the CLI's rule; synchronized drawing is left alone.
    pub(crate) fn observe(&mut self, screen: &Screen) {
        if !self.reads_screen() || screen.synchronized_update_deadline().is_some() {
            return;
        }
        if let Some(rule) = self.rule {
            self.evidence
                .observe(facade_rules::read_state(rule, &screen.view()));
        }
    }

    /// Whether the latest evidence shows work in progress.
    pub(crate) fn works(&self) -> bool {
        matches!(self.evidence.current(), Some(EvidenceState::Working))
    }

    /// Clears the completion that a person has now seen.
    pub(crate) fn seen(&mut self) {
        self.saved.just_done = false;
    }

    /// Records submitted text and enables turn completion tracking, including for empty text.
    pub(crate) fn said(&mut self, submission: Submission) {
        let text = display_line(&submission.text, SAID_CHARS);
        if !text.is_empty() {
            self.saved.said = Some(Said {
                at: facade_base::time::iso_now(),
                text,
                from: submission.sender.from,
                from_name: submission.sender.from_name.as_deref().map(display_name),
            });
        }
        self.saved.counts_turns = true;
    }

    /// Counts Enter as requesting work unless it answers the CLI's own question.
    pub(crate) fn asked(&mut self) {
        self.saved.counts_turns |= !self.question.open;
    }

    /// The last visible submitted line and its sender.
    pub(crate) fn said_line(&self) -> Option<&Said> {
        self.saved.said.as_ref()
    }

    /// Updates whether the input box is occupied by a CLI question.
    pub(crate) fn asks(&mut self, asking: bool, now: Instant) {
        if self.question.open && !asking {
            self.question.answered = Some(now);
        }
        self.question.open = asking;
    }

    /// Startup deadline, suspended until the CLI's current question is answered.
    pub(crate) fn start_bound(&self) -> Option<Instant> {
        (!self.question.open).then(|| self.question.deadline(self.started))
    }

    /// Restarts the tool connection allowance after daemon recovery.
    pub(crate) fn recovered(&mut self, now: Instant) {
        self.tools_since = now;
    }

    /// The current run's process start time.
    pub(crate) fn started(&self) -> Instant {
        self.started
    }

    /// How this run received Facade's tools.
    pub(crate) fn tools_given(&self) -> ToolsGiven {
        self.saved.tools
    }

    /// Records that readiness could not start the CLI's tool server.
    pub(crate) fn tools_not_started(&mut self) {
        self.saved.tools_not_started = true;
    }

    /// Updates the last tool connection while retaining evidence of a lost connection.
    pub(crate) fn tools_connection(&mut self, open: bool) {
        self.connection = match (open, self.connection) {
            (true, _) => Connection::Open,
            (false, Connection::Pending) => Connection::Pending,
            (false, _) => Connection::Lost,
        };
    }

    fn tool_reading(&self, now: Instant) -> (ToolsState, Option<ToolsReason>) {
        if self.saved.tools == ToolsGiven::NotInjected {
            return (ToolsState::NotInjected, None);
        }
        let unavailable = if self.end.is_some() {
            Some(ToolsReason::Ended)
        } else if self.saved.tools == ToolsGiven::NotGiven {
            Some(ToolsReason::NotGiven)
        } else {
            match self.connection {
                Connection::Open => return (ToolsState::Available, None),
                Connection::Lost => Some(ToolsReason::Disconnected),
                Connection::Pending if self.question.open => None,
                Connection::Pending if self.saved.tools_not_started => {
                    Some(ToolsReason::NotStarted)
                }
                Connection::Pending if now >= self.question.deadline(self.tools_since) => {
                    Some(ToolsReason::NotConnected)
                }
                Connection::Pending => None,
            }
        };
        match unavailable {
            None => (ToolsState::Connecting, None),
            reason => (ToolsState::Unavailable, reason),
        }
    }
}

fn reasoned(state: AgentState, reason: StateReason) -> (AgentState, Option<StateDetail>) {
    (
        state,
        Some(StateDetail {
            reason: Some(reason),
            ..Default::default()
        }),
    )
}

fn urgent(evidence: Option<&EvidenceState>) -> Option<(AgentState, Option<StateDetail>)> {
    match evidence? {
        EvidenceState::Blocked { kind, text } => Some((
            AgentState::WaitingForYou,
            Some(StateDetail {
                text: text.clone(),
                kind: Some(kind.unwrap_or(WaitKind::Unknown)),
                ..Default::default()
            }),
        )),
        EvidenceState::Error { text } => Some((
            AgentState::Error,
            text.as_ref().map(|words| StateDetail {
                text: Some(words.clone()),
                ..Default::default()
            }),
        )),
        _ => None,
    }
}

#[derive(Default)]
struct Question {
    open: bool,
    answered: Option<Instant>,
}
impl Question {
    fn deadline(&self, since: Instant) -> Instant {
        self.answered.unwrap_or(since).max(since) + START_TIMEOUT
    }
}

#[derive(Clone, Copy)]
enum Connection {
    Pending,
    Open,
    Lost,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Turn {
    Working,
    Blocked,
    Idle,
    Done,
    Error,
    #[default]
    Unknown,
}
impl From<Option<&EvidenceState>> for Turn {
    fn from(value: Option<&EvidenceState>) -> Self {
        match value {
            Some(EvidenceState::Working) => Self::Working,
            Some(EvidenceState::Blocked { .. }) => Self::Blocked,
            Some(EvidenceState::Idle) => Self::Idle,
            Some(EvidenceState::Done) => Self::Done,
            Some(EvidenceState::Error { .. }) => Self::Error,
            _ => Self::Unknown,
        }
    }
}

#[derive(Default)]
struct TurnProgress {
    previous: Turn,
    rest_since: Option<Instant>,
}
impl TurnProgress {
    fn advance(
        &mut self,
        next: Turn,
        now: Instant,
        viewing: Viewing,
        facts: &mut Kept,
    ) -> Option<Instant> {
        let rests = matches!(next, Turn::Idle | Turn::Done | Turn::Blocked | Turn::Error);
        if self.previous == Turn::Working && rests {
            let deadline = *self.rest_since.get_or_insert(now) + WORK_HOLD;
            if now < deadline {
                return Some(deadline);
            }
        }
        self.rest_since = None;
        let completes = matches!(next, Turn::Idle | Turn::Done)
            && (matches!(self.previous, Turn::Working | Turn::Blocked) || next == Turn::Done);
        if next != self.previous
            && completes
            && facts.counts_turns
            && matches!(viewing, Viewing::Unwatched)
        {
            facts.just_done = true;
        }
        self.previous = next;
        None
    }
}

// These variant and field names are also used in the saved state JSON.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum EvidenceState {
    Idle,
    Working,
    Done,
    Blocked {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<WaitKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Asked,
    TakenBack,
    Unrecognized,
}
impl EvidenceState {
    fn active(&self) -> bool {
        matches!(
            self,
            Self::Idle | Self::Working | Self::Done | Self::Blocked { .. } | Self::Error { .. }
        )
    }
}

#[derive(Clone, Copy)]
enum Source {
    Unreported,
    Screen,
    Reports,
}

struct Evidence {
    rule: Option<&'static StateRule>,
    source: Source,
    base: Option<EvidenceState>,
    correction: Option<EvidenceState>,
    shown: bool,
}
impl Evidence {
    fn new(rule: Option<&'static Rule>, facts: &Kept) -> Self {
        Self {
            rule: rule
                .and_then(|r| r.status.as_ref())
                .filter(|r| r.applies_to(facts.version.as_deref())),
            source: if facts.reports {
                Source::Reports
            } else {
                Source::Unreported
            },
            base: facts.reported.clone(),
            correction: None,
            shown: facts.shown,
        }
    }

    fn current(&self) -> Option<&EvidenceState> {
        self.correction.as_ref().or(self.base.as_ref())
    }

    fn replace(&mut self, next: EvidenceState) {
        self.shown |= next.active();
        if self.base.as_ref() != Some(&next) {
            self.correction = None;
            self.base = Some(next);
        }
    }

    fn revoke(&mut self) {
        if self.base.as_ref().is_some_and(EvidenceState::active) {
            let next = match self.source {
                Source::Screen => EvidenceState::Unrecognized,
                _ => EvidenceState::TakenBack,
            };
            self.replace(next);
        }
    }

    fn reads_screen(&self) -> bool {
        match self.rule {
            Some(StateRule::FrameTranscript(_)) => !matches!(self.source, Source::Reports),
            Some(StateRule::BackgroundCorrection(_)) => {
                matches!(self.base, Some(EvidenceState::Working))
            }
            Some(StateRule::TurnError(_)) => {
                matches!(self.base, Some(EvidenceState::Idle | EvidenceState::Done))
            }
            None => false,
        }
    }

    fn observe(&mut self, frame: Option<ScreenState>) {
        if !self.reads_screen() {
            return;
        }
        match self.rule {
            Some(StateRule::BackgroundCorrection(_)) => {
                self.correction = (frame == Some(ScreenState::Idle)).then_some(EvidenceState::Idle);
            }
            Some(StateRule::TurnError(_)) => {
                self.correction = match frame {
                    Some(ScreenState::Error(words)) => {
                        Some(EvidenceState::Error { text: Some(words) })
                    }
                    _ => None,
                };
            }
            _ => {
                let next = match frame {
                    Some(ScreenState::Idle) => EvidenceState::Idle,
                    Some(ScreenState::Working) => EvidenceState::Working,
                    Some(ScreenState::Blocked(kind)) => EvidenceState::Blocked {
                        kind: Some(wait_kind(kind)),
                        text: None,
                    },
                    Some(ScreenState::Error(words)) => EvidenceState::Error { text: Some(words) },
                    None if self.base.is_some() => EvidenceState::Unrecognized,
                    None => return,
                };
                self.source = Source::Screen;
                self.replace(next);
            }
        }
    }

    fn event(&mut self, event: StatusEvent) {
        match event {
            StatusEvent::Report(report) => {
                self.source = Source::Reports;
                match reported(report) {
                    Some(next) => self.replace(next),
                    None => self.revoke(),
                }
            }
            StatusEvent::Asked => {
                let needs_report = self.base.is_none() || matches!(self.source, Source::Screen);
                self.source = Source::Reports;
                if needs_report {
                    self.replace(EvidenceState::Asked);
                }
            }
            StatusEvent::ShellPrompt
                if !matches!(
                    self.base,
                    Some(EvidenceState::Working | EvidenceState::Blocked { .. })
                ) => {}
            StatusEvent::ShellPrompt | StatusEvent::Reset => self.revoke(),
        }
    }
}

fn reported(report: StatusReport) -> Option<EvidenceState> {
    let words = || {
        report
            .text
            .as_deref()
            .map(|words| display_line(words, WORDS_CHARS))
            .filter(|line| !line.is_empty())
    };
    match report.state? {
        ReportedState::Idle => Some(EvidenceState::Idle),
        ReportedState::Working => Some(EvidenceState::Working),
        ReportedState::Done => Some(EvidenceState::Done),
        ReportedState::Error => Some(EvidenceState::Error { text: words() }),
        ReportedState::Blocked => Some(EvidenceState::Blocked {
            text: words(),
            kind: report.kind.map(wait_kind),
        }),
    }
}

fn wait_kind(kind: BlockKind) -> WaitKind {
    match kind {
        BlockKind::Auth => WaitKind::Auth,
        BlockKind::Question => WaitKind::Question,
        BlockKind::Permission => WaitKind::Permission,
    }
}

/// Returns the facts file within an agent's screen folder.
pub(crate) fn state_file(screen: &Path) -> PathBuf {
    screen.join("state")
}

/// Loads saved facts, logging unreadable contents and returning empty facts on failure.
pub(crate) fn read_kept(file: &Path) -> Kept {
    let loaded = std::fs::read(file)
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(io::Error::other));
    match loaded {
        Ok(facts) => facts,
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "{} cannot be read, so the agent's state starts anew: {error}",
                        file.display()
                    ),
                );
            }
            Kept::default()
        }
    }
}

fn write_facts(path: &Path, facts: &Kept) -> io::Result<()> {
    let bytes = serde_json::to_vec(facts).expect("the state facts serialize");
    let temporary = path.with_extension("tmp");
    facade_base::files::create_private_file(&temporary)?.write_all(&bytes)?;
    std::fs::rename(temporary, path)
}

/// Writes initial facts and subsequent changes serially, until the watch channel closes.
/// Blocking file work runs on the blocking pool; consecutive write failures are logged once.
pub(crate) async fn keep(file: PathBuf, mut changes: watch::Receiver<Kept>) {
    changes.mark_changed();
    let mut failing = false;
    while changes.changed().await.is_ok() {
        let facts = changes.borrow_and_update().clone();
        let destination = file.clone();
        let result = tokio::task::spawn_blocking(move || write_facts(&destination, &facts)).await;
        if let Ok(outcome) = result {
            match outcome {
                Ok(()) => failing = false,
                Err(error) => {
                    if !failing {
                        facade_base::log::write(
                            "daemon",
                            "warn",
                            &format!(
                                "could not keep the state in {}: {error}; a later change tries again",
                                file.display()
                            ),
                        );
                    }
                    failing = true;
                }
            }
        }
    }
}

/// Converts wall time to an instant, clamping future and unrepresentable times to now.
pub(crate) fn instant_of(at: SystemTime) -> Instant {
    let current = Instant::now();
    let age = SystemTime::now()
        .duration_since(at)
        .unwrap_or(Duration::ZERO);
    current.checked_sub(age).unwrap_or(current)
}

#[cfg(test)]
mod tests {
    use crate::{HUMAN, Sender};
    use facade_screen::Screen;

    use super::*;

    fn report(body: &str) -> StatusEvent {
        let mut screen = Screen::new(20, 2, 0);
        let mut events = screen
            .feed(format!("\x1b]7501;{body}\x07").as_bytes())
            .status;
        assert_eq!(events.len(), 1, "{body} is one event");
        events.remove(0)
    }

    /// A run of `rule`'s CLI that started at `started`. A tracker of `rule`'s CLI at the version
    /// its screen evidence was verified on, past its start-up: its working is a turn.
    fn tracker(rule: Option<&str>, started: Instant) -> StateTracker {
        tracker_at(rule, started, Some("0.166.0"))
    }

    fn tracker_at(rule: Option<&str>, started: Instant, version: Option<&str>) -> StateTracker {
        let kept = Kept {
            version: version.map(str::to_string),
            counts_turns: true,
            ..Kept::default()
        };
        StateTracker::new(
            rule.map(|name| facade_rules::find(name).unwrap().unwrap()),
            started,
            kept,
            None,
            None,
        )
    }

    fn state(tracker: &mut StateTracker, now: Instant) -> (AgentState, Option<StateDetail>) {
        let reading = tracker.read(now, Viewing::Unwatched);
        (reading.state, reading.detail)
    }

    fn detail(
        kind: Option<WaitKind>,
        text: Option<&str>,
        how: Option<HowEnded>,
        reason: Option<StateReason>,
    ) -> Option<StateDetail> {
        Some(StateDetail {
            kind,
            text: text.map(Into::into),
            how,
            reason,
        })
    }

    #[test]
    fn each_state_comes_before_the_ones_after_it() {
        let now = Instant::now();
        let mut agent = tracker(None, now);
        let not_given = (ToolsState::NotInjected, None);
        assert_eq!(
            agent.read(now, Viewing::Unwatched),
            StateReading {
                state: AgentState::Starting,
                detail: None,
                tools: not_given.0,
                tools_reason: not_given.1,
                wake: Some(now + START_TIMEOUT)
            }
        );
        agent.take(vec![report("state=working")]);
        assert_eq!(state(&mut agent, now), (AgentState::Working, None));
        agent.take(vec![report("state=idle")]);
        assert_eq!(state(&mut agent, now), (AgentState::Working, None));
        let later = now + WORK_HOLD;
        assert_eq!(
            state(&mut agent, later),
            (AgentState::JustDone, None),
            "a turn ended while no terminal showed the agent"
        );
        // "Allow edits?" and "No credit" in base64.
        agent.take(vec![report(
            "state=blocked:kind=permission:msg=QWxsb3cgZWRpdHM/",
        )]);
        assert_eq!(
            state(&mut agent, later),
            (
                AgentState::WaitingForYou,
                detail(Some(WaitKind::Permission), Some("Allow edits?"), None, None)
            )
        );
        agent.take(vec![report("state=blocked")]);
        assert_eq!(
            state(&mut agent, later),
            (
                AgentState::WaitingForYou,
                detail(Some(WaitKind::Unknown), None, None, None)
            ),
            "a blocker without a kind"
        );
        agent.take(vec![report("state=error:msg=Tm8gY3JlZGl0")]);
        assert_eq!(
            state(&mut agent, later),
            (
                AgentState::Error,
                detail(None, Some("No credit"), None, None)
            )
        );
        agent.take(vec![report("state=working")]);
        assert_eq!(
            state(&mut agent, later),
            (AgentState::JustDone, None),
            "just done comes before working"
        );
        agent.seen();
        assert_eq!(state(&mut agent, later), (AgentState::Working, None));
        agent.take(vec![report("state=done")]);
        assert_eq!(state(&mut agent, later), (AgentState::Working, None));
        assert_eq!(
            state(&mut agent, later + WORK_HOLD),
            (AgentState::JustDone, None)
        );
        agent.seen();
        assert_eq!(
            state(&mut agent, later + WORK_HOLD),
            (AgentState::Idle, None)
        );
        agent.ended(
            &ProcessExit {
                code: Some(0),
                signal: None,
                reason: None,
                at: "t".into(),
            },
            false,
        );
        assert_eq!(
            state(&mut agent, later),
            (
                AgentState::Ended,
                detail(None, None, Some(HowEnded::Normal), None)
            )
        );
    }

    #[test]
    fn work_that_stops_shows_a_second_later_and_a_blocker_at_once() {
        let now = Instant::now();
        let mut agent = tracker(None, now);
        agent.take(vec![report("state=working")]);
        state(&mut agent, now);
        agent.take(vec![report("state=idle")]);
        assert_eq!(
            agent.read(now, Viewing::Watched),
            StateReading {
                state: AgentState::Working,
                detail: None,
                tools: ToolsState::NotInjected,
                tools_reason: None,
                wake: Some(now + WORK_HOLD)
            }
        );
        agent.take(vec![report("state=working")]);
        assert_eq!(
            state(&mut agent, now + WORK_HOLD),
            (AgentState::Working, None),
            "work that goes on never stopped"
        );
        agent.take(vec![report("state=idle")]);
        let stop = now + WORK_HOLD * 2;
        assert_eq!(state(&mut agent, stop), (AgentState::Working, None));
        assert_eq!(
            agent.read(stop + WORK_HOLD, Viewing::Watched).state,
            AgentState::Idle,
            "the turn ended while a terminal showed the agent"
        );
        agent.take(vec![
            report("state=working"),
            report("state=blocked:kind=question"),
        ]);
        assert_eq!(
            state(&mut agent, stop + WORK_HOLD).0,
            AgentState::WaitingForYou
        );
        let later = stop + WORK_HOLD * 2;
        agent.take(vec![report("state=working")]);
        state(&mut agent, later);
        agent.take(vec![report("state=error")]);
        assert_eq!(
            state(&mut agent, later).0,
            AgentState::Error,
            "an error shows at once"
        );
        assert_eq!(state(&mut agent, later + WORK_HOLD).0, AgentState::Error);
        agent.take(vec![report("state=idle")]);
        assert_eq!(
            state(&mut agent, later + WORK_HOLD).0,
            AgentState::Idle,
            "a turn that ended in an error is not just done"
        );
    }

    #[test]
    fn unknown_says_why_nothing_shows_what_the_cli_does() {
        let now = Instant::now();
        let reason = |agent: &mut StateTracker| {
            state(agent, now + START_TIMEOUT)
                .1
                .and_then(|detail| detail.reason)
        };
        let mut agent = tracker(None, now);
        assert_eq!(reason(&mut agent), Some(StateReason::NotShown));
        agent.take(vec![StatusEvent::Asked]);
        assert_eq!(
            state(&mut agent, now).0,
            AgentState::Starting,
            "a CLI that asked to report is starting until it reports"
        );
        assert_eq!(reason(&mut agent), Some(StateReason::Asked));
        for taking_back in [
            report("state=clear"),
            StatusEvent::Reset,
            StatusEvent::ShellPrompt,
        ] {
            agent.take(vec![report("state=working"), taking_back]);
            assert_eq!(
                state(&mut agent, now).0,
                AgentState::Unknown,
                "work taken back is never idle, and never starting again"
            );
            assert_eq!(reason(&mut agent), Some(StateReason::TakenBack));
        }
        agent.take(vec![report("state=idle"), StatusEvent::ShellPrompt]);
        assert_eq!(
            state(&mut agent, now + START_TIMEOUT).0,
            AgentState::Idle,
            "a new shell prompt ends only work or a wait"
        );
        agent.take(vec![StatusEvent::Asked]);
        assert_eq!(
            state(&mut agent, now + START_TIMEOUT).0,
            AgentState::Idle,
            "asking again keeps what the CLI reported"
        );
        let mut muse = tracker(Some("muse"), now);
        muse.evidence.observe(None);
        assert_eq!(
            state(&mut muse, now).0,
            AgentState::Starting,
            "an unrecognized screen at the start says nothing"
        );
        muse.evidence.observe(Some(ScreenState::Idle));
        muse.evidence.observe(None);
        assert_eq!(reason(&mut muse), Some(StateReason::Unrecognized));
    }

    /// A run given Facade's tools starts until its CLI shows what it does and its server connects.
    /// Tools that do not connect within the start's bound, that its rule gives but Facade could
    /// not, or whose server's connection closes make it an error, though a CLI waiting for the
    /// person shows that first. A run not given them is as before.
    #[test]
    fn tools_given_to_a_run_must_connect_and_stay_connected() {
        let now = Instant::now();
        let given = |tools| {
            StateTracker::new(
                Some(facade_rules::find("fake").unwrap().unwrap()),
                now,
                Kept::new_run(None, tools),
                None,
                None,
            )
        };
        let tools = |agent: &mut StateTracker, at| {
            let reading = agent.read(at, Viewing::Unwatched);
            (reading.state, reading.tools, reading.tools_reason)
        };
        let unusable = Some(StateDetail {
            reason: Some(StateReason::ToolsUnavailable),
            ..StateDetail::default()
        });

        let mut agent = given(ToolsGiven::Injected);
        agent.take(vec![report("state=idle")]);
        assert_eq!(
            tools(&mut agent, now),
            (AgentState::Starting, ToolsState::Connecting, None),
            "shown, but its tools not there yet"
        );
        assert_eq!(
            agent.read(now, Viewing::Unwatched).wake,
            Some(now + START_TIMEOUT),
            "it looks again at the bound"
        );
        agent.tools_connection(true);
        assert_eq!(
            tools(&mut agent, now),
            (AgentState::Idle, ToolsState::Available, None)
        );
        agent.tools_connection(false);
        assert_eq!(
            tools(&mut agent, now),
            (
                AgentState::Error,
                ToolsState::Unavailable,
                Some(ToolsReason::Disconnected)
            )
        );
        assert_eq!(
            state(&mut agent, now),
            (AgentState::Error, unusable.clone())
        );
        agent.take(vec![report("state=blocked:kind=question")]);
        assert_eq!(
            state(&mut agent, now).0,
            AgentState::WaitingForYou,
            "a question goes first"
        );
        agent.take(vec![report("state=idle")]);
        agent.tools_connection(true);
        assert_eq!(
            tools(&mut agent, now),
            (AgentState::Idle, ToolsState::Available, None),
            "a server that connects again"
        );

        let mut silent = given(ToolsGiven::Injected);
        silent.take(vec![report("state=idle")]);
        assert_eq!(
            tools(&mut silent, now + START_TIMEOUT),
            (
                AgentState::Error,
                ToolsState::Unavailable,
                Some(ToolsReason::NotConnected)
            )
        );
        let mut not_given = given(ToolsGiven::NotGiven);
        not_given.take(vec![report("state=idle")]);
        assert_eq!(
            tools(&mut not_given, now),
            (
                AgentState::Error,
                ToolsState::Unavailable,
                Some(ToolsReason::NotGiven)
            )
        );
        let mut plain = given(ToolsGiven::NotInjected);
        plain.take(vec![report("state=idle")]);
        assert_eq!(
            tools(&mut plain, now),
            (AgentState::Idle, ToolsState::NotInjected, None)
        );

        // A daemon that recovers the run waits the start's bound from its recovery for the server
        // to connect to it.
        let later = now + START_TIMEOUT * 10;
        let mut recovered = given(ToolsGiven::Injected);
        recovered.take(vec![report("state=idle")]);
        recovered.recovered(later);
        assert_eq!(tools(&mut recovered, later).1, ToolsState::Connecting);
        assert_eq!(
            tools(&mut recovered, later + START_TIMEOUT).2,
            Some(ToolsReason::NotConnected)
        );
        recovered.ended(
            &ProcessExit {
                code: Some(0),
                signal: None,
                reason: None,
                at: "t".into(),
            },
            false,
        );
        assert_eq!(
            tools(&mut recovered, later),
            (
                AgentState::Ended,
                ToolsState::Unavailable,
                Some(ToolsReason::Ended)
            )
        );
        let mut restarted = given(ToolsGiven::NotGiven);
        restarted.restarted(later, None, ToolsGiven::Injected);
        assert_eq!(
            tools(&mut restarted, later).1,
            ToolsState::Connecting,
            "a resumed run is given its tools anew"
        );
    }

    #[test]
    fn a_cli_started_by_its_rule_that_shows_nothing_within_its_start_s_bound_is_an_error() {
        let now = Instant::now();
        let late = now + START_TIMEOUT;
        let not_started = Some(StateDetail {
            reason: Some(StateReason::NotReady),
            ..StateDetail::default()
        });
        let mut fake = tracker(Some("fake"), now);
        assert_eq!(state(&mut fake, now).0, AgentState::Starting);
        assert_eq!(
            state(&mut fake, late),
            (AgentState::Error, not_started.clone())
        );
        let mut asked = tracker(Some("fake"), now);
        asked.take(vec![StatusEvent::Asked]);
        assert_eq!(
            state(&mut asked, late),
            (AgentState::Error, not_started.clone()),
            "a CLI that asked and never reported"
        );
        let mut muse = tracker(Some("muse"), now);
        muse.evidence.observe(None);
        assert_eq!(
            state(&mut muse, late),
            (AgentState::Error, not_started),
            "Muse's screen unrecognized since its start"
        );
        assert_eq!(
            state(&mut tracker(None, now), late).0,
            AgentState::Unknown,
            "a program without a rule"
        );
        fake.take(vec![report("state=working"), report("state=clear")]);
        assert_eq!(
            state(&mut fake, late).0,
            AgentState::Unknown,
            "activity unknown later in a run is no error"
        );
    }

    #[test]
    fn muse_s_screen_stands_in_for_reports_until_it_sends_one() {
        let now = Instant::now();
        let mut muse = tracker(Some("muse"), now);
        assert!(muse.reads_screen());
        muse.evidence
            .observe(Some(ScreenState::Blocked(BlockKind::Auth)));
        assert_eq!(
            state(&mut muse, now),
            (
                AgentState::WaitingForYou,
                detail(Some(WaitKind::Auth), None, None, None)
            )
        );
        muse.take(vec![StatusEvent::Asked]);
        assert!(!muse.reads_screen());
        assert_eq!(
            state(&mut muse, now).0,
            AgentState::Unknown,
            "once it asks, it reports"
        );
        muse.evidence.observe(Some(ScreenState::Working));
        assert_eq!(
            state(&mut muse, now).0,
            AgentState::Unknown,
            "its screen no longer counts"
        );
    }

    /// Codex at a version its correction was not verified on keeps its own working report, and a
    /// resume decides again by the version then.
    #[test]
    fn codex_at_a_version_its_correction_was_not_verified_on_keeps_its_working_report() {
        let now = Instant::now();
        for version in [Some("0.168.0"), None] {
            let mut codex = tracker_at(Some("codex"), now, version);
            codex.take(vec![report("state=working")]);
            assert!(!codex.reads_screen(), "{version:?}");
            codex.evidence.observe(Some(ScreenState::Idle));
            assert_eq!(
                state(&mut codex, now + WORK_HOLD).0,
                AgentState::Working,
                "{version:?}"
            );
        }
        let mut codex = tracker(Some("codex"), now);
        codex.restarted(now, Some("0.168.0".into()), ToolsGiven::NotInjected);
        codex.take(vec![report("state=working")]);
        assert!(!codex.reads_screen(), "a resume at another version");
        assert_eq!(codex.kept().version.as_deref(), Some("0.168.0"));
    }

    /// A menu or question on the CLI's screen in place of its input waits for the person, ahead of
    /// the bound on its tools, which does not run while it waits: the bounds on its start and its
    /// tools run again from the answer.
    #[test]
    fn a_question_on_the_screen_waits_for_the_person_and_holds_the_bounds() {
        let now = Instant::now();
        let mut agent = StateTracker::new(
            Some(facade_rules::find("fake").unwrap().unwrap()),
            now,
            Kept::new_run(None, ToolsGiven::Injected),
            None,
            None,
        );
        agent.asks(true, now);
        let late = now + START_TIMEOUT + Duration::from_secs(5);
        let reading = agent.read(late, Viewing::Unwatched);
        let waits = Some(StateDetail {
            kind: Some(WaitKind::Unknown),
            ..StateDetail::default()
        });
        assert_eq!(
            (reading.state, reading.detail, reading.tools, reading.wake),
            (
                AgentState::WaitingForYou,
                waits,
                ToolsState::Connecting,
                None
            )
        );
        agent.asks(false, late);
        let reading = agent.read(late, Viewing::Unwatched);
        assert_eq!(
            (reading.state, reading.tools, reading.wake),
            (
                AgentState::Starting,
                ToolsState::Connecting,
                Some(late + START_TIMEOUT)
            )
        );
        let reading = agent.read(late + START_TIMEOUT, Viewing::Unwatched);
        assert_eq!(
            (reading.state, reading.tools),
            (AgentState::Error, ToolsState::Unavailable),
            "the tools' bound ran from the answer"
        );
        agent.take(vec![report("state=blocked:kind=permission")]);
        agent.asks(true, late + START_TIMEOUT);
        let reading = agent.read(late + START_TIMEOUT, Viewing::Unwatched);
        assert_eq!(
            reading.detail.and_then(|detail| detail.kind),
            Some(WaitKind::Permission),
            "what the CLI reports goes first"
        );
    }

    /// A run whose start could not ready its tools has them not started, but nothing is decided
    /// about them while its CLI asks the person something: they read connecting until the question
    /// is answered.
    #[test]
    fn tools_a_start_could_not_ready_read_connecting_while_the_cli_asks() {
        let now = Instant::now();
        let mut agent = StateTracker::new(
            Some(facade_rules::find("agy").unwrap().unwrap()),
            now,
            Kept::new_run(None, ToolsGiven::Injected),
            None,
            None,
        );
        agent.tools_not_started();
        agent.asks(true, now);
        let reading = agent.read(now, Viewing::Unwatched);
        assert_eq!(
            (reading.tools, reading.tools_reason),
            (ToolsState::Connecting, None),
            "while the CLI asks"
        );
        agent.asks(false, now);
        let reading = agent.read(now, Viewing::Unwatched);
        assert_eq!(
            (reading.tools, reading.tools_reason),
            (ToolsState::Unavailable, Some(ToolsReason::NotStarted)),
            "once answered"
        );
    }

    /// Working a CLI shows before it is asked to do anything is no turn: its start-up, also after
    /// it first rested, as Codex 0.167.0 works on after its first idle when it starts slowly. An
    /// Enter typed into it that does not answer a question it shows makes its working a turn from
    /// then on, also for a daemon that keeps the run anew.
    #[test]
    fn working_is_a_turn_only_once_the_cli_was_asked_to_do_something() {
        let now = Instant::now();
        let start = || {
            StateTracker::new(
                Some(facade_rules::find("fake").unwrap().unwrap()),
                now,
                Kept::new_run(None, ToolsGiven::NotInjected),
                None,
                None,
            )
        };
        let turn = |tracker: &mut StateTracker, at: Instant| {
            tracker.take(vec![report("state=working")]);
            state(tracker, at);
            tracker.take(vec![report("state=idle")]);
            state(tracker, at);
            state(tracker, at + WORK_HOLD).0
        };
        let mut unasked = start();
        assert_eq!(turn(&mut unasked, now), AgentState::Idle, "its start-up");
        assert_eq!(
            turn(&mut unasked, now + WORK_HOLD),
            AgentState::Idle,
            "its start-up after its first rest"
        );
        unasked.asked();
        let mut kept = StateTracker::new(
            Some(facade_rules::find("fake").unwrap().unwrap()),
            now,
            unasked.kept(),
            None,
            None,
        );
        for tracker in [&mut unasked, &mut kept] {
            assert_eq!(
                turn(tracker, now + WORK_HOLD * 2),
                AgentState::JustDone,
                "working after an Enter"
            );
            tracker.seen();
            assert_eq!(
                turn(tracker, now + WORK_HOLD * 3),
                AgentState::JustDone,
                "and its working after that"
            );
        }
        let mut answered = start();
        answered.asks(true, now);
        answered.asked();
        answered.asks(false, now);
        assert_eq!(
            turn(&mut answered, now),
            AgentState::Idle,
            "an Enter that answers the CLI's question"
        );
        answered.asked();
        assert_eq!(
            turn(&mut answered, now + WORK_HOLD),
            AgentState::JustDone,
            "an Enter once the question went"
        );
        let mut typed_to = start();
        typed_to.take(vec![report("state=working")]);
        state(&mut typed_to, now);
        typed_to.said(Submission {
            text: "go on".into(),
            sender: Sender::person(),
        });
        typed_to.take(vec![report("state=idle")]);
        state(&mut typed_to, now);
        assert_eq!(
            state(&mut typed_to, now + WORK_HOLD).0,
            AgentState::JustDone,
            "input with Enter while it started"
        );
        let mut resumed = tracker(Some("fake"), now);
        resumed.restarted(now, None, ToolsGiven::NotInjected);
        assert_eq!(
            turn(&mut resumed, now),
            AgentState::Idle,
            "a resumed run starts up anew"
        );
    }

    /// OpenCode reports a turn whose model call failed as a turn that ended. The error its screen
    /// shows for that turn makes the state an error, in OpenCode's words, until its next report.
    #[test]
    fn opencode_s_failed_turn_on_its_screen_is_an_error_until_its_next_report() {
        let now = Instant::now();
        let mut opencode = tracker(Some("opencode"), now);
        assert!(
            !opencode.reads_screen(),
            "its screen says nothing while it has not ended a turn"
        );
        opencode.take(vec![report("state=working")]);
        assert!(!opencode.reads_screen());
        opencode.take(vec![report("state=done")]);
        assert!(opencode.reads_screen());
        opencode.evidence.observe(Some(ScreenState::Error(
            "stand-in model: recorded, not answered".into(),
        )));
        let error = Some(StateDetail {
            text: Some("stand-in model: recorded, not answered".into()),
            ..StateDetail::default()
        });
        assert_eq!(state(&mut opencode, now), (AgentState::Error, error));
        opencode.take(vec![report("state=working")]);
        assert_eq!(
            state(&mut opencode, now).0,
            AgentState::Working,
            "its next report ends the error"
        );
        opencode.take(vec![report("state=done")]);
        opencode.evidence.observe(None);
        state(&mut opencode, now);
        assert_eq!(
            state(&mut opencode, now + WORK_HOLD).0,
            AgentState::JustDone,
            "a turn its screen shows no error for"
        );
    }

    #[test]
    fn codex_s_finished_turn_narrows_its_working_report_until_its_screen_or_report_says_otherwise()
    {
        let now = Instant::now();
        let mut codex = tracker(Some("codex"), now);
        assert!(
            !codex.reads_screen(),
            "the correction reads only while Codex reports working"
        );
        codex.take(vec![report("state=working")]);
        state(&mut codex, now);
        codex.evidence.observe(Some(ScreenState::Idle));
        assert_eq!(state(&mut codex, now).0, AgentState::Working);
        assert_eq!(state(&mut codex, now + WORK_HOLD).0, AgentState::JustDone);
        codex.seen();
        assert_eq!(state(&mut codex, now + WORK_HOLD).0, AgentState::Idle);
        codex.take(vec![report("state=working")]);
        assert_eq!(
            state(&mut codex, now + WORK_HOLD).0,
            AgentState::Idle,
            "the same report again keeps the correction"
        );
        codex.evidence.observe(None);
        assert_eq!(
            state(&mut codex, now + WORK_HOLD).0,
            AgentState::Working,
            "a new turn on the screen ends it"
        );
        assert_eq!(
            codex.kept().reported,
            Some(EvidenceState::Working),
            "the CLI's own report is what is kept"
        );
    }

    #[test]
    fn an_ended_run_says_how_and_a_resumed_one_starts_anew_keeping_what_was_said() {
        let exit = |code: Option<i32>, signal: Option<&str>| ProcessExit {
            code,
            signal: signal.map(Into::into),
            reason: None,
            at: "t".into(),
        };
        let now = Instant::now();
        let mut agent = tracker(None, now);
        for (exit, stopped, how) in [
            (exit(Some(3), None), false, Some(HowEnded::Crashed)),
            (exit(None, Some("SIGSEGV")), false, Some(HowEnded::Crashed)),
            (exit(Some(0), None), true, Some(HowEnded::Stopped)),
            (exit(None, None), true, Some(HowEnded::Stopped)),
            (exit(None, None), false, None),
        ] {
            agent.ended(&exit, stopped);
            assert_eq!(
                agent
                    .read(now, Viewing::Unwatched)
                    .detail
                    .and_then(|detail| detail.how),
                how,
                "{exit:?}, stopped {stopped}"
            );
        }
        let nova = Sender {
            from: "a2".into(),
            from_name: Some("No\u{1b}[2Jva\r\n".into()),
        };
        agent.said(Submission {
            text: "  first\nline\u{200b}  ".into(),
            sender: nova,
        });
        agent.said(Submission {
            text: " \u{200b} ".into(),
            sender: Sender::person(),
        });
        agent.take(vec![report("state=idle")]);
        agent.restarted(now, None, ToolsGiven::NotInjected);
        assert_eq!(state(&mut agent, now).0, AgentState::Starting);
        let said = agent.said_line().unwrap();
        assert_eq!(
            (
                said.text.as_str(),
                said.from.as_str(),
                said.from_name.as_deref()
            ),
            ("first line", "a2", Some("No [2Jva")),
            "nothing visible is no saying"
        );
    }

    #[test]
    fn kept_facts_bring_back_the_same_state() {
        let now = Instant::now();
        let mut agent = tracker(None, now);
        agent.take(vec![report("state=blocked:kind=question:msg=V2hpY2g/")]);
        state(&mut agent, now);
        agent.said(Submission {
            text: "go on".into(),
            sender: Sender::person(),
        });
        let kept = agent.kept();
        let file = serde_json::to_vec(&kept).unwrap();
        let mut again = StateTracker::new(
            None,
            now - START_TIMEOUT,
            serde_json::from_slice(&file).unwrap(),
            None,
            None,
        );
        assert_eq!(
            state(&mut again, now),
            (
                AgentState::WaitingForYou,
                detail(Some(WaitKind::Question), Some("Which?"), None, None)
            )
        );
        assert_eq!(again.kept(), kept);
        agent.take(vec![report("state=done")]);
        state(&mut agent, now);
        let mut again = StateTracker::new(None, now, agent.kept(), None, None);
        assert_eq!(state(&mut again, now).0, AgentState::JustDone);
        again.seen();
        let mut once_more = StateTracker::new(None, now, again.kept(), None, None);
        assert_eq!(
            state(&mut once_more, now).0,
            AgentState::Idle,
            "a turn seen before is not just done again"
        );
    }

    #[tokio::test]
    async fn the_newest_facts_are_kept_privately_and_an_unreadable_file_starts_anew() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::test_folder::TestFolder::new("state-kept");
        let file = state_file(&dir);
        assert_eq!(read_kept(&file), Kept::default(), "no file keeps nothing");
        let (kept, changes) = watch::channel(Kept::default());
        let keeping = tokio::spawn(keep(file.clone(), changes));
        for text in ["one", "two", "three"] {
            kept.send_replace(Kept {
                said: Some(Said {
                    text: text.into(),
                    from: HUMAN.into(),
                    from_name: None,
                    at: "t".into(),
                }),
                ..Kept::default()
            });
            tokio::task::yield_now().await;
        }
        drop(kept);
        keeping.await.unwrap();
        assert_eq!(
            read_kept(&file).said.map(|said| said.text).as_deref(),
            Some("three"),
            "the newest change is written last"
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::write(&file, "{").unwrap();
        assert_eq!(read_kept(&file), Kept::default());
        let (kept, changes) = watch::channel(Kept::new_run(None, ToolsGiven::Injected));
        let keeping = tokio::spawn(keep(file.clone(), changes));
        drop(kept);
        keeping.await.unwrap();
        assert_eq!(
            read_kept(&file).tools,
            ToolsGiven::Injected,
            "the facts a run starts with are kept before anything changes"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
