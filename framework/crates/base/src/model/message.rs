//! Stored messages, delivery outcomes and their presentation.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::address::mcp::{exact_machine_selector, format_reference, parse_machine_selector};
use crate::process::ProcessState;

use super::agent::{
    ANSWER_WAIT, AgentRef, ManagedAgent, ManagedAgentState, ToolsState, error_words, exit_words,
};
use super::machine::WindowRef;
use super::terminal::{CUT_MARK, display_name, first_control};

/// The most characters (Unicode code points) a message carries.
pub const MAX_MESSAGE_CHARS: usize = 8000;
/// The most lines a message carries, whoever receives it: the most the slowest CLI to take a paste,
/// Antigravity, takes within a delivery.
pub const MAX_MESSAGE_LINES: usize = 540;
/// The default and largest number of messages in a page of the `messages` topic.
pub const DEFAULT_MESSAGES_LIMIT: u16 = 100;
pub const MAX_MESSAGES_LIMIT: u16 = 200;
/// The most message IDs one `messages` watch selects.
pub const MAX_MESSAGE_IDS: usize = 100;

/// Refuses text a message cannot carry, saying why: blank text, more than [`MAX_MESSAGE_CHARS`]
/// characters or [`MAX_MESSAGE_LINES`] lines, a control character other than tab and line breaks,
/// or a beginning cut off on its way.
pub fn check_message_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("text is blank: a message needs text".into());
    }
    let length = text.chars().count();
    if length > MAX_MESSAGE_CHARS {
        return Err(format!(
            "text has {length} characters; a message carries at most {MAX_MESSAGE_CHARS}: send it \
             in shorter parts"
        ));
    }
    // A carriage return breaks a line as a line feed does, and the two together break it once.
    let lines = text.replace("\r\n", "\n").split(['\n', '\r']).count();
    if lines > MAX_MESSAGE_LINES {
        return Err(format!(
            "text has {lines} lines; a message carries at most {MAX_MESSAGE_LINES}: send it in \
             shorter parts"
        ));
    }
    if let Some(control) = first_control(text) {
        return Err(control);
    }
    if text.starts_with(CUT_MARK) {
        return Err(format!(
            "text starts with {CUT_MARK:?}: its beginning was cut on its way; send it in \
             shorter parts"
        ));
    }
    Ok(())
}

/// The result of a send before encoding it for a client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendOutcome {
    pub message: Message,
    pub repeated: bool,
    pub withdrawn: bool,
    pub window_delivery: Option<Vec<WindowDeliveryOutcome>>,
}

/// One member window's outcome for a message to the person.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WindowDeliveryOutcome {
    Delivered { window: WindowRef },
    NotDelivered { window: WindowRef, reason: String },
    OutcomeUnknown { window: WindowRef },
}

impl WindowDeliveryOutcome {
    pub fn window(&self) -> &WindowRef {
        match self {
            Self::Delivered { window }
            | Self::NotDelivered { window, .. }
            | Self::OutcomeUnknown { window } => window,
        }
    }

    pub fn is_delivered(&self) -> bool {
        matches!(self, Self::Delivered { .. })
    }
}

/// The member windows' outcomes for one message to the person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowDelivery {
    /// Windows whose `messages` subscriptions took the notification.
    pub delivered: Vec<WindowRef>,
    /// Windows whose subscriptions did not take the notification.
    pub not_delivered: Vec<WindowDeliveryFailure>,
    /// The notification was sent, and its receipt was lost before delivery could be confirmed.
    pub outcome_unknown: Vec<WindowRef>,
}

impl WindowDelivery {
    /// Encodes the SQLite and MCP grouping.
    pub fn from_outcomes(outcomes: impl IntoIterator<Item = WindowDeliveryOutcome>) -> Self {
        let mut delivery = Self {
            delivered: Vec::new(),
            not_delivered: Vec::new(),
            outcome_unknown: Vec::new(),
        };
        for outcome in outcomes {
            match outcome {
                WindowDeliveryOutcome::Delivered { window } => delivery.delivered.push(window),
                WindowDeliveryOutcome::NotDelivered { window, reason } => {
                    delivery
                        .not_delivered
                        .push(WindowDeliveryFailure { window, reason });
                }
                WindowDeliveryOutcome::OutcomeUnknown { window } => {
                    delivery.outcome_unknown.push(window)
                }
            }
        }
        delivery
    }

    /// Reads the stored grouping into individual outcomes.
    pub fn into_outcomes(self) -> Vec<WindowDeliveryOutcome> {
        self.delivered
            .into_iter()
            .map(|window| WindowDeliveryOutcome::Delivered { window })
            .chain(self.not_delivered.into_iter().map(
                |WindowDeliveryFailure { window, reason }| WindowDeliveryOutcome::NotDelivered {
                    window,
                    reason,
                },
            ))
            .chain(
                self.outcome_unknown
                    .into_iter()
                    .map(|window| WindowDeliveryOutcome::OutcomeUnknown { window }),
            )
            .collect()
    }
}

/// Why a member window did not take a notification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowDeliveryFailure {
    pub window: WindowRef,
    /// `window_disconnected` if the window has no connection, or `not_watching` if no current
    /// subscription took the notification, or `machine_unavailable` if it could not be sent to the
    /// window's machine.
    pub reason: String,
}

/// The sender of Facade's own results.
pub const FACADE: &str = "facade";

/// A message: one sender, one recipient, the complete text, and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Message {
    /// `m` followed by a number, unique within the Facade home.
    pub message_id: String,
    /// The full reference for a window notification to the person or a remote send receipt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_ref: Option<MessageRef>,
    /// The sender: an agent ID, `human` for the person, or `facade` for a result: Facade's own
    /// words on what became of a start, not an agent's.
    pub from: String,
    /// The sender's machine, when different from the one that stored the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_machine_id: Option<String>,
    /// The sender's name when it sent the message. Omitted for the person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// The recipient's agent ID, or `human` for the person.
    pub to: String,
    /// The complete text as sent.
    pub text: String,
    /// The message this one answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The replied-to message's machine, when different from the one that stored this message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_machine_id: Option<String>,
    /// Whether the sender requested a command-line reply.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub command_line_reply: bool,
    /// The sender's window name if it had a single member window and the recipient did not belong
    /// to that window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_window: Option<String>,
    /// A result's call: the ID of the MCP `tools/call` it answers later. On a start's prompt, the
    /// call its result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// A result's facts, which its text words. Omitted for any other message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<StartOutcome>,
    /// When Facade received it, in UTC ISO 8601 format with milliseconds.
    pub at: String,
    pub delivery: Delivery,
}

/// What became of a start with a prompt, as its result tells the agent that started it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StartOutcome {
    /// The started agent as it was when its prompt was settled.
    pub agent: ManagedAgent,
    pub prompt: PromptOutcome,
}

/// A start prompt's message ID and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PromptOutcome {
    pub message_id: String,
    pub delivery: Delivery,
}

/// A start result's words, as Facade's editor extension words them: the agent started, whether its
/// tools are there, and what became of its prompt, with what of it reached the terminal and, where
/// it was not delivered, why.
pub fn start_result_text(outcome: &StartOutcome) -> String {
    start_result_text_at(outcome, &outcome.agent.agent_id, &outcome.prompt.message_id)
}

/// Formats a start result using the agent and prompt addresses resolved for the recipient.
pub fn start_result_text_at(
    outcome: &StartOutcome,
    agent_address: &str,
    prompt_address: &str,
) -> String {
    let agent = &outcome.agent;
    let mut lines = vec![format!(
        "{} ({agent_address}) has started.",
        display_name(&agent.name)
    )];
    match (agent.tools_state, agent.tools_reason) {
        (ToolsState::Connecting, _) => lines.push("Its Facade tools are still connecting.".into()),
        (ToolsState::Unavailable, Some(reason)) => lines.push(format!(
            "Its Facade tools are unavailable: {}.",
            reason.words()
        )),
        (ToolsState::Unavailable | ToolsState::NotInjected, _) => {
            lines.push("Its Facade tools are unavailable.".into())
        }
        _ => {}
    }
    let delivery = &outcome.prompt.delivery;
    let untouched =
        delivery.text_written == TextWritten::None && delivery.enter_written == Some(false);
    match delivery.status {
        DeliveryStatus::Success
            if delivery.delivered_via == Some(DeliveredVia::ReadByRecipient) =>
        {
            lines.push(format!(
                "Your prompt {prompt_address} has been passed on through read_messages."
            ));
            if !untouched {
                lines.push(input_words(delivery, false));
            }
        }
        DeliveryStatus::Success => {
            lines.push(format!("Your prompt {prompt_address} has been passed on."))
        }
        _ => {
            lines.push(match untouched {
                true => format!(
                    "Your prompt {prompt_address} could not be delivered. {}",
                    input_words(delivery, true)
                ),
                false => format!(
                    "Delivery of your prompt {prompt_address} could not be confirmed. {}",
                    input_words(delivery, true)
                ),
            });
            let mut why = delivery.failure_reason(agent_address);
            if !why.starts_with(agent_address) {
                let mut letters = why.chars();
                why = letters
                    .next()
                    .map(|first| first.to_uppercase().chain(letters).collect::<String>())
                    .unwrap_or_default();
            }
            why.push('.');
            lines.push(why);
            let detail = agent.state_detail.as_ref();
            if agent.process == ProcessState::Ended || agent.exit.is_some() {
                let exit = agent.exit.as_ref().map_or_else(
                    || "ended. Its exit status is unavailable".into(),
                    |exit| exit_words(exit, detail.and_then(|detail| detail.how)),
                );
                lines.push(format!("The agent {exit}."));
                lines.push(match &agent.session {
                    Some(session) => format!(
                        "Facade recorded session {}. Check `facade resume` for that session \
                         before starting it again.",
                        display_name(session)
                    ),
                    None => "Facade has no recorded session to resume. Read its screen before \
                             starting it again."
                        .into(),
                });
            } else if agent.state == ManagedAgentState::Error {
                let error = error_words(detail, agent.tools_reason);
                lines.push(format!(
                    "The agent {error}. Read its screen to decide what to do next."
                ));
            } else if agent.state == ManagedAgentState::WaitingForYou
                && let Some(wait) = detail
                    .and_then(|detail| detail.kind)
                    .and_then(|kind| kind.waiting_for())
            {
                lines.push(format!("The agent waits for {wait}. {ANSWER_WAIT}"));
            }
        }
    }
    lines.join("\n")
}

/// A failed Inbox send, including the actual submission facts and a safe next step.
pub fn send_failure_text(
    message: &str,
    target: &str,
    delivery: &Delivery,
    withdrawn: bool,
) -> String {
    let (typed, submitted) = input_facts(delivery);
    let next = if withdrawn
        && delivery.text_written == TextWritten::None
        && delivery.enter_written == Some(false)
    {
        "Facade withdrew the message. You can resend it."
    } else {
        "Check the recipient's terminal before retrying."
    };
    let why = delivery.failure_reason(target);
    format!(
        "Message {message} to {target} failed.\nDelivery failed because {why}. {typed} {submitted} {next}"
    )
}

/// What of a message reached the terminal, then what to check: before sending it again, or, after
/// it was delivered, for input left over.
fn input_words(delivery: &Delivery, before_retry: bool) -> String {
    if delivery.text_written == TextWritten::None && delivery.enter_written == Some(false) {
        return "Nothing was entered in the terminal.".into();
    }
    let (text, submitted) = input_facts(delivery);
    let check = if before_retry {
        "Check the terminal before sending it again."
    } else {
        "Check the terminal for leftover input."
    };
    format!("{text} {submitted} {check}")
}

fn input_facts(delivery: &Delivery) -> (&'static str, &'static str) {
    let text = match delivery.text_written {
        TextWritten::None => "No message text was entered.",
        TextWritten::Partial => "Only part of the message was entered.",
        TextWritten::Full => "The full message was entered.",
        TextWritten::Unknown | TextWritten::Unrecognized => "How much text was entered is unknown.",
    };
    let submitted = match delivery.enter_written {
        Some(true) => "The submission key was pressed.",
        Some(false) => "The submission key was not pressed.",
        None => "Whether the submission key was pressed is unknown.",
    };
    (text, submitted)
}

/// The message as its recipient's terminal shows it: a header naming its sender, its number, the
/// sender's window where that is another, and what it answers, then the text. A result shows `🔔`,
/// its first line and its number, then the rest.
pub fn typed_text(message: &Message) -> String {
    typed_text_with_machines(message, None, None)
}

/// Formats a message for its recipient's terminal. Give machine selectors from the recipient's
/// perspective for a remote sender or reply. The message's own number is local to the recipient.
pub fn typed_text_with_machines(
    message: &Message,
    from_machine: Option<&str>,
    reply_machine: Option<&str>,
) -> String {
    if message.from == FACADE {
        let (first, rest) = message.text.split_once('\n').unwrap_or((&message.text, ""));
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!("\n{rest}")
        };
        return format!("🔔 {first} · #{}{rest}", message.message_id);
    }
    let valid_selector = |selector: &&str| parse_machine_selector(selector).is_ok();
    let from_machine = from_machine.filter(valid_selector);
    let reply_machine = reply_machine.filter(valid_selector);
    let sender_ref = format_reference(
        &message.from,
        from_machine.filter(|_| message.from != "human"),
    );
    let sender = match &message.from_name {
        Some(name) => format!("{} ({sender_ref})", display_name(name)),
        None => sender_ref,
    };
    let origin = match (message.from_window.as_deref(), from_machine) {
        (Some(window), Some(machine)) => format!(" · From {} on {machine}", display_name(window)),
        (Some(window), None) => format!(" · From {}", display_name(window)),
        (None, Some(machine)) => format!(" · on {machine}"),
        (None, None) => String::new(),
    };
    let reply = message
        .reply_to
        .as_deref()
        .map(|reply| format!(" · Reply to {}", format_reference(reply, reply_machine)))
        .unwrap_or_default();
    format!(
        "📨 Message from {sender} · #{}{origin}{reply}\n{}",
        message.message_id, message.text
    )
}

/// What became of a message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Delivery {
    /// `pending` while the message is being delivered, then `success` or `failure`.
    pub status: DeliveryStatus,
    /// Why it was not delivered. Omitted unless it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<DeliveryFailure>,
    /// How much of the message reached the recipient's terminal.
    pub text_written: TextWritten,
    /// Whether the message's submission key (Enter or Tab) reached the recipient's terminal.
    /// Omitted when the write outcome is unknown, for example when the key was still queued at the
    /// deadline or a restart interrupted delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter_written: Option<bool>,
    /// When a pending delivery fails if the message is not delivered by then. Omitted once it is
    /// settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    /// How the message was delivered. Omitted unless it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_via: Option<DeliveredVia>,
    /// When the message was delivered. Omitted unless it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
}

impl Delivery {
    /// Why the message to `to` was not delivered, then what of it was typed, in words: `a draft
    /// held #a2's input until the deadline; Facade never types over a draft; nothing was typed`. It
    /// says no more than `text_written` and `enter_written`.
    pub fn failure_words(&self, to: &str) -> String {
        if self.reason == Some(DeliveryFailure::InteractionAfterWrite) {
            let (typed, submitted) = input_facts(self);
            return format!(
                "{}. {typed} {submitted} Check the recipient's terminal",
                self.failure_reason(to)
            );
        }
        let typed = match (self.text_written, self.enter_written) {
            (TextWritten::None, _) => "nothing was typed",
            (TextWritten::Partial, _) => "part of it was typed",
            (TextWritten::Full, Some(true)) => {
                "the full message and its submission key reached the terminal"
            }
            (TextWritten::Full, Some(false)) => {
                "the full message reached the terminal without its submission key"
            }
            (TextWritten::Full, None) => "all of it was typed",
            (TextWritten::Unknown | TextWritten::Unrecognized, _) => {
                "what of it was typed is not known"
            }
        };
        format!("{}; {typed}", self.failure_reason(to))
    }

    /// Why the message to `to` was not delivered, in words:
    /// `the deadline passed before #a2 took the message`.
    pub fn failure_reason(&self, to: &str) -> String {
        let known = !matches!(
            self.text_written,
            TextWritten::Unknown | TextWritten::Unrecognized
        );
        match self.reason.unwrap_or(DeliveryFailure::Unknown) {
            DeliveryFailure::Ended => format!("{to} ended before the message was delivered"),
            DeliveryFailure::InputDraft => format!(
                "a draft held {to}'s input until the deadline; Facade never types over a draft"
            ),
            DeliveryFailure::InputInteraction => format!(
                "a menu, login, or question of {to}'s CLI held its input until the deadline"
            ),
            DeliveryFailure::InputUnknown => {
                format!("{to}'s input was not recognized as empty until the deadline")
            }
            DeliveryFailure::Timeout => format!("the deadline passed before {to} took the message"),
            DeliveryFailure::SubmissionUnconfirmed if known => {
                format!("{to}'s CLI did not take the message before the deadline")
            }
            DeliveryFailure::SubmissionUnconfirmed => {
                format!("Facade could not confirm by the deadline that {to}'s CLI took the message")
            }
            DeliveryFailure::InteractionAfterWrite => format!(
                "{to}'s CLI opened a question or menu after Facade wrote delivery input. \
                 The paste or submission key may have been taken as an answer"
            ),
            DeliveryFailure::Unsupported => format!(
                "Facade types no messages into {to}'s CLI: it has no rule to read its input by"
            ),
            DeliveryFailure::Unknown => format!("the message was not delivered to {to}"),
        }
    }
}

/// The state of a message's delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    /// The message is being delivered, or waits for its guest's next turn.
    Pending,
    /// The message was delivered.
    Success,
    /// The message was not delivered.
    Failure,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Why a message was not delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryFailure {
    /// The recipient ended, or its terminal stopped taking input, before the message was delivered.
    Ended,
    /// A draft held the recipient's input until the deadline. A draft that is not the message's own
    /// is never typed over.
    InputDraft,
    /// A menu, login, or question of the recipient's CLI held its input until the deadline.
    InputInteraction,
    /// The recipient's input was not recognized as empty until the deadline: its screen did not
    /// show it as its CLI's rule describes it.
    InputUnknown,
    /// The input was empty. The delivery deadline passed before the paste and submission key
    /// could both reach the terminal and be confirmed.
    Timeout,
    /// Its paste began, but the recipient's CLI did not take the message before the deadline. A
    /// paste its terminal had not taken whole by then still goes in, and no Enter follows it.
    SubmissionUnconfirmed,
    /// A question or menu appeared after delivery input reached the terminal and before the
    /// CLI showed that it took the message.
    InteractionAfterWrite,
    /// The recipient's CLI has no rule to read its input by, so Facade types no message into it.
    Unsupported,
    /// A reason this build does not recognize.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// How much of a message reached the recipient's terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TextWritten {
    /// None of it.
    None,
    /// Part of it.
    Partial,
    /// All of it.
    Full,
    /// Not known: the recipient read the message while its typist was typing it, its typist did not
    /// say by the deadline, what it typed was still queued then, to reach the terminal once the CLI
    /// reads, or the daemon before a restart had begun its paste.
    Unknown,
    /// A value this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

/// How a message was delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveredVia {
    /// Typed into the recipient's terminal and submitted.
    #[serde(rename = "terminal")]
    TypedIntoInput,
    /// Returned by a snapshot of the recipient's `messages` topic.
    #[serde(rename = "read")]
    ReadByRecipient,
    /// A message to the person: delivered to one or more member windows' subscriptions.
    #[serde(rename = "notified")]
    DeliveredToWindows,
    /// Returned to the sending command as its reply.
    ReturnedToRequest,
    /// A way this build does not recognize.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl DeliveredVia {
    /// The spelling used in storage and MCP.
    #[allow(non_upper_case_globals)]
    pub const Read: Self = Self::ReadByRecipient;
}

/// Arguments for the `messages` topic: which messages of the inbox to read. Without `ids` or `all`,
/// the messages not yet delivered.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MessagesWatchArgs {
    /// These messages, by ID (`m4` or `#m4`): 1 to 100. Excludes `all` and `cursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
    /// Every message in the inbox, delivered or not: messages are kept 30 days.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
    /// Continues the previous page of the same selection from its `next_cursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// The most messages in a page, 1 to 200. Defaults to 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u16>,
    /// The newest messages of the selection, this many, 1 to 200, in one page. Excludes `ids`,
    /// `cursor` and `limit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<u16>,
}

/// The inbox at the start of a `messages` watch.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MessagesSnapshot {
    /// The selected messages, oldest first.
    pub messages: Vec<Message>,
    /// IDs in `ids` that are not in the inbox.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_found: Vec<String>,
    /// Pass as `cursor` to read the next page. Omitted on the last page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A message's identity on the machine that assigned its number.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
pub struct MessageRef {
    pub machine_id: String,
    pub message_id: String,
}

impl MessageRef {
    pub fn exact_address(&self) -> String {
        self.address(&exact_machine_selector(&self.machine_id))
    }

    pub fn address(&self, machine_selector: &str) -> String {
        format_reference(&self.message_id, Some(machine_selector))
    }

    pub fn label(&self, local_machine_id: &str, machine_selector: &str) -> String {
        format_reference(
            &self.message_id,
            (self.machine_id != local_machine_id).then_some(machine_selector),
        )
    }
}

/// A start's result message for its creator, with the number the creator's machine reserved.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "DeliverStartResultArgs")]
pub struct AgentDeliverStartResultArgs {
    pub recipient: AgentRef,
    pub message: Message,
}

#[cfg(test)]
mod tests {
    use super::super::agent::ToolsReason;
    use super::*;
    use serde_json::json;

    #[test]
    fn window_delivery_rows_keep_the_stored_grouping_and_methods() {
        let one = json!({ "machine_id": "here", "window_id": "one" });
        let two = json!({ "machine_id": "here", "window_id": "two" });
        let three = json!({ "machine_id": "there", "window_id": "three" });
        let stored = json!({
            "delivered": [one],
            "not_delivered": [{ "window": two, "reason": "not_watching" }],
            "outcome_unknown": [three],
        });
        let receipt: WindowDelivery = serde_json::from_value(stored.clone()).unwrap();
        let outcomes = receipt.into_outcomes();
        assert_eq!(
            serde_json::to_value(&outcomes).unwrap(),
            json!([
                { "window": one, "state": "delivered" },
                { "window": two, "state": "not_delivered", "reason": "not_watching" },
                { "window": three, "state": "outcome_unknown" },
            ])
        );
        assert_eq!(
            serde_json::to_value(WindowDelivery::from_outcomes(outcomes)).unwrap(),
            stored
        );
        for (via, name) in [
            (DeliveredVia::TypedIntoInput, "terminal"),
            (DeliveredVia::ReadByRecipient, "read"),
            (DeliveredVia::DeliveredToWindows, "notified"),
            (DeliveredVia::ReturnedToRequest, "returned_to_request"),
        ] {
            assert_eq!(serde_json::to_value(via).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<DeliveredVia>(json!(name)).unwrap(),
                via
            );
        }
    }

    /// A message shows under one header line: its sender's name and ID, its number, its sender's
    /// window where that is another, and what it answers.
    #[test]
    fn a_message_shows_its_sender_number_window_and_reply_above_its_text() {
        let delivery = Delivery {
            status: DeliveryStatus::Pending,
            reason: None,
            text_written: TextWritten::None,
            enter_written: Some(false),
            deadline: None,
            delivered_via: None,
            delivered_at: None,
        };
        let mut sent = Message {
            message_ref: None,
            from_machine_id: None,
            reply_to_machine_id: None,
            message_id: "m42".into(),
            from: "a1".into(),
            from_name: Some("Ada".into()),
            to: "a2".into(),
            text: "message 42".into(),
            reply_to: None,
            command_line_reply: false,
            from_window: None,
            call_id: None,
            result: None,
            at: "2026-11-10T00:00:00.000Z".into(),
            delivery,
        };
        assert_eq!(
            typed_text(&sent),
            "📨 Message from Ada (#a1) · #m42\nmessage 42"
        );
        sent.reply_to = Some("m39".into());
        assert_eq!(
            typed_text(&sent),
            "📨 Message from Ada (#a1) · #m42 · Reply to #m39\nmessage 42"
        );
        sent.from_window = Some("Design".into());
        assert_eq!(
            typed_text(&sent),
            "📨 Message from Ada (#a1) · #m42 · From Design · Reply to #m39\nmessage 42",
            "the sender's window, where it is another"
        );
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu"), Some("id:3f9a2c1d")),
            "📨 Message from Ada (#a1@gpu) · #m42 · From Design on gpu · Reply to #m39@id:3f9a2c1d\nmessage 42"
        );
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu\n"), Some("gpu\n")),
            typed_text(&sent),
            "only valid selectors appear in the header"
        );
        sent.from_window = None;
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu"), None),
            "📨 Message from Ada (#a1@gpu) · #m42 · on gpu · Reply to #m39\nmessage 42"
        );
        sent.from_window = Some("evil\u{1b}[201~\r\nWINDOW".into());
        assert_eq!(
            typed_text(&sent).lines().count(),
            2,
            "a window's name shows on the header's one line"
        );
        sent.from_window = None;
        sent.from_name = Some("evil\u{1b}[201~\r\nINJECTED".into());
        sent.reply_to = None;
        let typed = typed_text(&sent);
        assert_eq!(
            typed.split_once('\n'),
            Some((
                "📨 Message from evil [201~ INJECTED (#a1) · #m42",
                "message 42"
            )),
            "a name shows on the header's one line"
        );
        sent.from = "human".into();
        sent.from_name = None;
        assert_eq!(
            typed_text(&sent),
            "📨 Message from #human · #m42\nmessage 42"
        );
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu"), None),
            "📨 Message from #human · #m42 · on gpu\nmessage 42",
            "the person always uses the reserved #human reference"
        );
    }

    /// A result shows `🔔`, its first line and its own number, then the rest: no sender's header
    /// and no reply. Its words say the agent started, whether its tools are there, and what became
    /// of its prompt: passed on, through a read, or not delivered with what reached the terminal
    /// and why.
    #[test]
    fn a_result_shows_under_a_bell_and_words_what_became_of_the_prompt() {
        let agent: ManagedAgent = serde_json::from_value(serde_json::json!({
            "agent_id": "a5", "name": "helper", "cli": "claude", "cwd": "/w",
            "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "windows": [{
                "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "window_id": "terminal"
            }],
            "location_id": "loc-1", "pid": 7, "process": "running",
            "cols": 80, "rows": 24, "created_at": "2026-11-11T00:00:00.000Z", "root": "a5",
            "yolo": true, "state": "idle", "tools_state": "available",
        }))
        .unwrap();
        let delivery = |status, reason, text_written, enter_written, delivered_via| Delivery {
            status,
            reason,
            text_written,
            enter_written,
            deadline: None,
            delivered_via,
            delivered_at: None,
        };
        let outcome = |agent: &ManagedAgent, delivery: Delivery| StartOutcome {
            agent: agent.clone(),
            prompt: PromptOutcome {
                message_id: "m42".into(),
                delivery,
            },
        };
        let words = |agent: &ManagedAgent, delivery| start_result_text(&outcome(agent, delivery));
        let typed = delivery(
            DeliveryStatus::Success,
            None,
            TextWritten::Full,
            Some(true),
            Some(DeliveredVia::TypedIntoInput),
        );
        assert_eq!(
            words(&agent, typed.clone()),
            "helper (a5) has started.\nYour prompt m42 has been passed on."
        );
        let read = delivery(
            DeliveryStatus::Success,
            None,
            TextWritten::None,
            Some(false),
            Some(DeliveredVia::ReadByRecipient),
        );
        assert_eq!(
            words(&agent, read),
            "helper (a5) has started.\nYour prompt m42 has been passed on through \
             read_messages."
        );
        let read_while_typed = delivery(
            DeliveryStatus::Success,
            None,
            TextWritten::Unknown,
            None,
            Some(DeliveredVia::ReadByRecipient),
        );
        assert_eq!(
            words(&agent, read_while_typed),
            "helper (a5) has started.\nYour prompt m42 has been passed on through \
             read_messages.\n\
             How much text was entered is unknown. Whether the submission key was pressed is \
             unknown. Check the terminal for leftover input."
        );
        let ended = delivery(
            DeliveryStatus::Failure,
            Some(DeliveryFailure::Ended),
            TextWritten::None,
            Some(false),
            None,
        );
        assert_eq!(
            words(&agent, ended.clone()),
            "helper (a5) has started.\nYour prompt m42 could not be delivered. Nothing \
             was entered in the terminal.\n\
             a5 ended before the message was delivered."
        );
        assert_eq!(
            start_result_text_at(&outcome(&agent, ended.clone()), "a5@devbox", "m42@devbox"),
            "helper (a5@devbox) has started.\nYour prompt m42@devbox could not be delivered. \
             Nothing was entered in the terminal.\na5@devbox ended before the message was delivered."
        );
        let ended_agent = ManagedAgent {
            process: ProcessState::Ended,
            state: ManagedAgentState::Ended,
            ..agent.clone()
        };
        assert!(words(&ended_agent, ended.clone()).ends_with(
            "The agent ended. Its exit status is unavailable.\n\
             Facade has no recorded session to resume. Read its screen before starting it again."
        ));
        let ended_with_session = ManagedAgent {
            exit: Some(crate::process::ProcessExit {
                code: Some(7),
                signal: None,
                reason: None,
                at: agent.created_at.clone(),
            }),
            session: Some("recorded-session".into()),
            ..ended_agent
        };
        assert!(words(&ended_with_session, ended).ends_with(
            "The agent ended with exit code 7.\n\
             Facade recorded session recorded-session. Check `facade resume` for that session \
             before starting it again."
        ));
        let unconfirmed = delivery(
            DeliveryStatus::Failure,
            Some(DeliveryFailure::SubmissionUnconfirmed),
            TextWritten::Full,
            Some(false),
            None,
        );
        assert_eq!(
            words(&agent, unconfirmed),
            "helper (a5) has started.\nDelivery of your prompt m42 could not be \
             confirmed. The full message was entered. The submission key was not pressed. \
             Check the terminal before sending it again.\na5's CLI did not take the \
             message before the deadline."
        );
        let unavailable = ManagedAgent {
            tools_state: ToolsState::Unavailable,
            tools_reason: Some(ToolsReason::NotConnected),
            ..agent.clone()
        };
        assert_eq!(
            words(&unavailable, typed.clone()).lines().nth(1),
            Some(
                "Its Facade tools are unavailable: its Facade server did not connect within \
                 30 seconds."
            )
        );
        let result = Message {
            message_ref: None,
            from_machine_id: None,
            reply_to_machine_id: None,
            message_id: "m43".into(),
            from: FACADE.into(),
            from_name: None,
            to: "a1".into(),
            text: words(&agent, typed),
            reply_to: None,
            command_line_reply: false,
            from_window: None,
            call_id: Some("7".into()),
            result: None,
            at: "2026-11-11T00:00:00.000Z".into(),
            delivery: delivery(
                DeliveryStatus::Pending,
                None,
                TextWritten::None,
                Some(false),
                None,
            ),
        };
        assert_eq!(
            typed_text(&result),
            "🔔 helper (a5) has started. · #m43\nYour prompt m42 has been passed on."
        );
        assert_eq!(
            typed_text(&Message {
                text: "one line".into(),
                ..result
            }),
            "🔔 one line · #m43"
        );
    }

    /// A failed delivery says why, then what of it was typed, never more than its delivery says.
    #[test]
    fn a_failed_delivery_says_why_and_claims_no_more_than_is_known() {
        let failed = |reason, text_written, enter_written| {
            let delivery = Delivery {
                status: DeliveryStatus::Failure,
                reason: Some(reason),
                text_written,
                enter_written,
                deadline: None,
                delivered_via: None,
                delivered_at: None,
            };
            delivery.failure_words("#a2")
        };
        use DeliveryFailure::{InputDraft, SubmissionUnconfirmed, Timeout};
        assert_eq!(
            failed(InputDraft, TextWritten::None, Some(false)),
            "a draft held #a2's input until the deadline; Facade never types over a draft; \
             nothing was typed"
        );
        assert_eq!(
            failed(Timeout, TextWritten::None, Some(false)),
            "the deadline passed before #a2 took the message; nothing was typed"
        );
        let unconfirmed = "#a2's CLI did not take the message before the deadline";
        for (text_written, enter_written, typed) in [
            (TextWritten::None, Some(false), "nothing was typed"),
            (TextWritten::Partial, Some(false), "part of it was typed"),
            (
                TextWritten::Full,
                Some(false),
                "the full message reached the terminal without its submission key",
            ),
            (
                TextWritten::Full,
                Some(true),
                "the full message and its submission key reached the terminal",
            ),
        ] {
            assert_eq!(
                failed(SubmissionUnconfirmed, text_written, enter_written),
                format!("{unconfirmed}; {typed}")
            );
        }
        assert_eq!(
            failed(SubmissionUnconfirmed, TextWritten::Unknown, None),
            "Facade could not confirm by the deadline that #a2's CLI took the message; what of it \
             was typed is not known"
        );
    }

    #[test]
    fn a_question_after_delivery_input_warns_the_sender_what_may_have_happened() {
        let delivery = Delivery {
            status: DeliveryStatus::Failure,
            reason: Some(DeliveryFailure::InteractionAfterWrite),
            text_written: TextWritten::Full,
            enter_written: Some(false),
            deadline: None,
            delivered_via: None,
            delivered_at: None,
        };
        let words = delivery.failure_words("#a2");
        let notice = send_failure_text("m1", "#a2", &delivery, false);
        for message in [words, notice] {
            assert!(
                message.contains(
                    "#a2's CLI opened a question or menu after Facade wrote delivery input"
                )
            );
            assert!(
                message.contains("The paste or submission key may have been taken as an answer")
            );
            assert!(message.contains("The submission key was not pressed"));
            assert!(message.contains("Check the recipient's terminal"));
        }
        assert_eq!(
            serde_json::to_value(delivery.reason).unwrap(),
            serde_json::json!("interaction_after_write")
        );
    }

    #[test]
    fn message_text_is_printable_characters_tabs_and_line_breaks_up_to_eight_thousand_characters() {
        assert!(check_message_text("hello\n\tworld 界").is_ok());
        assert!(
            check_message_text(&"界".repeat(MAX_MESSAGE_CHARS)).is_ok(),
            "characters, not bytes"
        );
        assert!(
            check_message_text(&"x".repeat(MAX_MESSAGE_CHARS + 1))
                .unwrap_err()
                .starts_with("text has 8001 characters")
        );
        let lines = |count: usize, between: &str| vec!["x"; count].join(between);
        assert!(check_message_text(&lines(MAX_MESSAGE_LINES, "\n")).is_ok());
        for between in ["\n", "\r", "\r\n"] {
            let refused = check_message_text(&lines(MAX_MESSAGE_LINES + 1, between)).unwrap_err();
            assert_eq!(
                refused,
                "text has 541 lines; a message carries at most 540: send it in shorter parts",
                "{between:?}"
            );
        }
        assert_eq!(
            check_message_text(" \n\t").unwrap_err(),
            "text is blank: a message needs text"
        );
        assert_eq!(
            check_message_text("a\u{1b}[2J").unwrap_err(),
            "text contains the control character U+001B at character 2; text takes printable \
             characters, tabs, and line breaks"
        );
        assert!(
            check_message_text("a\u{7f}")
                .unwrap_err()
                .contains("U+007F"),
            "DEL too"
        );
        assert!(
            check_message_text("[Earlier output truncated] the rest")
                .unwrap_err()
                .contains("its beginning was cut")
        );
    }
}
