//! The normal daemon and machine protocol, alongside the v2 takeover types.

pub mod address;
mod agents;
mod forwarding;
mod machines;
mod messages;
mod terminal;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, de};

pub use super::daemon::{
    AgentSyncState, ClientKind, DaemonLogArgs, DaemonLogResult, DaemonUpgrade, DaemonUpgradeArgs,
    DaemonUpgradeResult, Delivery, HelloResult, InputInfo, LocationKind, LogRead, PromptOutcome,
    Said, ScreenBuffer, ScreenChange, StateDetail, TerminalColors, ToolsReason, ToolsState,
};
pub use super::machine::{
    AgentRef, CliListResult, ConnectionKind, ConnectionState, MachineAddResult, MachineHello,
    MachineIdentity, MachineQueryArgs, MachineQueryStatus, MachineRemove, MachineRename,
    MessageRef, SshInteraction,
};
pub use super::operations::{EmptyResult, NoArgs};
use super::operations::{Operation, OperationVisitor, Topic, TopicVisitor, collect_names};
pub use agents::*;
pub use forwarding::*;
pub use machines::*;
pub use messages::*;
pub use terminal::*;

pub const DAEMON_PROTOCOL_RANGE: [u32; 2] = [3, 3];
pub const TAKEOVER_DAEMON_PROTOCOL_RANGE: [u32; 2] = [2, 3];

/// Introduces a daemon client or a machine. Actor identity is supplied by the daemon.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3HelloParams")]
pub struct HelloParams {
    #[serde(rename = "protocol")]
    pub protocol_range: [u32; 2],
    pub build: String,
    pub kind: ClientKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineHello>,
}

impl HelloParams {
    pub fn for_machine(mut machine: MachineHello) -> Self {
        machine.protocol_range = DAEMON_PROTOCOL_RANGE;
        Self {
            protocol_range: machine.protocol_range,
            build: machine.build.clone(),
            kind: ClientKind::Machine,
            machine: Some(machine),
        }
    }
}

/// An agent's public address or exact stored reference.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AgentTarget {
    Address { agent: String },
    Reference { reference: AgentRef },
}

impl<'de> Deserialize<'de> for AgentTarget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            #[serde(default, deserialize_with = "present")]
            agent: Option<String>,
            #[serde(default, deserialize_with = "present")]
            reference: Option<AgentRef>,
        }

        let fields = Fields::deserialize(deserializer)?;
        match (fields.agent, fields.reference) {
            (Some(agent), None) => Ok(Self::Address { agent }),
            (None, Some(reference)) => Ok(Self::Reference { reference }),
            _ => Err(de::Error::custom(
                "provide exactly one of agent or reference",
            )),
        }
    }
}

impl JsonSchema for AgentTarget {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AgentTarget".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "oneOf": [
                {
                    "type": "object",
                    "properties": { "agent": { "type": "string" }, "reference": false },
                    "required": ["agent"]
                },
                {
                    "type": "object",
                    "properties": { "agent": false, "reference": generator.subschema_for::<AgentRef>() },
                    "required": ["reference"]
                }
            ]
        })
    }
}

// A present field must decode as a value. This leaves absent fields distinguishable from null.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

macro_rules! operations {
    ($($marker:ident: $name:literal, $doc:literal, $args:ty => $result:ty;)*) => {
        $(
            pub struct $marker;
            impl Operation for $marker {
                const NAME: &'static str = $name;
                const DOC: &'static str = $doc;
                type Args = $args;
                type Result = $result;
            }
        )*

        pub fn visit_operations(visitor: &mut impl OperationVisitor) {
            $(visitor.operation::<$marker>();)*
            visitor.operation::<MachineRemove>();
            visitor.operation::<MachineRename>();
            visitor.operation::<LogRead>();
            visitor.operation::<DaemonUpgrade>();
        }
    }
}

operations! {
    AgentList: "agent.list", "Lists reachable agents and machine query outcomes.", MachineQueryArgs => AgentListResult;
    AgentInspect: "agent.inspect", "Describes an agent and its terminal viewers.", AgentSelectorArgs => AgentInspectResult;
    AgentStart: "agent.start", "Starts a new managed agent.", StartArgs => StartResult;
    AgentCheckStart: "agent.start_preflight", "Checks the arguments of an agent start.", StartArgs => EmptyResult;
    AgentResumeList: "agent.resume_list", "Lists resumable agents and CLI sessions.", ResumeListArgs => ResumeListResult;
    AgentResume: "agent.resume", "Resumes an agent or a CLI session.", ResumeArgs => ResumeResult;
    LocationList: "location.list", "Lists working locations on a machine.", LocationListArgs => LocationListResult;
    CliList: "cli.list", "Lists CLIs available in the selected launch environment.", CliListArgs => CliListResult;
    AgentStop: "agent.stop", "Stops the agent's CLI and keeps the agent record.", AgentSelectorArgs => StopResult;
    AgentRemove: "agent.remove", "Removes a managed agent.", AgentSelectorArgs => RemoveResult;
    AgentRename: "agent.rename", "Changes an agent's name.", AgentRenameArgs => RenameResult;
    AgentType: "agent.type", "Sends input to a managed agent's terminal.", AgentTypeArgs => TypeResult;
    AgentSend: "agent.send", "Sends a message to an agent.", AgentSendArgs => SendResult;
    AgentResize: "agent.resize", "Resizes a managed agent's terminal.", AgentResizeArgs => EmptyResult;
    AgentScreen: "agent.screen", "Reads the last logical lines of an agent's screen.", AgentScreenArgs => ScreenText;
    DaemonStatus: "daemon.status", "Reports the daemon's status on a machine.", StatusArgs => StatusResult;
    WorkspaceImportLegacy: "workspace.import_legacy", "Reads the verified members of a legacy workspace.", LegacyWorkspaceArgs => LegacyWorkspaceResult;
    MachineList: "machine.list", "Lists known machines and routes.", NoArgs => MachineListResult;
    MachineAdd: "machine.add", "Saves a verified SSH connection.", MachineAddArgs => MachineAddResult;
    MachineConnect: "machine.connect", "Authorizes a foreground machine connection.", MachineConnectArgs => MachineConnectResult;
}

pub struct AgentsTopic;
impl Topic for AgentsTopic {
    const NAME: &'static str = "agents";
    const DOC: &'static str = "Agent records and synchronization state of their running machines.";
    type Args = NoArgs;
    type Snapshot = AgentsSnapshot;
    type Change = AgentsChange;
}

pub struct ScreenTopic;
impl Topic for ScreenTopic {
    const NAME: &'static str = "screen";
    const DOC: &'static str = "The managed agent's terminal redraw and subsequent output.";
    type Args = ScreenWatchArgs;
    type Snapshot = ScreenSnapshot;
    type Change = ScreenChange;
}

pub struct MachinesTopic;
impl Topic for MachinesTopic {
    const NAME: &'static str = "machines";
    const DOC: &'static str = "Changes to the machine table in the daemon's view.";
    type Args = NoArgs;
    type Snapshot = Vec<MachineInfo>;
    type Change = MachinesChange;
}

pub fn visit_topics(visitor: &mut impl TopicVisitor) {
    visitor.topic::<AgentsTopic>();
    visitor.topic::<ScreenTopic>();
    visitor.topic::<MachinesTopic>();
}

pub fn operation_names() -> Vec<String> {
    collect_names(visit_operations)
}

pub fn topic_names() -> Vec<String> {
    collect_names(visit_topics)
}
