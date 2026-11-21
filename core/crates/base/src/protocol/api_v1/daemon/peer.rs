//! Forwarded requests, watch bindings, and daemon notifications.

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value;

use super::super::frame::{
    ErrorBody, Request, Size, decode_arguments, encode_line, object, object_only, object_schema,
    present, present_object, size_input, size_input_schema, strict_flattened_object,
};
use super::super::versions::ApiVersions;
use super::agents::{
    agent_ref_input, agent_ref_input_schema, message_ref_input, message_ref_input_schema,
};
use super::{
    AgentInfo, AgentRef, CallParams, MachineInfo, Message, MessageRef, SingleMachineScope,
    StartOutcome, TerminalColors, WaitKind, methods,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Caller {
    Terminal {
        machine_id: String,
    },
    Ide {
        machine_id: String,
    },
    Agent {
        #[serde(deserialize_with = "agent_ref_input")]
        #[schemars(schema_with = "agent_ref_input_schema")]
        agent: AgentRef,
        #[serde(deserialize_with = "agent_ref_input")]
        #[schemars(schema_with = "agent_ref_input_schema")]
        root: AgentRef,
        yolo: bool,
    },
}

impl Caller {
    pub fn machine_id(&self) -> &str {
        match self {
            Self::Terminal { machine_id } | Self::Ide { machine_id } => machine_id,
            Self::Agent { agent, .. } => &agent.machine_id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WatchParams {
    pub topic: String,
    #[serde(deserialize_with = "object")]
    #[schemars(schema_with = "object_schema")]
    pub args: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ForwardRequest {
    Call(CallParams),
    Watch(WatchParams),
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[schemars(transform = strict_flattened_object)]
pub struct ForwardParams {
    #[schemars(length(min = 1))]
    pub route: Vec<String>,
    pub caller: Caller,
    #[serde(flatten)]
    pub request: ForwardRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub time_left_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub from_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "message_ref_input_schema")]
    pub start_result: Option<MessageRef>,
}

impl<'de> Deserialize<'de> for ForwardParams {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum Method {
            Call,
            Watch,
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            route: Vec<String>,
            caller: Caller,
            method: Method,
            params: Value,
            #[serde(default, deserialize_with = "present")]
            time_left_ms: Option<u64>,
            #[serde(default, deserialize_with = "present")]
            from_name: Option<String>,
            #[serde(default, deserialize_with = "optional_message_ref_input")]
            start_result: Option<MessageRef>,
        }

        let Fields {
            route,
            caller,
            method,
            params,
            time_left_ms,
            from_name,
            start_result,
        } = object_only(deserializer)?;
        if route.is_empty() {
            return Err(de::Error::custom("a forward route must be nonempty"));
        }
        let request = match method {
            Method::Call => decode_arguments(params).map(ForwardRequest::Call),
            Method::Watch => decode_arguments(params).map(ForwardRequest::Watch),
        }
        .map_err(|error| de::Error::custom(error.message))?;
        Ok(Self {
            route,
            caller,
            request,
            time_left_ms,
            from_name,
            start_result,
        })
    }
}

fn optional_message_ref_input<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<MessageRef>, D::Error> {
    message_ref_input(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WatchResult {
    pub watch: u64,
    pub snapshot: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ForwardWatchResult {
    pub watch: u64,
    pub snapshot: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<AttachBinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AttachBinding {
    pub viewer: u64,
    pub boot_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InternalEnsureRouteArgs {
    pub wake: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InternalAttachResizeArgs {
    pub viewer: u64,
    pub boot_id: String,
    #[serde(deserialize_with = "size_input")]
    #[schemars(schema_with = "size_input_schema")]
    pub size: Size,
    #[serde(
        default,
        deserialize_with = "present_object",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "TerminalColors")]
    pub colors: Option<TerminalColors>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InternalAgentRecordsArgs {
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InternalDeliverStartResultArgs {
    #[serde(deserialize_with = "agent_ref_input")]
    #[schemars(schema_with = "agent_ref_input_schema")]
    pub recipient: AgentRef,
    #[serde(deserialize_with = "receipt_message_input")]
    #[schemars(schema_with = "receipt_message_input_schema")]
    pub message: Message,
}

const RECEIPT_AGENT_REFS: [&str; 3] = ["reference", "creator", "root"];

fn receipt_message_input<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Message, D::Error> {
    let message = object(deserializer)?;
    if let Some(reference) = message.get("message_ref") {
        message_ref_input(reference).map_err(de::Error::custom)?;
    }
    if let Some(outcome) = message.get("result") {
        let agent = outcome
            .get("agent")
            .and_then(Value::as_object)
            .ok_or_else(|| de::Error::custom("receipt outcome requires an agent object"))?;
        for field in RECEIPT_AGENT_REFS {
            if let Some(reference) = agent.get(field) {
                agent_ref_input(reference).map_err(de::Error::custom)?;
            }
        }
        if let Some(size) = agent.get("size") {
            size_input(size).map_err(de::Error::custom)?;
        }
    }
    serde_json::from_value(message).map_err(de::Error::custom)
}

fn receipt_message_input_schema(generator: &mut SchemaGenerator) -> Schema {
    let mut agent = AgentInfo::json_schema(generator);
    for field in RECEIPT_AGENT_REFS {
        receipt_property(&mut agent, field, agent_ref_input_schema(generator));
    }
    receipt_property(&mut agent, "size", size_input_schema(generator));

    let mut outcome = StartOutcome::json_schema(generator);
    receipt_property(&mut outcome, "agent", agent);

    let mut message = Message::json_schema(generator);
    receipt_property(
        &mut message,
        "message_ref",
        message_ref_input_schema(generator),
    );
    receipt_property(&mut message, "result", outcome);
    message
}

fn receipt_property(schema: &mut Schema, field: &str, property: Schema) {
    *schema
        .get_mut("properties")
        .and_then(|properties| properties.get_mut(field))
        .expect("receipt field exists in the shared schema") = property.into();
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InternalDeliverWaitNoticeArgs {
    #[serde(deserialize_with = "agent_ref_input")]
    #[schemars(schema_with = "agent_ref_input_schema")]
    pub recipient: AgentRef,
    #[serde(deserialize_with = "agent_ref_input")]
    #[schemars(schema_with = "agent_ref_input_schema")]
    pub waiting: AgentRef,
    pub name: String,
    #[serde(deserialize_with = "wait_kind")]
    pub kind: WaitKind,
}

fn wait_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<WaitKind, D::Error> {
    let kind = WaitKind::deserialize(deserializer)?;
    if kind == WaitKind::Unrecognized {
        return Err(de::Error::custom("unknown wait kind"));
    }
    Ok(kind)
}

#[derive(Clone, Debug, Copy, Default, Serialize, Deserialize, JsonSchema)]
pub struct MachineSleepingParams {}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AdvertiseParams {
    pub machines: Vec<MachineInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChangedParams {
    pub watch: u64,
    pub change: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WatchEndedParams {
    pub watch: u64,
    pub error: ErrorBody,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UnwatchParams {
    pub watch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CancelParams {
    pub id: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ClosingParams {
    pub build: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ConnectedMachine {
    pub machine_id: String,
    pub boot_id: String,
    pub name: String,
    pub build: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_cleans_processes: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ConnectedParams {
    pub machine: ConnectedMachine,
    pub first_connection: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ConnectFailedParams {
    pub error: ErrorBody,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DaemonUpgradeArgs {
    pub program: String,
    pub build: String,
    pub daemon_api_versions: ApiVersions,
    pub keeper_api_versions: ApiVersions,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DaemonUpgradeResult {
    pub from: String,
    pub agent_count: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StatusArgs {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "SingleMachineScope")]
    pub scope: Option<SingleMachineScope>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StatusResult {
    pub home: String,
    pub settings_file: String,
    pub build: String,
    pub daemon_pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keeper_pid: Option<u32>,
    pub agent_count: u64,
    pub machines: Vec<super::MachineQuery>,
}

pub fn cancel_line(id: u64) -> Vec<u8> {
    encode_line(&Request::new(None, methods::CANCEL, CancelParams { id }))
}
