//! Serializes program input and confirms message submission from the CLI's input box.
//! The actor owns terminal I/O; byte receipts anchor every delay to actual writes.

use std::collections::VecDeque;
use std::time::Duration;

use facade_base::daemon::{DeliveryFailure, InputInfo, InputState, TextWritten};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_rules::PasteRule;
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::{ESCAPE_DELAY, PASTE_END, PASTE_START, Submission};
use crate::Sender;
use crate::messages::{DeliveryHandle, Outcome};

const PASTE_DELAY: Duration = Duration::from_millis(100);
const DRAFT_TIMEOUT: Duration = Duration::from_secs(2);
const EMPTY_TIMEOUT: Duration = Duration::from_secs(3);
const ENTER_INTERVAL: Duration = Duration::from_secs(2);
const READ_INTERVAL: Duration = Duration::from_millis(500);
const MAX_JOINED_BYTES: usize = 32 * 1024;

/// Terminal modes sampled by the actor; no locks are taken.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Modes {
    pub(crate) bracketed_paste: bool,
    pub(crate) application_cursor_keys: bool,
}

/// An input observation and its draft, supplied synchronously by the actor.
pub(crate) type Reading = (InputInfo, Option<String>);

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
    key_count: Option<usize>,
    completed: usize,
}

impl Typing {
    /// Validates text and optionally appends Enter; does not wait or take locks.
    pub(crate) fn text(
        text: String,
        enter: bool,
        sender: Sender,
    ) -> Result<(Typing, TypingAnswer), String> {
        match facade_base::daemon::first_control(&text) {
            Some(problem) => {
                return Err(format!(
                    "{problem}; send Escape and other control keys as keys"
                ));
            }
            None if text.is_empty() && !enter => {
                return Err("text is empty and enter is false: there is nothing to type".into());
            }
            None => {}
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
        let (mut call, reply) = Self::new(strokes, None);
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
            Ok(Self::new(strokes, Some(names.len())))
        } else {
            Err(format!(
                "unknown keys: {}; {KNOWN_KEYS}",
                unknown.join(", ")
            ))
        }
    }

    fn new(strokes: VecDeque<Stroke>, key_count: Option<usize>) -> (Self, TypingAnswer) {
        let (answer, receiver) = oneshot::channel();
        (
            Self {
                strokes,
                answer,
                submission: None,
                key_count,
                completed: 0,
            },
            receiver,
        )
    }

    /// Maximum queued bytes in either terminal mode; no I/O or locks.
    pub(crate) fn most_bytes(&self) -> usize {
        self.strokes.iter().map(Stroke::most_bytes).sum()
    }

    fn interruption(&self, why: &str, partial: bool) -> ErrorBody {
        if self.completed == 0 && !partial {
            return ErrorBody::new(Reason::Ended, format!("{why}; nothing was typed"));
        }
        let detail = match (self.key_count, partial, self.completed) {
            (Some(total), true, done) => {
                format!("{done} of {total} keys and part of the next were pressed")
            }
            (Some(total), false, done) => format!("{done} of {total} keys were pressed"),
            (None, _, 0) => "part of the text was typed".to_owned(),
            (None, _, _) => "the text was typed but not its Enter".to_owned(),
        };
        let mut error = ErrorBody::new(Reason::PartialInput, format!("{why}; {detail}"));
        if self.key_count.is_some() {
            error.data.keys_sent = Some(self.completed as u32);
        } else {
            error.data.enter_written = Some(false);
            error.data.text_written = Some(if self.completed == 0 {
                TextWritten::Partial
            } else {
                TextWritten::Full
            });
        }
        error
    }
}

/// Message header typed outside the paste when the CLI's rule requires it.
pub(crate) const LEAD: &str = "📨 Message from ";

/// A delivery and its submission, owned by the actor's typist.
#[derive(Debug)]
pub(crate) struct MessageTyping {
    number: u64,
    text: String,
    submission: Box<Submission>,
    deadline: Instant,
    alone: bool,
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
            alone: false,
        }
    }

    /// Keeps a first prompt, which must occupy its own paste; no I/O or locks.
    pub(crate) fn start_prompt(
        text: String,
        number: u64,
        deadline: Instant,
        submission: Submission,
    ) -> MessageTyping {
        let mut prompt = Self::new(text, number, deadline, submission);
        prompt.alone = true;
        prompt
    }

    /// Maximum bytes for the text, paste brackets and Enter; no I/O or locks.
    pub(crate) fn most_bytes(&self) -> usize {
        self.text.len() + PASTE_START.len() + PASTE_END.len() + 1
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
    Waiting,
    Draft(DraftCheck),
    Entered {
        draft: DraftCheck,
        shown: String,
        at: Instant,
    },
}

struct DraftCheck {
    prefix: &'static str,
    text: String,
    stable: Option<(Instant, String)>,
    recovered: bool,
}

impl DraftCheck {
    fn new(rule: &PasteRule, text: String, recovered: bool) -> Self {
        let prefix = if rule.lead && text.starts_with(LEAD) {
            LEAD
        } else {
            ""
        };
        Self {
            text: text[prefix.len()..].to_owned(),
            prefix,
            stable: None,
            recovered,
        }
    }

    fn prefix(&self) -> Option<&str> {
        (!self.prefix.is_empty()).then_some(self.prefix)
    }
}

impl Batch {
    fn deadline(&self) -> Option<Instant> {
        self.messages.iter().map(|m| m.deadline).min()
    }

    fn poll_at(&self, now: Instant) -> Instant {
        self.deadline()
            .map_or(now + READ_INTERVAL, |due| due.min(now + READ_INTERVAL))
    }

    fn held(&self) -> usize {
        match self.phase {
            DeliveryPhase::Waiting => self.messages.iter().map(MessageTyping::most_bytes).sum(),
            DeliveryPhase::Draft(_) => 1,
            DeliveryPhase::Entered { .. } => 0,
        }
    }

    fn begun(&self) -> bool {
        !matches!(self.phase, DeliveryPhase::Waiting)
    }
}

/// Serial input state. The actor calls it exclusively; it never writes a PTY or takes a lock.
pub(crate) struct Typist {
    deliveries: DeliveryHandle,
    paste: Option<&'static PasteRule>,
    calls: VecDeque<Typing>,
    current: Option<Typing>,
    inbox: VecDeque<MessageTyping>,
    batch: Option<Batch>,
    receipt: Option<Receipt>,
    submitted: Option<Submission>,
    entered: bool,
    paste_held: bool,
}

impl Typist {
    /// Uses the supplied delivery handle; later message operations may synchronously persist data.
    pub(crate) fn new(paste: Option<&'static PasteRule>, deliveries: DeliveryHandle) -> Typist {
        Self {
            deliveries,
            paste,
            calls: VecDeque::new(),
            current: None,
            inbox: VecDeque::new(),
            batch: None,
            receipt: None,
            submitted: None,
            entered: false,
            paste_held: false,
        }
    }

    /// Advances receipt accounting, then one call or delivery; persistence may block, no typist lock.
    pub(crate) fn step(
        &mut self,
        now: Instant,
        written: u64,
        queued: u64,
        modes: Modes,
        read: &dyn Fn() -> Reading,
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
        if self.current.is_none() && !self.pasting() {
            self.current = self.calls.pop_front();
        }
        if self.current.is_some() {
            match pause {
                Some(at) => Step::wait(Some(at)),
                None => self.emit_call(queued, modes),
            }
        } else {
            self.advance_delivery(now, queued, modes, read, pause)
        }
    }

    /// Stops every call and delivery with its actual write progress; delivery persistence may block.
    pub(crate) fn fail_all(&mut self, written: u64, why: &str) {
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
            self.deliveries.settle(
                &numbers(&batch.messages),
                Outcome::Failed {
                    reason: DeliveryFailure::Ended,
                    text_written,
                    enter_written,
                },
            );
        }
        let pending: Vec<_> = self.inbox.drain(..).collect();
        self.deliveries
            .settle(&numbers(&pending), Outcome::untyped(DeliveryFailure::Ended));
        self.receipt = None;
    }

    /// Restores a persisted paste without retyping; persistence on refusal may block, no typist lock.
    pub(crate) fn finish_paste(&mut self, messages: Vec<MessageTyping>) {
        self.return_waiting();
        match (self.paste, self.batch.is_none()) {
            (Some(rule), true) => {
                let draft = DraftCheck::new(rule, joined(&messages), true);
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
        self.return_waiting();
        self.inbox.push_front(prompt);
    }

    /// Settles a prompt for a run already ended; persistence may block, no typist lock.
    pub(crate) fn fail_ended(&self, prompt: MessageTyping) {
        self.deliveries
            .settle(&[prompt.number], Outcome::untyped(DeliveryFailure::Ended));
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
        self.paste
    }
    /// Reads queued input's maximum size, excluding bytes already emitted; no I/O or locks.
    pub(crate) fn held_bytes(&self) -> usize {
        self.calls.iter().map(Typing::most_bytes).sum::<usize>()
            + self.current.as_ref().map_or(0, Typing::most_bytes)
            + self
                .inbox
                .iter()
                .map(MessageTyping::most_bytes)
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
        self.types_calls() || self.reads_input()
    }
    /// Reads whether delivery has passed persistence and awaits settlement; no I/O or locks.
    pub(crate) fn pasting(&self) -> bool {
        self.batch.as_ref().is_some_and(Batch::begun)
    }
    /// Reads whether a program call is pending or active; no I/O or locks.
    pub(crate) fn types_calls(&self) -> bool {
        self.current.is_some() || !self.calls.is_empty()
    }
    /// Reads whether message confirmation needs input observations; no I/O or locks.
    pub(crate) fn reads_input(&self) -> bool {
        self.batch.is_some() || !self.inbox.is_empty()
    }

    fn return_waiting(&mut self) {
        if self.batch.as_ref().is_some_and(|batch| !batch.begun()) {
            let batch = self.batch.take().expect("unbegun batch");
            for message in batch.messages.into_iter().rev() {
                self.inbox.push_front(message);
            }
        }
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
        let call = self.current.as_mut().expect("active call");
        let mut receipt = Receipt {
            offset,
            boundaries: Vec::new(),
            arrived: None,
            delay: Duration::ZERO,
        };
        let mut result = Step::default();
        while let Some(stroke) = call.strokes.pop_front() {
            stroke.write(modes, &mut result.write);
            self.entered |= matches!(stroke, Stroke::Key(Key::Enter));
            receipt.boundaries.push(offset + result.write.len() as u64);
            receipt.delay = stroke.delay(self.paste);
            if receipt.delay != Duration::ZERO {
                break;
            }
        }
        self.receipt = Some(receipt);
        result
    }

    fn stalled(&mut self, now: Instant) -> Step {
        let deadline = self
            .batch
            .as_ref()
            .filter(|batch| batch.begun())
            .and_then(Batch::deadline);
        match deadline {
            Some(at) if at <= now => {
                let batch = self.batch.take().expect("stalled delivery");
                self.settle_batch(batch, Outcome::UNCONFIRMED)
            }
            _ => Step::wait(deadline),
        }
    }

    fn delivery_progress(&self, batch: &Batch, written: u64) -> (TextWritten, Option<bool>) {
        let full = self
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.complete(written));
        match &batch.phase {
            DeliveryPhase::Waiting => (TextWritten::None, Some(false)),
            DeliveryPhase::Entered { .. } => (TextWritten::Full, Some(full)),
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

    fn settle_batch(&mut self, batch: Batch, outcome: Outcome) -> Step {
        if outcome == Outcome::Typed
            && let Some(last) = batch.messages.last()
        {
            self.submitted = Some((*last.submission).clone());
        }
        self.deliveries.settle(&numbers(&batch.messages), outcome);
        Step::wait((!self.inbox.is_empty() || !self.calls.is_empty()).then(Instant::now))
    }

    fn gather(&mut self, batch: &mut Batch) {
        batch
            .messages
            .retain(|message| self.deliveries.still_to_type(message.number));
        let mut size: usize = batch
            .messages
            .iter()
            .map(|message| message.text.len())
            .sum();
        while let Some(next) = self.inbox.front() {
            if !batch.messages.is_empty()
                && (next.alone
                    || batch.messages.iter().any(|message| message.alone)
                    || size + next.text.len() > MAX_JOINED_BYTES)
            {
                break;
            }
            let message = self.inbox.pop_front().expect("queued message");
            if self.deliveries.still_to_type(message.number) {
                size += message.text.len();
                batch.messages.push(message);
            }
        }
    }

    fn fit_deadlines(&mut self, batch: &mut Batch, rule: &PasteRule, now: Instant) {
        while let Some(due) = batch.deadline() {
            if now + delivery_time(rule, &joined(&batch.messages)) <= due {
                break;
            }
            let message = batch.messages.pop().expect("delivery with a deadline");
            if batch.messages.is_empty() {
                self.deliveries.settle(
                    &[message.number],
                    Outcome::untyped(DeliveryFailure::Timeout),
                );
            } else {
                self.inbox.push_front(message);
            }
        }
    }

    fn advance_delivery(
        &mut self,
        now: Instant,
        offset: u64,
        modes: Modes,
        read: &dyn Fn() -> Reading,
        paused: Option<Instant>,
    ) -> Step {
        let Some(rule) = self.paste else {
            let messages: Vec<_> = self.inbox.drain(..).collect();
            self.deliveries.settle(
                &numbers(&messages),
                Outcome::untyped(DeliveryFailure::Unsupported),
            );
            return Step::default();
        };
        loop {
            if self.paste_held && !self.pasting() {
                return Step::default();
            }
            let mut batch = match self.batch.take() {
                Some(batch) => batch,
                None if self.inbox.is_empty() => return Step::default(),
                None => Batch {
                    messages: Vec::new(),
                    phase: DeliveryPhase::Waiting,
                },
            };
            match std::mem::replace(&mut batch.phase, DeliveryPhase::Waiting) {
                DeliveryPhase::Draft(draft) => {
                    return self.check_draft(batch, draft, rule, now, offset, read, paused);
                }
                DeliveryPhase::Entered { draft, shown, at } => {
                    return self.check_enter(batch, draft, shown, at, now, offset, read, paused);
                }
                DeliveryPhase::Waiting => {}
            }
            self.gather(&mut batch);
            let (info, _) = read();
            let reason = match info.state {
                InputState::Usable => DeliveryFailure::Timeout,
                InputState::Draft => DeliveryFailure::InputDraft,
                InputState::Interaction => DeliveryFailure::InputInteraction,
                _ => DeliveryFailure::InputUnknown,
            };
            let mut expired = Vec::new();
            batch.messages.retain(|message| {
                if message.deadline > now {
                    true
                } else {
                    expired.push(message.number);
                    false
                }
            });
            self.deliveries.settle(&expired, Outcome::untyped(reason));
            if info.state == InputState::Usable && paused.is_none() {
                self.fit_deadlines(&mut batch, rule, now);
                batch.messages.sort_by_key(|message| message.number);
                crate::gate_for_test("before-paste-begins");
                let granted = self.deliveries.begin_paste(&numbers(&batch.messages));
                let Some(granted) = granted else {
                    let wake = batch.poll_at(now);
                    self.batch = Some(batch);
                    return Step::wait(Some(wake));
                };
                batch
                    .messages
                    .retain(|message| granted.contains(&message.number));
                if !batch.messages.is_empty() {
                    let draft = DraftCheck::new(rule, joined(&batch.messages), false);
                    let mut write = draft.prefix.as_bytes().to_vec();
                    write_paste(&draft.text, modes.bracketed_paste, &mut write);
                    batch.phase = DeliveryPhase::Draft(draft);
                    self.record_write(offset, write.len(), PASTE_DELAY);
                    self.batch = Some(batch);
                    return Step {
                        write,
                        wake: Some(now + READ_INTERVAL),
                    };
                }
            }
            if batch.messages.is_empty() {
                continue;
            }
            let wake = batch.poll_at(now);
            self.batch = Some(batch);
            return Step::wait(Some(paused.map_or(wake, |at| at.max(now).min(wake))));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn check_draft(
        &mut self,
        mut batch: Batch,
        mut draft: DraftCheck,
        rule: &PasteRule,
        now: Instant,
        offset: u64,
        read: &dyn Fn() -> Reading,
        paused: Option<Instant>,
    ) -> Step {
        if batch.deadline().is_some_and(|due| now >= due) {
            let outcome = if draft.recovered {
                Outcome::UNCONFIRMED
            } else {
                Outcome::Failed {
                    reason: DeliveryFailure::SubmissionUnconfirmed,
                    text_written: TextWritten::Full,
                    enter_written: Some(false),
                }
            };
            // Restore the phase for byte accounting and takeover queries.
            batch.phase = DeliveryPhase::Draft(draft);
            return self.settle_batch(batch, outcome);
        }
        let (info, observed) = read();
        let own = observed.filter(|text| {
            info.state == InputState::Draft
                && facade_rules::is_own_draft(rule, text, &draft.text, draft.prefix(), info.hidden)
        });
        let wake = match own {
            None => {
                draft.stable = None;
                batch.deadline().map(|due| (now + READ_INTERVAL).min(due))
            }
            Some(observed) => {
                let since = draft.stable.get_or_insert((now, observed)).0;
                let settled = since + facade_rules::settle_time(rule, &draft.text);
                if now >= settled && paused.is_none() {
                    crate::pause_for_test("before-message-enter");
                    let shown = draft.stable.take().expect("stable draft").1;
                    batch.phase = DeliveryPhase::Entered {
                        draft,
                        shown,
                        at: now,
                    };
                    self.batch = Some(batch);
                    self.record_write(offset, 1, Duration::ZERO);
                    crate::gate_for_test("message-enter");
                    return Step {
                        write: vec![b'\r'],
                        wake: Some(now + READ_INTERVAL),
                    };
                }
                let ready = settled.max(paused.unwrap_or(now));
                Some(batch.deadline().map_or(ready, |due| ready.min(due)))
            }
        };
        batch.phase = DeliveryPhase::Draft(draft);
        self.batch = Some(batch);
        Step::wait(wake)
    }

    #[allow(clippy::too_many_arguments)]
    fn check_enter(
        &mut self,
        mut batch: Batch,
        draft: DraftCheck,
        shown: String,
        mut at: Instant,
        now: Instant,
        offset: u64,
        read: &dyn Fn() -> Reading,
        paused: Option<Instant>,
    ) -> Step {
        let (info, observed) = read();
        if info.state == InputState::Usable {
            return self.settle_batch(batch, Outcome::Typed);
        }
        if batch.deadline().is_some_and(|due| now >= due) {
            return self.settle_batch(
                batch,
                Outcome::Failed {
                    reason: DeliveryFailure::SubmissionUnconfirmed,
                    text_written: TextWritten::Full,
                    enter_written: Some(true),
                },
            );
        }
        let same = info.state == InputState::Draft
            && observed.is_some_and(|text| {
                facade_rules::is_same_draft(&text, &shown, &draft.text, draft.prefix(), info.hidden)
            });
        let result = if same && now >= at + ENTER_INTERVAL && paused.is_none() {
            at = now;
            self.record_write(offset, 1, Duration::ZERO);
            Step {
                write: vec![b'\r'],
                wake: Some(now + READ_INTERVAL),
            }
        } else {
            Step::wait(batch.deadline().map(|due| (now + READ_INTERVAL).min(due)))
        };
        batch.phase = DeliveryPhase::Entered { draft, shown, at };
        self.batch = Some(batch);
        result
    }
}

fn numbers(messages: &[MessageTyping]) -> Vec<u64> {
    messages.iter().map(|message| message.number).collect()
}

fn joined(messages: &[MessageTyping]) -> String {
    let mut text = String::new();
    for (index, message) in messages.iter().enumerate() {
        if index > 0 {
            text.push_str("\n\n");
        }
        text.push_str(&message.text);
    }
    text
}

fn paste_time(text: &str) -> Duration {
    Duration::from_millis(text.len().div_ceil(4096) as u64)
}

fn delivery_time(rule: &PasteRule, text: &str) -> Duration {
    facade_rules::settle_time(rule, text) + DRAFT_TIMEOUT + EMPTY_TIMEOUT + paste_time(text) * 2
}

#[derive(Debug)]
enum Stroke {
    Paste(String),
    Key(Key),
}

impl Stroke {
    fn write(&self, modes: Modes, bytes: &mut Vec<u8>) {
        match self {
            Self::Key(key) => key.write(modes.application_cursor_keys, bytes),
            Self::Paste(text) => write_paste(text, modes.bracketed_paste, bytes),
        }
    }

    fn most_bytes(&self) -> usize {
        if let Self::Paste(text) = self {
            return text.len() + PASTE_START.len() + PASTE_END.len();
        }
        let mut bytes = Vec::new();
        self.write(Modes::default(), &mut bytes);
        bytes.len()
    }

    fn delay(&self, rule: Option<&PasteRule>) -> Duration {
        match self {
            Self::Key(Key::Escape) => ESCAPE_DELAY,
            Self::Key(_) => Duration::ZERO,
            Self::Paste(text) => {
                PASTE_DELAY + rule.map_or(Duration::ZERO, |r| facade_rules::settle_time(r, text))
            }
        }
    }
}

fn write_paste(text: &str, bracketed: bool, bytes: &mut Vec<u8>) {
    if bracketed {
        bytes.extend(PASTE_START);
        let normalized = text.replace("\r\n", "\r").replace('\n', "\r");
        bytes.extend(normalized.as_bytes());
        bytes.extend(PASTE_END);
    } else {
        bytes.extend(text.as_bytes());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Key {
    Character(char),
    Ctrl(u8),
    Space,
    Enter,
    Escape,
    Tab,
    ShiftTab,
    Backspace,
    Delete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
}

const KEY_NAMES: [(&str, Key); 21] = [
    ("Enter", Key::Enter),
    ("Return", Key::Enter),
    ("Escape", Key::Escape),
    ("Esc", Key::Escape),
    ("Tab", Key::Tab),
    ("Shift+Tab", Key::ShiftTab),
    ("Backspace", Key::Backspace),
    ("Delete", Key::Delete),
    ("Up", Key::Up),
    ("ArrowUp", Key::Up),
    ("Down", Key::Down),
    ("ArrowDown", Key::Down),
    ("Left", Key::Left),
    ("ArrowLeft", Key::Left),
    ("Right", Key::Right),
    ("ArrowRight", Key::Right),
    ("Home", Key::Home),
    ("End", Key::End),
    ("PageUp", Key::PageUp),
    ("PageDown", Key::PageDown),
    ("Space", Key::Space),
];
const KNOWN_KEYS: &str = "keys are Enter (or Return), Escape (or Esc), Tab, Shift+Tab, Backspace, \
                          Delete, Up, Down, Left, Right (or ArrowUp, \
                          ArrowDown, ArrowLeft, ArrowRight), Home, End, PageUp, PageDown, Space, \
                          and Ctrl+A to Ctrl+Z, in any letter case, or any one \
                          character other than a control character";

impl Key {
    fn named(name: &str) -> Option<Self> {
        let standard = KEY_NAMES
            .iter()
            .position(|(known, _)| name.eq_ignore_ascii_case(known));
        if let Some(index) = standard {
            return Some(KEY_NAMES[index].1);
        }
        let letters = name.as_bytes();
        if letters.len() == 6
            && letters[..5].eq_ignore_ascii_case(b"ctrl+")
            && letters[5].is_ascii_alphabetic()
        {
            return Some(Self::Ctrl(letters[5].to_ascii_lowercase() - b'a' + 1));
        }
        let mut chars = name.chars();
        let character = chars.next()?;
        (chars.next().is_none() && !character.is_control()).then_some(Self::Character(character))
    }

    fn write(self, application: bool, bytes: &mut Vec<u8>) {
        let fixed: &[u8] = match self {
            Self::Character(c) => {
                bytes.extend(c.encode_utf8(&mut [0; 4]).as_bytes());
                return;
            }
            Self::Ctrl(value) => {
                bytes.push(value);
                return;
            }
            Self::Enter => b"\r",
            Self::Escape => b"\x1b",
            Self::Tab => b"\t",
            Self::Space => b" ",
            Self::Backspace => b"\x7f",
            Self::ShiftTab => b"\x1b[Z",
            Self::Delete => b"\x1b[3~",
            Self::PageUp => b"\x1b[5~",
            Self::PageDown => b"\x1b[6~",
            cursor => {
                let final_byte = match cursor {
                    Self::Up => b'A',
                    Self::Down => b'B',
                    Self::Right => b'C',
                    Self::Left => b'D',
                    Self::Home => b'H',
                    Self::End => b'F',
                    _ => unreachable!("cursor key"),
                };
                bytes.extend([0x1b, if application { b'O' } else { b'[' }, final_byte]);
                return;
            }
        };
        bytes.extend(fixed);
    }
}

#[cfg(test)]
mod tests {
    use facade_base::daemon::{DeliveredVia, DeliveryStatus, MessagesWatchArgs};

    use super::*;
    use crate::messages::Messages;
    use std::sync::Arc;

    fn test_messages() -> Arc<Messages> {
        crate::messages::tests::messages().0
    }

    const ANY: Modes = Modes {
        bracketed_paste: true,
        application_cursor_keys: false,
    };

    fn names(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|key| key.to_string()).collect()
    }

    /// The agent's input as the actor keeps it: bytes queued, how many reached the terminal, and
    /// how the screen reads it.
    struct Terminal {
        queued: Vec<u8>,
        written: usize,
        reading: Reading,
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
    fn input(state: InputState, draft: Option<&str>) -> Reading {
        (
            InputInfo {
                state,
                evidence: String::new(),
                mechanism: None,
                hidden: None,
            },
            draft.map(str::to_string),
        )
    }

    impl Terminal {
        fn step(&mut self, typist: &mut Typist, now: Instant, modes: Modes) -> Option<Instant> {
            let reading = self.reading.clone();
            let step = typist.step(
                now,
                self.written as u64,
                self.queued.len() as u64,
                modes,
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
        for (name, _) in KEY_NAMES {
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
        for (name, key) in KEY_NAMES {
            let (mut default, mut application) = (Vec::new(), Vec::new());
            key.write(false, &mut default);
            key.write(true, &mut application);
            assert_eq!(
                default.len(),
                application.len(),
                "{name} counts the same in both modes"
            );
        }
    }

    #[test]
    fn a_paste_is_bracketed_with_carriage_returns_only_when_the_cli_asked_for_bracketed_paste() {
        let pasted = |bracketed: bool| {
            let mut out = Vec::new();
            write_paste("one\ntwo\r\nthree\rfour\tend", bracketed, &mut out);
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
            .for_each(|stroke| stroke.write(ANY, &mut out));
        assert!(
            out.len() <= typing.most_bytes(),
            "the most bytes cover what is written"
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
        let mut typist = Typist::new(None, test_messages().delivery_handle());
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
        let mut typist = Typist::new(None, test_messages().delivery_handle());
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
        let mut typist = Typist::new(None, test_messages().delivery_handle());
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
            let mut typist = Typist::new(None, test_messages().delivery_handle());
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
        let mut typist = Typist::new(None, test_messages().delivery_handle());
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
        let mut typist = Typist::new(None, test_messages().delivery_handle());
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
                let mut typist = Typist::new(None, test_messages().delivery_handle());
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
            Some(&facade_rules::find(cli).unwrap().unwrap().paste),
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
        Some(DeliveredVia::Terminal),
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
    /// delivered once the input is empty again.
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
        assert_eq!(terminal.write_all(), b"\r");
        assert_eq!(
            became(&post, number),
            PENDING,
            "not delivered before the input is empty again"
        );
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, shown + Duration::from_millis(300), ANY);
        assert_eq!(became(&post, number), TYPED);
        assert!(!typist.busy() && typist.held_bytes() == 0);
    }

    /// A run's start prompt goes before the messages that waited for it, those gathered for a paste
    /// among them, and alone: the messages follow in a paste of their own once the CLI took it.
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
            b"\x1b[200~first\r\rsecond\r\rthird\x1b[201~",
            "the messages after it, in the order they came"
        );
        for number in [first_number, second_number, third_number] {
            assert_eq!(became(&post, number), PENDING);
        }
    }

    /// A message fails at its deadline, saying what held the input, with nothing typed. A paste
    /// goes only where it, its Enter, and its confirmation fit before the deadline.
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
        // An empty input with too little time left for the paste, its Enter, and its confirmation:
        // nothing is typed.
        let mut typist = typist_for("fake", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let (typing, number, told) = message_told(&post, "hello", start + Duration::from_secs(1));
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        assert!(terminal.write_all().is_empty());
        assert_eq!(
            withdrawn(&post, number, &told),
            failed(DeliveryFailure::Timeout, TextWritten::None, false)
        );
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
            Some(DeliveredVia::Read),
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
                .step(start, 0, 0, ANY, &read_by_the_agent)
                .write
                .is_empty()
        );
        assert_eq!(delivered_via(&post, number), Some(DeliveredVia::Read));
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
    fn messages_waiting_together_go_in_one_paste_with_one_enter() {
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
            b"\x1b[200~first\r\rsecond\x1b[201~",
            "each whole, in order, a blank line between them"
        );
        terminal.step(&mut typist, start + Duration::from_millis(1010), ANY);
        // The fake CLI shows a paste of several lines as its placeholder.
        terminal.reading = input(InputState::Draft, Some("[Pasted text #1 +2 lines]"));
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(2), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        assert_eq!(
            typist.take_submitted(),
            None,
            "nothing is said before the CLI takes the messages"
        );
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(3), ANY);
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

    /// Messages waiting together join in the order they were sent, whatever order they reached the
    /// typist in.
    #[test]
    fn messages_join_in_the_order_they_were_sent() {
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
        assert_eq!(terminal.write_all(), b"\x1b[200~first\r\rsecond\x1b[201~");
    }

    /// Claude takes a paste alone as material, so a message's first header words are typed before
    /// its paste.
    #[test]
    fn a_cli_that_takes_a_paste_alone_as_material_gets_the_header_s_first_words_typed() {
        let post = test_messages();
        let mut typist = typist_for("claude", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Usable, None),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (typing, number) = message(
            &post,
            "📨 Message from #human · #m5\nhi",
            start + Duration::from_secs(30),
        );
        typist.deliver(typing);
        terminal.step(&mut typist, start, ANY);
        assert_eq!(
            terminal.write_all(),
            "📨 Message from \x1b[200~#human · #m5\rhi\x1b[201~".as_bytes()
        );
        terminal.step(&mut typist, start + Duration::from_millis(10), ANY);
        terminal.reading = input(
            InputState::Draft,
            Some("📨 Message from [Pasted text #1 +1 lines]"),
        );
        let wake = terminal
            .step(&mut typist, start + Duration::from_secs(1), ANY)
            .unwrap();
        terminal.step(&mut typist, wake, ANY);
        assert_eq!(terminal.write_all(), b"\r");
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(2), ANY);
        assert_eq!(became(&post, number), TYPED);
    }

    /// A result goes in a paste with no typed lead, even into a CLI that gets one, and joins the
    /// messages waiting with it.
    #[test]
    fn a_result_is_pasted_without_a_lead_and_joins_the_messages_waiting_with_it() {
        let post = test_messages();
        let mut typist = typist_for("claude", &post);
        let mut terminal = Terminal {
            reading: input(InputState::Draft, Some("held")),
            ..Terminal::default()
        };
        let start = Instant::now();
        let (result, result_number) = message(
            &post,
            "🔔 Nova (#a2) has started. · #m6\nYour initial message #m4 has been passed on.",
            start + Duration::from_secs(30),
        );
        let (later, later_number) = message(
            &post,
            "📨 Message from #human · #m7\nhi",
            start + Duration::from_secs(30),
        );
        typist.deliver(result);
        typist.deliver(later);
        terminal.step(&mut typist, start, ANY);
        terminal.reading = input(InputState::Usable, None);
        terminal.step(&mut typist, start + Duration::from_secs(1), ANY);
        let pasted = "\x1b[200~🔔 Nova (#a2) has started. · #m6\rYour initial message #m4 has been \
                      passed on.\r\r📨 Message from #human · #m7\rhi\x1b[201~";
        assert_eq!(String::from_utf8(terminal.write_all()).unwrap(), pasted);
        assert_eq!(
            (became(&post, result_number), became(&post, later_number)),
            (PENDING, PENDING),
            "one paste, still to be confirmed"
        );
    }

    /// A pasted message the CLI does not take fails at its deadline as unconfirmed, with what
    /// reached the terminal. An Enter the CLI is slow to take goes again only over the same own
    /// draft, two seconds later.
    #[test]
    fn a_pasted_message_the_cli_does_not_take_fails_as_unconfirmed() {
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
        assert!(
            !typist.busy() && typist.held_bytes() == 0,
            "nothing stays held for the Enter that never went"
        );

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
        assert!(
            terminal.write_all().is_empty(),
            "no second Enter within two seconds"
        );
        terminal.step(&mut typist, wake + ENTER_INTERVAL, ANY);
        assert_eq!(
            terminal.write_all(),
            b"\r",
            "Enter again over its own draft"
        );
        terminal.reading = input(InputState::Draft, Some("hello, edited"));
        terminal.step(&mut typist, wake + ENTER_INTERVAL * 3, ANY);
        assert!(
            terminal.write_all().is_empty(),
            "never over a draft that is not its own"
        );
        terminal.step(&mut typist, deadline, ANY);
        assert_eq!(
            became(&post, number),
            failed(
                DeliveryFailure::SubmissionUnconfirmed,
                TextWritten::Full,
                true
            )
        );
    }

    /// No Enter goes at or after a message's deadline: a draft that first shows just before it gets
    /// none, as its settle time would end after it, and the message fails as unconfirmed with its
    /// text written.
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
        let (typing, number) = message(&post, "hello", deadline);
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
        assert!(terminal.write_all().is_empty(), "no Enter at the deadline");
        assert_eq!(
            became(&post, number),
            failed(
                DeliveryFailure::SubmissionUnconfirmed,
                TextWritten::Full,
                false
            )
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

    /// A paste goes only where its delivery fits before the deadline, as CLIS-2.1 times it: 2
    /// seconds for the message's own draft to show, the CLI's settle time, and 3 seconds for the
    /// input to empty, each with the paste's own time.
    #[test]
    fn a_message_is_pasted_only_where_its_delivery_fits_before_its_deadline() {
        let start = Instant::now();
        let post = test_messages();
        for (left, pasted) in [(4900, false), (5200, true)] {
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

    /// Messages that would make a paste too long for an earlier message's deadline wait for the
    /// next paste. Antigravity takes 45 ms a line: with a 300-line message, a short one with 9
    /// seconds left would not fit, so it goes alone and the long one after it.
    #[test]
    fn a_message_that_fits_alone_is_never_failed_by_a_longer_one_waiting_with_it() {
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

    /// The longest message there is, 8,000 four-byte characters on 540 lines under the longest
    /// header, its sender's window named in it too, fits a whole delivery to every CLI,
    /// Antigravity's 45 ms a line included: so one limit holds for every recipient.
    #[test]
    fn the_longest_message_fits_a_delivery_to_every_cli() {
        use facade_base::daemon::{MAX_MESSAGE_CHARS, MAX_MESSAGE_LINES};
        let mut lines = vec!["\u{1D54F}".repeat(13); MAX_MESSAGE_LINES];
        let length = |lines: &[String]| {
            lines.iter().map(|line| line.chars().count()).sum::<usize>() + lines.len() - 1
        };
        let rest = MAX_MESSAGE_CHARS - length(&lines);
        lines[0].push_str(&"\u{1D54F}".repeat(rest));
        let text = lines.join("\n");
        assert_eq!(
            (
                text.chars().count(),
                facade_base::daemon::check_message_text(&text)
            ),
            (MAX_MESSAGE_CHARS, Ok(()))
        );
        let message = facade_base::daemon::Message {
            message_id: "m999999999".into(),
            from: "a999999999".into(),
            from_name: Some("\u{1D54F}".repeat(200)),
            to: "a1".into(),
            text,
            reply_to: Some("m999999999".into()),
            from_window: Some("\u{1D54F}".repeat(200)),
            call_id: None,
            result: None,
            at: facade_base::time::iso_now(),
            delivery: facade_base::daemon::Delivery {
                status: facade_base::daemon::DeliveryStatus::Pending,
                reason: None,
                text_written: TextWritten::None,
                enter_written: Some(false),
                deadline: None,
                delivered_via: None,
                delivered_at: None,
            },
        };
        let typed = facade_base::daemon::typed_text(&message);
        for rule in facade_rules::rules().unwrap() {
            let time = delivery_time(&rule.paste, &typed);
            assert!(
                time <= crate::messages::delivery_limit(),
                "{} takes {time:?}",
                rule.cli
            );
        }
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
        let (call, _) = Typing::new(VecDeque::from([Stroke::Paste("never read".into())]), None);
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

    /// Messages taken off a joined paste go back to the queue in order: after the first goes alone,
    /// the next paste has the second before the third.
    #[test]
    fn messages_taken_off_a_joined_paste_keep_their_order() {
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
            pasted.starts_with(b"\x1b[200~line\rline")
                && pasted.ends_with(b"line\r\rthird\x1b[201~"),
            "the second, then the third"
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
                None,
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
        let mut typist = Typist::new(None, post.delivery_handle());
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
            "settled as the input emptied"
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
    /// Enter goes, and the input emptying after it confirms the message.
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
        typist.finish_paste(vec![typing]);
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
        typist.finish_paste(vec![typing]);
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
        typist.finish_paste(vec![first, second]);
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
            Some(DeliveredVia::Read),
            "the read's delivery stays"
        );
        terminal.step(&mut typist, now, ANY);
        assert_eq!(terminal.write_all(), b"\x1b[200~later\x1b[201~");
        assert_eq!(became(&post, later_number), PENDING);
    }

    /// A paste begun before a restart goes ahead of messages gathered for a paste not begun,
    /// however they reached the typist first: they wait behind it, then go on in the order they
    /// came. A paste holds them in the order they were sent, so the order they wait in shows where
    /// they go in two pastes: here their deadline leaves time for one of them at a time.
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
        let one = delivery_time(
            &facade_rules::find("fake").unwrap().unwrap().paste,
            &earlier,
        );
        assert!(
            delivery_time(
                &facade_rules::find("fake").unwrap().unwrap().paste,
                &format!("{earlier}\n\n{later}")
            ) > one
        );
        let due = start + Duration::from_secs(1) + one;
        let (first, first_number) = message(&post, &earlier, due);
        let (second, second_number) = message(&post, &later, due);
        typist.deliver(first);
        typist.deliver(second);
        terminal.step(&mut typist, start, ANY);
        let (begun, begun_number) = message(&post, "hello", start + Duration::from_secs(20));
        post.delivery_handle().begin_paste(&[begun_number]);
        typist.finish_paste(vec![begun]);
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
        let mut typist = Typist::new(None, post.delivery_handle());
        let (typing, number) = message(&post, "hello", Instant::now() + Duration::from_secs(20));
        post.delivery_handle().begin_paste(&[number]);
        typist.finish_paste(vec![typing]);
        assert_eq!(became(&post, number), NOT_KNOWN);
        assert!(!typist.busy());
    }
}
