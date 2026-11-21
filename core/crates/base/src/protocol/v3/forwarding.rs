//! Requests between authenticated machines.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{AgentRef, Message, TerminalColors};
use crate::operations::{CallParams, EmptyResult, Operation, OperationVisitor};

/// Asks the machines on an authenticated route to open saved connections passively.
pub const MACHINE_PROBE_ROUTE: &str = "machine.probe_route";

/// Announces an authenticated machine's idle daemon exit to a capable machine.
pub const MACHINE_SLEEPING: &str = "machine.sleeping";

/// The watch's identity at the holder of a running agent's terminal.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AttachBinding {
    pub viewer: u64,
    pub boot_id: String,
}

/// A response to a forwarded watch on an authenticated machine session.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ForwardWatchResult {
    /// Watch ID scoped to this machine session.
    pub watch: u64,
    /// The snapshot for the forwarded watch's topic.
    pub snapshot: Value,
    /// The holder supplies this binding for a live shared Attach.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach: Option<AttachBinding>,
}

/// Parameters of a forwarded `attach.resize` on an authenticated machine session.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ForwardAttachResizeArgs {
    /// The holder's viewer ID from the live watch response.
    pub viewer: u64,
    /// The holder's daemon start ID from the same response.
    pub boot_id: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colors: Option<TerminalColors>,
}

/// An identity verified by the daemon that accepted the original request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "V3Caller")]
pub enum Caller {
    Terminal {
        machine_id: String,
    },
    Ide {
        machine_id: String,
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
            Self::Terminal { machine_id } | Self::Ide { machine_id } => machine_id,
            Self::Agent { agent, .. } => &agent.machine_id,
        }
    }
}

/// Parameters of `forward`. The outer JSON-RPC ID identifies this hop.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3ForwardParams")]
pub struct ForwardParams {
    /// Remaining machine IDs, from this hop's receiver to the destination.
    pub route: Vec<String>,
    pub caller: Caller,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_left_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub method: String,
    pub params: Value,
}

/// A forwarded call and the facts verified by the originating machine.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3ForwardCall")]
pub struct ForwardCall {
    pub call: CallParams,
    pub by_model: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// The resolved destination of `agent.send`, used again on retry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<AgentRef>,
}

/// A start outcome with the message number already reserved on the recipient's machine.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3DeliverStartResultArgs")]
pub struct AgentDeliverStartResultArgs {
    pub recipient: AgentRef,
    pub message: Message,
}

pub struct AgentDeliverStartResult;

impl Operation for AgentDeliverStartResult {
    const NAME: &'static str = "agent.deliver_start_result";
    const DOC: &'static str =
        "Delivers the result of a start at its reserved message number. Machine sessions only.";
    type Args = AgentDeliverStartResultArgs;
    type Result = EmptyResult;
}

pub fn visit_internal_operations(visitor: &mut impl OperationVisitor) {
    visitor.operation::<AgentDeliverStartResult>();
}
