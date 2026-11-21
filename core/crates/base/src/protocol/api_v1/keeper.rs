//! The daemon's API v1 control link to the Keeper.

#![allow(
    clippy::result_large_err,
    reason = "The Keeper wire API returns the structured error by value"
)]

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::frame::{size_input, size_input_schema};
use super::versions::decode_hello_offer;
use super::{
    ApiVersion, ApiVersions, CallParams, EmptyResult, ErrorBody, ErrorData, Operation, ProcessExit,
    ProtocolMismatchDetails, Size, decode_arguments, highest_common,
};
use crate::keeper::{self as legacy, KeeperStartArgs};
use crate::operations::OperationVisitor;
use crate::start::StartCommand;

pub const SUPPORTED_API_VERSIONS: &[ApiVersion] = &[ApiVersion::MIN];
pub use legacy::methods;

pub const METHODS: &[(&str, &str)] = &[
    (
        methods::HELLO,
        "Selects the highest common keeper API version and lists the CLIs the keeper holds.",
    ),
    (
        methods::CALL,
        "Runs a keeper operation. Params are `op`, a name from the table below, and `args`, that operation's argument object.",
    ),
    (
        methods::CHANGED,
        "Reports that a CLI ended (`AgentChange`).",
    ),
];

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HelloParams {
    pub api_versions: ApiVersions,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct HelloResult {
    pub api_version: ApiVersion,
    pub build: String,
    pub agents: Vec<HeldAgent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HeldAgent {
    /// The local agent's opaque ID.
    pub agent_id: String,
    pub pid: u32,
    /// The operating system's process birth value, compared for equality.
    pub birth: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopping: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StartArgs {
    pub agent_id: String,
    /// The program followed by its arguments.
    #[serde(deserialize_with = "nonempty_command")]
    #[schemars(length(min = 1))]
    pub command: Vec<String>,
    /// The CLI's complete environment.
    pub env: BTreeMap<String, String>,
    /// The resolved working directory.
    pub cwd: String,
    #[serde(deserialize_with = "size_input")]
    #[schemars(schema_with = "size_input_schema")]
    pub size: Size,
}

fn nonempty_command<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let command = Vec::deserialize(deserializer)?;
    if command.is_empty() {
        return Err(serde::de::Error::custom("command must contain a program"));
    }
    Ok(command)
}

impl From<StartArgs> for KeeperStartArgs {
    fn from(args: StartArgs) -> Self {
        Self {
            agent: args.agent_id,
            launch: StartCommand::from_words(args.command, args.cwd),
            env: args.env,
            cols: args.size.cols,
            rows: args.size.rows,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StartResult {
    pub pid: u32,
    pub birth: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StopArgs {
    pub agent_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SyncArgs {
    pub agent_id: String,
    pub pid: u32,
    pub birth: String,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PingArgs {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChange {
    Exit {
        agent_id: String,
        exit: ProcessExit,
    },
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

pub fn decode_hello(params: Value) -> Result<HelloParams, ErrorBody> {
    decode_hello_offer(&params)?;
    decode_arguments(params)
}

pub fn select_version(offered: &ApiVersions) -> Result<ApiVersion, ErrorBody> {
    highest_common(offered, SUPPORTED_API_VERSIONS).ok_or_else(|| {
        ErrorBody::protocol_incompatible(
            "No common keeper API version.",
            ProtocolMismatchDetails {
                offered_api_versions: None,
                supported_api_versions: supported_versions(),
                agents: None,
            },
        )
    })
}

pub fn decode_hello_result(result: Value, offered: &ApiVersions) -> Result<HelloResult, ErrorBody> {
    let result: HelloResult = decode_arguments(result)?;
    if !offered.contains(result.api_version) {
        return Err(ErrorBody::protocol_incompatible(
            format!(
                "Keeper selected API version {} outside the offer.",
                result.api_version
            ),
            ProtocolMismatchDetails {
                offered_api_versions: Some(offered.clone()),
                supported_api_versions: supported_versions(),
                agents: None,
            },
        ));
    }
    Ok(result)
}

fn supported_versions() -> ApiVersions {
    ApiVersions::new(SUPPORTED_API_VERSIONS.to_vec())
        .expect("keeper supports at least one API version")
}

pub fn project_error(error: crate::jsonrpc::ErrorBody) -> ErrorBody {
    ErrorBody {
        code: error.code,
        message: error.message,
        data: ErrorData {
            reason: error.data.reason.as_str().into(),
            details: None,
        },
    }
}

macro_rules! keeper_operations {
    ($($marker:ident => $variant:ident($args:ty) -> $result:ty),+ $(,)?) => {
        $(
            pub struct $marker;

            impl Operation for $marker {
                const NAME: &'static str = legacy::$marker::NAME;
                const DOC: &'static str = legacy::$marker::DOC;
                type Args = $args;
                type Result = $result;
            }
        )+

        #[derive(Debug)]
        pub enum KeeperCall {
            $($variant($args),)+
        }

        pub fn decode_call(params: Value) -> Result<KeeperCall, ErrorBody> {
            let CallParams { op, args } = decode_arguments(params)?;
            match op.as_str() {
                $($marker::NAME => decode_arguments(args).map(KeeperCall::$variant),)+
                _ => Err(ErrorBody::invalid_argument(format!("Unknown keeper operation {op:?}."))),
            }
        }

        pub fn visit_operations(visitor: &mut impl OperationVisitor) {
            $(visitor.operation::<$marker>();)+
        }
    };
}

keeper_operations! {
    AgentStart => Start(StartArgs) -> StartResult,
    AgentStop => Stop(StopArgs) -> EmptyResult,
    AgentSync => Sync(SyncArgs) -> EmptyResult,
    DaemonPing => Ping(PingArgs) -> EmptyResult,
}
