//! Agent records, roster, start and resume messages.

use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Deserializer, Serialize, de};

use crate::jsonrpc::AgentRemoval;
use crate::process::{ProcessExit, ProcessState};

use super::{
    AgentRef, AgentSyncState, InputInfo, MachineQueryResult, Message, Said, StateDetail,
    ToolsReason, ToolsState, present,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Managed,
    Guest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CreatorKind {
    Agent,
    CommandLine,
    VsCode,
}

/// The source of an agent's start, as displayed to the caller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentCreator {
    Agent { address: String },
    CommandLine,
    VsCode,
}

/// A public roster row. The ID is the agent's copyable address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentListRow {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: AgentKind,
    pub state: AgentState,
    pub cli: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub folder: String,
    pub started_at: String,
}

/// A roster row and the exact reference to use for later operations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentListEntry {
    pub reference: AgentRef,
    #[serde(flatten)]
    pub row: AgentListRow,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3AgentListResult")]
pub struct AgentListResult {
    pub agents: Vec<AgentListEntry>,
    pub machines: Vec<MachineQueryResult>,
}

/// Shared arguments for start and preflight.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3StartArgs")]
pub struct StartArgs {
    pub cli: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// The entry's default folder, which is discarded when forwarding to another machine.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub folder_is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// A branch to create as a worktree from the repository's current HEAD.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ResumeListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ResumeListResult {
    pub items: Vec<ResumeCandidate>,
    pub machines: Vec<MachineQueryResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeCandidate {
    pub target: ResumeTarget,
    pub cli: String,
    pub folder: String,
    pub machine_id: String,
    pub session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    /// The name of a managed agent. Omitted for a saved session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The managed run ended because Facade stopped it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The managed run's exit time or the saved session's modification time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// The copyable agent address or the CLI session and its working location.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeTarget {
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[schemars(rename = "V3ResumeArgs", transform = resume_machine_selector)]
pub struct ResumeArgs {
    #[serde(flatten)]
    pub target: ResumeTarget,
    /// The exact machine saved with a Pin. Mutually exclusive with the public machine selector.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

impl<'de> Deserialize<'de> for ResumeArgs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            reference: String,
            #[serde(default, deserialize_with = "present")]
            machine: Option<String>,
            folder: Option<String>,
            #[serde(default, deserialize_with = "present")]
            machine_id: Option<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            cols: u16,
            rows: u16,
        }

        let fields = Fields::deserialize(deserializer)?;
        if fields.machine.is_some() && fields.machine_id.is_some() {
            return Err(de::Error::custom(
                "provide at most one of machine or machine_id",
            ));
        }
        Ok(Self {
            target: ResumeTarget {
                reference: fields.reference,
                machine: fields.machine,
                folder: fields.folder,
            },
            machine_id: fields.machine_id,
            env: fields.env,
            cols: fields.cols,
            rows: fields.rows,
        })
    }
}

fn resume_machine_selector(schema: &mut Schema) {
    schema.insert(
        "anyOf".into(),
        serde_json::json!([
            { "type": "object", "properties": { "machine_id": false } },
            { "type": "object", "properties": { "machine": false } },
        ]),
    );
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResumeResult {
    pub agent: AgentInfo,
    /// The call created a new agent to open a saved CLI session.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_saved_session: bool,
}

/// A saved session that matched the requested session ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionMatch {
    /// The full CLI session ID.
    pub id: String,
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RemoveResult {
    pub reference: AgentRef,
    pub address: String,
}

/// An agent's details.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3AgentInfo")]
pub struct AgentInfo {
    /// The stable ID is `a` followed by a number. It is unique within its Facade home while
    /// that home's SQLite database (`core/facade.db`) retains the agent number counter.
    pub agent_id: String,
    /// The copyable address, including a machine selector. The serving daemon fills client views.
    pub address: String,
    #[serde(rename = "type")]
    pub kind: AgentKind,
    /// The label in the serving client's machine view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The running machine is currently unreachable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unreachable: bool,
    /// The display name. Names are nonempty but may repeat.
    pub name: String,
    /// The CLI: the name of its entry in Facade's settings file, a built-in's such as `claude` or
    /// an added one such as `Codex · work` (CONFIGURATION-2.1), or the program's file name for a
    /// program started by its path or name.
    pub cli: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The CLI's working folder at startup.
    pub cwd: String,
    /// The ID of the Facade machine that runs the agent.
    pub machine_id: String,
    /// The CLI's process ID. Omitted for a guest, whose process Facade does not know.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Whether the CLI is running or ended.
    pub process: ProcessState,
    /// Terminal width in columns. Omitted for a guest, which has no terminal of Facade's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    /// Terminal height in rows. Omitted for a guest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    /// When the agent was first created, in UTC ISO 8601 format with milliseconds.
    pub created_at: String,
    /// The latest start or resume time, in UTC ISO 8601 format with milliseconds.
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_kind: Option<CreatorKind>,
    /// The agent whose client started it. Omitted where the person started it, and for a guest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    /// The creator's machine ID. Omitted when it is the record's own machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator_machine_id: Option<String>,
    /// The first agent of its creation tree: itself where it has no creator, or else its creator's
    /// root. It stays when agents of the tree end or go.
    pub root: String,
    /// The root agent's machine ID. Omitted when it is the record's own machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_machine_id: Option<String>,
    /// Whether its run has YOLO on: its CLI runs without asking, and it reaches every agent. With
    /// YOLO off, its CLI runs as it natively does, and it reaches only the agents of its creation
    /// tree. A launch takes it from Facade's settings file, `facade.json`, as it is accepted; a
    /// guest as it joins.
    pub yolo: bool,
    /// The recorded exit. Omitted while the agent is running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<ProcessExit>,
    /// The ID of the CLI session the agent's CLI last reported, which `agent.resume` continues.
    /// Omitted until one is reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// What the agent is doing.
    pub state: AgentState,
    /// More about the state: what the CLI waits for, its own words, how its process ended, or why
    /// the state is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_detail: Option<StateDetail>,
    /// The last thing that went into the agent's message input. Omitted until something has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub said: Option<Said>,
    /// Whether the agent's CLI can use Facade's tools.
    pub tools_state: ToolsState,
    /// Why the agent's CLI cannot use Facade's tools. Omitted unless they are unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_reason: Option<ToolsReason>,
}

impl AgentInfo {
    pub fn reference(&self) -> AgentRef {
        AgentRef {
            machine_id: self.machine_id.clone(),
            agent_id: self.agent_id.clone(),
        }
    }
}

/// The identity and state of the reachable agent selected by an operation or offered as a match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentLabel {
    pub reference: AgentRef,
    /// The agent's address in the requesting daemon's machine view.
    pub address: String,
    pub name: String,
    pub cli: String,
    pub state: AgentState,
    /// The managed agent has a recorded session that Facade can resume.
    pub resumable: bool,
}

/// The agent's current state.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "V3AgentState")]
pub enum AgentState {
    /// The CLI has not shown what it is doing yet, within 60 seconds of its start or resume.
    Starting,
    /// The CLI is working, or stopped working less than a second ago.
    Working,
    /// The CLI waits for the person; `state_detail.kind` says for what. A menu or question it draws
    /// in place of its input counts, with `kind` `unknown` where it did not say, also while it
    /// starts.
    WaitingForYou,
    /// A turn ended while no terminal showed the agent. It stays so until one does. Work before the
    /// CLI is asked to do anything is no turn: an Enter typed into it asks, unless it answers a
    /// question the CLI shows. Words after the CLI's name at its start are the CLI's own and ask
    /// nothing.
    JustDone,
    /// The CLI is not working and waits for nothing.
    Idle,
    /// The CLI reported an error or its screen shows that the turn it reported ended failed, or,
    /// started by its rule's name, it showed nothing of what it is doing within 60 seconds of its
    /// start or resume.
    Error,
    /// The CLI's process ended; `state_detail.how` says how, where that is known.
    Ended,
    /// Nothing shows what the CLI is doing; `state_detail.reason` says why.
    Unknown,
    /// A Guest is connected and can take messages.
    Online,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Online => "online",
            AgentState::Starting => "starting",
            AgentState::Working => "working",
            AgentState::WaitingForYou => "waiting_for_you",
            AgentState::JustDone => "just_done",
            AgentState::Idle => "idle",
            AgentState::Error => "error",
            AgentState::Ended => "ended",
            AgentState::Unknown => "unknown",
            AgentState::Unrecognized => "unrecognized",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3InspectResult")]
pub struct AgentInspectResult {
    pub agent: AgentInfo,
    /// The CLI rule the agent was started by: its CLI's name, such as `claude`. Omitted for an
    /// agent started by a program path or a name without a rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    pub input: InputInfo,
    /// Whether the running CLI reports its session to Facade. False for an ended agent.
    pub session_tracking: bool,
    /// The recorded startup source, where it is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_by: Option<AgentCreator>,
    /// The viewers currently attached to the terminal.
    pub viewers: Vec<String>,
    /// The verified client kinds and originating machines of those attachments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentInfo>,
    /// The actual launch command formatted by the running machine, with run credentials redacted.
    /// Omitted if this run's launch command was not recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_command: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Shell,
    VsCode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AttachmentInfo {
    pub kind: AttachmentKind,
    pub machine_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3StartResult")]
pub struct StartResult {
    /// The agent's record.
    pub agent: AgentInfo,
    /// The prompt, kept and pending, where one was given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Message>,
    /// The ID of the result the prompt owes the agent the client acts for, a message from `facade`
    /// once the prompt is settled. Omitted where no result is owed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_message_id: Option<String>,
    /// The machine that assigned `result_message_id`, when a result is owed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_machine_id: Option<String>,
    /// The call repeated an earlier one by its request ID: the agent is that call's, as it stands
    /// now. Omitted otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repeated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3StopResult")]
pub struct StopResult {
    pub reference: AgentRef,
    pub address: String,
    /// The record whose run this call stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentLabel>,
    #[serde(flatten)]
    pub exit: ProcessExit,
    /// The CLI had ended before this stop, so the stop signaled nothing. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub already_ended: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3AgentMachineState")]
pub struct AgentMachineState {
    pub machine_id: String,
    pub state: AgentSyncState,
    /// For a synced machine, its complete records, including an empty list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<AgentInfo>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3AgentsSnapshot")]
pub struct AgentsSnapshot {
    /// Records on the machine that serves this view.
    pub agents: Vec<AgentInfo>,
    pub machines: Vec<AgentMachineState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "V3AgentsChange")]
pub enum AgentsChange {
    /// Insert or replace the whole agent record by machine and agent ID.
    Updated { agent: Box<AgentInfo> },
    /// Remove the record with this machine and agent ID.
    Removed {
        machine_id: String,
        agent_id: String,
        cause: AgentRemoval,
    },
    /// The state of this running machine's contribution to the view.
    #[serde(rename = "machine_state")]
    SyncUpdated { machine: AgentMachineState },
    /// An unknown change kind. Skip it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}
