//! Message delivery and receipts.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{AgentInfo, AgentLabel, Delivery, MessageRef, PromptOutcome};

/// The receipt of a send, with the address that can be used to wait for a reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3SendResult")]
pub struct SendResult {
    pub id: String,
    pub message: Message,
    /// The recipient selected for this send, including when delivery fails.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<AgentLabel>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repeated: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub withdrawn: bool,
    /// The original message the Guest was waiting for this sender to answer. It can be
    /// included when a send without `reply_to` timed out and was withdrawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_reply_to: Option<MessageRef>,
}

/// The public MCP inbox request.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ReadMessagesArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<u16>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wait: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

/// A complete inbox message as the receiving MCP client reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InboxMessage {
    pub id: String,
    pub from: String,
    pub at: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReadMessagesResult {
    pub messages: Vec<InboxMessage>,
    /// Continue the page by passing this value as `after`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3SendArgs")]
pub struct AgentSendArgs {
    /// The recipient's address or name.
    pub to: String,
    /// The complete message: at most 8,000 characters and 540 lines of text, tabs, and line breaks,
    /// not blank.
    pub text: String,
    /// The message this one answers, by ID or address such as `m4@gpu`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The storage machine of the reply's reference, after the originating daemon verified it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_machine_id: Option<String>,
    /// The caller's own ID of this send, 1 to 200 characters. A retry within an hour with the same
    /// sender, sender machine, target, and ID joins its ongoing delivery or returns its original
    /// result. A withdrawn message keeps only a private record of the outcome for retries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// What is left of the send's 30 seconds as it leaves the client, in milliseconds: its
    /// delivery's deadline counts that from the daemon's receipt, at most 29,500. Omitted, 29,500.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_left_ms: Option<u64>,
    /// A terminal can request a numbered delivery outcome for a target without an input rule.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_unsupported_receipt: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3Message")]
pub struct Message {
    /// `m` followed by a number, unique within the Facade home.
    pub message_id: String,
    /// The full reference, when a remote message receipt needs it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_ref: Option<MessageRef>,
    /// The sender: an agent ID, `command_line` or `facade`.
    pub from: String,
    /// The sender's machine, when different from the one that stored the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_machine_id: Option<String>,
    /// The sender's name when it sent the message. Omitted for `command_line` and `facade`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// The recipient's agent ID.
    pub to: String,
    /// The complete text as sent.
    pub text: String,
    /// The message this one answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The replied-to message's machine, when different from the one that stored this message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_machine_id: Option<String>,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3StartOutcome")]
pub struct StartOutcome {
    /// The started agent as it was when its prompt was settled.
    pub agent: AgentInfo,
    pub prompt: PromptOutcome,
}
