//! Machine identities, session parameters and the machine operations of the daemon protocol.

use std::time::SystemTime;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::address::{exact_machine_selector, format_reference, short_machine_id};
use super::daemon::{
    AgentInfo, AgentStartWireArgs, CliInfo, LocationInfo, Message, TerminalColors, WindowDelivery,
    WindowDeliveryOutcome, WindowRef, methods,
};
use super::jsonrpc::{ErrorBody, Notification};
use super::operations::{
    CallParams, EmptyResult, NoArgs, Operation, OperationVisitor, Topic, TopicVisitor,
};

/// An agent's durable identity, independently of names and routes.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
pub struct AgentRef {
    pub machine_id: String,
    pub agent_id: String,
}

impl AgentRef {
    pub fn exact_address(&self) -> String {
        self.address(&exact_machine_selector(&self.machine_id))
    }

    pub fn address(&self, machine_selector: &str) -> String {
        format_reference(&self.agent_id, Some(machine_selector))
    }

    pub fn label(&self, local_machine_id: &str, machine_selector: &str) -> String {
        format_reference(
            &self.agent_id,
            (self.machine_id != local_machine_id).then_some(machine_selector),
        )
    }
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

/// A machine's persistent identity and current display name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineIdentity {
    pub machine_id: String,
    pub name: String,
}

/// The introduction on each side of a machine hello.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineHello {
    pub machine_id: String,
    /// Changes each time the daemon starts. Distinguishes concurrent uses of a machine ID.
    pub boot_id: String,
    pub name: String,
    pub build: String,
    #[serde(rename = "protocol")]
    pub protocol_range: [u32; 2],
    /// On Linux, whether the system clears this user's processes at the end of the SSH session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_cleans_processes: Option<bool>,
}

/// A random UUID v4 for this daemon's lifetime.
pub fn new_boot_id() -> String {
    let first = crate::random_u64();
    let second = crate::random_u64();
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        first >> 32,
        (first >> 16) & 0xffff,
        (first & 0x0fff) | 0x4000,
        ((second >> 48) & 0x3fff) | 0x8000,
        second & 0xffff_ffff_ffff,
    )
}

/// A row visible from the machine that supplies the table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineInfo {
    pub machine_id: String,
    /// The running daemon, where observed. Every advertised route carries it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    /// The remaining hops, ending at this machine. Empty for the table's own machine.
    /// Absent for a saved destination without a route.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<Vec<String>>,
    pub connections: Vec<MachineConnection>,
}

impl MachineInfo {
    pub fn is_unreachable(&self) -> bool {
        self.route.is_none()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionKind {
    Saved,
    Temporary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Connected,
    #[serde(rename = "unavailable")]
    Disconnected,
    SshInteractionRequired,
}

/// One connection as seen from its machine table row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineConnection {
    /// The other end of the connection.
    pub machine_id: String,
    pub initiator_machine_id: String,
    pub kind: ConnectionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    pub state: ConnectionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_interaction: Option<SshInteraction>,
}

/// A complete replacement for a directly connected machine's table. Every row has a route, build
/// and boot ID.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AdvertiseParams {
    pub machines: Vec<MachineInfo>,
}

/// The identity supplied by the daemon that accepted a local call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Caller {
    Terminal {
        machine_id: String,
    },
    Ide {
        window: WindowRef,
    },
    Agent {
        agent: AgentRef,
        root: AgentRef,
        yolo: bool,
    },
}

impl Caller {
    pub fn machine_id(&self) -> &str {
        match self {
            Self::Terminal { machine_id } => machine_id,
            Self::Ide { window } => &window.machine_id,
            Self::Agent { agent, .. } => &agent.machine_id,
        }
    }
}

/// Parameters of `forward`. The outer JSON-RPC ID identifies this hop.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ForwardParams {
    /// Remaining machine IDs. First is this hop's receiver and last is the final receiver.
    pub route: Vec<String>,
    pub caller: Caller,
    /// Milliseconds left where the call has a deadline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_left_ms: Option<u64>,
    /// The existing deduplication ID, carried only for `agent.start` and `agent.send`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// The original JSON-RPC method, decoded at the final receiver.
    pub method: String,
    /// The method payload. A forwarded `call` carries `ForwardCall`.
    pub params: Value,
}

/// A call on a machine session with facts the originating daemon takes from the local caller.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ForwardCall {
    pub call: CallParams,
    /// The originating connection acts for a model through MCP. Selects the model's start rules.
    pub by_model: bool,
    /// The verified sender's name for `agent.send`, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// The name of the sender's sole member window for `agent.send`, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_window: Option<String>,
    /// Colors from the window in `Caller::Ide` for `agent.resize`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_colors: Option<TerminalColors>,
}

/// The transport the local client will bridge to this machine session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MachineTransport {
    Ssh {
        ssh_destination: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        remote_home: Option<String>,
    },
    /// A temporary channel supplied by the client, such as an editor's existing SSH connection.
    Bridge,
}

/// A foreground machine session to authorize.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineConnectArgs {
    pub transport: MachineTransport,
    /// A bridge is always temporary.
    pub kind: ConnectionKind,
}

/// Returned before switching the local client stream into a machine session.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineConnectResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_machine_id: Option<String>,
}

/// Connection verified on the foreground stream.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConnectedParams {
    pub machine: MachineHello,
    pub first_connection: bool,
}

/// Foreground handshake failed after local authorization.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ConnectFailedParams {
    pub error: ErrorBody,
}

/// The outcome returned to the local client that opened a machine session.
pub enum ConnectionOutcome {
    Connected(ConnectedParams),
    Failed(ConnectFailedParams),
}

impl ConnectionOutcome {
    pub fn into_notification(self) -> Notification {
        match self {
            Self::Connected(params) => Notification::new(methods::CONNECTED, params),
            Self::Failed(params) => Notification::new(methods::CONNECT_FAILED, params),
        }
    }

    pub fn from_notification(notification: Notification) -> serde_json::Result<Option<Self>> {
        let outcome = match notification.method.as_str() {
            methods::CONNECTED => Self::Connected(serde_json::from_value(notification.params)?),
            methods::CONNECT_FAILED => Self::Failed(serde_json::from_value(notification.params)?),
            _ => return Ok(None),
        };
        Ok(Some(outcome))
    }
}

/// Save the identity verified in the foreground session.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineAddArgs {
    pub ssh_destination: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    pub machine_id: String,
}

/// The saved connection is ready.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineAddResult {
    pub machine: MachineHello,
    pub first_connection: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineListResult {
    pub machines: Vec<MachineInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineRemoveArgs {
    /// An input machine selector.
    pub machine: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineRemoveResult {
    pub machine_id: String,
    pub ssh_destination: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    pub reachable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineRenameArgs {
    /// An input machine selector.
    pub machine: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MachineRenameResult {
    pub machine_id: String,
    pub name: String,
}

/// A change to the machine table visible to a client.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MachinesChange {
    Updated {
        machine: MachineInfo,
    },
    Removed {
        machine_id: String,
    },
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// What the originating machine knows about a query or the first snapshot of a subscription.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineResponseState {
    Waiting,
    Responded,
    TimedOut,
    Failed,
    Unreachable,
}

/// A machine's contribution to an agent list or watch, before projecting it for a client.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MachineStateRow {
    pub machine_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    pub state: MachineResponseState,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreachable: bool,
    /// When this machine's response was received at the origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responded_at: Option<String>,
}

impl From<&MachineInfo> for MachineStateRow {
    fn from(machine: &MachineInfo) -> Self {
        let unreachable = machine.is_unreachable();
        Self {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
            build: machine.build.clone(),
            state: if unreachable {
                MachineResponseState::Unreachable
            } else {
                MachineResponseState::Waiting
            },
            unreachable,
            responded_at: None,
        }
    }
}

impl MachineStateRow {
    pub fn observe(&mut self, state: MachineResponseState, received_at: Option<SystemTime>) {
        self.state = state;
        self.unreachable = state == MachineResponseState::Unreachable;
        self.responded_at = received_at.map(crate::time::iso_time);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MachineQueryStatus {
    Answered,
    Unavailable,
    TimedOut,
    Error,
}

/// The outcome of asking one machine for its reachable agents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineQueryResult {
    pub machine_id: String,
    pub short_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    pub status: MachineQueryStatus,
    /// The UTC time of the answer, to milliseconds, when a machine answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<String>,
}

impl From<MachineQueryResult> for MachineStateRow {
    /// Reads a completed v2 query. An unavailable machine is unreachable at settlement.
    fn from(machine: MachineQueryResult) -> Self {
        let state = match machine.status {
            MachineQueryStatus::Answered => MachineResponseState::Responded,
            MachineQueryStatus::Unavailable => MachineResponseState::Unreachable,
            MachineQueryStatus::TimedOut => MachineResponseState::TimedOut,
            MachineQueryStatus::Error => MachineResponseState::Failed,
        };
        Self {
            machine_id: machine.machine_id,
            name: machine.name,
            build: machine.build,
            state,
            unreachable: state == MachineResponseState::Unreachable,
            responded_at: machine.answered_at,
        }
    }
}

impl From<MachineStateRow> for MachineQueryResult {
    fn from(row: MachineStateRow) -> Self {
        let status = match row.state {
            MachineResponseState::Responded => MachineQueryStatus::Answered,
            MachineResponseState::TimedOut => MachineQueryStatus::TimedOut,
            MachineResponseState::Failed => MachineQueryStatus::Error,
            MachineResponseState::Waiting | MachineResponseState::Unreachable => {
                MachineQueryStatus::Unavailable
            }
        };
        Self {
            short_id: short_machine_id(&row.machine_id),
            machine_id: row.machine_id,
            name: row.name,
            build: row.build,
            status,
            answered_at: row.responded_at,
        }
    }
}

/// Selects a machine for a query. An omitted selector uses the operation's default.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MachineQueryArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentListResult {
    pub agents: Vec<AgentInfo>,
    pub machines: Vec<MachineQueryResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CliListResult {
    pub clis: Vec<CliInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_problem: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WindowLocation {
    pub window: WindowRef,
    pub location: LocationInfo,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LocationListResult {
    pub locations: Vec<WindowLocation>,
}

/// A single message for the person, offered to its member windows on another machine.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "DeliverArgs")]
pub struct WindowDeliverArgs {
    pub message_ref: MessageRef,
    pub message: Message,
    pub windows: Vec<WindowRef>,
}

/// A start's result message for its creator, with the number the creator's machine reserved.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "DeliverStartResultArgs")]
pub struct AgentDeliverStartResultArgs {
    pub recipient: AgentRef,
    pub message: Message,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineIdConflict {
    pub machine_id: String,
    /// Both conflicting connection paths, including their sources.
    pub paths: [String; 2],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SshInteraction {
    pub reason: String,
    /// The complete command and arguments with which to repair the saved connection.
    pub command: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOutcome {
    NotExecuted,
    OutcomeUnknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Unavailable {
    pub execution: ExecutionOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowRef>,
    /// Complete addresses returned before a name lookup could finish.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matches: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unanswered: Vec<MachineIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProtocolMismatch {
    pub local_build: String,
    pub local_protocol: [u32; 2],
    pub remote_build: String,
    pub remote_protocol: [u32; 2],
}

pub struct MachineConnect;
impl Operation for MachineConnect {
    const NAME: &'static str = "machine.connect";
    const DOC: &'static str =
        "Authorizes foreground SSH and changes the client stream into the machine session.";
    type Args = MachineConnectArgs;
    type Result = MachineConnectResult;
}

pub struct MachineAdd;
impl Operation for MachineAdd {
    const NAME: &'static str = "machine.add";
    const DOC: &'static str =
        "Saves a verified connection and waits for its background session to connect.";
    type Args = MachineAddArgs;
    type Result = MachineAddResult;
}

pub struct MachineList;
impl Operation for MachineList {
    const NAME: &'static str = "machine.list";
    const DOC: &'static str =
        "Lists reachable machines and saved connections, with routes and connection states.";
    type Args = NoArgs;
    type Result = MachineListResult;
}

pub struct MachineRemove;
impl Operation for MachineRemove {
    const NAME: &'static str = "machine.remove";
    const DOC: &'static str =
        "Removes the local saved connection and reports remaining reachability.";
    type Args = MachineRemoveArgs;
    type Result = MachineRemoveResult;
}

pub struct MachineRename;
impl Operation for MachineRename {
    const NAME: &'static str = "machine.rename";
    const DOC: &'static str = "Changes the name on the selected machine.";
    type Args = MachineRenameArgs;
    type Result = MachineRenameResult;
}

pub struct AgentList;
impl Operation for AgentList {
    const NAME: &'static str = "agent.list";
    const DOC: &'static str = "Lists reachable agents from the selected machine or all known query destinations. \
        Answers once they reply or after three seconds. The client receives agents oldest first, using the creation time \
        recorded by each agent's own machine. Equal timestamps are ordered by machine ID, then by numeric agent ID.";
    type Args = MachineQueryArgs;
    type Result = AgentListResult;
}

pub struct CliList;
impl Operation for CliList {
    const NAME: &'static str = "cli.list";
    const DOC: &'static str = "Lists the CLIs of the selected machine's login environment.";
    type Args = MachineQueryArgs;
    type Result = CliListResult;
}

pub struct LocationList;
impl Operation for LocationList {
    const NAME: &'static str = "location.list";
    const DOC: &'static str = "Lists locations the selected machine's windows supply.";
    type Args = MachineQueryArgs;
    type Result = LocationListResult;
}

pub struct AgentCheckStart;
impl Operation for AgentCheckStart {
    const NAME: &'static str = "agent.start_preflight";
    const DOC: &'static str =
        "Checks a start's program and location without starting an agent or making a worktree.";
    type Args = AgentStartWireArgs;
    type Result = EmptyResult;
}

pub struct WindowDeliver;
impl Operation for WindowDeliver {
    const NAME: &'static str = "window.deliver";
    const DOC: &'static str = "Offers a message to the listed local window subscriptions and returns their outcomes. Machine sessions only.";
    type Args = WindowDeliverArgs;
    type Result = WindowDelivery;
}

/// The destination's window outcomes before encoding a machine response.
pub struct WindowDeliverResult {
    pub window_delivery: Vec<WindowDeliveryOutcome>,
}

impl From<WindowDeliverResult> for WindowDelivery {
    fn from(result: WindowDeliverResult) -> Self {
        Self::from_outcomes(result.window_delivery)
    }
}

pub struct AgentDeliverStartResult;
impl Operation for AgentDeliverStartResult {
    const NAME: &'static str = "agent.deliver_start_result";
    const DOC: &'static str =
        "Delivers the result of a start at its reserved message number. Machine sessions only.";
    type Args = AgentDeliverStartResultArgs;
    type Result = EmptyResult;
}

pub struct MachinesTopic;
impl Topic for MachinesTopic {
    const NAME: &'static str = "machines";
    const DOC: &'static str = "Follows the view of reachable machines and saved connections.";
    type Args = NoArgs;
    type Snapshot = Vec<MachineInfo>;
    type Change = MachinesChange;
}

/// Visits operations exposed to clients by the daemon that implements machine routing.
pub fn visit_operations(visitor: &mut impl OperationVisitor) {
    visitor.operation::<MachineConnect>();
    visitor.operation::<MachineAdd>();
    visitor.operation::<MachineList>();
    visitor.operation::<MachineRemove>();
    visitor.operation::<MachineRename>();
    visitor.operation::<AgentList>();
    visitor.operation::<CliList>();
    visitor.operation::<LocationList>();
    visitor.operation::<AgentCheckStart>();
}

pub fn visit_internal_operations(visitor: &mut impl OperationVisitor) {
    visitor.operation::<WindowDeliver>();
    visitor.operation::<AgentDeliverStartResult>();
}

pub fn visit_topics(visitor: &mut impl TopicVisitor) {
    visitor.topic::<MachinesTopic>();
}

pub fn operation_names() -> Vec<String> {
    super::operations::collect_names(visit_operations)
}

pub fn topic_names() -> Vec<String> {
    super::operations::collect_names(visit_topics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn v2_keeps_the_original_connection_names_and_route_omission() {
        for (state, word) in [
            (ConnectionState::Connected, "connected"),
            (ConnectionState::Disconnected, "unavailable"),
            (
                ConnectionState::SshInteractionRequired,
                "ssh_interaction_required",
            ),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(word));
            assert_eq!(
                serde_json::from_value::<ConnectionState>(json!(word)).unwrap(),
                state
            );
        }

        let mut wire = json!({ "machine_id": "here", "name": "desk", "connections": [] });
        let offline: MachineInfo = serde_json::from_value(wire.clone()).unwrap();
        assert!(offline.is_unreachable());
        assert_eq!(serde_json::to_value(offline).unwrap(), wire);
        wire["route"] = json!([]);
        let local: MachineInfo = serde_json::from_value(wire.clone()).unwrap();
        assert!(!local.is_unreachable());
        assert_eq!(serde_json::to_value(local).unwrap(), wire);
    }

    #[test]
    fn a_shared_machine_row_keeps_the_observation_and_projects_to_both_v2_shapes() {
        use crate::daemon::{AgentMachineState, AgentMachineView};
        use std::time::{Duration, UNIX_EPOCH};

        let route = json!({
            "machine_id": "c07cafe7-9a12-4b73-8e9f-cc2d44289832", "name": "gpu",
            "route": [], "build": "test", "connections": []
        });
        let machine: MachineInfo = serde_json::from_value(route).unwrap();
        let mut row = MachineStateRow::from(&machine);
        assert_eq!(row.state, MachineResponseState::Waiting);
        let now = Some(UNIX_EPOCH + Duration::from_secs(1));
        for (state, time, query, watch) in [
            (
                MachineResponseState::Waiting,
                None,
                "unavailable",
                "pending",
            ),
            (MachineResponseState::Responded, now, "answered", "synced"),
            (
                MachineResponseState::TimedOut,
                None,
                "timed_out",
                "unreachable",
            ),
            (MachineResponseState::Failed, now, "error", "unreachable"),
            (
                MachineResponseState::Unreachable,
                None,
                "unavailable",
                "unreachable",
            ),
        ] {
            row.observe(state, time);
            let canonical = serde_json::to_value(&row).unwrap();
            let mut expected = json!({
                "machine_id": machine.machine_id, "name": "gpu", "build": "test",
                "state": state,
            });
            let at = "1970-01-01T00:00:01.000Z";
            if time.is_some() {
                expected["responded_at"] = json!(at);
            }
            if state == MachineResponseState::Unreachable {
                expected["unreachable"] = json!(true);
            }
            assert_eq!(canonical, expected);

            let query_row = serde_json::to_value(MachineQueryResult::from(row.clone())).unwrap();
            let mut expected = json!({
                "machine_id": machine.machine_id, "short_id": "c07cafe7", "name": "gpu",
                "build": "test", "status": query,
            });
            if time.is_some() {
                expected["answered_at"] = json!(at);
            }
            assert_eq!(query_row, expected);
            let watch_row = serde_json::to_value(AgentMachineState::from(AgentMachineView {
                row: row.clone(),
                agents: (state == MachineResponseState::Responded).then(Vec::new),
            }))
            .unwrap();
            let mut expected = json!({ "machine_id": machine.machine_id, "state": watch });
            if state == MachineResponseState::Responded {
                expected["agents"] = json!([]);
            }
            assert_eq!(watch_row, expected);
        }
    }
}
