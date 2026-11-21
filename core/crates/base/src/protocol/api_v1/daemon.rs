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

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::frame::{ErrorBody, ProtocolMismatchDetails, decode_arguments, present, present_object};
use super::versions::{ApiVersion, ApiVersions, decode_hello_offer, highest_common};

pub use super::frame::CallParams;
pub use super::frame::NoArgs;
pub use crate::daemon::{
    CliInfo, Delivery, InputInfo, Said, ScreenBuffer, StateDetail, ToolsReason, ToolsState,
    WaitKind,
};
pub use crate::daemon::{LocationKind, PromptOutcome};
pub use crate::jsonrpc::AgentRemoval;
pub use crate::machine::{CliListResult, MachineIdentity};
pub use crate::operations::EmptyResult;
pub use crate::v3::{
    AgentCreator, AgentKind, AgentState, AttachmentInfo, AttachmentKind, CreatorKind, LocationInfo,
    SessionMatch,
};

pub use agents::*;
pub use attach::*;
pub use machine::*;
pub use peer::*;
pub use registry::*;

pub mod methods {
    pub use crate::daemon::methods::{
        ADVERTISE, CALL, CANCEL, CHANGED, CLOSING, CONNECT_FAILED, CONNECTED, FORWARD, HELLO,
        UNWATCH, WATCH, WATCH_ENDED,
    };

    pub const MACHINE_SLEEPING: &str = "machine.sleeping";
}

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
