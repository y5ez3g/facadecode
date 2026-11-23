//! Daemon API v1 handshake, methods, and operation and topic types.

#![allow(
    clippy::result_large_err,
    reason = "The wire API returns the structured error by value"
)]

mod agents;
mod attach;
mod machine;
mod peer;
mod registry;

use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::frame::{ErrorBody, ProtocolMismatchDetails, decode_arguments, present, present_object};
use super::versions::{ApiVersion, ApiVersions, decode_hello_offer, highest_common};

pub use super::frame::CallParams;
pub use super::frame::NoArgs;
pub use crate::model::agent::{
    AgentCreator, AgentKind, AgentState, AttachmentInfo, AttachmentKind, CliInfo, CreatorKind,
    Said, SessionMatch, StateDetail, ToolsReason, ToolsState, WaitKind,
};
pub use crate::model::error::AgentRemoval;
pub use crate::model::machine::{CliListResult, LocationKind, MachineIdentity};
pub use crate::model::message::{Delivery, PromptOutcome};
pub use crate::model::terminal::{InputInfo, ScreenBuffer};
pub use crate::operations::EmptyResult;

pub use agents::*;
pub use attach::*;
pub use machine::*;
pub use peer::*;
pub use registry::*;

pub mod methods {
    pub const HELLO: &str = "hello";
    pub const CALL: &str = "call";
    pub const WATCH: &str = "watch";
    pub const UNWATCH: &str = "unwatch";
    pub const CANCEL: &str = "cancel";
    pub const CHANGED: &str = "changed";
    pub const CLOSING: &str = "closing";
    pub const WATCH_ENDED: &str = "watch_ended";
    pub const ADVERTISE: &str = "advertise";
    pub const FORWARD: &str = "forward";
    pub const CONNECTED: &str = "connected";
    pub const CONNECT_FAILED: &str = "connect_failed";
    pub const MACHINE_SLEEPING: &str = "machine.sleeping";
}

/// How long the calls under way have to finish once a daemon hands over to a newer build,
/// `daemon.upgrade`.
pub const DRAIN_TIME: Duration = Duration::from_secs(3);
/// How long the agents of a daemon handing over have to stop reading their terminals, writing what
/// is queued for them first.
pub const QUIET_TIME: Duration = Duration::from_millis(500);
/// How long the connections of a daemon handing over have to answer `closing` before it ends.
pub const CLOSING_TIME: Duration = Duration::from_millis(300);
/// The longest a daemon takes to hand over once it answers `daemon.upgrade`, before the keeper
/// starts the new daemon: its drain, its agents going quiet, its connections' `closing`, and the
/// keys attached terminals sent until they answered.
pub(super) const HANDOVER_TIME: Duration = DRAIN_TIME
    .saturating_add(QUIET_TIME)
    .saturating_add(CLOSING_TIME)
    .saturating_add(QUIET_TIME)
    .saturating_add(QUIET_TIME);

pub const SUPPORTED_API_VERSIONS: &[ApiVersion] = &[ApiVersion::MIN];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    Terminal,
    Ide,
    Mcp,
    Machine,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HelloParams {
    pub api_versions: ApiVersions,
    pub build: String,
    pub kind: ClientKind,
    #[serde(
        default,
        deserialize_with = "present_object",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "MachineHelloParams")]
    pub machine: Option<MachineHelloParams>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub foreground: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MachineHelloParams {
    pub machine_id: String,
    pub boot_id: String,
    pub name: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub ssh_cleans_processes: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineHelloResult {
    pub boot_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_cleans_processes: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct KeeperInfo {
    pub pid: u32,
    pub build: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct HelloResult {
    pub api_version: ApiVersion,
    pub build: String,
    pub machine_id: String,
    pub pid: u32,
    pub agent_count: u64,
    pub ops: Vec<String>,
    pub topics: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keeper: Option<KeeperInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineHelloResult>,
}

pub fn decode_hello(params: Value) -> Result<HelloParams, ErrorBody> {
    // Check the offer first so a prerelease range hello gets the same diagnostic as a missing offer.
    decode_hello_offer(&params)?;
    let hello: HelloParams = decode_arguments(params)?;
    if hello.kind == ClientKind::Machine && hello.machine.is_none() {
        return Err(ErrorBody::invalid_argument(
            "A machine hello requires hello.params.machine.",
        ));
    }
    Ok(hello)
}

pub fn select_version(offered: &ApiVersions) -> Result<ApiVersion, ErrorBody> {
    highest_common(offered, SUPPORTED_API_VERSIONS).ok_or_else(|| {
        ErrorBody::protocol_incompatible(
            "No common daemon API version.",
            ProtocolMismatchDetails {
                offered_api_versions: None,
                supported_api_versions: supported_versions(),
                agents: None,
            },
        )
    })
}

fn supported_versions() -> ApiVersions {
    ApiVersions::new(SUPPORTED_API_VERSIONS.to_vec()).expect("daemon supports API versions")
}

pub fn decode_hello_result(
    result: Value,
    offered: &ApiVersions,
    kind: ClientKind,
) -> Result<HelloResult, ErrorBody> {
    let hello: HelloResult = decode_arguments(result)?;
    if !offered.contains(hello.api_version) {
        return Err(ErrorBody::protocol_incompatible(
            format!(
                "Daemon selected API version {} outside the offer.",
                hello.api_version
            ),
            ProtocolMismatchDetails {
                offered_api_versions: Some(offered.clone()),
                supported_api_versions: supported_versions(),
                agents: None,
            },
        ));
    }
    if kind == ClientKind::Machine && hello.machine.is_none() {
        return Err(ErrorBody::invalid_argument(
            "A machine hello result requires result.machine.",
        ));
    }
    Ok(hello)
}

#[cfg(test)]
mod tests {
    use crate::api_v1::{MAX_LINE_BYTES, RequestRead, ResponseBody, ServerMessage, read_request};

    #[test]
    fn server_messages_distinguish_notifications_and_responses() {
        let notification: ServerMessage =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"changed","params":{"watch":1}}"#)
                .unwrap();
        assert!(matches!(notification, ServerMessage::Notification(n) if n.method == "changed"));
        let response: ServerMessage =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":3,"result":{}}"#).unwrap();
        assert!(matches!(response, ServerMessage::Response(r) if r.id == Some(3)));
        let unread: ServerMessage = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"m","data":{"reason":"invalid_argument"}}}"#,
        )
        .unwrap();
        assert!(
            matches!(unread, ServerMessage::Response(r) if r.id.is_none() && matches!(r.body, ResponseBody::Error(_)))
        );
    }

    #[test]
    fn request_reader_reports_parse_errors_and_bounds_line_length() {
        let mut buffer = Vec::new();
        let code = |input: &[u8]| match read_request(&mut &input[..], &mut Vec::new()).unwrap() {
            RequestRead::Malformed(malformed) => malformed.error.code,
            RequestRead::LineTooLong(error) => error.code,
            RequestRead::Request(_) => 0,
            RequestRead::Eof => 1,
        };
        assert_eq!(code(b"{nope\n"), -32700);
        assert_eq!(code(b"[1,2]\n"), -32600);
        assert_eq!(
            code(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{}}\n"),
            0
        );
        assert_eq!(code(b""), 1);
        let long = vec![b'x'; MAX_LINE_BYTES + 10];
        assert!(matches!(
            read_request(&mut &long[..], &mut buffer).unwrap(),
            RequestRead::LineTooLong(_)
        ));
        assert!(
            buffer.len() <= MAX_LINE_BYTES + 1,
            "buffered {} bytes of an unterminated line",
            buffer.len()
        );
    }
}
