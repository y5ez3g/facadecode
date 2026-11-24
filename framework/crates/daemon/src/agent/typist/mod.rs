//! Serializes program input and submits messages over the CLI's own draft.
//! The actor owns terminal I/O; byte receipts anchor every delay to actual writes.

mod probe;

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use facade_base::api_v1::daemon::InputStep;
use facade_base::key_input::{Key, MAX_INPUT_BYTES, MAX_KEYS, PASTE_END, PASTE_START};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::terminal::{key_down_records, key_down_records_len};
use facade_base::{
    model::message::{DeliveryFailure, TextWritten},
    model::terminal::{InputInfo, InputState, first_control},
};
use facade_rules::{BoxReading, ConsoleTyping, LineCell, PasteRule, ProbeVerdict, Rule};
use tokio::sync::oneshot;
use tokio::time::Instant;

use self::probe::{Next, PROBE_READ, Probe};
use super::{ESCAPE_DELAY, Submission};
use crate::Sender;
use crate::messages::{DeliveryHandle, Outcome, RESPONSE_GRACE};

const PASTE_DELAY: Duration = Duration::from_millis(100);
const READ_INTERVAL: Duration = Duration::from_millis(500);
const KNOWN_KEYS: &str = "keys are Enter (or Return), Escape (or Esc), Tab, Shift+Tab, Backspace, \
                          Delete, Up, Down, Left, Right (or ArrowUp, \
                          ArrowDown, ArrowLeft, ArrowRight), Home, End, PageUp, PageDown, Space, \
                          and Ctrl+A to Ctrl+Z, in any letter case, or any one \
                          character other than a control character";

/// Terminal modes and working state sampled by the actor.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Modes {
    pub(crate) bracketed_paste: bool,
    pub(crate) application_cursor_keys: bool,
    pub(crate) working: bool,
}

/// Bytes to queue now and the next timer to arrange; neither operation waits.
#[derive(Debug, Default)]
pub(crate) struct Step {
    pub(crate) write: Vec<u8>,
    pub(crate) wake: Option<Instant>,
}

impl Step {
    fn wait(at: Option<Instant>) -> Self {
        Self {
            write: Vec::new(),
            wake: at,
        }
    }
}

/// Resolves after terminal writes complete, or describes the input that stopped.
pub(crate) type TypingAnswer = oneshot::Receiver<Result<(), ErrorBody>>;

/// One indivisible program call; constructed without I/O or locks.
#[derive(Debug)]
pub(crate) struct Typing {
    strokes: VecDeque<Stroke>,
    answer: oneshot::Sender<Result<(), ErrorBody>>,
    submission: Option<Box<Submission>>,
    kind: CallKind,
    completed: usize,
}

#[derive(Debug)]
enum CallKind {
    Text,
    Keys(usize),
    Sequence(usize),
}

impl Typing {
    /// Validates text and optionally appends Enter; does not wait or take locks.
    pub(crate) fn text(
        text: String,
        enter: bool,
        sender: Sender,
    ) -> Result<(Typing, TypingAnswer), String> {
        Self::validate_text(&text)?;
        if text.is_empty() && !enter {
            return Err("text is empty and enter is false: there is nothing to type".into());
        }
        let submission = if enter && !text.is_empty() {
            Some(Box::new(Submission {
                text: text.clone(),
                sender,
            }))
        } else {
            None
        };
        let mut strokes = VecDeque::new();
        if !text.is_empty() {
            strokes.push_back(Stroke::Paste(text));
        }
        if enter {
            strokes.push_back(Stroke::Key(Key::Enter));
        }
        let (mut call, reply) = Self::new(strokes, CallKind::Text);
        call.submission = submission;
        Ok((call, reply))
    }

    /// Resolves names into ordered keys synchronously, without locks.
    pub(crate) fn keys(names: &[String]) -> Result<(Typing, TypingAnswer), String> {
        if names.is_empty() {
            return Err("keys is empty; give at least one key".into());
        }
        let mut strokes = VecDeque::new();
        let mut unknown = Vec::new();
        for name in names {
            match Key::named(name) {
                Some(key) => strokes.push_back(Stroke::Key(key)),
                None => unknown.push(format!("{name:?}")),
            }
        }
        if unknown.is_empty() {
            Ok(Self::new(strokes, CallKind::Keys(names.len())))
        } else {
            Err(format!(
                "unknown keys: {}; {KNOWN_KEYS}",
                unknown.join(", ")
            ))
        }
    }

    /// Validates the complete ordered batch before it can be queued.
    pub(crate) fn sequence(steps: Vec<InputStep>) -> Result<(Typing, TypingAnswer), String> {
        if steps.is_empty() {
            return Err("Sequence is empty. Give at least one step.".into());
        }
        let total = steps.len();
        let mut strokes = VecDeque::new();
        let mut keys = 0;
        for (index, step) in steps.into_iter().enumerate() {
            let stroke = match step {
                InputStep::Text { text } => {
                    let number = index + 1;
                    if text.is_empty() {
                        return Err(format!("sequence step {number} has empty text"));
                    }
                    Self::validate_text(&text)
                        .map_err(|problem| format!("sequence step {number}: {problem}"))?;
                    Stroke::Paste(text)
                }
                InputStep::Key { key } => {
                    let key = Key::named(&key).ok_or_else(|| {
                        format!(
                            "sequence step {}: unknown key {key:?}; {KNOWN_KEYS}",
                            index + 1
                        )
                    })?;
                    keys += 1;
                    Stroke::Key(key)
                }
            };
            strokes.push_back(stroke);
        }
        if keys > MAX_KEYS {
            return Err(format!(
                "sequence allows at most {MAX_KEYS} keys, got {keys}"
            ));
        }
        let (call, reply) = Self::new(strokes, CallKind::Sequence(total));
        // As the published preflight counts it, whatever the agent's terminal: the actor counts the
        // bytes its terminal takes against the room there is.
        let bytes = call.most_bytes(None);
        if bytes > MAX_INPUT_BYTES {
            return Err(format!(
                "sequence uses {bytes} input bytes; the limit is {MAX_INPUT_BYTES}"
            ));
        }
        Ok((call, reply))
    }

    pub(crate) fn is_sequence(&self) -> bool {
        matches!(self.kind, CallKind::Sequence(_))
    }

    fn validate_text(text: &str) -> Result<(), String> {
        match first_control(text) {
            Some(problem) => Err(format!(
                "{problem}; send Escape and other control keys as keys"
            )),
            None => Ok(()),
        }
    }

    fn new(strokes: VecDeque<Stroke>, kind: CallKind) -> (Self, TypingAnswer) {
        let (answer, receiver) = oneshot::channel();
        (
            Self {
                strokes,
                answer,
                submission: None,
                kind,
                completed: 0,
            },
            receiver,
        )
    }

    /// Maximum queued bytes in either terminal mode, as the `console` takes them where the CLI
    /// reads console input records; no I/O or locks.
    pub(crate) fn most_bytes(&self, console: Option<ConsoleTyping>) -> usize {
        self.strokes
            .iter()
            .map(|stroke| stroke.most_bytes(console))
            .sum()
    }

    fn interruption(&self, why: &str, partial: bool) -> ErrorBody {
        if self.completed == 0 && !partial {
            return ErrorBody::new(Reason::Ended, format!("{why}; nothing was typed"));
        }
        let done = self.completed;
        let interrupted =
            |detail: &str| ErrorBody::new(Reason::PartialInput, format!("{why}; {detail}"));
        match self.kind {
            CallKind::Text => {
                let (detail, written) = if done == 0 {
                    ("part of the text was typed", TextWritten::Partial)
                } else {
                    ("the text was typed but not its Enter", TextWritten::Full)
                };
                let mut error = interrupted(detail);
                error.data.enter_written = Some(false);
                error.data.text_written = Some(written);
                error
            }
            CallKind::Keys(total) => {
                let detail = if partial {
                    format!("{done} of {total} keys and part of the next were pressed")
                } else {
                    format!("{done} of {total} keys were pressed")
                };
                let mut error = interrupted(&detail);
                error.data.keys_sent = Some(done as u32);
                error
            }
            CallKind::Sequence(total) => {
                let detail = if partial {
                    format!("{done} of {total} sequence steps were written, plus part of the next")
                } else {
                    format!("{done} of {total} sequence steps were written")
                };
                ErrorBody::new(Reason::PartialInput, format!("{why}. {detail}."))
            }
        }
    }
}

/// A delivery and its submission, owned by the actor's typist.
#[derive(Debug)]
pub(crate) struct MessageTyping {
    number: u64,
    text: String,
    submission: Box<Submission>,
    deadline: Instant,
    prompt: bool,
}

impl MessageTyping {
    /// Keeps a message until its deadline; does not wait or take locks.
    pub(crate) fn new(
        text: String,
        number: u64,
        deadline: Instant,
        submission: Submission,
    ) -> MessageTyping {
        Self {
            number,
            text,
            submission: Box::new(submission),
            deadline,
            prompt: false,
        }
    }

    /// Keeps a first prompt, which goes ahead of waiting messages; no I/O or locks.
    pub(crate) fn start_prompt(
        text: String,
        number: u64,
        deadline: Instant,
        submission: Submission,
    ) -> MessageTyping {
        let mut prompt = Self::new(text, number, deadline, submission);
        prompt.prompt = true;
        prompt
    }

    /// Maximum bytes for the text and its paste brackets, as the `console` takes them where the
    /// CLI reads console input records, and the one-byte submission key.
    pub(crate) fn most_bytes(&self, console: Option<ConsoleTyping>) -> usize {
        Self::bytes_for(&self.text, console)
    }

    /// The input to reserve for a message or a start prompt while it waits.
    pub(super) fn bytes_for(text: &str, console: Option<ConsoleTyping>) -> usize {
        paste_size(text, console) + Key::Enter.most_bytes()
    }
}

/// A byte range already handed to the actor, with stroke boundaries for partial failures.
struct Receipt {
    offset: u64,
    boundaries: Vec<u64>,
    arrived: Option<Instant>,
    delay: Duration,
}

impl Receipt {
    fn complete(&self, written: u64) -> bool {
        self.arrived.is_some() || written >= self.boundaries.last().copied().unwrap_or(self.offset)
    }

    fn progress(&self, written: u64) -> (usize, bool) {
        let full = self
            .boundaries
            .iter()
            .filter(|&&end| end <= written)
            .count();
        let edge = full
            .checked_sub(1)
            .map_or(self.offset, |i| self.boundaries[i]);
        (full, full < self.boundaries.len() && written > edge)
    }

    fn paused(&self, now: Instant) -> Option<Instant> {
        self.arrived
            .map(|at| at + self.delay)
            .filter(|at| *at > now)
    }
}

struct Batch {
    messages: Vec<MessageTyping>,
    phase: DeliveryPhase,
}

enum DeliveryPhase {
    Draft(DraftCheck),
    Submitting,
    Clearing { until: Instant },
}

struct DraftCheck {
    paste: PasteDraft,
    previous: Option<PasteDraft>,
    stable: Option<(Instant, String)>,
    observed: bool,
    recovered: bool,
    typed: Option<u64>,
}

struct PasteDraft {
    text: String,
}

impl PasteDraft {
    fn matches(&self, rule: &PasteRule, reading: &BoxReading, legacy_split: bool) -> bool {
        reading.info.state == InputState::Draft
            && reading.draft.as_deref().is_some_and(|shown| {
                facade_rules::is_own_draft(rule, shown, &self.text, reading.draft_hidden())
                    || (legacy_split && self.matches_split_paste(rule, shown))
            })
    }

    /// Before full-message pastes, Claude displayed part of the header before its paste marker.
    fn matches_split_paste(&self, rule: &PasteRule, shown: &str) -> bool {
        for prefix in ["📨 Message from ", "📨 Message "] {
            if let Some(pasted) = self.text.strip_prefix(prefix) {
                return facade_rules::is_legacy_split_paste(rule, shown, prefix, pasted);
            }
        }
        false
    }

    fn char_count(&self) -> usize {
        self.text.chars().count()
    }

    fn backspaces(&self) -> Vec<u8> {
        vec![b'\x7f'; self.char_count()]
    }
}

impl DraftCheck {
    fn new(text: String, typed: Option<u64>) -> Self {
        Self {
            paste: PasteDraft { text },
            previous: None,
            stable: None,
            observed: false,
            recovered: typed.is_none(),
            typed,
        }
    }

    /// A recovered paste can match either header until the draft distinguishes them. A placeholder
    /// that matches both can settle while it still shows neither header.
    fn matches(&mut self, rule: &PasteRule, reading: &BoxReading, legacy_split: bool) -> bool {
        let current = self.paste.matches(rule, reading, legacy_split);
        if self
            .previous
            .as_ref()
            .is_some_and(|paste| paste.matches(rule, reading, legacy_split))
        {
            if !current {
                self.paste = self.previous.take().expect("the previous draft matched");
            }
            return true;
        }
        if current {
            self.previous = None;
        }
        current
    }
}

impl Batch {
    fn deadline(&self) -> Option<Instant> {
        self.messages.iter().map(|m| m.deadline).min()
    }

    fn held(&self) -> usize {
        match self.phase {
            DeliveryPhase::Draft(_) => 1,
            DeliveryPhase::Submitting | DeliveryPhase::Clearing { .. } => 0,
        }
    }
}

/// Serial input state. The actor calls it exclusively; it never writes a PTY or takes a lock.
pub(crate) struct Typist {
    deliveries: DeliveryHandle,
    rule: Option<&'static Rule>,
    /// How the CLI takes typing where it reads console input records.
    console: Option<ConsoleTyping>,
    calls: VecDeque<Typing>,
    current: Option<Typing>,
    inbox: VecDeque<MessageTyping>,
    batch: Option<Batch>,
    /// A timed-out paste the terminal took before the CLI drew its draft.
    late_draft: Option<DraftCheck>,
    receipt: Option<Receipt>,
    submitted: Option<Submission>,
    entered: bool,
    paste_held: bool,
    /// The agent named in what a probe logs.
    agent: String,
    /// A probe under way: nothing else is typed until it is done.
    probing: Option<Probe>,
    /// What each row this run's probes tried was found to be: a row is tried once a run.
    probed: HashMap<Vec<LineCell>, ProbeVerdict>,
    /// The run's start waits on an input a probe may tell.
    probe_wanted: bool,
}

impl Typist {
    /// Uses the supplied delivery handle; later message operations may synchronously persist data.
    pub(crate) fn new(
        agent: &str,
        rule: Option<&'static Rule>,
        console: Option<ConsoleTyping>,
        deliveries: DeliveryHandle,
    ) -> Typist {
        Self {
            deliveries,
            rule,
            console,
            calls: VecDeque::new(),
            current: None,
            inbox: VecDeque::new(),
            batch: None,
            late_draft: None,
            receipt: None,
            submitted: None,
            entered: false,
            paste_held: false,
            agent: agent.to_string(),
            probing: None,
            probed: HashMap::new(),
            probe_wanted: false,
        }
    }

    /// A new run of the CLI starts: what the last run's probes found no longer holds, and a probe
    /// under way stops.
    pub(crate) fn clear_probes(&mut self) {
        self.probed.clear();
        self.probing = None;
        self.probe_wanted = false;
    }

    /// The run's start waits on an input that may hold a hint or a draft: it is probed once no call
    /// is typed and no paste is under way.
    pub(crate) fn want_probe(&mut self) {
        self.probe_wanted = true;
    }

    /// `reading` as this run's probes found its row, where one tried it: a hint reads as an empty
    /// input, a draft as a draft. Nothing is typed to find out.
    pub(crate) fn recall(&self, reading: BoxReading) -> BoxReading {
        let verdict = reading
            .line
            .as_ref()
            .filter(|_| reading.unsure)
            .and_then(|line| self.probed.get(&line.cells));
        let (state, what) = match verdict {
            Some(ProbeVerdict::Hint) => (InputState::Usable, "a hint"),
            Some(ProbeVerdict::Draft) => (InputState::Draft, "a draft"),
            _ => return reading,
        };
        BoxReading {
            info: InputInfo {
                state,
                evidence: format!("{}; a probe found it {what}", reading.info.evidence),
                ..reading.info
            },
            unsure: false,
            ..reading
        }
    }

    /// Whether `reading` is unsure of a row no probe of this run tried.
    fn unprobed(&self, reading: &BoxReading) -> bool {
        reading.unsure
            && reading
                .line
                .as_ref()
                .is_some_and(|line| !self.probed.contains_key(&line.cells))
    }

    /// Begins a probe of `reading`'s row with its space; the row counts as tried at once.
    fn begin_probe(&mut self, reading: &BoxReading, now: Instant, offset: u64, typed: u64) -> Step {
        let line = reading.line.clone().expect("an unprobed reading has a row");
        self.probed.insert(line.cells.clone(), ProbeVerdict::Other);
        self.probing = Some(Probe::new(line, now, typed));
        self.record_write(offset, 1, Duration::ZERO);
        Step {
            write: b" ".to_vec(),
            wake: Some(now + PROBE_READ),
        }
    }

    /// One step of the probe under way; none once it is done, what it found kept for the run.
    fn continue_probe(
        &mut self,
        mut probe: Probe,
        now: Instant,
        offset: u64,
        typed: u64,
        read_screen: &dyn Fn() -> BoxReading,
    ) -> Option<Step> {
        match probe.next(&self.agent, now, typed, read_screen) {
            Next::Wait(at) => {
                self.probing = Some(probe);
                Some(Step::wait(Some(at)))
            }
            Next::Backspace => {
                self.probing = Some(probe);
                self.record_write(offset, 1, Duration::ZERO);
                let mut write = Vec::new();
                Key::Backspace.write(false, &mut write);
                Some(Step {
                    write,
                    wake: Some(now + PROBE_READ),
                })
            }
            Next::Done(verdict) => {
                self.probed.insert(probe.row().to_vec(), verdict);
                None
            }
        }
    }

    /// Advances receipt accounting, then a probe, one call or delivery; persistence may block, no
    /// typist lock. `typed` counts the person's writes so far. `read_screen` reads the input box as
    /// the screen shows it, where `read` may say the run's start holds it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn step(
        &mut self,
        now: Instant,
        written: u64,
        queued: u64,
        modes: Modes,
        typed: u64,
        read: &dyn Fn() -> BoxReading,
        read_screen: &dyn Fn() -> BoxReading,
    ) -> Step {
        if let Some(receipt) = &mut self.receipt
            && receipt.arrived.is_none()
        {
            if !receipt.complete(written) {
                return self.stalled(now);
            }
            receipt.arrived = Some(now);
            if let Some(call) = &mut self.current {
                call.completed += receipt.boundaries.len();
            }
        }
        if self
            .current
            .as_ref()
            .is_some_and(|call| call.strokes.is_empty())
        {
            let call = self.current.take().expect("completed call");
            if let Some(submission) = call.submission {
                self.submitted = Some(*submission);
            }
            let _ = call.answer.send(Ok(()));
        }
        let pause = self
            .receipt
            .as_ref()
            .and_then(|receipt| receipt.paused(now));
        if let Some(probe) = self.probing.take()
            && let Some(step) = self.continue_probe(probe, now, queued, typed, read_screen)
        {
            return step;
        }
        if self.probe_wanted
            && pause.is_none()
            && self.current.is_none()
            && self.calls.is_empty()
            && !self.pasting()
        {
            self.probe_wanted = false;
            let reading = read_screen();
            if self.unprobed(&reading) {
                return self.begin_probe(&reading, now, queued, typed);
            }
        }
        if self.current.is_none() && !self.pasting() {
            self.current = self.calls.pop_front();
        }
        if self.current.is_some() {
            match pause {
                Some(at) => Step::wait(Some(at)),
                None => self.emit_call(queued, modes),
            }
        } else {
            self.advance_delivery(now, queued, modes, typed, read, pause)
        }
    }

    /// Stops every call and delivery with its actual write progress; delivery persistence may block.
    pub(crate) fn fail_all(&mut self, written: u64, why: &str) {
        (self.probing, self.probe_wanted) = (None, false);
        if let Some(mut call) = self.current.take() {
            let mut remaining = call.strokes.len();
            let mut partial = false;
            if let Some(receipt) = &self.receipt
                && receipt.arrived.is_none()
            {
                let (full, part) = receipt.progress(written);
                call.completed += full;
                remaining += receipt.boundaries.len() - full;
                partial = part;
            }
            let response = if remaining == 0 {
                Ok(())
            } else {
                Err(call.interruption(why, partial))
            };
            if remaining == 0
                && let Some(submission) = call.submission
            {
                self.submitted = Some(*submission);
            }
            let _ = call.answer.send(response);
        }
        for call in self.calls.drain(..) {
            let error = ErrorBody::new(Reason::Ended, format!("{why}; nothing was typed"));
            let _ = call.answer.send(Err(error));
        }
        if let Some(batch) = self.batch.take() {
            let (text_written, enter_written) = self.delivery_progress(&batch, written);
            let outcome = if enter_written == Some(true) {
                Outcome::Typed
            } else {
                Outcome::Failed {
                    reason: DeliveryFailure::Ended,
                    text_written,
                    enter_written,
                }
            };
            self.settle_delivery(&batch.messages, outcome);
        }
        let pending: Vec<_> = self.inbox.drain(..).collect();
        self.deliveries
            .settle(&numbers(&pending), Outcome::untyped(DeliveryFailure::Ended));
        self.late_draft = None;
        self.receipt = None;
    }

    /// Restores a persisted paste without retyping; persistence on refusal may block, no typist lock.
    pub(crate) fn finish_paste(
        &mut self,
        messages: Vec<MessageTyping>,
        previous_text: Option<String>,
    ) {
        match (self.rule, self.batch.is_none()) {
            (Some(_), true) => {
                let mut draft = DraftCheck::new(joined(&messages), None);
                draft.previous = previous_text.map(|text| PasteDraft { text });
                self.batch = Some(Batch {
                    messages,
                    phase: DeliveryPhase::Draft(draft),
                });
            }
            _ => self
                .deliveries
                .settle(&numbers(&messages), Outcome::UNCONFIRMED),
        }
    }

    /// Queues the first prompt ahead of unbegun deliveries, synchronously and without locks.
    pub(crate) fn deliver_first(&mut self, prompt: MessageTyping) {
        self.inbox.push_front(prompt);
    }

    /// Settles a prompt the run cannot take; persistence may block, no typist lock.
    pub(super) fn fail_prompt(&self, prompt: MessageTyping, reason: DeliveryFailure) {
        self.deliveries
            .settle(&[prompt.number], Outcome::untyped(reason));
    }

    /// Queues one program call synchronously; no I/O or locks.
    pub(crate) fn push(&mut self, typing: Typing) {
        self.calls.push_back(typing);
    }
    /// Queues one delivery synchronously; no I/O or locks.
    pub(crate) fn deliver(&mut self, message: MessageTyping) {
        self.inbox.push_back(message);
    }
    /// Suspends new pastes during takeover; no I/O or locks.
    pub(crate) fn hold_pastes(&mut self) {
        self.paste_held = true;
    }
    /// Reads the rule supplied at construction; no I/O or locks.
    pub(crate) fn paste_rule(&self) -> Option<&'static PasteRule> {
        self.rule.map(|rule| &rule.paste)
    }
    /// How the CLI takes typing where it reads console input records.
    pub(crate) fn console(&self) -> Option<ConsoleTyping> {
        self.console
    }
    /// Reads queued input's maximum size as the CLI's terminal takes it, excluding bytes already
    /// emitted; no I/O or locks.
    pub(crate) fn held_bytes(&self) -> usize {
        let console = self.console;
        self.calls
            .iter()
            .map(|call| call.most_bytes(console))
            .sum::<usize>()
            + self
                .current
                .as_ref()
                .map_or(0, |call| call.most_bytes(console))
            + self
                .inbox
                .iter()
                .map(|message| message.most_bytes(console))
                .sum::<usize>()
            + self.batch.as_ref().map_or(0, Batch::held)
    }
    /// Takes the last confirmed submission synchronously; no I/O or locks.
    pub(crate) fn take_submitted(&mut self) -> Option<Submission> {
        self.submitted.take()
    }
    /// Takes whether a program Enter was emitted; no I/O or locks.
    pub(crate) fn take_entered(&mut self) -> bool {
        std::mem::take(&mut self.entered)
    }
    /// Reads whether any input work remains; no I/O or locks.
    pub(crate) fn busy(&self) -> bool {
        self.types_calls() || self.reads_input() || self.probing.is_some() || self.probe_wanted
    }
    /// Reads whether a probe is under way; no I/O or locks.
    pub(crate) fn probing(&self) -> bool {
        self.probing.is_some()
    }
    /// Reads whether delivery has passed persistence and awaits settlement; no I/O or locks.
    pub(crate) fn pasting(&self) -> bool {
        self.batch.is_some()
    }
    /// Reads whether a program call is pending or active; no I/O or locks.
    pub(crate) fn types_calls(&self) -> bool {
        self.current.is_some() || !self.calls.is_empty()
    }
    /// Reads whether a sequence is queued or still awaiting its final write receipt.
    pub(crate) fn sequence_pending(&self) -> bool {
        self.current.as_ref().is_some_and(Typing::is_sequence)
            || self.calls.iter().any(Typing::is_sequence)
    }
    /// Reads whether message confirmation needs input observations; no I/O or locks.
    pub(crate) fn reads_input(&self) -> bool {
        self.batch.is_some() || self.late_draft.is_some() || !self.inbox.is_empty()
    }

    fn record_write(&mut self, offset: u64, length: usize, delay: Duration) {
        self.receipt = Some(Receipt {
            offset,
            boundaries: vec![offset + length as u64],
            arrived: None,
            delay,
        });
    }

    fn emit_call(&mut self, offset: u64, modes: Modes) -> Step {
        let paste_rule = self.paste_rule();
        let call = self.current.as_mut().expect("active call");
        let mut receipt = Receipt {
            offset,
            boundaries: Vec::new(),
            arrived: None,
            delay: Duration::ZERO,
        };
        let mut result = Step::default();
        while let Some(stroke) = call.strokes.pop_front() {
            stroke.write(modes, self.console, &mut result.write);
            self.entered |= matches!(stroke, Stroke::Key(Key::Enter));
            receipt.boundaries.push(offset + result.write.len() as u64);
            receipt.delay = stroke.delay(paste_rule, self.console);
            if call.is_sequence() || receipt.delay != Duration::ZERO {
                break;
            }
        }
        if !result.write.is_empty()
            && let Some(draft) = &mut self.late_draft
        {
            // A program call can edit the box just like keys from the person.
            draft.typed = None;
        }
        self.receipt = Some(receipt);
        result
    }

    fn stalled(&mut self, now: Instant) -> Step {
        let Some(batch) = &self.batch else {
            return Step::default();
        };
        let deadline = match batch.phase {
            DeliveryPhase::Draft(_) => batch.deadline(),
            // The write receipt confirms whether the submission key reached the terminal.
            // Post can still report an unknown outcome if the terminal hangs.
            DeliveryPhase::Submitting => None,
            DeliveryPhase::Clearing { until } => Some(until),
        };
        if deadline.is_some_and(|at| at <= now) {
            let batch = self.batch.take().expect("stalled delivery");
            let outcome = match batch.phase {
                DeliveryPhase::Clearing { .. } => Self::uncleared(),
                _ => Outcome::UNCONFIRMED,
            };
            self.settle_delivery(&batch.messages, outcome)
        } else {
            Step::wait(deadline)
        }
    }

    fn delivery_progress(&self, batch: &Batch, written: u64) -> (TextWritten, Option<bool>) {
        let full = self
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.complete(written));
        match &batch.phase {
            DeliveryPhase::Submitting => (TextWritten::Full, Some(full)),
            DeliveryPhase::Clearing { .. } => (TextWritten::Full, Some(false)),
            DeliveryPhase::Draft(draft) if draft.recovered => (TextWritten::Unknown, None),
            DeliveryPhase::Draft(_) => {
                let text = if full {
                    TextWritten::Full
                } else if self
                    .receipt
                    .as_ref()
                    .is_some_and(|receipt| written > receipt.offset)
                {
                    TextWritten::Partial
                } else {
                    TextWritten::None
                };
                (text, Some(false))
            }
        }
    }

    fn settle_delivery(&mut self, messages: &[MessageTyping], outcome: Outcome) -> Step {
        if outcome == Outcome::Typed
            && let Some(last) = messages.last()
        {
            self.submitted = Some((*last.submission).clone());
        }
        self.deliveries.settle(&numbers(messages), outcome);
        Step::wait((!self.inbox.is_empty() || !self.calls.is_empty()).then(Instant::now))
    }

    fn advance_delivery(
        &mut self,
        now: Instant,
        offset: u64,
        modes: Modes,
        typed: u64,
        read: &dyn Fn() -> BoxReading,
        paused: Option<Instant>,
    ) -> Step {
        let Some(rule) = self.paste_rule() else {
            let messages: Vec<_> = self.inbox.drain(..).collect();
            self.deliveries.settle(
                &numbers(&messages),
                Outcome::untyped(DeliveryFailure::Unsupported),
            );
            return Step::default();
        };
        if let Some(batch) = self.batch.take() {
            return match batch.phase {
                DeliveryPhase::Submitting => self.settle_delivery(&batch.messages, Outcome::Typed),
                DeliveryPhase::Clearing { until } => self.check_cleared(batch, read(), now, until),
                DeliveryPhase::Draft(draft) => self.check_draft(
                    batch.messages,
                    draft,
                    rule,
                    now,
                    offset,
                    typed,
                    modes.working,
                    read(),
                    paused,
                ),
            };
        }
        if self.paste_held || (self.inbox.is_empty() && self.late_draft.is_none()) {
            return Step::default();
        }
        let reading = read();
        let info = self.recall(reading.clone()).info;
        // An empty box can be the last frame before the CLI took the paste. Wait for
        // its draft before trusting the box again, and erase it only if it is still ours.
        if let Some(draft) = &self.late_draft {
            if draft.typed == Some(typed) && draft.paste.matches(rule, &reading, false) {
                let write = draft.paste.backspaces();
                self.late_draft = None;
                self.record_write(offset, write.len(), Duration::ZERO);
                return Step { write, wake: None };
            }
            if draft.typed != Some(typed)
                && info.state == InputState::Draft
                && reading.draft.is_some()
            {
                self.late_draft = None;
            }
        }
        let reason = match info.state {
            InputState::Usable => DeliveryFailure::Timeout,
            InputState::Draft => DeliveryFailure::InputDraft,
            InputState::Interaction => DeliveryFailure::InputInteraction,
            _ => DeliveryFailure::InputUnknown,
        };
        let mut expired = Vec::new();
        self.inbox.retain(|message| {
            if !self.deliveries.still_to_type(message.number) {
                return false;
            }
            if message.deadline <= now {
                expired.push(message.number);
                return false;
            }
            true
        });
        self.deliveries.settle(&expired, Outcome::untyped(reason));
        if self.inbox.is_empty() {
            return Step::default();
        }
        if self.late_draft.is_some() {
            return Step::wait(self.inbox.iter().map(|message| message.deadline).min());
        }
        if paused.is_none() && self.unprobed(&reading) {
            return self.begin_probe(&reading, now, offset, typed);
        }
        if info.state == InputState::Usable && paused.is_none() {
            let (index, next) = self
                .inbox
                .iter()
                .enumerate()
                .min_by_key(|(_, message)| (!message.prompt, message.number))
                .expect("at least one message");
            crate::gate_for_test("before-paste-begins");
            if let Some(granted) = self.deliveries.begin_paste(&[next.number]) {
                let next = self.inbox.remove(index).expect("admitted message");
                if granted.is_empty() {
                    return Step::wait((!self.inbox.is_empty()).then_some(now));
                }
                let draft = DraftCheck::new(next.text.clone(), Some(typed));
                let mut write = Vec::new();
                write_paste(
                    &draft.paste.text,
                    modes.bracketed_paste,
                    self.console,
                    &mut write,
                );
                let wake = (now + READ_INTERVAL).min(next.deadline);
                self.batch = Some(Batch {
                    messages: vec![next],
                    phase: DeliveryPhase::Draft(draft),
                });
                self.record_write(offset, write.len(), PASTE_DELAY);
                return Step {
                    write,
                    wake: Some(wake),
                };
            }
        }
        Step::wait(
            self.inbox
                .iter()
                .map(|message| message.deadline)
                .chain(paused)
                .min()
                .map(|due| due.min(now + READ_INTERVAL)),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn check_draft(
        &mut self,
        messages: Vec<MessageTyping>,
        mut draft: DraftCheck,
        rule: &PasteRule,
        now: Instant,
        offset: u64,
        typed: u64,
        working: bool,
        reading: BoxReading,
        paused: Option<Instant>,
    ) -> Step {
        let deadline = messages
            .iter()
            .map(|m| m.deadline)
            .min()
            .expect("started paste");
        let untouched = *draft.typed.get_or_insert(typed) == typed;
        let legacy_split = draft.recovered && self.rule.is_some_and(|rule| rule.cli == "claude");
        let own = if untouched && draft.matches(rule, &reading, legacy_split) {
            reading.draft.as_deref()
        } else {
            None
        };
        draft.observed |= own.is_some();
        let same = |observed: &str, shown: &str| {
            facade_rules::is_same_draft(observed, shown, &draft.paste.text, reading.draft_hidden())
        };
        if now >= deadline {
            let known_length = draft
                .previous
                .as_ref()
                .is_none_or(|previous| previous.char_count() == draft.paste.char_count());
            if known_length
                && own.is_some_and(|text| {
                    draft
                        .stable
                        .as_ref()
                        .is_none_or(|(_, shown)| same(text, shown))
                })
            {
                // The paste started in an empty input. The person's input has not changed,
                // and the input box still shows this paste alone. Backspace only that draft.
                let write = draft.paste.backspaces();
                let until = now + RESPONSE_GRACE;
                self.record_write(offset, write.len(), Duration::ZERO);
                self.batch = Some(Batch {
                    messages,
                    phase: DeliveryPhase::Clearing { until },
                });
                return Step {
                    write,
                    wake: Some(until),
                };
            }
            let outcome = if draft.recovered {
                Outcome::UNCONFIRMED
            } else {
                Self::uncleared()
            };
            if !draft.recovered
                && untouched
                && !draft.observed
                && self.recall(reading).info.state == InputState::Usable
            {
                self.late_draft = Some(draft);
            }
            return self.settle_delivery(&messages, outcome);
        }
        let wake = match own {
            None => {
                draft.stable = None;
                now + READ_INTERVAL
            }
            Some(observed) => {
                if draft
                    .stable
                    .as_ref()
                    .is_some_and(|(_, shown)| !same(observed, shown))
                {
                    draft.stable = None;
                }
                let since = draft
                    .stable
                    .get_or_insert_with(|| (now, observed.to_owned()))
                    .0;
                let settled = since + facade_rules::settle_time(rule, &draft.paste.text);
                if now >= settled && paused.is_none() {
                    crate::pause_for_test("before-message-enter");
                    // Recovered drafts can be first prompts, so retain Enter for them.
                    let working_message = working
                        && !draft.recovered
                        && !messages.iter().any(|message| message.prompt);
                    let mut write = Vec::new();
                    rule.submission_key(working_message)
                        .write(false, &mut write);
                    self.batch = Some(Batch {
                        messages,
                        phase: DeliveryPhase::Submitting,
                    });
                    self.record_write(offset, write.len(), Duration::ZERO);
                    crate::gate_for_test("message-enter");
                    return Step { write, wake: None };
                }
                settled.max(paused.unwrap_or(now))
            }
        };
        self.batch = Some(Batch {
            messages,
            phase: DeliveryPhase::Draft(draft),
        });
        Step::wait(Some(wake.min(deadline)))
    }

    fn uncleared() -> Outcome {
        Outcome::Failed {
            reason: DeliveryFailure::SubmissionUnconfirmed,
            text_written: TextWritten::Full,
            enter_written: Some(false),
        }
    }

    fn check_cleared(
        &mut self,
        batch: Batch,
        reading: BoxReading,
        now: Instant,
        until: Instant,
    ) -> Step {
        if self.recall(reading).info.state == InputState::Usable {
            return self.settle_delivery(
                &batch.messages,
                Outcome::Withdrawn {
                    reason: DeliveryFailure::Timeout,
                    text_written: TextWritten::Full,
                },
            );
        }
        if now >= until {
            return self.settle_delivery(&batch.messages, Self::uncleared());
        }
        self.batch = Some(batch);
        Step::wait(Some(until))
    }
}

fn numbers(messages: &[MessageTyping]) -> Vec<u64> {
    messages.iter().map(|message| message.number).collect()
}

fn joined(messages: &[MessageTyping]) -> String {
    let mut text = String::new();
    for (index, message) in messages.iter().enumerate() {
        if index > 0 {
            text.push_str(crate::PASTE_SEPARATOR);
        }
        text.push_str(&message.text);
    }
    text
}

/// How much longer a CLI that reads console input records takes to read `text` a key at a time:
/// its wait for each UTF-16 code unit.
fn console_time(console: Option<ConsoleTyping>, text: &str) -> Duration {
    console.map_or(Duration::ZERO, |console| {
        console.per_char * text.encode_utf16().count() as u32
    })
}

/// Whether characters above U+FFFF go as key-down records.
fn records_above_bmp(console: Option<ConsoleTyping>) -> bool {
    console.is_some_and(|console| console.records_above_bmp)
}

#[derive(Debug)]
enum Stroke {
    Paste(String),
    Key(Key),
}

impl Stroke {
    /// Its bytes, as the `console` takes them where the CLI reads console input records.
    fn write(&self, modes: Modes, console: Option<ConsoleTyping>, bytes: &mut Vec<u8>) {
        match self {
            Self::Key(Key::Character(c)) => {
                write_text(
                    c.encode_utf8(&mut [0; 4]),
                    records_above_bmp(console),
                    bytes,
                );
            }
            Self::Key(key) => key.write(modes.application_cursor_keys, bytes),
            Self::Paste(text) => write_paste(text, modes.bracketed_paste, console, bytes),
        }
    }

    /// The most bytes [`Stroke::write`] writes in either terminal mode for the `console`.
    fn most_bytes(&self, console: Option<ConsoleTyping>) -> usize {
        match self {
            Self::Paste(text) => paste_size(text, console),
            Self::Key(Key::Character(c)) => {
                text_size(c.encode_utf8(&mut [0; 4]), records_above_bmp(console))
            }
            Self::Key(key) => key.most_bytes(),
        }
    }

    fn delay(&self, rule: Option<&PasteRule>, console: Option<ConsoleTyping>) -> Duration {
        match self {
            Self::Key(Key::Escape) => ESCAPE_DELAY,
            Self::Key(_) => Duration::ZERO,
            Self::Paste(text) => {
                PASTE_DELAY
                    + rule.map_or(Duration::ZERO, |r| facade_rules::settle_time(r, text))
                    + console_time(console, text)
            }
        }
    }
}

/// A paste of `text`, between the paste brackets where the CLI asked for them. Its line breaks go
/// as the `console`'s line break key where it has one. Otherwise they go as returns between the
/// brackets, and as they are without brackets.
fn write_paste(text: &str, bracketed: bool, console: Option<ConsoleTyping>, bytes: &mut Vec<u8>) {
    let records = records_above_bmp(console);
    let line_break = console.and_then(|console| console.line_break);
    if !bracketed && line_break.is_none() {
        write_text(text, records, bytes);
        return;
    }
    if bracketed {
        bytes.extend(PASTE_START);
    }
    for (index, line) in text.replace("\r\n", "\n").split(['\n', '\r']).enumerate() {
        if index > 0 {
            match line_break {
                Some(key) => key.write_press(bytes),
                None => bytes.push(b'\r'),
            }
        }
        write_text(line, records, bytes);
    }
    if bracketed {
        bytes.extend(PASTE_END);
    }
}

/// The most bytes [`write_paste`] writes for `text`, with the paste brackets or without, as the
/// `console` takes it.
fn paste_size(text: &str, console: Option<ConsoleTyping>) -> usize {
    let brackets = PASTE_START.len() + PASTE_END.len();
    let size = brackets + text_size(text, records_above_bmp(console));
    let Some(key) = console.and_then(|console| console.line_break) else {
        // A line break goes as it is, or as one return between the brackets.
        return size;
    };
    // Each line break, a return, a line feed or the two together, goes as a press of the key.
    let ends = text
        .bytes()
        .filter(|byte| matches!(byte, b'\r' | b'\n'))
        .count();
    let breaks = ends - text.matches("\r\n").count();
    size - ends + breaks * key.press_len()
}

/// How many bytes [`write_text`] writes for `text`.
fn text_size(text: &str, records: bool) -> usize {
    if !records {
        return text.len();
    }
    text.chars()
        .map(|c| match c.len_utf8() {
            4 => key_down_records_len(c.encode_utf8(&mut [0; 4])),
            len => len,
        })
        .sum()
}

/// `text` as typed: with `records`, each character above U+FFFF as key-down records, which a
/// Windows console takes whole, and the rest as it is.
fn write_text(text: &str, records: bool, bytes: &mut Vec<u8>) {
    if !records {
        bytes.extend(text.as_bytes());
        return;
    }
    for c in text.chars() {
        let mut utf8 = [0; 4];
        let c = c.encode_utf8(&mut utf8);
        if c.len() == 4 {
            bytes.extend(key_down_records(c));
        } else {
            bytes.extend(c.as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use facade_base::key_input::NAMED_KEYS;
    use facade_base::model::message::{DeliveredVia, DeliveryStatus, MessagesWatchArgs};

    use super::*;
    use crate::messages::Messages;
    use std::sync::Arc;

    fn test_messages() -> Arc<Messages> {
        crate::messages::tests::messages().0
    }

    const ANY: Modes = Modes {
        bracketed_paste: true,
        application_cursor_keys: false,
        working: false,
    };
    const ALIASES: [&str; 6] = [
        "Return",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
    ];

    fn names(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|key| key.to_string()).collect()
    }

    /// The agent's input as the actor keeps it: bytes queued, how many reached the terminal, and
    /// how the screen reads it.
    struct Terminal {
        queued: Vec<u8>,
        written: usize,
        reading: BoxReading,
    }

    impl Default for Terminal {
        fn default() -> Self {
            Terminal {
                queued: Vec::new(),
                written: 0,
                reading: input(InputState::Unknown, None),
            }
        }
    }

    /// An input reading: its state and a draft's text.
    fn input(state: InputState, draft: Option<&str>) -> BoxReading {
        BoxReading {
            info: InputInfo {
                state,
                evidence: String::new(),
                mechanism: None,
                hidden: None,
            },
            draft: draft.map(str::to_string),
            line: None,
            unsure: false,
        }
    }

    impl Terminal {
        fn step(&mut self, typist: &mut Typist, now: Instant, modes: Modes) -> Option<Instant> {
            let reading = self.reading.clone();
            let step = typist.step(
                now,
                self.written as u64,
                self.queued.len() as u64,
                modes,
                0,
                &|| reading.clone(),
                &|| reading.clone(),
            );
            self.queued.extend(step.write);
            step.wake
        }

        /// Writes everything queued to the terminal and returns it.
        fn write_all(&mut self) -> Vec<u8> {
            let new = self.queued[self.written..].to_vec();
            self.written = self.queued.len();
            new
        }
    }

    #[test]
    fn keys_are_named_in_any_letter_case_and_characters_exactly() {
        for (name, key) in [
            ("Enter", Key::Enter),
            ("return", Key::Enter),
            ("ESC", Key::Escape),
            ("escape", Key::Escape),
            ("shift+tab", Key::ShiftTab),
            ("arrowup", Key::Up),
            ("PAGEDOWN", Key::PageDown),
            ("Ctrl+C", Key::Ctrl(3)),
            ("ctrl+a", Key::Ctrl(1)),
            ("CTRL+Z", Key::Ctrl(26)),
            ("y", Key::Character('y')),
            ("Y", Key::Character('Y')),
            (" ", Key::Character(' ')),
            ("é", Key::Character('é')),
            ("界", Key::Character('界')),
        ] {
            assert_eq!(Key::named(name), Some(key), "{name}");
        }
        for name in [
            "", "F13", "Ctrl+1", "Ctrl+", "Ctrl+AB", "Alt+x", "yes", "\u{1b}", "\t", "\u{7f}",
            "\u{85}",
        ] {
            assert_eq!(Key::named(name), None, "{name:?}");
        }
        for name in NAMED_KEYS.into_iter().chain(ALIASES) {
            assert!(
                KNOWN_KEYS.contains(name),
                "the error for an unknown key names {name}"
            );
        }
    }

    #[test]
    fn keys_go_as_a_terminal_sends_them_in_the_cli_s_cursor_mode() {
        let sent = |name: &str, application: bool| {
            let mut out = Vec::new();
            Key::named(name).unwrap().write(application, &mut out);
            out
        };
        assert_eq!(sent("Up", false), b"\x1b[A");
        assert_eq!(sent("Up", true), b"\x1bOA");
        assert_eq!(sent("Home", true), b"\x1bOH");
        assert_eq!(sent("End", false), b"\x1b[F");
        assert_eq!(
            sent("PageUp", true),
            b"\x1b[5~",
            "only cursor keys, Home, and End change"
        );
        assert_eq!(sent("Ctrl+C", false), [3]);
        assert_eq!(sent("Shift+Tab", false), b"\x1b[Z");
        assert_eq!(sent("界", false), "界".as_bytes());
        for name in NAMED_KEYS.into_iter().chain(ALIASES) {
            assert_eq!(
                sent(name, false).len(),
                sent(name, true).len(),
                "{name} counts the same in both modes"
            );
        }
    }

    #[test]
    fn a_paste_is_bracketed_with_carriage_returns_only_when_the_cli_asked_for_bracketed_paste() {
        let pasted = |bracketed: bool| {
            let mut out = Vec::new();
            write_paste("one\ntwo\r\nthree\rfour\tend", bracketed, None, &mut out);
            out
        };
        assert_eq!(
            pasted(true),
            b"\x1b[200~one\rtwo\rthree\rfour\tend\x1b[201~"
        );
        assert_eq!(pasted(false), b"one\ntwo\r\nthree\rfour\tend");
        let (typing, _) = Typing::text("one\ntwo\r\n".into(), true, Sender::person()).unwrap();
        let mut out = Vec::new();
        typing
            .strokes
            .iter()
            .for_each(|stroke| stroke.write(ANY, None, &mut out));
        assert!(
            out.len() <= typing.most_bytes(None),
            "the most bytes cover what is written"
        );
    }

    /// A CLI that reads console input records, whose Enter submits and which puts a line break in
    /// its input for Shift+Enter.
    const CONSOLE: ConsoleTyping = ConsoleTyping {
        per_char: Duration::from_millis(3),
        records_above_bmp: true,
        line_break: Some(facade_base::terminal::KeyRecord::SHIFT_ENTER),
    };
    /// Shift+Enter pressed: going down, then up.
    const SHIFT_ENTER: &[u8] = b"\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_";

    #[test]
    fn a_line_break_of_a_paste_goes_as_the_console_s_line_break_key_and_never_as_a_return() {
        let text = "📨 Message m1 from s01\none\r\ntwo\rthree\n\nfour";
        let lines = [
            [key_down_records("📨"), b" Message m1 from s01".to_vec()].concat(),
            b"one".to_vec(),
            b"two".to_vec(),
            b"three".to_vec(),
            Vec::new(),
            b"four".to_vec(),
        ];
        for bracketed in [true, false] {
            let mut out = Vec::new();
            write_paste(text, bracketed, Some(CONSOLE), &mut out);
            let mut expected = lines.join(SHIFT_ENTER);
            if bracketed {
                expected = [PASTE_START, &expected, PASTE_END].concat();
            }
            assert_eq!(out, expected, "bracketed: {bracketed}");
            assert!(!out.contains(&b'\r') && !out.contains(&b'\n'));
        }
        // A CLI without the key has its line breaks as before.
        let without = ConsoleTyping {
            line_break: None,
            ..CONSOLE
        };
        for (bracketed, expected) in [
            (true, &b"\x1b[200~one\rtwo\x1b[201~"[..]),
            (false, b"one\r\ntwo"),
        ] {
            let mut out = Vec::new();
            write_paste("one\r\ntwo", bracketed, Some(without), &mut out);
            assert_eq!(out, expected, "bracketed: {bracketed}");
        }
    }

    #[test]
    fn a_message_with_lines_is_pasted_with_the_console_s_line_break_key() {
        let post = test_messages();
        let start = Instant::now();
        let (typing, _) = message(&post, "one\ntwo", start + Duration::from_secs(30));
        let mut typist = Typist::new(
            "a1",
            Some(facade_rules::find("codex").unwrap().unwrap()),
            Some(CONSOLE),
            post.delivery_handle(),
        );
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        assert_eq!(
            terminal.write_all(),
            [PASTE_START, b"one", SHIFT_ENTER, b"two", PASTE_END].concat()
        );
    }

    /// The bytes a paste is counted are never fewer than it writes, with the paste brackets or
    /// without, for a CLI that reads console input records or not: line breaks alone, of each
    /// kind and together, blank lines, characters above U+FFFF alone and among the rest. Where a
    /// key breaks the lines, the count is what a bracketed paste writes.
    #[test]
    fn a_paste_is_counted_as_its_bytes_in_the_terminal_at_most() {
        let records_only = ConsoleTyping {
            line_break: None,
            ..CONSOLE
        };
        let key_only = ConsoleTyping {
            records_above_bmp: false,
            ..CONSOLE
        };
        let texts = [
            String::new(),
            "plain".into(),
            "\n".repeat(1000),
            "\r\n".repeat(1000),
            "\r".repeat(1000),
            "\n\r\n\r\r\n\n\n\r\r".repeat(100),
            "😀".repeat(1000),
            "a😀\r\n\n😀b\r😀\u{ffff}\u{10ffff}\r\n".repeat(100),
        ];
        for text in &texts {
            for console in [None, Some(CONSOLE), Some(records_only), Some(key_only)] {
                let counted = paste_size(text, console);
                for bracketed in [true, false] {
                    let mut out = Vec::new();
                    write_paste(text, bracketed, console, &mut out);
                    assert!(
                        out.len() <= counted,
                        "{} > {counted}: {console:?}, bracketed: {bracketed}, {:?}",
                        out.len(),
                        &text[..text.len().min(20)]
                    );
                    if bracketed && console.is_some_and(|console| console.line_break.is_some()) {
                        assert_eq!(out.len(), counted, "{console:?}");
                    }
                }
            }
        }
    }

    /// A call, a sequence and a message are counted as the CLI's terminal takes them: for Codex
    /// on Windows, 30,000 lines of a text of 60,012 bytes as written take 1,110,012 bytes.
    #[test]
    fn a_call_a_sequence_and_a_message_are_counted_as_the_console_takes_them() {
        let text = "a\n".repeat(30_000);
        let (typing, _) = Typing::text(text.clone(), false, Sender::person()).unwrap();
        assert_eq!(
            typing.most_bytes(None),
            60_012,
            "as the published preflight counts"
        );
        let mut out = Vec::new();
        for stroke in &typing.strokes {
            stroke.write(ANY, Some(CONSOLE), &mut out);
        }
        assert_eq!(out.len(), 1_110_012);
        assert_eq!(typing.most_bytes(Some(CONSOLE)), out.len());
        assert!(typing.most_bytes(Some(CONSOLE)) > MAX_INPUT_BYTES);

        let steps = vec![
            InputStep::Text {
                text: "one\r\n\r\ntwo😀".into(),
            },
            InputStep::Key { key: "😀".into() },
            InputStep::Key {
                key: "Enter".into(),
            },
        ];
        let (sequence, _) = Typing::sequence(steps).unwrap();
        let mut out = Vec::new();
        for stroke in &sequence.strokes {
            stroke.write(ANY, Some(CONSOLE), &mut out);
        }
        assert_eq!(sequence.most_bytes(Some(CONSOLE)), out.len());
        assert!(sequence.most_bytes(None) < out.len());

        let post = test_messages();
        let (message, _) = message(&post, &text[..2_000], Instant::now());
        let mut out = Vec::new();
        write_paste(&message.text, true, Some(CONSOLE), &mut out);
        assert_eq!(
            message.most_bytes(Some(CONSOLE)),
            out.len() + Key::Enter.most_bytes()
        );
    }

    #[test]
    fn text_takes_printable_characters_tabs_and_line_breaks_only() {
        assert!(Typing::text("a\tb\nc\r\nd 界".into(), false, Sender::person()).is_ok());
        let escape = Typing::text("ab\u{1b}[A".into(), false, Sender::person()).unwrap_err();
        assert!(
            escape.starts_with("text contains the control character U+001B at character 3;")
                && escape.ends_with("as keys"),
            "{escape}"
        );
        assert!(
            Typing::text("x\u{9b}".into(), false, Sender::person())
                .unwrap_err()
                .contains("U+009B"),
            "C1 controls are refused too"
        );
        assert_eq!(
            Typing::text(String::new(), false, Sender::person()).unwrap_err(),
            "text is empty and enter is false: there is nothing to type"
        );
        let (enter_alone, _) = Typing::text(String::new(), true, Sender::person()).unwrap();
        assert!(
            matches!(enter_alone.strokes.as_slices().0, [Stroke::Key(Key::Enter)]),
            "{enter_alone:?}"
        );
        assert_eq!(
            Typing::keys(&[]).unwrap_err(),
            "keys is empty; give at least one key"
        );
        let unknown = Typing::keys(&names(&["Esc", "F13", "yes"])).unwrap_err();
        assert!(
            unknown.starts_with("unknown keys: \"F13\", \"yes\"; keys are Enter (or Return)"),
            "{unknown}"
        );
    }

    /// The text goes first, alone. Its Enter waits until the whole text reached the terminal and
    /// 0.1 seconds more, then goes in a write of its own. The call is answered once the Enter
    /// reached the terminal.
    #[test]
    fn enter_goes_in_a_write_of_its_own_after_the_text_reached_the_terminal() {
        let mut typist = Typist::new("a1", None, None, test_messages().delivery_handle());
        let mut terminal = Terminal::default();
        let (typing, mut answer) =
            Typing::text("hello\nworld".into(), true, Sender::person()).unwrap();
        typist.push(typing);
        let start = Instant::now();
        assert_eq!(
            terminal.step(&mut typist, start, ANY),
            None,
            "it waits for the text to reach the terminal"
        );
        // Queued behind other input, the text has not reached the terminal: nothing more goes,
        // however long that takes.
        assert_eq!(
            terminal.step(&mut typist, start + Duration::from_secs(5), ANY),
            None
        );
        assert_eq!(terminal.write_all(), b"\x1b[200~hello\rworld\x1b[201~");
        let reached = start + Duration::from_secs(6);
        assert_eq!(
            terminal.step(&mut typist, reached, ANY),
            Some(reached + PASTE_DELAY),
            "the pause counts from when the text reached the terminal"
        );
        assert_eq!(
            terminal.step(&mut typist, reached + Duration::from_millis(99), ANY),
            Some(reached + PASTE_DELAY)
        );
        assert!(
            terminal.write_all().is_empty(),
            "nothing goes during the pause"
        );
        assert_eq!(terminal.step(&mut typist, reached + PASTE_DELAY, ANY), None);
        assert_eq!(terminal.write_all(), b"\r");
        assert!(
            answer.try_recv().is_err(),
            "the call is answered once its Enter reached the terminal"
        );
        assert_eq!(typist.take_submitted(), None);
        terminal.step(&mut typist, reached + PASTE_DELAY, ANY);
        assert_eq!(answer.try_recv(), Ok(Ok(())));
        let submitted = typist.take_submitted().expect("the text was submitted");
        assert_eq!(
            submitted,
            Submission {
                text: "hello\nworld".into(),
                sender: Sender::person()
            }
        );
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    /// Text with Enter is submitted once its Enter reached the terminal. Text alone, keys, an Enter
    /// alone, and a call cut off before its Enter reached the terminal submit nothing.
    #[test]
    fn only_text_whose_enter_reached_the_terminal_is_submitted() {
        let mut typist = Typist::new("a1", None, None, test_messages().delivery_handle());
        let mut terminal = Terminal::default();
        for typing in [
            Typing::text("sent".into(), true, Sender::person()),
            Typing::text("draft".into(), false, Sender::person()),
            Typing::keys(&names(&["Enter"])),
            Typing::text(String::new(), true, Sender::person()),
        ] {
            typist.push(typing.unwrap().0);
        }
        let mut now = Instant::now();
        for _ in 0..12 {
            terminal.step(&mut typist, now, ANY);
            terminal.write_all();
            now += PASTE_DELAY;
        }
        assert!(!typist.busy());
        assert_eq!(
            typist
                .take_submitted()
                .map(|submitted| submitted.text)
                .as_deref(),
            Some("sent")
        );
        assert_eq!(typist.take_submitted(), None, "taken once");
        typist.push(
            Typing::text("cut".into(), true, Sender::person())
                .unwrap()
                .0,
        );
        terminal.step(&mut typist, now, ANY);
        terminal.write_all();
        typist.fail_all(terminal.written as u64, "the agent ended");
        assert_eq!(
            typist.take_submitted(),
            None,
            "its Enter never reached the terminal"
        );
    }

    /// After an Escape, the next key waits 50 ms; keys without an Escape between them go in one
    /// write.
    #[test]
    fn the_key_after_an_escape_waits() {
        let mut typist = Typist::new("a1", None, None, test_messages().delivery_handle());
        let mut terminal = Terminal::default();
        let (typing, mut answer) = Typing::keys(&names(&[
            "Down", "Down", "Escape", "x", "Esc", "Esc", "Enter",
        ]))
        .unwrap();
        typist.push(typing);
        let start = Instant::now();
        terminal.step(&mut typist, start, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[B\x1b[B\x1b",
            "keys up to and with the first Escape"
        );
        assert_eq!(
            terminal.step(&mut typist, start, ANY),
            Some(start + ESCAPE_DELAY)
        );
        assert_eq!(terminal.step(&mut typist, start + ESCAPE_DELAY, ANY), None);
        assert_eq!(terminal.write_all(), b"x\x1b");
        let second = start + ESCAPE_DELAY * 2;
        assert_eq!(
            terminal.step(&mut typist, second, ANY),
            Some(second + ESCAPE_DELAY)
        );
        terminal.step(&mut typist, second + ESCAPE_DELAY, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b",
            "two Escapes never go in one write"
        );
        let third = second + ESCAPE_DELAY * 2;
        terminal.step(&mut typist, third, ANY);
        terminal.step(&mut typist, third + ESCAPE_DELAY, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.step(&mut typist, third + ESCAPE_DELAY, ANY);
        assert_eq!(answer.try_recv(), Ok(Ok(())));
    }

    /// The pause after a call's last Escape or paste holds the next call's first stroke too.
    #[test]
    fn the_next_call_waits_for_the_pause_after_the_last_one() {
        let start = Instant::now();
        for (first, pause) in [
            (Typing::keys(&names(&["Escape"])).unwrap(), ESCAPE_DELAY),
            (
                Typing::text("draft".into(), false, Sender::person()).unwrap(),
                PASTE_DELAY,
            ),
        ] {
            let mut typist = Typist::new("a1", None, None, test_messages().delivery_handle());
            let mut terminal = Terminal::default();
            let (first, mut answered) = first;
            typist.push(first);
            terminal.step(&mut typist, start, ANY);
            terminal.write_all();
            assert_eq!(
                terminal.step(&mut typist, start, ANY),
                None,
                "a call with nothing after it waits for no pause"
            );
            assert_eq!(
                answered.try_recv(),
                Ok(Ok(())),
                "it is answered once it reached the terminal"
            );
            let (enter, mut entered) = Typing::keys(&names(&["Enter"])).unwrap();
            typist.push(enter);
            let later = start + pause / 2;
            assert_eq!(terminal.step(&mut typist, later, ANY), Some(start + pause));
            assert!(terminal.write_all().is_empty());
            terminal.step(&mut typist, start + pause, ANY);
            assert_eq!(terminal.write_all(), b"\r");
            terminal.step(&mut typist, start + pause, ANY);
            assert_eq!(entered.try_recv(), Ok(Ok(())));
        }
    }

    /// Calls are typed one at a time: the next starts once the one before was answered.
    #[test]
    fn calls_are_typed_whole_in_the_order_they_came() {
        let mut typist = Typist::new("a1", None, None, test_messages().delivery_handle());
        let mut terminal = Terminal::default();
        let (first, mut first_answer) =
            Typing::text("first".into(), true, Sender::person()).unwrap();
        let (second, mut second_answer) = Typing::keys(&names(&["a", "b"])).unwrap();
        typist.push(first);
        typist.push(second);
        let start = Instant::now();
        terminal.step(&mut typist, start, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[200~first\x1b[201~",
            "only the first call's text"
        );
        let due = terminal.step(&mut typist, start, ANY).unwrap();
        terminal.step(&mut typist, due, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\r",
            "its Enter before anything of the next call"
        );
        terminal.step(&mut typist, due, ANY);
        assert_eq!(first_answer.try_recv(), Ok(Ok(())));
        assert_eq!(
            terminal.write_all(),
            b"ab",
            "the next call follows at once: an Enter needs no pause"
        );
        terminal.step(&mut typist, due, ANY);
        assert_eq!(second_answer.try_recv(), Ok(Ok(())));
    }

    #[test]
    fn the_bytes_of_waiting_calls_count_until_they_are_written() {
        let mut typist = Typist::new("a1", None, None, test_messages().delivery_handle());
        let (text, _) = Typing::text("12345".into(), true, Sender::person()).unwrap();
        let (keys, _) = Typing::keys(&names(&["Up", "Delete", "界"])).unwrap();
        typist.push(text);
        typist.push(keys);
        assert_eq!(typist.held_bytes(), (6 + 5 + 6 + 1) + (3 + 4 + 3));
        let mut terminal = Terminal::default();
        terminal.step(&mut typist, Instant::now(), ANY);
        assert_eq!(
            typist.held_bytes(),
            1 + 10,
            "the paste moved to the queue; its Enter and the keys wait"
        );
    }

    /// A call that stops says what of it was typed: whole strokes that reached the terminal, and a
    /// stroke cut off partway. A call whose strokes all reached the terminal before typing stopped
    /// succeeds.
    #[test]
    fn a_call_that_stops_says_what_of_it_was_typed() {
        // Types a call, letting each write reach the terminal and each of its first `pauses` pauses
        // pass, then stops typing with the last `short` bytes queued still short of the terminal.
        let stopped =
            |(typing, mut answer): (Typing, TypingAnswer), pauses: usize, short: usize| {
                let mut typist = Typist::new("a1", None, None, test_messages().delivery_handle());
                let (waiting, mut waiting_answer) = Typing::keys(&names(&["z"])).unwrap();
                typist.push(typing);
                typist.push(waiting);
                let mut terminal = Terminal::default();
                let mut now = Instant::now();
                terminal.step(&mut typist, now, ANY);
                for _ in 0..pauses {
                    terminal.write_all();
                    now = terminal.step(&mut typist, now, ANY).expect("a pause");
                    terminal.step(&mut typist, now, ANY);
                }
                typist.fail_all((terminal.queued.len() - short) as u64, "#a3 ended");
                assert_eq!(
                    facts(waiting_answer.try_recv().unwrap()),
                    Err((
                        Reason::Ended,
                        "#a3 ended; nothing was typed".into(),
                        None,
                        None,
                        None
                    ))
                );
                assert!(!typist.busy() && typist.held_bytes() == 0);
                facts(answer.try_recv().unwrap())
            };
        let failed = |typed: &str, text_written: TextWritten| {
            let message = format!("#a3 ended; {typed}");
            Err(match text_written {
                TextWritten::None => (Reason::Ended, message, None, None, None),
                written => (
                    Reason::PartialInput,
                    message,
                    Some(written),
                    Some(false),
                    None,
                ),
            })
        };
        let pressed = |typed: &str, keys_sent: u32| {
            Err((
                Reason::PartialInput,
                format!("#a3 ended; {typed}"),
                None,
                None,
                Some(keys_sent),
            ))
        };
        // The paste is 17 bytes with its brackets; its Enter is 1.
        let text = || Typing::text("hello".into(), true, Sender::person()).unwrap();
        assert_eq!(
            stopped(text(), 0, 17),
            failed("nothing was typed", TextWritten::None)
        );
        assert_eq!(
            stopped(text(), 0, 14),
            failed("part of the text was typed", TextWritten::Partial)
        );
        assert_eq!(
            stopped(text(), 0, 0),
            failed("the text was typed but not its Enter", TextWritten::Full)
        );
        assert_eq!(
            stopped(text(), 1, 1),
            failed("the text was typed but not its Enter", TextWritten::Full)
        );
        assert_eq!(stopped(text(), 1, 0), Ok(()));
        // Up and Escape go together, then Down and Enter after the pause.
        let keys = || Typing::keys(&names(&["Up", "Escape", "Down", "Enter"])).unwrap();
        assert_eq!(
            stopped(keys(), 0, 4),
            failed("nothing was typed", TextWritten::None)
        );
        assert_eq!(
            stopped(keys(), 0, 2),
            pressed("0 of 4 keys and part of the next were pressed", 0)
        );
        assert_eq!(
            stopped(keys(), 0, 1),
            pressed("1 of 4 keys were pressed", 1)
        );
        assert_eq!(
            stopped(keys(), 0, 0),
            pressed("2 of 4 keys were pressed", 2)
        );
        assert_eq!(
            stopped(keys(), 1, 1),
            pressed("3 of 4 keys were pressed", 3)
        );
    }

    /// An answer's facts: its reason, message, and what went in.
    type Facts = (
        Reason,
        String,
        Option<TextWritten>,
        Option<bool>,
        Option<u32>,
    );

    fn facts(answer: Result<(), ErrorBody>) -> Result<(), Facts> {
        answer.map_err(|error| {
            (
                error.data.reason,
                error.message,
                error.data.text_written,
                error.data.enter_written,
                error.data.keys_sent,
            )
        })
    }

    /// A typist for the CLI of rule `cli`, which settles its messages in `post`.
    fn typist_for(cli: &str, post: &Arc<Messages>) -> Typist {
        Typist::new(
            "a1",
            Some(facade_rules::find(cli).unwrap().unwrap()),
            None,
            post.delivery_handle(),
        )
    }

    /// A message from #a2 Nova to #a1, kept in `post`, as its recipient's terminal shows `text`.
    /// Returns it for the typist, and its number.
    fn message(post: &Messages, text: &str, deadline: Instant) -> (MessageTyping, u64) {
        let (typing, number, _) = message_told(post, text, deadline);
        (typing, number)
    }

    /// What its send is told of a message, once it is settled.
    type Told = tokio::sync::watch::Receiver<Option<crate::messages::Settled>>;

    /// A message as [`message`] keeps it, with what its send is told.
    fn message_told(post: &Messages, text: &str, deadline: Instant) -> (MessageTyping, u64, Told) {
        let (posted, told) =
            crate::messages::tests::post_new(post, crate::messages::tests::message(0, "a1"));
        let number = crate::messages::number(&posted);
        let said = Submission {
            text: text.into(),
            sender: Sender {
                from: "a2".into(),
                from_name: Some("Nova".into()),
            },
        };
        (
            MessageTyping::new(text.into(), number, deadline, said),
            number,
            told,
        )
    }

    /// What became of message `number`, which its failure withdrew from its recipient's inbox, as
    /// its send was told.
    fn withdrawn(post: &Messages, number: u64, told: &Told) -> Became {
        assert!(
            post.message(&format!("m{number}")).is_none(),
            "#m{number} is withdrawn"
        );
        let Some(crate::messages::Settled::Withdrawn(message)) = told.borrow().clone() else {
            panic!("#m{number}'s send was told nothing");
        };
        let delivery = message.delivery;
        (
            delivery.status,
            delivery.reason,
            delivery.text_written,
            delivery.enter_written,
            delivery.delivered_via,
        )
    }

    /// What became of a message: its status, why it failed, what of it reached the terminal, and
    /// how it was delivered.
    type Became = (
        DeliveryStatus,
        Option<DeliveryFailure>,
        TextWritten,
        Option<bool>,
        Option<DeliveredVia>,
    );

    /// What became of message `number`, as the post office keeps it.
    fn became(post: &Messages, number: u64) -> Became {
        let delivery = post
            .message(&format!("m{number}"))
            .expect("a kept message")
            .delivery;
        (
            delivery.status,
            delivery.reason,
            delivery.text_written,
            delivery.enter_written,
            delivery.delivered_via,
        )
    }

    /// Still being delivered: nothing settled it.
    const PENDING: Became = (
        DeliveryStatus::Pending,
        None,
        TextWritten::None,
        Some(false),
        None,
    );
    /// Typed and submitted.
    const TYPED: Became = (
        DeliveryStatus::Success,
        None,
        TextWritten::Full,
        Some(true),
        Some(DeliveredVia::TypedIntoInput),
    );
    /// Pasted, and what became of it not known.
    const NOT_KNOWN: Became = (
        DeliveryStatus::Failure,
        Some(DeliveryFailure::SubmissionUnconfirmed),
        TextWritten::Unknown,
        None,
        None,
    );

    /// Not delivered, for `reason`, with what of it reached the terminal.
    fn failed(reason: DeliveryFailure, text_written: TextWritten, enter_written: bool) -> Became {
        (
            DeliveryStatus::Failure,
            Some(reason),
            text_written,
            Some(enter_written),
            None,
        )
    }

    /// How message `number` was delivered, if it was.
    fn delivered_via(post: &Messages, number: u64) -> Option<DeliveredVia> {
        became(post, number).4
    }

    /// A message waits while a draft holds the input and goes in as one paste once it is empty. Its
    /// Enter goes once the input shows it as its own draft for its CLI's settle time, and it is
    /// delivered once Enter reaches the terminal.
    #[test]
    fn a_message_waits_for_an_empty_input_and_gets_its_enter_only_over_its_own_draft() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal::default();
        let start = Instant::now();
        let (typing, number) = message(&post, "hello there", start + Duration::from_secs(30));
        typist.deliver(typing);
        terminal.reading = input(InputState::Draft, Some("a person's draft"));
        assert_eq!(
            terminal.step(&mut typist, start, ANY),
            Some(start + READ_INTERVAL),
            "it reads the input again"
        );
        assert!(
            terminal.write_all().is_empty(),
            "nothing is typed over a draft"
        );
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~hello there\x1b[201~");
        terminal.step(&mut typist, start + Duration::from_millis(1010), ANY);
        // Another draft is not its own: no Enter over it.
        terminal.reading = input(InputState::Draft, Some("hello there and more"));
        terminal.step(&mut typist, start + Duration::from_secs(2), ANY);
        assert!(terminal.write_all().is_empty());
        terminal.reading = input(InputState::Draft, Some("hello there"));
        terminal.step(&mut typist, start + Duration::from_millis(2900), ANY);
        terminal.reading = input(InputState::Draft, Some("hello there!"));
        terminal.step(&mut typist, start + Duration::from_millis(2950), ANY);
        // Its own draft again: the settle time starts again.
        terminal.reading = input(InputState::Draft, Some("hello there"));
        let shown = start + Duration::from_secs(3);
        assert_eq!(
            terminal.step(&mut typist, shown, ANY),
            Some(shown + Duration::from_millis(80)),
            "the fake CLI's settle time"
        );
        terminal.step(&mut typist, shown + Duration::from_millis(80), ANY);
        assert_eq!(became(&post, number), PENDING, "Enter is only queued");
        assert_eq!(terminal.write_all(), b"\r");
        terminal.step(&mut typist, shown + Duration::from_millis(300), ANY);
        assert_eq!(became(&post, number), TYPED);
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    /// A run's start prompt goes first, ahead of every waiting message.
    #[test]
    fn a_start_prompt_goes_before_the_messages_waiting_and_in_a_paste_of_its_own() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("held")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (first, first_number) = message(&post, "first", start + Duration::from_secs(30));
        let (second, second_number) = message(&post, "second", start + Duration::from_secs(30));
        typist.deliver(first);
        terminal.step(&mut typist, start, ANY);
        typist.deliver(second);
        terminal.step(&mut typist, start + Duration::from_millis(500), ANY);
        let (posted, _) =
            crate::messages::tests::post_new(&post, crate::messages::tests::message(0, "a1"));
        let prompt_number = crate::messages::number(&posted);
        let said = Submission {
            text: "fix it".into(),
            sender: Sender::person(),
        };
        typist.deliver_first(MessageTyping::start_prompt(
            "fix it".into(),
            prompt_number,
            start + Duration::from_secs(30),
            said,
        ));
        let (third, third_number) = message(&post, "third", start + Duration::from_secs(30));
        typist.deliver(third);
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[200~fix it\x1b[201~",
            "the prompt alone, first"
        );
        terminal.step(&mut typist, start + Duration::from_millis(1010), ANY);
        terminal.reading = input(InputState::Draft, Some("fix it"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(2), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(3), ANY);
        assert_eq!(became(&post, prompt_number), TYPED);
        assert_eq!(
            typist.take_submitted().map(|said| said.text),
            Some("fix it".into())
        );
        terminal.step(&mut typist, start + Duration::from_millis(3200), ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[200~first\x1b[201~",
            "the first of the waiting messages follows"
        );
        for number in [first_number, second_number, third_number] {
            assert_eq!(became(&post, number), PENDING);
        }
    }

    /// A message fails at its deadline, saying what held the input, with nothing typed.
    #[test]
    fn a_message_fails_at_its_deadline_saying_what_held_the_input() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(5);
        let post = test_messages();
        for (state, draft, reason) in [
            (InputState::Draft, Some("hold"), DeliveryFailure::InputDraft),
            (
                InputState::Interaction,
                None,
                DeliveryFailure::InputInteraction,
            ),
            (InputState::Unknown, None, DeliveryFailure::InputUnknown),
        ] {
            let mut typist = typist_for("fake", &post);
            let mut terminal = Terminal::default();
            let (typing, number, told) = message_told(&post, "hello", deadline);
            typist.deliver(typing);
            terminal.reading = input(state, draft);
            assert_eq!(
                terminal.step(&mut typist, deadline - Duration::from_millis(100), ANY),
                Some(deadline)
            );
            assert_eq!(became(&post, number), PENDING);
            terminal.step(&mut typist, deadline, ANY);
            assert!(terminal.write_all().is_empty());
            assert_eq!(
                withdrawn(&post, number, &told),
                failed(reason, TextWritten::None, false),
                "{state:?}"
            );
        }
    }

    #[test]
    fn a_message_read_before_its_paste_is_never_typed() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("hold")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (typing, number) = message(&post, "hello", start + Duration::from_secs(30));
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        assert_eq!(
            post.read("a1", &Default::default()).unwrap().messages.len(),
            1,
            "a read takes it before its paste"
        );
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert!(terminal.write_all().is_empty());
        assert_eq!(
            delivered_via(&post, number),
            Some(DeliveredVia::ReadByRecipient),
            "its read answered its sender"
        );
        assert!(!typist.busy() && typist.held_bytes() == 0);

        // A read that takes it at the last moment, while the typist reads the input before its
        // paste.
        let mut typist = typist_for("fake", &post);
        let (typing, number) = message(&post, "hello", start + Duration::from_secs(30));
        typist.deliver(typing);
        let read_by_the_agent = || {
            post.read("a1", &Default::default()).unwrap();
            input(InputState::Usable, None)
        };
        assert!(
            typist
                .step(start, 0, 0, ANY, 0, &read_by_the_agent, &read_by_the_agent)
                .write
                .is_empty()
        );
        assert_eq!(
            delivered_via(&post, number),
            Some(DeliveredVia::ReadByRecipient)
        );
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    /// Calls go before messages waiting for the input, so keys can answer a menu a message waits
    /// on. While a message's text is in the input, nothing else is typed until it is confirmed.
    #[test]
    fn calls_go_before_waiting_messages_and_wait_for_one_in_the_input() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Interaction, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (typing, number) = message(&post, "note", start + Duration::from_secs(30));
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        let (keys, mut pressed) = Typing::keys(&names(&["Down", "Enter"])).unwrap();
        typist.push(keys);
        terminal.step(&mut typist, start, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[B\r",
            "the keys answer the menu while the message waits"
        );
        terminal.step(&mut typist, start, ANY);
        assert_eq!(pressed.try_recv(), Ok(Ok(())));
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~note\x1b[201~");
        let (text, mut typed) = Typing::text("later".into(), false, Sender::person()).unwrap();
        typist.push(text);
        terminal.step(&mut typist, start + Duration::from_secs(2), ANY);
        assert!(
            terminal.write_all().is_empty(),
            "the call waits while the message's text is in the input"
        );
        terminal.reading = input(InputState::Draft, Some("note"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(3), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        let now = start + Duration::from_secs(4);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(became(&post, number), TYPED);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[200~later\x1b[201~",
            "then the call goes"
        );
        terminal.step(&mut typist, now, ANY);
        assert_eq!(typed.try_recv(), Ok(Ok(())));
    }

    #[test]
    fn waiting_messages_each_get_their_own_paste_and_enter() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("hold")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (first, first_number) = message(&post, "first", start + Duration::from_secs(30));
        let (second, second_number) = message(&post, "second", start + Duration::from_secs(30));
        typist.deliver(first);
        terminal.step(&mut typist, start, ANY);
        typist.deliver(second);
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[200~first\x1b[201~",
            "the first message uses the input alone"
        );
        terminal.step(&mut typist, start + Duration::from_millis(1010), ANY);
        terminal.reading = input(InputState::Draft, Some("first"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(2), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.step(&mut typist, start + Duration::from_secs(3), ANY);
        assert_eq!(became(&post, first_number), TYPED);
        assert_eq!(became(&post, second_number), PENDING);
        assert_eq!(typist.take_submitted().unwrap().text, "first");
        terminal.step(&mut typist, start + Duration::from_secs(3), ANY);
        assert!(
            terminal.write_all().is_empty(),
            "the second waits for empty input"
        );
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(4), ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~second\x1b[201~");
        terminal.step(&mut typist, start + Duration::from_millis(4010), ANY);
        terminal.reading = input(InputState::Draft, Some("second"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(5), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(
            (became(&post, first_number), became(&post, second_number)),
            (TYPED, TYPED)
        );
        let said = typist.take_submitted().expect("the messages were said");
        assert_eq!(
            (said.text.as_str(), said.sender.from.as_str()),
            ("second", "a2"),
            "the last of them is what was said last"
        );
    }

    /// Waiting messages go in the order they were sent, regardless of when they reached the typist.
    #[test]
    fn messages_go_in_the_order_they_were_sent() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("hold")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (first, _) = message(&post, "first", start + Duration::from_secs(30));
        let (second, _) = message(&post, "second", start + Duration::from_secs(30));
        typist.deliver(second);
        typist.deliver(first);
        terminal.step(&mut typist, start, ANY);
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~first\x1b[201~");
    }

    #[test]
    fn claude_gets_the_header_and_body_in_one_paste() {
        let post = test_messages();
        let mut typist = typist_for("claude", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (typing, number) = message(
            &post,
            "📨 Message m5 from command line\nhi",
            start + Duration::from_secs(30),
        );
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        assert_eq!(
            terminal.write_all(),
            "\x1b[200~📨 Message m5 from command line\rhi\x1b[201~".as_bytes()
        );
        terminal.step(&mut typist, start + Duration::from_millis(10), ANY);
        terminal.reading = input(InputState::Draft, Some("[Pasted text #1 +1 lines]"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(1), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(2), ANY);
        assert_eq!(became(&post, number), TYPED);
    }

    /// A paste that never shows its draft fails. Once Enter is written, the delivery settles.
    #[test]
    fn a_paste_with_no_visible_draft_fails_and_a_written_enter_settles_once() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(10);
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let (typing, number) = message(&post, "hello", deadline);
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        terminal.write_all();
        terminal.step(&mut typist, start + Duration::from_millis(10), ANY);
        terminal.step(&mut typist, deadline, ANY);
        assert_eq!(
            became(&post, number),
            failed(
                DeliveryFailure::SubmissionUnconfirmed,
                TextWritten::Full,
                false
            ),
            "its own draft never showed"
        );
        let second_deadline = deadline + Duration::from_secs(1);
        let (second, number_behind, told) = message_told(&post, "behind", second_deadline);
        typist.deliver(second);
        let wake = terminal.step(&mut typist, deadline, ANY);
        assert_eq!(wake, Some(second_deadline));
        assert!(
            terminal.write_all().is_empty(),
            "the old empty box admits no paste"
        );
        terminal.step(&mut typist, second_deadline, ANY);
        assert_eq!(
            withdrawn(&post, number_behind, &told),
            failed(DeliveryFailure::Timeout, TextWritten::None, false)
        );
        terminal.reading = input(InputState::Draft, Some("hello"));
        terminal.step(&mut typist, second_deadline, ANY);
        assert_eq!(terminal.write_all(), b"\x7f\x7f\x7f\x7f\x7f");
        assert!(!typist.pasting() && typist.held_bytes() == 0);

        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let (typing, number) = message(&post, "hello", deadline);
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        terminal.write_all();
        terminal.step(&mut typist, start + Duration::from_millis(10), ANY);
        terminal.reading = input(InputState::Draft, Some("hello"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(1), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.step(&mut typist, wake + Duration::from_secs(1), ANY);
        assert_eq!(became(&post, number), TYPED);
        terminal.step(&mut typist, deadline, ANY);
        assert!(
            terminal.write_all().is_empty(),
            "Enter is never sent a second time"
        );
        assert_eq!(became(&post, number), TYPED);
    }

    /// No Enter goes at or after a message's deadline: a draft that first shows just before it gets
    /// none, as its settle time would end after it. Its draft is removed and it is withdrawn.
    #[test]
    fn no_enter_goes_at_or_after_a_message_s_deadline() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(10);
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let (typing, number, told) = message_told(&post, "hello", deadline);
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        terminal.write_all();
        terminal.step(&mut typist, start + Duration::from_millis(10), ANY);
        // A CLI busy with its turn draws the paste 10 ms before the deadline.
        terminal.reading = input(InputState::Draft, Some("hello"));
        assert_eq!(
            terminal.step(&mut typist, deadline - Duration::from_millis(10), ANY),
            Some(deadline),
            "it wakes at the deadline, not after"
        );
        terminal.step(&mut typist, deadline, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x7f\x7f\x7f\x7f\x7f",
            "only its own draft is erased"
        );
        assert_eq!(
            became(&post, number),
            PENDING,
            "the withdrawal awaits the redraw"
        );
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, deadline + Duration::from_millis(10), ANY);
        assert_eq!(
            withdrawn(&post, number, &told),
            failed(DeliveryFailure::Timeout, TextWritten::Full, false)
        );
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    /// A paste the terminal has not taken by the deadline, as a CLI that reads no input leaves it,
    /// still ends then. What is still queued goes in once the CLI reads, so what of it reaches the
    /// terminal is not known. When the CLI reads it later and shows it as its draft, no Enter
    /// follows.
    #[test]
    fn a_paste_the_terminal_has_not_taken_ends_at_the_deadline_and_never_gets_its_enter() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(10);
        let post = test_messages();
        for reached in [0, 4] {
            let mut typist = typist_for("fake", &post);
            let mut terminal = Terminal {
                reading: input(InputState::Usable, None),
                ..Terminal::default()
            };
            let (typing, number) = message(&post, "hello", deadline);
            typist.deliver(typing);
            terminal.step(&mut typist, start, ANY);
            terminal.written = reached;
            assert_eq!(
                terminal.step(&mut typist, start + Duration::from_secs(1), ANY),
                Some(deadline),
                "it wakes at the deadline"
            );
            assert_eq!(became(&post, number), PENDING);
            terminal.step(&mut typist, deadline, ANY);
            assert_eq!(
                became(&post, number),
                NOT_KNOWN,
                "{reached} bytes reached it, and the rest goes on"
            );
            terminal.write_all();
            terminal.reading = input(InputState::Draft, Some("hello"));
            let later = deadline + Duration::from_secs(110);
            if let Some(wake) = terminal.step(&mut typist, later, ANY) {
                terminal.step(&mut typist, wake, ANY);
            }
            assert!(
                terminal.write_all().is_empty(),
                "no Enter after the deadline"
            );
            assert!(!typist.busy() && typist.held_bytes() == 0);
        }
    }

    /// The time left limits submission, without imposing a separate paste-rate length limit.
    #[test]
    fn a_message_can_start_before_its_deadline_without_a_paste_rate_limit() {
        let start = Instant::now();
        let post = test_messages();
        for (left, pasted) in [(0, false), (4900, true)] {
            let mut typist = typist_for("fake", &post);
            let mut terminal = Terminal {
                reading: input(InputState::Usable, None),
                ..Terminal::default()
            };
            let (typing, number, told) =
                message_told(&post, "hello", start + Duration::from_millis(left));
            typist.deliver(typing);
            terminal.step(&mut typist, start, ANY);
            assert_eq!(!terminal.write_all().is_empty(), pasted, "{left} ms left");
            if !pasted {
                assert_eq!(
                    withdrawn(&post, number, &told),
                    failed(DeliveryFailure::Timeout, TextWritten::None, false)
                );
            }
        }
    }

    /// A short message is delivered separately when a longer one waits after it.
    #[test]
    fn a_short_message_is_delivered_before_a_longer_waiting_one() {
        let post = test_messages();
        let mut typist = typist_for("agy", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("hold")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let long = vec!["line"; 300].join("\n");
        let (short, short_number) = message(&post, "short", start + Duration::from_secs(9));
        let (long_message, long_number) = message(&post, &long, start + Duration::from_secs(30));
        typist.deliver(short);
        typist.deliver(long_message);
        terminal.step(&mut typist, start, ANY);
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_millis(500), ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[200~short\x1b[201~",
            "the short message goes alone"
        );
        terminal.step(&mut typist, start + Duration::from_millis(510), ANY);
        terminal.reading = input(InputState::Draft, Some("short"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(1), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        let now = start + Duration::from_secs(2);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(became(&post, short_number), TYPED);
        terminal.step(&mut typist, now, ANY);
        let pasted = terminal.write_all();
        assert!(
            pasted.starts_with(b"\x1b[200~line\rline") && pasted.ends_with(b"line\x1b[201~"),
            "then the long one"
        );
        assert_eq!(became(&post, long_number), PENDING, "it is being delivered");
    }

    /// A message waiting for the input while a call's paste is stuck, behind a CLI that reads
    /// nothing, is not the typist's to fail at its deadline: nothing of it was typed, so the post
    /// office settles it as `timeout` for its send.
    #[test]
    fn a_waiting_message_is_left_to_its_send_while_a_call_s_paste_is_stuck() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(10);
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("hold")),
            ..Terminal::default()
        };
        let (typing, number) = message(&post, "hello", deadline);
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        let (call, _) = Typing::new(
            VecDeque::from([Stroke::Paste("never read".into())]),
            CallKind::Text,
        );
        typist.push(call);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert!(
            !terminal.queued.is_empty() && terminal.written == 0,
            "the call's paste waits for the terminal"
        );
        terminal.step(&mut typist, deadline, ANY);
        terminal.step(&mut typist, deadline + Duration::from_secs(1), ANY);
        assert_eq!(
            became(&post, number),
            PENDING,
            "the typist does not settle it"
        );
        assert!(
            post.delivery_handle().still_to_type(number),
            "nothing typed it, so its send can still settle it as timeout"
        );
    }

    /// Once the first and its Enter are written, the second uses the next empty input.
    #[test]
    fn the_second_waiting_message_precedes_the_third() {
        let post = test_messages();
        let mut typist = typist_for("agy", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("hold")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let long = vec!["line"; 300].join("\n");
        let (first, first_number) = message(&post, "first", start + Duration::from_secs(9));
        let (second, _) = message(&post, &long, start + Duration::from_secs(30));
        let (third, _) = message(&post, "third", start + Duration::from_secs(30));
        for delivery in [first, second, third] {
            typist.deliver(delivery);
        }
        terminal.step(&mut typist, start, ANY);
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_millis(500), ANY);
        assert_eq!(
            terminal.write_all(),
            b"\x1b[200~first\x1b[201~",
            "the first goes alone"
        );
        terminal.step(&mut typist, start + Duration::from_millis(510), ANY);
        terminal.reading = input(InputState::Draft, Some("first"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(1), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        let now = start + Duration::from_secs(2);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(became(&post, first_number), TYPED);
        terminal.step(&mut typist, now, ANY);
        let pasted = terminal.write_all();
        assert!(
            pasted.starts_with(b"\x1b[200~line\rline") && pasted.ends_with(b"line\x1b[201~"),
            "the second uses its own paste while the third waits"
        );
    }

    /// A text's Enter waits a tenth of a second and its CLI's settle time after the text reached
    /// the terminal: Muse Code's 250 ms, and Antigravity's 80 ms and 45 ms a line (CLIS-2.1).
    #[test]
    fn the_enter_after_a_text_waits_for_its_cli_s_settle_time() {
        let post = test_messages();
        for (cli, text, pause) in [
            ("muse", "one line", 350),
            ("agy", "three\nshort\nlines", 100 + 80 + 3 * 45),
        ] {
            let mut typist = typist_for(cli, &post);
            let mut terminal = Terminal::default();
            let (typing, _) = Typing::new(
                VecDeque::from([Stroke::Paste(text.into()), Stroke::Key(Key::Enter)]),
                CallKind::Text,
            );
            typist.push(typing);
            let start = Instant::now();
            terminal.step(&mut typist, start, ANY);
            terminal.write_all();
            let due = start + Duration::from_millis(pause);
            assert_eq!(terminal.step(&mut typist, start, ANY), Some(due), "{cli}");
            terminal.step(&mut typist, due - Duration::from_millis(1), ANY);
            assert!(
                terminal.write_all().is_empty(),
                "{cli}: no Enter before its settle time"
            );
            terminal.step(&mut typist, due, ANY);
            assert_eq!(terminal.write_all(), b"\r", "{cli}");
        }
    }

    #[test]
    fn a_message_to_a_cli_without_a_rule_fails_at_once() {
        let post = test_messages();
        let mut typist = Typist::new("a1", None, None, post.delivery_handle());
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let (typing, number) = message(&post, "hello", Instant::now() + Duration::from_secs(30));
        typist.deliver(typing);
        terminal.step(&mut typist, Instant::now(), ANY);
        assert!(terminal.write_all().is_empty());
        assert_eq!(
            became(&post, number),
            failed(DeliveryFailure::Unsupported, TextWritten::None, false)
        );
    }

    /// When typing stops, a message whose paste reached the terminal fails as ended with its text
    /// written; waiting ones with nothing.
    #[test]
    fn messages_cut_off_by_the_agent_s_end_say_what_was_written() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (pasted, pasted_number) = message(&post, "hello", start + Duration::from_secs(30));
        typist.deliver(pasted);
        terminal.step(&mut typist, start, ANY);
        let (waiting, waiting_number) = message(&post, "later", start + Duration::from_secs(30));
        typist.deliver(waiting);
        terminal.write_all();
        typist.fail_all(terminal.written as u64, "#a3 ended");
        assert_eq!(
            became(&post, pasted_number),
            failed(DeliveryFailure::Ended, TextWritten::Full, false)
        );
        assert_eq!(
            became(&post, waiting_number),
            failed(DeliveryFailure::Ended, TextWritten::None, false)
        );
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    /// A typist settles a paste before it begins the next: the next paste's beginning is recorded
    /// only once the last one's outcome is, so a restart finds at most one paste of an agent begun
    /// and not settled.
    #[test]
    fn a_paste_is_settled_before_the_next_one_begins() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (first, first_number) = message(&post, "first", start + Duration::from_secs(30));
        typist.deliver(first);
        terminal.step(&mut typist, start, ANY);
        terminal.write_all();
        let (second, _) = message(&post, "second", start + Duration::from_secs(30));
        typist.deliver(second);
        terminal.reading = input(InputState::Draft, Some("first"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(1), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        let now = start + Duration::from_secs(2);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(
            became(&post, first_number),
            TYPED,
            "settled as soon as Enter reached the terminal"
        );
        let begun: Vec<Option<u64>> = post
            .pending()
            .unwrap()
            .into_iter()
            .map(|kept| kept.paste)
            .collect();
        assert_eq!(begun, [None], "the second paste has not begun");
        terminal.step(&mut typist, now, ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~second\x1b[201~");
    }

    /// A paste whose beginning cannot be recorded is not typed: the typist tries again at its next
    /// step, and pastes once the beginning is recorded.
    #[test]
    fn a_paste_whose_beginning_cannot_be_recorded_waits_and_is_tried_again() {
        let (post, store) = crate::messages::tests::messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (typing, number) = message(&post, "hello", start + Duration::from_secs(30));
        typist.deliver(typing);
        store.set_read_only(true);
        assert_eq!(
            terminal.step(&mut typist, start, ANY),
            Some(start + READ_INTERVAL),
            "it tries again"
        );
        assert!(terminal.write_all().is_empty(), "nothing is typed");
        assert_eq!(became(&post, number), PENDING);
        store.set_read_only(false);
        terminal.step(&mut typist, start + READ_INTERVAL, ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~hello\x1b[201~");
    }

    /// A paste the daemon before this one began is never typed again. An empty input confirms
    /// nothing: the old daemon may have pressed Enter, or its paste may never have reached the
    /// terminal. Once the input shows the paste whole as its own draft for the CLI's settle time,
    /// Enter goes, and writing it confirms the message.
    #[test]
    fn a_paste_begun_before_a_restart_is_never_typed_again_and_gets_enter_only_over_its_own_draft()
    {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal::default();
        let start = Instant::now();
        let (typing, number) = message(&post, "hello", start + Duration::from_secs(20));
        assert_eq!(
            post.delivery_handle().begin_paste(&[number]),
            Some(vec![number]),
            "the daemon before began its paste"
        );
        typist.finish_paste(vec![typing], None);
        terminal.step(&mut typist, start, ANY);
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        terminal.step(&mut typist, start + Duration::from_secs(5), ANY);
        assert!(
            terminal.write_all().is_empty(),
            "nothing is typed into an empty input"
        );
        assert_eq!(
            became(&post, number),
            PENDING,
            "an empty input confirms nothing"
        );
        terminal.reading = input(InputState::Draft, Some("hello"));
        let shown = start + Duration::from_secs(6);
        assert_eq!(
            terminal.step(&mut typist, shown, ANY),
            Some(shown + Duration::from_millis(80)),
            "the fake CLI's settle time"
        );
        terminal.step(&mut typist, shown + Duration::from_millis(80), ANY);
        assert_eq!(
            terminal.write_all(),
            b"\r",
            "Enter alone, over its own draft"
        );
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, shown + Duration::from_millis(300), ANY);
        assert_eq!(became(&post, number), TYPED);
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    #[test]
    fn a_claude_paste_with_an_old_typed_prefix_gets_its_enter_after_recovery() {
        for shown in [
            "📨 Message from [Pasted text #1 +1 lines]",
            "📨 Message [Pasted text #1 +1 lines]",
        ] {
            let post = test_messages();
            let mut typist = typist_for("claude", &post);
            let mut terminal = Terminal {
                reading: input(InputState::Draft, Some(shown)),
                ..Terminal::default()
            };
            let start = Instant::now();
            let (typing, number) = message(
                &post,
                "📨 Message m1 from command line\nhello",
                start + Duration::from_secs(20),
            );
            post.delivery_handle().begin_paste(&[number]);
            typist.finish_paste(
                vec![typing],
                Some("📨 Message from the command line · m1\nhello".to_owned()),
            );
            let wake = terminal.step(&mut typist, start, ANY).unwrap();
            assert!(terminal.write_all().is_empty());
            terminal.step(&mut typist, wake, ANY);
            assert_eq!(terminal.write_all(), b"\r", "{shown}");
            terminal.reading = input(InputState::Usable, None);
            terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
            assert_eq!(became(&post, number), TYPED);
            assert!(!typist.busy());
        }
    }

    #[test]
    fn a_split_paste_placeholder_is_owned_only_by_a_recovered_claude_paste() {
        let post = test_messages();
        let mut typist = typist_for("opencode", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("📨 Message [Pasted ~3 lines]")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let deadline = start + Duration::from_secs(20);
        let (typing, number) = message(
            &post,
            "📨 Message m1 from command line\nhello\nworld",
            deadline,
        );
        post.delivery_handle().begin_paste(&[number]);
        typist.finish_paste(vec![typing], None);
        let wake = terminal.step(&mut typist, start, ANY).unwrap();
        terminal.step(&mut typist, wake, ANY);
        terminal.step(&mut typist, deadline, ANY);
        assert!(terminal.write_all().is_empty());
        assert_eq!(became(&post, number), NOT_KNOWN);
        assert!(!typist.busy());
    }

    #[test]
    fn a_recovered_placeholder_can_reveal_the_previous_header() {
        let post = test_messages();
        let mut typist = typist_for("opencode", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("[Pasted ~3 lines]")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let previous = "📨 Message from the command line · m1\nhello\nworld";
        let (typing, number) = message(
            &post,
            "📨 Message m1 from command line\nhello\nworld",
            start + Duration::from_secs(20),
        );
        post.delivery_handle().begin_paste(&[number]);
        typist.finish_paste(vec![typing], Some(previous.into()));
        let wake = terminal.step(&mut typist, start, ANY).unwrap();
        assert!(terminal.write_all().is_empty());
        terminal.reading = input(InputState::Draft, Some(previous));
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        assert_eq!(became(&post, number), TYPED);
        assert!(!typist.busy());
    }

    #[test]
    fn an_ambiguous_recovered_draft_keeps_its_text_after_the_deadline() {
        let post = test_messages();
        let mut typist = typist_for("codex", &post);
        let mut reading = input(InputState::Draft, Some("last two\nlast one"));
        reading.info.hidden = Some(facade_base::model::terminal::HiddenRows { above: 2, below: 0 });
        let mut terminal = Terminal {
            reading,
            ..Terminal::default()
        };
        let deadline = Instant::now() + Duration::from_secs(1);
        let (typing, number) = message(
            &post,
            "📨 Message m1 from command line\nfirst\nlast two\nlast one",
            deadline,
        );
        let previous = "📨 Message from the command line · m1\nfirst\nlast two\nlast one";
        post.delivery_handle().begin_paste(&[number]);
        typist.finish_paste(vec![typing], Some(previous.into()));
        terminal.step(&mut typist, deadline, ANY);
        assert!(terminal.write_all().is_empty());
        assert_eq!(became(&post, number), NOT_KNOWN);
        assert!(!typist.busy());
    }

    /// A paste begun before a restart whose own draft never shows fails at its deadline as
    /// unconfirmed, with what of it reached the terminal and whether an Enter followed unknown.
    #[test]
    fn a_paste_begun_before_a_restart_fails_unconfirmed_at_its_deadline() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let deadline = start + Duration::from_secs(10);
        let (typing, number) = message(&post, "hello", deadline);
        post.delivery_handle().begin_paste(&[number]);
        typist.finish_paste(vec![typing], None);
        assert_eq!(
            terminal.step(&mut typist, start, ANY),
            Some(start + READ_INTERVAL)
        );
        terminal.step(&mut typist, deadline, ANY);
        assert!(terminal.write_all().is_empty());
        assert_eq!(became(&post, number), NOT_KNOWN);
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    /// A joined paste begun before a restart is recognized whole, and messages given after it wait
    /// behind it. One of its messages that a read delivered stays delivered.
    #[test]
    fn a_joined_paste_begun_before_a_restart_is_recognized_whole_and_holds_later_messages() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (first, first_number) = message(&post, "first", start + Duration::from_secs(20));
        let (second, second_number) = message(&post, "second", start + Duration::from_secs(20));
        let (later, later_number) = message(&post, "later", start + Duration::from_secs(25));
        post.delivery_handle()
            .begin_paste(&[first_number, second_number]);
        post.read(
            "a1",
            &MessagesWatchArgs {
                ids: Some(vec![format!("m{second_number}")]),
                ..Default::default()
            },
        )
        .unwrap();
        typist.finish_paste(vec![first, second], None);
        typist.deliver(later);
        terminal.step(&mut typist, start, ANY);
        assert!(
            terminal.write_all().is_empty(),
            "the later message waits behind the paste"
        );
        terminal.reading = input(InputState::Draft, Some("[Pasted text #1 +2 lines]"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(1), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        let now = start + Duration::from_secs(2);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(became(&post, first_number), TYPED);
        assert_eq!(
            delivered_via(&post, second_number),
            Some(DeliveredVia::ReadByRecipient),
            "the read's delivery stays"
        );
        terminal.step(&mut typist, now, ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~later\x1b[201~");
        assert_eq!(became(&post, later_number), PENDING);
    }

    /// Messages that have not begun wait for a recovered paste and then go in sending order.
    #[test]
    fn a_paste_begun_before_a_restart_goes_ahead_of_messages_not_pasted_yet() {
        let post = test_messages();
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("hello")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (earlier, later) = ("a".repeat(4000), "b".repeat(4000));
        let due = start + Duration::from_secs(20);
        let (first, first_number) = message(&post, &earlier, due);
        let (second, second_number) = message(&post, &later, due);
        typist.deliver(first);
        typist.deliver(second);
        terminal.step(&mut typist, start, ANY);
        let (begun, begun_number) = message(&post, "hello", start + Duration::from_secs(20));
        post.delivery_handle().begin_paste(&[begun_number]);
        typist.finish_paste(vec![begun], None);
        let shown = start + Duration::from_millis(100);
        assert_eq!(
            terminal.step(&mut typist, shown, ANY),
            Some(shown + Duration::from_millis(80)),
            "the paste's own draft shows"
        );
        terminal.step(&mut typist, shown + Duration::from_millis(80), ANY);
        assert_eq!(
            terminal.write_all(),
            b"\r",
            "Enter over the begun paste's own draft"
        );
        terminal.reading = input(InputState::Usable, None);
        let now = start + Duration::from_secs(1);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(became(&post, begun_number), TYPED);
        terminal.step(&mut typist, now, ANY);
        assert_eq!(
            terminal.write_all(),
            format!("\x1b[200~{earlier}\x1b[201~").as_bytes(),
            "then the first of the messages that came first"
        );
        assert_eq!(
            (became(&post, first_number), became(&post, second_number)),
            (PENDING, PENDING)
        );
    }

    /// A typist without a rule cannot read the input to finish a paste begun before a restart: it
    /// fails at once as unconfirmed.
    #[test]
    fn a_paste_begun_before_a_restart_that_no_rule_can_finish_fails_at_once() {
        let post = test_messages();
        let mut typist = Typist::new("a1", None, None, post.delivery_handle());
        let (typing, number) = message(&post, "hello", Instant::now() + Duration::from_secs(20));
        post.delivery_handle().begin_paste(&[number]);
        typist.finish_paste(vec![typing], None);
        assert_eq!(became(&post, number), NOT_KNOWN);
        assert!(!typist.busy());
    }
}
