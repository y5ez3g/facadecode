//! Plans the input used during a run's start. The actor performs every planned press.

use std::time::Duration;

use facade_base::model::terminal::InputState;
use facade_rules::{Pattern, ReadyTools, Rule, TrustQuestion};
use facade_screen::Screen;
use tokio::time::Instant;

use super::{ESCAPE_DELAY, START_TIMEOUT};
use crate::ToolsGiven;

const SCREEN_STILL: Duration = Duration::from_secs(1);
const SELECTION_TIMEOUT: Duration = Duration::from_secs(10);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// Keys readiness wants pressed, which the actor hands to the typist.
pub(crate) enum Press {
    /// The tools command, pasted before its startup deadline.
    ToolCommand { text: String, deadline: Instant },
    /// A single key for preparing the tools, with the same deadline.
    ToolKey { key: String, deadline: Instant },
    /// Keys in the trust answer.
    Keys(Vec<String>),
}

/// What one step of a run's start sees.
pub(crate) struct StartView<'a> {
    pub(crate) screen: &'a Screen,
    /// The input as the rule reads the screen now.
    pub(crate) input: InputState,
    /// Draft text from the input box, if the rule could read its rows.
    pub(crate) draft: Option<&'a str>,
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
    /// Readying the tools failed: they stay unavailable until their server connects.
    pub(crate) tools_not_started: bool,
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
                startup_deadline: deadline,
                issued: false,
                command_issued: false,
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
            tools_not_started: false,
        };
        if let Some(mut tools) = self.tools.take() {
            tools.advance(now, view, press, &mut result, &self.agent_id);
            if !matches!(tools.phase, ToolPhase::Done) {
                result.wake = tools.wake();
                self.tools = Some(tools);
            }
        }
        if let Some(mut trust) = self.trust.take() {
            trust.advance(now, view, press, &self.agent_id);
            if !matches!(trust.phase, TrustPhase::Done) {
                let next = trust.wake(now, view);
                result.wake = Some(result.wake.map_or(next, |wake| wake.min(next)));
                self.trust = Some(trust);
            }
        }
        result
    }

    /// Validates the pending stroke against the actor's current complete frame.
    pub(super) fn tool_write_matches(
        &self,
        screen: &Screen,
        input: InputState,
        draft: Option<&str>,
        composer_allowed: bool,
    ) -> bool {
        let Some(tools) = &self.tools else {
            return false;
        };
        match tools.phase {
            ToolPhase::Text => composer_allowed && input == InputState::Usable,
            ToolPhase::Panel => composer_allowed && tools.shows_command(screen, input, draft),
            ToolPhase::Drain => tools.ready_panel(screen),
            _ => false,
        }
    }

    /// Whether the visible panel is one the start has opened and is still observing.
    pub(super) fn in_tool_panel(&self, screen: &Screen) -> bool {
        self.tools.as_ref().is_some_and(|tools| {
            (matches!(tools.phase, ToolPhase::Drain)
                || (matches!(tools.phase, ToolPhase::Panel) && tools.issued))
                && shows(screen, &tools.rule.opened)
        })
    }

    /// Gives a new question to the person, retaining the ordering of a close already issued.
    pub(super) fn interrupt_tools_for_question(&mut self) -> bool {
        let Some(tools) = &self.tools else {
            return false;
        };
        if matches!(
            tools.phase,
            ToolPhase::Input | ToolPhase::Pause | ToolPhase::Done
        ) || (matches!(tools.phase, ToolPhase::Drain) && tools.issued)
        {
            return false;
        }
        let mut reason = String::from("its CLI began waiting for a person during tool preparation");
        if tools.command_issued
            && (matches!(tools.phase, ToolPhase::Text)
                || (matches!(tools.phase, ToolPhase::Panel) && !tools.issued))
        {
            reason.push_str(&format!(
                ", and some or all of {} may remain in its input",
                tools.rule.text
            ));
        }
        facade_base::log::write(
            "daemon",
            "warn",
            &format!(
                "#{}: {reason}. Its first turn may run without Facade's tools",
                self.agent_id
            ),
        );
        self.tools = None;
        true
    }

    /// The system took the current startup stroke. It must drain in terminal order.
    pub(super) fn tool_write_issued(&mut self) {
        if let Some(tools) = &mut self.tools {
            tools.issued = true;
            tools.command_issued |= matches!(tools.phase, ToolPhase::Text);
        }
    }

    /// Starts the panel close interval when the terminal has written the whole close key.
    pub(super) fn tool_write_arrived(&mut self, written_at: Instant) {
        if let Some(tools) = &mut self.tools
            && tools.issued
            && matches!(tools.phase, ToolPhase::Drain)
        {
            tools.wait(ToolPhase::Pause, written_at + ESCAPE_DELAY);
        }
    }

    /// Whether keys and calls wait now, `input` being the input as read now.
    pub(crate) fn holds_input(&self, input: InputState) -> bool {
        self.tools.as_ref().is_some_and(|tools| {
            !matches!(tools.phase, ToolPhase::Input) || input != InputState::Interaction
        })
    }

    pub(super) fn waiting_for_input(&self) -> bool {
        self.tools
            .as_ref()
            .is_some_and(|tools| matches!(tools.phase, ToolPhase::Input))
    }

    /// The person took the input while the start was waiting for the probe.
    pub(super) fn interrupt_input_wait(&mut self) -> bool {
        if self.waiting_for_input() {
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

// Text echo and panel readiness share the startup deadline. The close drains through its receipt.
struct ToolStart {
    rule: &'static ReadyTools,
    phase: ToolPhase,
    deadline: Instant,
    startup_deadline: Instant,
    /// Whether the system has already taken the most recent stroke.
    issued: bool,
    /// Whether any part of the tools command may remain in the composer.
    command_issued: bool,
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
        self.issued = false;
    }

    fn wake(&self) -> Option<Instant> {
        (!(matches!(self.phase, ToolPhase::Drain) && self.issued)).then_some(self.deadline)
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
            ToolPhase::Input => self.input(now, view, press),
            ToolPhase::Text => self.text(now, view, press),
            ToolPhase::Panel => self.panel(now, view, press),
            ToolPhase::Drain if !self.issued && now >= self.deadline => {
                self.phase = ToolPhase::Done;
                Some(Err(
                    "its startup deadline passed before it could close the panel".into(),
                ))
            }
            ToolPhase::Drain if self.issued && !view.typing => {
                self.phase = ToolPhase::Done;
                Some(Err(
                    "its tool panel close key failed to reach the terminal".into()
                ))
            }
            ToolPhase::Drain => None,
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
                            "#{agent_id}: {why}. Its first turn may run without Facade's tools"
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
    ) -> Option<Result<String, String>> {
        let input = if view.screen.output_frame_complete() {
            view.input
        } else {
            InputState::Unknown
        };
        if input == InputState::Interaction
            || (input == InputState::Unknown && view.start_bound.is_none_or(|end| now < end))
        {
            self.deadline = bounded(view, now + START_TIMEOUT);
            return None;
        }
        // A draft read while the CLI still draws may be half of a redraw: judged once the screen is
        // still, or once the start's time is up.
        if input == InputState::Draft
            && now < still_at(now, view)
            && view.start_bound.is_none_or(|end| now < end)
        {
            self.deadline = bounded(view, still_at(now, view));
            return None;
        }
        let deadline = view.start_bound.unwrap_or(self.startup_deadline);
        let failure = match input {
            InputState::Unknown => {
                format!(
                    "its input showed nothing it could read within {} seconds of its start",
                    START_TIMEOUT.as_secs()
                )
            }
            InputState::Usable if view.works => {
                "it was working when its input first showed empty".into()
            }
            InputState::Usable if now >= deadline => {
                "its input first showed empty at the startup deadline".into()
            }
            InputState::Usable => match press(Press::ToolCommand {
                text: self.rule.text.clone(),
                deadline,
            }) {
                Ok(()) => {
                    self.wait(ToolPhase::Text, deadline);
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
        if now < self.deadline {
            if !view.typing
                && view.screen.output_frame_complete()
                && self.shows_command(view.screen, view.input, view.draft)
            {
                if let Err(why) = press(Press::ToolKey {
                    key: "Enter".into(),
                    deadline: self.deadline,
                }) {
                    self.phase = ToolPhase::Done;
                    return Some(Err(why));
                }
                self.wait(ToolPhase::Panel, self.deadline);
            }
            return None;
        }
        Some(Err(self.unsubmitted_command()))
    }

    fn shows_command(&self, screen: &Screen, input: InputState, draft: Option<&str>) -> bool {
        input == InputState::Draft
            && draft == Some(self.rule.text.as_str())
            && shows(screen, &self.rule.typed)
    }

    fn ready_panel(&self, screen: &Screen) -> bool {
        shows(screen, &self.rule.opened) && shows(screen, &self.rule.ready)
    }

    fn unsubmitted_command(&mut self) -> String {
        self.phase = ToolPhase::Done;
        let text = &self.rule.text;
        let mut reason = format!("the startup deadline passed before {text} was submitted");
        if self.command_issued {
            reason.push_str(&format!(
                ", and some or all of {text} may remain in its input"
            ));
        }
        reason
    }

    fn panel(
        &mut self,
        now: Instant,
        view: &StartView<'_>,
        press: &mut dyn FnMut(Press) -> Result<(), String>,
    ) -> Option<Result<String, String>> {
        if now >= self.deadline {
            if !self.issued {
                return Some(Err(self.unsubmitted_command()));
            }
            self.phase = ToolPhase::Done;
            return Some(Err(
                "its panel did not show its tools ready by the startup deadline".into(),
            ));
        }
        if view.typing || !view.screen.output_frame_complete() || !self.ready_panel(view.screen) {
            return None;
        }
        Some(Ok(
            match press(Press::ToolKey {
                key: self.rule.close.clone(),
                deadline: self.deadline,
            }) {
                Ok(()) => {
                    self.wait(ToolPhase::Drain, self.deadline);
                    "its tools showed ready".into()
                }
                Err(why) => {
                    self.phase = ToolPhase::Done;
                    format!("its tools showed ready, and its panel could not be closed: {why}")
                }
            },
        ))
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
    super::with_screen_view(screen, |view| {
        view.rows.iter().any(|row| {
            let text: String = row.iter().map(|cell| cell.text()).collect();
            pattern.is_match(text.trim_end())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_late_tool_panel_keeps_the_persons_keys_until_it_is_ready_or_the_start_ends() {
        let rule = facade_rules::find("agy").unwrap();
        for (echoes, finishes) in [(true, true), (true, false), (false, false)] {
            let mut readiness = Readiness::new(rule, "a1");
            let mut screen = Screen::new(80, 24, 0);
            let mut presses = Vec::new();
            let started = Instant::now();
            readiness.begin(started, ToolsGiven::Injected, false);
            let mut step = |elapsed, input, frame: &str| {
                screen.feed(format!("\x1b[2J\x1b[H{frame}").as_bytes());
                let now = started + Duration::from_secs(elapsed);
                let view = StartView {
                    screen: &screen,
                    input,
                    draft: frame.strip_prefix("> "),
                    works: false,
                    start_bound: (input != InputState::Interaction)
                        .then_some(started + START_TIMEOUT),
                    drawn_at: Some(now),
                    typing: false,
                };
                let before = presses.len();
                let result = readiness.step(now, &view, &mut |press| {
                    match press {
                        Press::ToolCommand { text, deadline } => {
                            assert_eq!(deadline, started + START_TIMEOUT);
                            presses.push(text);
                        }
                        Press::ToolKey { key, deadline } => {
                            assert_eq!(deadline, started + START_TIMEOUT);
                            presses.push(key);
                        }
                        Press::Keys(keys) => presses.extend(keys),
                    }
                    Ok(())
                });
                if presses.len() != before {
                    readiness.tool_write_issued();
                    readiness.tool_write_arrived(now);
                }
                (result, readiness.holds_input(input))
            };

            step(1, InputState::Usable, "> ");
            let (echo, holds) = step(4, InputState::Usable, "> ");
            assert!(
                !echo.tools_not_started,
                "the command can still echo by the bound"
            );
            assert!(holds);
            if !echoes {
                let (expired, holds) = step(START_TIMEOUT.as_secs(), InputState::Usable, "> ");
                assert!(expired.tools_not_started);
                assert!(!holds, "a missing command releases the person at the bound");
                assert_eq!(presses, ["/mcp"]);
                continue;
            }
            step(5, InputState::Draft, "> /mcp");
            step(
                6,
                InputState::Interaction,
                "MCP Servers\r\n  ⋯ facade_facade",
            );
            let (waiting, holds) = step(
                16,
                InputState::Interaction,
                "MCP Servers\r\n  ⋯ facade_facade",
            );
            assert!(
                !waiting.tools_not_started,
                "the panel is still starting its tools"
            );
            assert!(holds, "the person's first turn still waits");
            assert_eq!(waiting.wake, Some(started + START_TIMEOUT));
            let (elapsed, row) = if finishes {
                (18, "  ✓ facade_facade")
            } else {
                (START_TIMEOUT.as_secs(), "  ⋯ facade_facade")
            };
            let (settled, _) = step(
                elapsed,
                InputState::Interaction,
                &format!("MCP Servers\r\n{row}"),
            );
            assert_eq!(settled.tools_not_started, !finishes);
            if !finishes {
                assert_eq!(
                    presses,
                    ["/mcp", "Enter"],
                    "leave an unready panel to the person"
                );
                continue;
            }
            step(elapsed, InputState::Usable, "> ");
            let (_, holds) = step(elapsed + 1, InputState::Usable, "> ");
            assert!(!holds, "the held keys can follow the panel's close");
            assert_eq!(presses, ["/mcp", "Enter", "Escape"]);
        }
    }
}
