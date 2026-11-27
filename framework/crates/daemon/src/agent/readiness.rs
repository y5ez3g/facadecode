//! Plans the input used during a run's start. The actor performs every planned press.

use std::time::Duration;

use facade_base::model::terminal::InputState;
use facade_rules::{Pattern, ReadyTools, Rule, TrustQuestion};
use facade_screen::Screen;
use tokio::time::Instant;

use super::{ESCAPE_DELAY, START_TIMEOUT};
use crate::ToolsGiven;

const TEXT_TIMEOUT: Duration = Duration::from_secs(2);
const PANEL_TIMEOUT: Duration = Duration::from_secs(10);
const SCREEN_STILL: Duration = Duration::from_secs(1);
const SELECTION_TIMEOUT: Duration = Duration::from_secs(10);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// Keys readiness wants pressed, which the actor hands to the typist.
pub(crate) enum Press {
    /// Text pasted, without Enter, as the person.
    Text(String),
    /// Keys by name.
    Keys(Vec<String>),
}

/// What one step of a run's start sees.
pub(crate) struct StartView<'a> {
    pub(crate) screen: &'a Screen,
    /// The input as the rule reads the screen now.
    pub(crate) input: InputState,
    /// The CLI works on a turn.
    pub(crate) works: bool,
    /// The start's bound; None while the CLI asks a question of its own.
    pub(crate) start_bound: Option<Instant>,
    /// When the CLI last drew.
    pub(crate) drawn_at: Option<Instant>,
    /// The typist still types calls.
    pub(crate) typing: bool,
}

/// What one step came to.
pub(crate) struct StartStep {
    /// When to look again; the actor also looks whenever the CLI draws.
    pub(crate) wake: Option<Instant>,
    /// The keys and calls held meanwhile go on now, in the order they came.
    pub(crate) release_held: bool,
    /// Readying the tools failed: they stay unavailable until their server connects.
    pub(crate) tools_not_started: bool,
    /// Facade Code Framework answered the CLI's trust question.
    pub(crate) answered: bool,
}

/// What a run's start does first: readying its CLI's tools and answering its trust question when allowed.
pub(crate) struct Readiness {
    agent_id: String,
    ready_tools: Option<&'static ReadyTools>,
    question: Option<&'static TrustQuestion>,
    tools: Option<ToolStart>,
    trust: Option<TrustStart>,
}

impl Readiness {
    /// Keeps the rule's start instructions for this agent; does not press keys.
    pub(crate) fn new(rule: Option<&'static Rule>, agent_id: &str) -> Readiness {
        Readiness {
            agent_id: agent_id.into(),
            ready_tools: rule.and_then(|rule| rule.ready_tools.as_ref()),
            question: rule.and_then(|rule| rule.yolo.question.as_ref()),
            tools: None,
            trust: None,
        }
    }

    /// Readies tools where the CLI was given them and its rule says how. Answers the rule's trust question
    /// only if `allow_auto_trust` is true. `started` is when its process started. Returns when to look.
    pub(crate) fn begin(
        &mut self,
        started: Instant,
        tools: ToolsGiven,
        allow_auto_trust: bool,
    ) -> Option<Instant> {
        self.end();
        let deadline = started + START_TIMEOUT;
        if tools == ToolsGiven::Injected {
            self.tools = self.ready_tools.map(|rule| ToolStart {
                rule,
                phase: ToolPhase::Input,
                deadline,
            });
        }
        if allow_auto_trust {
            self.trust = self.question.map(|rule| TrustStart {
                rule,
                phase: TrustPhase::Question,
                deadline,
            });
        }
        self.is_under_way().then_some(deadline)
    }

    /// The run ended or a resume began: nothing more is pressed.
    pub(crate) fn end(&mut self) {
        self.tools = None;
        self.trust = None;
    }

    /// Takes the next steps at `now`; each key goes through `press`, which says why it cannot be typed.
    pub(crate) fn step(
        &mut self,
        now: Instant,
        view: &StartView<'_>,
        press: &mut dyn FnMut(Press) -> Result<(), String>,
    ) -> StartStep {
        let mut result = StartStep {
            wake: None,
            release_held: false,
            tools_not_started: false,
            answered: false,
        };
        if let Some(mut tools) = self.tools.take() {
            tools.advance(now, view, press, &mut result, &self.agent_id);
            if matches!(tools.phase, ToolPhase::Done) {
                result.release_held = true;
            } else {
                result.wake = Some(tools.wake(now));
                self.tools = Some(tools);
            }
        }
        if let Some(mut trust) = self.trust.take() {
            let answering = matches!(trust.phase, TrustPhase::Answer { .. });
            trust.advance(now, view, press, &self.agent_id);
            result.answered = !answering && matches!(trust.phase, TrustPhase::Answer { .. });
            if !matches!(trust.phase, TrustPhase::Done) {
                let next = trust.wake(now, view);
                result.wake = Some(result.wake.map_or(next, |wake| wake.min(next)));
                self.trust = Some(trust);
            }
        }
        result
    }

    /// Whether keys and calls wait now, `input` being the input as read now.
    pub(crate) fn holds_input(&self, input: InputState) -> bool {
        self.tools.as_ref().is_some_and(|tools| {
            !matches!(tools.phase, ToolPhase::Input) || input != InputState::Interaction
        })
    }

    /// Whether the tool startup is still watching for the composer, before typing anything.
    pub(crate) fn waiting_for_input(&self) -> bool {
        self.tools
            .as_ref()
            .is_some_and(|tools| matches!(tools.phase, ToolPhase::Input))
    }

    /// Lets the person type when the probe is only watching. A confirmed native question
    /// already allows keys and can still be followed by the tool probe.
    pub(crate) fn yield_to_input(&mut self, input: InputState) -> bool {
        if self.waiting_for_input() && input != InputState::Interaction {
            self.tools = None;
            return true;
        }
        false
    }

    /// Whether the tools are being readied: messages wait as behind a draft.
    pub(crate) fn readies_tools(&self) -> bool {
        self.tools.is_some()
    }

    /// Whether anything is under way: the actor steps it each time the CLI draws.
    pub(crate) fn is_under_way(&self) -> bool {
        self.readies_tools() || self.trust.is_some()
    }
}

// Deadlines live beside the phases, so that each phase changes only the wait it owns.
struct ToolStart {
    rule: &'static ReadyTools,
    phase: ToolPhase,
    deadline: Instant,
}

enum ToolPhase {
    Input,
    Text,
    Panel,
    Drain,
    Pause,
    Done,
}

impl ToolStart {
    fn wait(&mut self, phase: ToolPhase, deadline: Instant) {
        self.phase = phase;
        self.deadline = deadline;
    }

    fn wake(&self, now: Instant) -> Instant {
        if matches!(self.phase, ToolPhase::Drain) {
            self.deadline.min(now + ESCAPE_DELAY)
        } else {
            self.deadline
        }
    }

    fn advance(
        &mut self,
        now: Instant,
        view: &StartView<'_>,
        press: &mut dyn FnMut(Press) -> Result<(), String>,
        result: &mut StartStep,
        agent_id: &str,
    ) {
        let outcome = match self.phase {
            ToolPhase::Input => self.input(now, view, press, result),
            ToolPhase::Text => self.text(now, view, press),
            ToolPhase::Panel => self.panel(now, view, press),
            ToolPhase::Drain => {
                if !view.typing || now >= self.deadline {
                    self.wait(ToolPhase::Pause, now + ESCAPE_DELAY);
                }
                None
            }
            ToolPhase::Pause => {
                if now >= self.deadline {
                    self.phase = ToolPhase::Done;
                }
                None
            }
            ToolPhase::Done => None,
        };
        if let Some(outcome) = outcome {
            let (level, message) = match outcome {
                Ok(done) => ("info", format!("#{agent_id}: before its first turn {done}")),
                Err(why) => {
                    result.tools_not_started = true;
                    (
                        "warn",
                        format!(
                            "#{agent_id}: its tools are not started before its first turn: {why}"
                        ),
                    )
                }
            };
            facade_base::log::write("daemon", level, &message);
        }
    }

    fn input(
        &mut self,
        now: Instant,
        view: &StartView<'_>,
        press: &mut dyn FnMut(Press) -> Result<(), String>,
        result: &mut StartStep,
    ) -> Option<Result<String, String>> {
        if view.input == InputState::Interaction {
            result.release_held = true;
        }
        if view.input == InputState::Interaction
            || (view.input == InputState::Unknown && view.start_bound.is_none_or(|end| now < end))
        {
            self.deadline = bounded(view, now + START_TIMEOUT);
            return None;
        }
        // A draft read while the CLI still draws may be half of a redraw: judged once the screen is
        // still, or once the start's time is up.
        if view.input == InputState::Draft
            && now < still_at(now, view)
            && view.start_bound.is_none_or(|end| now < end)
        {
            self.deadline = bounded(view, still_at(now, view));
            return None;
        }
        let failure = match view.input {
            InputState::Unknown => {
                format!(
                    "its input showed nothing it could read within {} seconds of its start",
                    START_TIMEOUT.as_secs()
                )
            }
            InputState::Usable if view.works => {
                "it was working when its input first showed empty".into()
            }
            InputState::Usable => match press(Press::Text(self.rule.text.clone())) {
                Ok(()) => {
                    self.wait(ToolPhase::Text, bounded(view, now + TEXT_TIMEOUT));
                    return None;
                }
                Err(why) => why,
            },
            input => format!("its input first read {}", input.as_str()),
        };
        self.phase = ToolPhase::Done;
        Some(Err(failure))
    }

    fn text(
        &mut self,
        now: Instant,
        view: &StartView<'_>,
        press: &mut dyn FnMut(Press) -> Result<(), String>,
    ) -> Option<Result<String, String>> {
        if shows(view.screen, &self.rule.typed) {
            if let Err(why) = press(Press::Keys(vec!["Enter".into()])) {
                self.phase = ToolPhase::Done;
                return Some(Err(why));
            }
            self.wait(ToolPhase::Panel, bounded(view, now + PANEL_TIMEOUT));
            return None;
        }
        if now < self.deadline {
            return None;
        }
        let failed = format!(
            "{} did not show alone in its input, so Enter was not pressed",
            self.rule.text
        );
        let keys = vec!["Backspace".into(); self.rule.text.chars().count()];
        let reason = match press(Press::Keys(keys)) {
            Err(why) => {
                self.phase = ToolPhase::Done;
                format!("{failed}, and it could not be taken back: {why}")
            }
            Ok(()) => {
                self.wait(ToolPhase::Drain, bounded(view, now + TEXT_TIMEOUT));
                format!("{failed} and it was taken back")
            }
        };
        Some(Err(reason))
    }

    fn panel(
        &mut self,
        now: Instant,
        view: &StartView<'_>,
        press: &mut dyn FnMut(Press) -> Result<(), String>,
    ) -> Option<Result<String, String>> {
        let ready = shows(view.screen, &self.rule.ready);
        if !ready && now < self.deadline {
            return None;
        }
        self.phase = ToolPhase::Done;
        let mut suffix = String::new();
        if ready || shows(view.screen, &self.rule.opened) {
            match press(Press::Keys(vec![self.rule.close.clone()])) {
                Ok(()) => self.wait(ToolPhase::Drain, bounded(view, now + TEXT_TIMEOUT)),
                Err(why) => suffix = format!(", and its panel could not be closed: {why}"),
            }
        }
        Some(if ready {
            Ok(format!("its tools showed ready{suffix}"))
        } else {
            Err(format!("its panel did not show its tools ready{suffix}"))
        })
    }
}

struct TrustStart {
    rule: &'static TrustQuestion,
    phase: TrustPhase,
    deadline: Instant,
}

enum TrustPhase {
    Question,
    Selection,
    Answer { absent_since: Option<Instant> },
    Done,
}

impl TrustStart {
    fn wake(&self, now: Instant, view: &StartView<'_>) -> Instant {
        match self.phase {
            TrustPhase::Answer {
                absent_since: Some(since),
            } => since + SCREEN_STILL,
            TrustPhase::Question | TrustPhase::Selection if now < still_at(now, view) => {
                self.deadline.min(still_at(now, view))
            }
            _ => self.deadline,
        }
    }

    fn advance(
        &mut self,
        now: Instant,
        view: &StartView<'_>,
        press: &mut dyn FnMut(Press) -> Result<(), String>,
        agent_id: &str,
    ) {
        let shown = shows(view.screen, &self.rule.shown);
        if let TrustPhase::Answer {
            ref mut absent_since,
        } = self.phase
        {
            if shown {
                *absent_since = None;
                if now >= self.deadline {
                    self.leave(agent_id, "it stayed on the screen after its answer");
                }
            } else {
                let since = *absent_since.get_or_insert(now);
                if now >= since + SCREEN_STILL {
                    self.phase = TrustPhase::Done;
                    facade_base::log::write(
                        "daemon",
                        "info",
                        &format!(
                            "#{agent_id}: its CLI's question about trusting the launch's folder was answered, as YOLO is on"
                        ),
                    );
                }
            }
            return;
        }
        let asked = shown && shows(view.screen, &self.rule.answer);
        let selected = asked && shows(view.screen, &self.rule.selected);
        if selected && now >= still_at(now, view) {
            match press(Press::Keys(vec![self.rule.confirm.clone()])) {
                Ok(()) => {
                    self.phase = TrustPhase::Answer { absent_since: None };
                    self.deadline = now + ANSWER_TIMEOUT;
                }
                Err(why) => self.fail(agent_id, &why),
            }
            return;
        }
        match self.phase {
            TrustPhase::Question => {
                if asked && now >= still_at(now, view) {
                    match press(Press::Keys(self.rule.keys.clone())) {
                        Ok(()) => {
                            self.phase = TrustPhase::Selection;
                            self.deadline = now + SELECTION_TIMEOUT;
                        }
                        Err(why) => self.fail(agent_id, &why),
                    }
                } else if now >= self.deadline || (!asked && view.input == InputState::Usable) {
                    if asked {
                        self.leave(agent_id, "the screen did not stay still while it showed");
                    } else {
                        self.phase = TrustPhase::Done;
                    }
                }
            }
            TrustPhase::Selection if now >= self.deadline => self.leave(agent_id,
                "the selection did not show on the answer that trusts it while the screen was still"),
            _ => {}
        }
    }

    fn leave(&mut self, agent_id: &str, why: &str) {
        self.fail(agent_id, &format!("{why}, so it was left to the person"));
    }

    fn fail(&mut self, agent_id: &str, why: &str) {
        self.phase = TrustPhase::Done;
        facade_base::log::write(
            "daemon",
            "warn",
            &format!(
                "#{agent_id}: its CLI's question about trusting the launch's folder was not answered: {why}"
            ),
        );
    }
}

fn still_at(now: Instant, view: &StartView<'_>) -> Instant {
    view.drawn_at.map_or(now, |drawn| drawn + SCREEN_STILL)
}

fn bounded(view: &StartView<'_>, deadline: Instant) -> Instant {
    view.start_bound
        .map_or(deadline, |bound| deadline.min(bound))
}

fn shows(screen: &Screen, pattern: &Pattern) -> bool {
    for row in screen.view().rows {
        let text: String = row.iter().map(|cell| cell.text.as_str()).collect();
        if pattern.is_match(text.trim_end()) {
            return true;
        }
    }
    false
}
