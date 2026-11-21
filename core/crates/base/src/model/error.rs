//! Shared operation errors and delivery diagnostics.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::agent::{AgentLabel, SessionMatch};
use super::machine::{
    ExecutionOutcome, Kept, MachineIdConflict, MachineQueryResult, SshInteraction, Unavailable,
};
use super::message::{
    MessageRef, TextWritten, WindowDelivery, WindowDeliveryFailure, WindowDeliveryOutcome,
};

/// JSON-RPC's own error codes, and the one it leaves to servers that Facade uses for every other
/// failure.
const INVALID_PARAMS: i64 = -32602;
const SERVER_ERROR: i64 = -32000;

/// A request error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorBody {
    /// The JSON-RPC error code: -32700 for invalid JSON, -32600 for an invalid request, -32601 for
    /// an unknown method, -32602 for invalid arguments, and -32000 for other failures.
    pub code: i64,
    /// A plain-language explanation of the error.
    pub message: String,
    /// Structured error details.
    pub data: Box<ErrorData>,
}

/// A send error with its window receipt before encoding it for a client.
#[derive(Clone, Debug)]
pub struct SendFailure {
    pub error: ErrorBody,
    pub window_delivery: Option<Vec<WindowDeliveryOutcome>>,
}

impl From<ErrorBody> for SendFailure {
    fn from(mut error: ErrorBody) -> Self {
        let failures = error.data.windows.take();
        let window_delivery = error
            .data
            .window_delivery
            .take()
            .map(WindowDelivery::into_outcomes)
            .or_else(|| {
                failures.map(|failures| {
                    failures
                        .into_iter()
                        .map(|WindowDeliveryFailure { window, reason }| {
                            WindowDeliveryOutcome::NotDelivered { window, reason }
                        })
                        .collect()
                })
            });
        Self {
            error,
            window_delivery,
        }
    }
}

impl From<SendFailure> for ErrorBody {
    fn from(failure: SendFailure) -> Self {
        let mut error = failure.error;
        if let Some(outcomes) = failure.window_delivery {
            let receipt = WindowDelivery::from_outcomes(outcomes);
            if error.data.unavailable.as_ref().is_some_and(|unavailable| {
                unavailable.execution == ExecutionOutcome::OutcomeUnknown
            }) {
                error.data.window_delivery = Some(receipt);
            } else {
                error.data.windows = Some(receipt.not_delivered);
            }
        }
        error
    }
}

/// Error details for clients to inspect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorData {
    /// The error reason for clients to inspect.
    pub reason: Reason,
    /// With `partial_input` for text: how much of the text reached the agent's terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_written: Option<TextWritten>,
    /// With `partial_input` for text: whether its Enter reached the agent's terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter_written: Option<bool>,
    /// With `partial_input` for keys: how many keys reached the agent's terminal whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys_sent: Option<u32>,
    /// With `worktree.create`, or `agent.start` with a `worktree`, that failed after Git made part
    /// or all of the worktree: what it made, which stays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<Kept>,
    /// With a refused start or resume that an entry of the settings file caused - its program not
    /// found, the entry turned off or wrong, or a model or effort the entry gives that its CLI cannot
    /// take - the entry's name, such as `claude`. A client offers to open the settings file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    /// With `unavailable` when no member window took a message to `#human`: each window and why
    /// it could not take the message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<WindowDeliveryFailure>>,
    /// The receipt for a send whose remote window outcomes could not be confirmed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_delivery: Option<WindowDelivery>,
    /// The original kept message, where its delivery outcome is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_ref: Option<MessageRef>,
    /// A confirmed reason the addressed agent record was removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_removal: Option<AgentRemoval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id_conflict: Option<MachineIdConflict>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_interaction: Option<SshInteraction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<Unavailable>,
    /// Complete references that matched a name or machine ID prefix.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
    /// Reachable matches or the reachable agent whose operation failed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentLabel>,
    /// Matching machines or the selected machine whose connection failed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub machines: Vec<MachineQueryResult>,
    /// Saved sessions matching the requested ID.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<SessionMatch>,
    /// CLIs that can start here when the requested CLI is not configured.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_clis: Vec<String>,
}

/// The recorded cause of an agent record's removal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentRemoval {
    Expired,
    Removed,
}

/// Reasons used by the runtime and MCP error codec.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// An argument is missing, malformed, or out of range, or the request is unsupported.
    InvalidArgument,
    /// The agent, run, message, or watch does not exist.
    NotFound,
    /// The selected machine confirmed that the requested CLI session does not exist.
    SessionNotFound,
    /// A reference names more than one agent, or the person and an agent: select one by its ID.
    AmbiguousReference,
    /// The agent ended: it takes no more input or messages.
    Ended,
    /// A text or keys call stopped partway: the agent ended, or its terminal stopped taking input,
    /// after part of the call reached the terminal. The error's data says what went in.
    PartialInput,
    /// The operation cannot complete: for example, a stop or a screen watch's snapshot timed out,
    /// or the keeper disconnected.
    Unavailable,
    /// The two sides share no protocol version, or a required client kind, operation, or field is
    /// unsupported.
    #[serde(rename = "protocol_incompatible")]
    IncompatibleProtocol,
    /// Two running daemons introduced themselves with the same machine ID.
    MachineIdConflict,
    /// A saved SSH connection needs a foreground login or verification.
    SshInteractionRequired,
    /// A message exceeds the line limit, or input exceeds the per-call limit or available queue
    /// room.
    CapacityExceeded,
    /// An internal Facade error.
    Internal,
    /// The caller is not allowed to perform this operation. The keeper accepts only the daemon
    /// holding the daemon lock.
    Refused,
    /// Facade's settings file, `facade.json` in the Facade home, cannot be read as it must, which
    /// stops every launch until it is fixed. The message says each problem, with the file's path
    /// and, where known, its line and column.
    #[serde(rename = "configuration_invalid")]
    InvalidSettings,
    /// A tool server lacks a caller it can serve. The stored spelling also covers invalid settings.
    #[serde(rename = "configuration_invalid", skip_deserializing)]
    #[schemars(skip)]
    CallerUnavailable,
    /// The call was withdrawn by its `cancel` before it took effect: a message whose paste had not
    /// begun, which is not kept.
    Cancelled,
    /// Git could not make a worktree it was asked for: `data.kept` says what it made, which stays.
    WorktreeFailed,
    /// A newer Facade is taking over: the call did nothing, and a client repeats it once the new
    /// daemon answers.
    Upgrading,
    /// The CLI cannot do what the call asks of it: take a model or an effort it has no way to set,
    /// or resume a session that a CLI of another type had.
    Unsupported,
    /// An error reason this build does not recognize.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl ErrorBody {
    /// Creates an operation error with the JSON-RPC code for its reason.
    pub fn new(reason: Reason, message: impl Into<String>) -> Self {
        let data = Box::new(ErrorData {
            reason,
            text_written: None,
            enter_written: None,
            keys_sent: None,
            kept: None,
            entry: None,
            windows: None,
            window_delivery: None,
            message_ref: None,
            record_removal: None,
            machine_id_conflict: None,
            ssh_interaction: None,
            unavailable: None,
            candidates: Vec::new(),
            agents: Vec::new(),
            machines: Vec::new(),
            sessions: Vec::new(),
            available_clis: Vec::new(),
        });
        let code = if reason == Reason::InvalidArgument {
            INVALID_PARAMS
        } else {
            SERVER_ERROR
        };
        ErrorBody {
            code,
            message: message.into(),
            data,
        }
    }

    /// Creates an error for an argument that is missing, malformed or out of range.
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        ErrorBody::new(Reason::InvalidArgument, message)
    }

    /// Creates an error for a caller that is not allowed to perform the operation.
    pub fn refused(message: impl Into<String>) -> Self {
        ErrorBody::new(Reason::Refused, message)
    }

    /// Creates an error for an internal Facade failure. Its message keeps the error's causes.
    pub fn internal(error: impl fmt::Display) -> Self {
        ErrorBody::new(Reason::Internal, format!("{error:#}"))
    }
}

impl Reason {
    /// The reason for clients that project the canonical error.
    pub fn canonical_name(self) -> &'static str {
        match self {
            Reason::InvalidSettings => "invalid_settings",
            Reason::IncompatibleProtocol => "incompatible_protocol",
            Reason::CallerUnavailable => "caller_unavailable",
            reason => reason.as_str(),
        }
    }

    /// The reason name retained by the runtime and MCP error codec.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::InvalidArgument => "invalid_argument",
            Reason::NotFound => "not_found",
            Reason::SessionNotFound => "session_not_found",
            Reason::AmbiguousReference => "ambiguous_reference",
            Reason::Ended => "ended",
            Reason::PartialInput => "partial_input",
            Reason::Unavailable => "unavailable",
            Reason::IncompatibleProtocol => "protocol_incompatible",
            Reason::MachineIdConflict => "machine_id_conflict",
            Reason::SshInteractionRequired => "ssh_interaction_required",
            Reason::CapacityExceeded => "capacity_exceeded",
            Reason::Internal => "internal",
            Reason::Refused => "refused",
            Reason::InvalidSettings | Reason::CallerUnavailable => "configuration_invalid",
            Reason::Cancelled => "cancelled",
            Reason::WorktreeFailed => "worktree_failed",
            Reason::Upgrading => "upgrading",
            Reason::Unsupported => "unsupported",
            Reason::Unknown => "unknown",
        }
    }
}

/// Formats the message and reason: `no agent a9; nothing was done; no agents are listed (not_found)`.
impl fmt::Display for ErrorBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ErrorBody { message, data, .. } = self;
        write!(f, "{message} ({})", data.reason.as_str())
    }
}

impl std::error::Error for ErrorBody {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_reasons_keep_stored_names_and_diagnostic_details() {
        let mut settings = ErrorBody::new(Reason::InvalidSettings, "this entry is malformed");
        settings.data.entry = Some("fake".into());
        let old_settings = json!({
            "code": -32000, "message": "this entry is malformed",
            "data": { "reason": "configuration_invalid", "entry": "fake" },
        });
        assert_eq!(serde_json::to_value(&settings).unwrap(), old_settings);
        let decoded: ErrorBody = serde_json::from_value(old_settings).unwrap();
        assert_eq!(decoded, settings);
        assert_eq!(decoded.data.reason.canonical_name(), "invalid_settings");
        assert_eq!(
            decoded.to_string(),
            "this entry is malformed (configuration_invalid)"
        );

        let protocol = ErrorBody::new(Reason::IncompatibleProtocol, "different protocol");
        let old_protocol = json!({
            "code": -32000, "message": "different protocol",
            "data": {
                "reason": "protocol_incompatible",
            },
        });
        assert_eq!(serde_json::to_value(&protocol).unwrap(), old_protocol);
        let decoded: ErrorBody = serde_json::from_value(old_protocol).unwrap();
        assert_eq!(decoded, protocol);
        assert_eq!(
            decoded.data.reason.canonical_name(),
            "incompatible_protocol"
        );
        assert_eq!(
            decoded.to_string(),
            "different protocol (protocol_incompatible)"
        );
    }

    #[test]
    fn a_callerless_tool_server_has_a_distinct_canonical_reason() {
        let caller = Reason::CallerUnavailable;
        assert_eq!(caller.canonical_name(), "caller_unavailable");
        assert_eq!(caller.as_str(), "configuration_invalid");
        let saved = serde_json::to_value(caller).unwrap();
        assert_eq!(saved, json!("configuration_invalid"));
        // The old name describes invalid settings until the caller context is known.
        assert_eq!(
            serde_json::from_value::<Reason>(saved).unwrap(),
            Reason::InvalidSettings
        );
        for (reason, name) in [
            (Reason::Refused, "refused"),
            (Reason::Upgrading, "upgrading"),
            (Reason::NotFound, "not_found"),
            (Reason::InvalidArgument, "invalid_argument"),
        ] {
            assert_eq!(reason.canonical_name(), name);
            assert_eq!(serde_json::to_value(reason).unwrap(), json!(name));
        }
    }

    #[test]
    fn a_reason_this_build_does_not_know_reads_as_unknown() {
        let error: ErrorBody = serde_json::from_value(
            json!({ "code": -32000, "message": "m", "data": { "reason": "too_tired" } }),
        )
        .unwrap();
        assert_eq!(error.data.reason, Reason::Unknown);
    }
}
