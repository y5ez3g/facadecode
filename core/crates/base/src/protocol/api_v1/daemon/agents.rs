//! Agent identities, operations and records.

use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, de};

use super::super::frame::{
    ErrorBody, Size, empty_variant, input_record, input_record_schema, object_only, present,
    size_input, size_input_schema,
};
use super::{
    AgentCreator, AgentKind, AgentRemoval, AgentState, AttachmentInfo, CreatorKind, Delivery,
    InputInfo, MachineQuery, ProcessState, PromptOutcome, Said, StateDetail, ToolsReason,
    ToolsState,
};
use crate::key_input::{Key, paste_bytes};
use crate::process::ProcessExit;

pub type Environment = BTreeMap<String, String>;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, JsonSchema)]
pub struct AgentRef {
    pub machine_id: String,
    pub agent_id: String,
}

impl<'de> Deserialize<'de> for AgentRef {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            machine_id: String,
            agent_id: String,
        }

        let Fields {
            machine_id,
            agent_id,
        } = object_only(deserializer)?;
        Ok(Self {
            machine_id,
            agent_id,
        })
    }
}

pub(super) fn agent_ref_input<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<AgentRef, D::Error> {
    input_record(deserializer, &["machine_id", "agent_id"])
}

pub(super) fn agent_ref_input_schema(generator: &mut SchemaGenerator) -> Schema {
    input_record_schema::<AgentRef>(generator)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum AgentTarget {
    Selector(
        #[serde(deserialize_with = "selector")]
        #[schemars(length(min = 1))]
        String,
    ),
    Reference(
        #[serde(deserialize_with = "agent_ref_input")]
        #[schemars(schema_with = "agent_ref_input_schema")]
        AgentRef,
    ),
}

fn selector<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let selector = String::deserialize(deserializer)?;
    if selector.is_empty() {
        return Err(de::Error::custom("an agent selector must be nonempty"));
    }
    Ok(selector)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Scope {
    #[serde(deserialize_with = "empty_variant")]
    Local,
    Machine {
        machine: String,
    },
    #[serde(deserialize_with = "empty_variant")]
    Reachable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SingleMachineScope {
    #[serde(deserialize_with = "empty_variant")]
    Local,
    Machine {
        machine: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FolderScope {
    Cwd,
    All,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StopSelection {
    Targets {
        #[serde(deserialize_with = "targets")]
        #[schemars(length(min = 1))]
        targets: Vec<AgentTarget>,
    },
    All {
        scope: Scope,
    },
}

fn targets<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<AgentTarget>, D::Error> {
    let targets = Vec::deserialize(deserializer)?;
    if targets.is_empty() {
        return Err(de::Error::custom("stop targets must be nonempty"));
    }
    Ok(targets)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResumeTarget {
    Agent {
        #[serde(deserialize_with = "agent_ref_input")]
        #[schemars(schema_with = "agent_ref_input_schema")]
        reference: AgentRef,
    },
    Session {
        machine_id: String,
        cli: String,
        session: String,
        folder: String,
    },
    Selector {
        #[serde(deserialize_with = "selector")]
        #[schemars(length(min = 1))]
        selector: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "SingleMachineScope")]
        scope: Option<SingleMachineScope>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "String")]
        folder: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TerminalInput {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        enter: bool,
    },
    Keys {
        keys: Vec<String>,
    },
    Raw {
        raw: String,
    },
    #[serde(deserialize_with = "input_sequence")]
    Sequence {
        steps: Vec<InputStep>,
    },
}

impl TerminalInput {
    /// Counts the queued paste and key bytes. Raw input has its own byte check.
    pub fn typing_bytes(&self) -> Option<usize> {
        match self {
            Self::Text { text, enter } => {
                let enter_bytes = if *enter { Key::Enter.most_bytes() } else { 0 };
                Some(text_typing_bytes(text) + enter_bytes)
            }
            Self::Keys { keys } => keys
                .iter()
                .try_fold(0, |total, key| Some(total + Key::named(key)?.most_bytes())),
            Self::Sequence { steps } => steps.iter().try_fold(0, |total, step| {
                let bytes = match step {
                    InputStep::Text { text } => text_typing_bytes(text),
                    InputStep::Key { key } => Key::named(key)?.most_bytes(),
                };
                Some(total + bytes)
            }),
            Self::Raw { .. } => None,
        }
    }
}

fn text_typing_bytes(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        paste_bytes(text)
    }
}

fn input_sequence<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<InputStep>, D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Fields {
        steps: Vec<InputStep>,
    }

    let Fields { steps } = object_only(deserializer)?;
    Ok(steps)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputStep {
    Text { text: String },
    Key { key: String },
}

impl<'de> Deserialize<'de> for InputStep {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        enum Step {
            Text { text: String },
            Key { key: String },
        }

        Ok(match object_only(deserializer)? {
            Step::Text { text } => Self::Text { text },
            Step::Key { key } => Self::Key { key },
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, JsonSchema)]
pub struct MessageRef {
    pub machine_id: String,
    pub message_id: String,
}

impl<'de> Deserialize<'de> for MessageRef {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            machine_id: String,
            message_id: String,
        }

        let Fields {
            machine_id,
            message_id,
        } = object_only(deserializer)?;
        Ok(Self {
            machine_id,
            message_id,
        })
    }
}

pub(super) fn message_ref_input<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<MessageRef, D::Error> {
    input_record(deserializer, &["machine_id", "message_id"])
}

pub(super) fn message_ref_input_schema(generator: &mut SchemaGenerator) -> Schema {
    input_record_schema::<MessageRef>(generator)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ReplyTo {
    Address(String),
    Reference(
        #[serde(deserialize_with = "message_ref_input")]
        #[schemars(schema_with = "message_ref_input_schema")]
        MessageRef,
    ),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentListArgs {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Scope")]
    pub scope: Option<Scope>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentListResult {
    pub agents: Vec<AgentListEntry>,
    pub machines: Vec<MachineQuery>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResumeListArgs {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Scope")]
    pub scope: Option<Scope>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub folder: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "FolderScope")]
    pub folder_scope: Option<FolderScope>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ResumeListResult {
    pub items: Vec<ResumeCandidate>,
    pub machines: Vec<MachineQuery>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResumeArgs {
    pub target: ResumeTarget,
    #[serde(deserialize_with = "size_input")]
    #[schemars(schema_with = "size_input_schema")]
    pub size: Size,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Environment")]
    pub env: Option<Environment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeResult {
    pub agent: AgentInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_saved_session: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StopArgs {
    pub selection: StopSelection,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BatchStopResult {
    pub items: Vec<StopItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machines: Option<Vec<MachineQuery>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StopItem {
    #[serde(deserialize_with = "stop_result_target")]
    #[schemars(schema_with = "stop_result_target_schema")]
    pub target: AgentTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentLabel>,
    #[serde(flatten)]
    pub outcome: StopOutcome,
}

fn stop_result_target<'de, D: Deserializer<'de>>(deserializer: D) -> Result<AgentTarget, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Target {
        Selector(#[serde(deserialize_with = "selector")] String),
        Reference(AgentRef),
    }
    Ok(match Target::deserialize(deserializer)? {
        Target::Selector(selector) => AgentTarget::Selector(selector),
        Target::Reference(reference) => AgentTarget::Reference(reference),
    })
}

fn stop_result_target_schema(generator: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "anyOf": [
            { "type": "string", "minLength": 1 },
            generator.subschema_for::<AgentRef>()
        ]
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum StopOutcome {
    Stopped { exit: ProcessExit },
    Failed { error: ErrorBody },
    Skipped,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StartArgs {
    pub cli: String,
    #[serde(deserialize_with = "size_input")]
    #[schemars(schema_with = "size_input_schema")]
    pub size: Size,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "SingleMachineScope")]
    pub scope: Option<SingleMachineScope>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub folder_is_default: bool,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub worktree: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub model: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub effort: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub prompt: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Environment")]
    pub env: Option<Environment>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub request_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub call_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StartResult {
    pub agent: AgentInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_machine_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repeated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentTargetArgs {
    pub target: AgentTarget,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameArgs {
    pub target: AgentTarget,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RenameResult {
    pub agent: AgentInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentTypeArgs {
    pub target: AgentTarget,
    pub input: TerminalInput,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TypeResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentLabel>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScreenArgs {
    pub target: AgentTarget,
    #[serde(
        default,
        deserialize_with = "screen_lines",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "u16", range(min = 1, max = 2000))]
    pub lines: Option<u16>,
}

fn screen_lines<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u16>, D::Error> {
    let lines = u16::deserialize(deserializer)?;
    if !(1..=2000).contains(&lines) {
        return Err(de::Error::custom("screen lines must be between 1 and 2000"));
    }
    Ok(Some(lines))
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SendArgs {
    pub to: AgentTarget,
    pub text: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "ReplyTo")]
    pub reply_to: Option<ReplyTo>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub request_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "u64")]
    pub time_left_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_unsupported_receipt: bool,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "SendWait")]
    pub wait_for: Option<SendWait>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SendWait {
    Inbox,
    Delivery,
    Result,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CommandReply {
    pub reference: MessageRef,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SendResult {
    pub id: String,
    pub message: Message,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<AgentLabel>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repeated: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub withdrawn: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_reply_to: Option<MessageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<CommandReply>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Message {
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_ref: Option<MessageRef>,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    pub to: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<StartOutcome>,
    pub at: String,
    pub delivery: Delivery,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StartOutcome {
    pub agent: AgentInfo,
    pub prompt: PromptOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentListEntry {
    pub reference: AgentRef,
    pub address: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: AgentKind,
    pub state: AgentState,
    pub cli: String,
    pub folder: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentInfo {
    pub reference: AgentRef,
    pub address: String,
    #[serde(rename = "type")]
    pub kind: AgentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unreachable: bool,
    pub name: String,
    pub cli: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub process: ProcessState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    pub created_at: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_kind: Option<CreatorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<AgentRef>,
    pub root: AgentRef,
    pub yolo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<ProcessExit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub state: AgentState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_detail: Option<StateDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub said: Option<Said>,
    pub tools_state: ToolsState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_reason: Option<ToolsReason>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentLabel {
    pub reference: AgentRef,
    pub address: String,
    #[serde(rename = "type")]
    pub kind: AgentKind,
    pub name: String,
    pub cli: String,
    pub state: AgentState,
    pub resumable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentLookupCandidate {
    pub agent: AgentInfo,
    pub has_rule: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeCandidate {
    #[serde(deserialize_with = "resume_candidate_target")]
    #[schemars(with = "ResumeCandidateTarget")]
    pub target: ResumeTarget,
    pub machine_id: String,
    pub cli: String,
    pub folder: String,
    pub session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ResumeCandidateTarget {
    Agent {
        reference: AgentRef,
    },
    Session {
        machine_id: String,
        cli: String,
        session: String,
        folder: String,
    },
}

fn resume_candidate_target<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<ResumeTarget, D::Error> {
    Ok(match ResumeCandidateTarget::deserialize(deserializer)? {
        ResumeCandidateTarget::Agent { reference } => ResumeTarget::Agent { reference },
        ResumeCandidateTarget::Session {
            machine_id,
            cli,
            session,
            folder,
        } => ResumeTarget::Session {
            machine_id,
            cli,
            session,
            folder,
        },
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InspectResult {
    pub agent: AgentInfo,
    pub input: InputInfo,
    pub session_tracking: bool,
    pub viewers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_by: Option<AgentCreator>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_command: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RemoveResult {
    pub reference: AgentRef,
    pub address: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentSyncState {
    Synced,
    Pending,
    Unreachable,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentMachineState {
    pub machine_id: String,
    pub state: AgentSyncState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<AgentInfo>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsSnapshot {
    pub agents: Vec<AgentInfo>,
    pub machines: Vec<AgentMachineState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentsChange {
    Updated {
        agent: Box<AgentInfo>,
    },
    Removed {
        machine_id: String,
        agent_id: String,
        cause: AgentRemoval,
    },
    #[serde(rename = "machine_state")]
    SyncUpdated {
        machine: AgentMachineState,
    },
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_change_of_a_kind_this_build_does_not_know_is_skipped_and_the_next_one_still_reads() {
        let changes = json!([
            { "kind": "removed", "agent_id": "a1", "machine_id": "fixture", "cause": "removed" },
            { "kind": "renamed", "agent_id": "a2", "name": "x" },
            { "kind": "removed", "agent_id": "a3", "machine_id": "fixture", "cause": "removed" },
        ]);
        let read: Vec<AgentsChange> = serde_json::from_value(changes).unwrap();
        assert_eq!(
            read,
            vec![
                AgentsChange::Removed {
                    machine_id: "fixture".into(),
                    agent_id: "a1".into(),
                    cause: AgentRemoval::Removed,
                },
                AgentsChange::Unknown,
                AgentsChange::Removed {
                    machine_id: "fixture".into(),
                    agent_id: "a3".into(),
                    cause: AgentRemoval::Removed,
                }
            ]
        );
    }
}
