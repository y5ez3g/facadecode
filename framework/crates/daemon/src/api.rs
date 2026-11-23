//! Translates daemon wire values at the boundary with stored and in-process records.

use facade_base::api_v1::{self, Operation, daemon as wire};
use facade_base::model::agent::AgentLabel;
use facade_base::model::agent::AgentRef;
use facade_base::model::machine::MachineQueryResult;
use facade_base::model::machine::MachineQueryStatus;
use facade_base::model::machine::MachineState;
use facade_base::model::message::DeliveredVia;
use facade_base::{
    jsonrpc::decode_arguments,
    model::error::{ErrorBody, Reason},
};
use serde_json::{Map, Value, json};

use crate::operations::StartRequest;
use crate::service::value_of;

pub(crate) fn error(reason: &str, message: impl Into<String>) -> api_v1::ErrorBody {
    api_v1::ErrorBody {
        code: -32000,
        message: message.into(),
        data: api_v1::ErrorData {
            reason: reason.into(),
            details: None,
        },
    }
}

pub(crate) fn project_error(error: ErrorBody) -> api_v1::ErrorBody {
    let mut fields = object(value_of(&error.data));
    let mut reason = fields.remove("reason").unwrap_or(Value::Null);
    let mut code = error.code;
    if matches!(
        error.data.reason,
        Reason::NotFound | Reason::InvalidArgument
    ) && error.data.entry.is_none()
        && (error.message.starts_with("No CLI ")
            || error.message.starts_with("Choose a CLI by name."))
    {
        reason = value_of(Reason::InvalidArgument);
        code = -32602;
        fields.insert(
            "available_clis".into(),
            value_of(&error.data.available_clis),
        );
    }
    if let Some(Value::Object(details)) = fields.remove("unavailable") {
        fields.extend(details);
    }
    if let Some(Value::Object(details)) = fields.remove("machine_id_conflict") {
        fields.extend(details);
    }
    if let Some(Value::Object(mut details)) = fields.remove("ssh_interaction") {
        rename(&mut details, "reason", "message");
        fields.extend(details);
    }
    let reason = reason.as_str().unwrap_or("internal");
    let allowed: &[&str] = match reason {
        "invalid_argument" => &["available_clis"],
        "not_found" => &["record_removal", "agents"],
        "session_not_found" => &["sessions"],
        "ambiguous_reference" => &["candidates", "agents", "machines", "sessions"],
        "ended" | "unsupported" => &["agents"],
        "partial_input" => &["text_written", "enter_written", "keys_sent", "agents"],
        "unavailable" => &[
            "agents",
            "execution",
            "machine",
            "unanswered",
            "matches",
            "machines",
            "message_ref",
            "windows",
            "window_delivery",
        ],
        "protocol_incompatible" => &["offered_api_versions", "supported_api_versions", "agents"],
        "machine_id_conflict" => &["machine_id", "paths"],
        "ssh_interaction_required" => &["message", "command"],
        "refused" => &["entry", "agents"],
        "configuration_invalid" => &["entry"],
        "worktree_failed" => &["kept"],
        _ => &[],
    };
    let confirmed_delivery = error.data.message_ref.is_some()
        && matches!(
            error.data.delivered_via,
            Some(DeliveredVia::TypedIntoInput | DeliveredVia::ReadByRecipient)
        );
    fields.retain(|key, _| {
        allowed.contains(&key.as_str())
            || key == "message_ref"
            || (key == "delivered_via" && confirmed_delivery)
    });
    // These reasons may report one already-authorized target. A reach refusal has no label.
    if matches!(reason, "unavailable" | "refused") && error.data.agents.len() != 1 {
        fields.remove("agents");
    }
    if let Some(Value::Array(agents)) = fields.get_mut("agents") {
        for agent in agents {
            project_label(agent);
        }
    }
    api_v1::ErrorBody {
        code,
        message: error.message,
        data: api_v1::ErrorData {
            reason: reason.to_owned(),
            details: (!fields.is_empty()).then_some(fields),
        },
    }
}

/// Peer errors enter the same in-process path as local errors for lookup and stop receipts.
pub(crate) fn received_error(error: api_v1::ErrorBody) -> ErrorBody {
    let mut details = error.data.details.unwrap_or_default();
    if let Some(execution) = details.remove("execution") {
        let mut unavailable = Map::from_iter([("execution".into(), execution)]);
        for name in ["machine", "window", "matches", "unanswered"] {
            if let Some(value) = details.remove(name) {
                unavailable.insert(name.into(), value);
            }
        }
        details.insert("unavailable".into(), Value::Object(unavailable));
    }
    if error.data.reason == "ssh_interaction_required" {
        let mut ssh = Map::new();
        if let Some(message) = details.remove("message") {
            ssh.insert("reason".into(), message);
        }
        if let Some(command) = details.remove("command") {
            ssh.insert("command".into(), command);
        }
        if !ssh.is_empty() {
            details.insert("ssh_interaction".into(), Value::Object(ssh));
        }
    }
    if error.data.reason == "machine_id_conflict"
        && let (Some(id), Some(paths)) = (details.remove("machine_id"), details.remove("paths"))
    {
        details.insert(
            "machine_id_conflict".into(),
            json!({ "machine_id": id, "paths": paths }),
        );
    }
    details.insert("reason".into(), Value::String(error.data.reason));
    let data = decode_arguments(Value::Object(details))
        .unwrap_or_else(|_| ErrorBody::new(Reason::Unavailable, "").data);
    ErrorBody {
        code: error.code,
        message: error.message,
        data,
    }
}

pub(crate) fn agent_ref(reference: wire::AgentRef) -> AgentRef {
    AgentRef {
        machine_id: reference.machine_id,
        agent_id: reference.agent_id,
    }
}

pub(crate) fn wire_ref(reference: &AgentRef) -> wire::AgentRef {
    wire::AgentRef {
        machine_id: reference.machine_id.clone(),
        agent_id: reference.agent_id.clone(),
    }
}

pub(crate) fn single_machine(scope: Option<wire::SingleMachineScope>) -> Option<String> {
    match scope {
        Some(wire::SingleMachineScope::Machine { machine }) => Some(machine),
        _ => None,
    }
}

pub(crate) fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(value) => value,
        _ => Map::new(),
    }
}

pub(crate) fn rename(fields: &mut Map<String, Value>, old: &str, new: &str) {
    if let Some(value) = fields.remove(old) {
        fields.insert(new.into(), value);
    }
}

pub(crate) fn project_label(label: &mut Value) {
    if let Some(fields) = label.as_object_mut() {
        let kind = if fields.get("state").and_then(Value::as_str) == Some("online") {
            "guest"
        } else {
            "managed"
        };
        fields.insert("type".into(), Value::String(kind.into()));
    }
}

pub(crate) fn project_machine(
    mut machine: wire::MachineInfo,
    disclose_ssh: bool,
) -> wire::MachineInfo {
    if !disclose_ssh {
        for connection in &mut machine.connections {
            connection.transport = None;
            connection.ssh_interaction = None;
        }
    }
    machine
}

pub(crate) fn start_args(args: wire::StartArgs, result: Option<wire::MessageRef>) -> StartRequest {
    StartRequest {
        cli: args.cli,
        args: args.args,
        folder: args.folder,
        worktree: args.worktree,
        model: args.model,
        effort: args.effort,
        name: args.name,
        prompt: args.prompt,
        env: args.env.unwrap_or_default(),
        cols: args.size.cols,
        rows: args.size.rows,
        call_id: args.call_id,
        request_id: args.request_id,
        result_message_id: result.as_ref().map(|result| result.message_id.clone()),
        result_message_machine_id: result.map(|result| result.machine_id),
    }
}

pub(crate) fn wire_label(label: AgentLabel) -> wire::AgentLabel {
    wire::AgentLabel {
        reference: wire_ref(&label.reference),
        address: label.address,
        kind: if label.state == wire::AgentState::Online {
            wire::AgentKind::Guest
        } else {
            wire::AgentKind::Managed
        },
        name: label.name,
        cli: label.cli,
        state: label.state,
        resumable: label.resumable,
    }
}

/// Parse the holder's stop receipt while allowing extra reply members.
pub(crate) fn stop_receipt(
    mut value: Value,
) -> Result<(facade_base::process::ProcessExit, AgentLabel), ErrorBody> {
    let item = value
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .filter(|items| items.len() == 1)
        .map(|items| items[0].take())
        .ok_or_else(|| ErrorBody::invalid_argument("expected one remote stop receipt"))?;
    if let Some(error) = item.get("error") {
        return Err(received_error(decode_arguments(error.clone())?));
    }
    let agent = item
        .get("agent")
        .ok_or_else(|| ErrorBody::invalid_argument("missing stopped agent"))?;
    let exit = item
        .get("exit")
        .filter(|_| item["status"] == "stopped")
        .ok_or_else(|| ErrorBody::invalid_argument("expected confirmed exit"))?;
    Ok((
        decode_arguments(exit.clone())?,
        decode_arguments(agent.clone())?,
    ))
}

pub(crate) fn machine_query(row: MachineQueryResult) -> wire::MachineQuery {
    let state = match row.state {
        MachineState::Online => wire::MachineState::Online,
        MachineState::Connecting => wire::MachineState::Connecting,
        MachineState::Disconnected => wire::MachineState::Disconnected,
        MachineState::Sleeping => wire::MachineState::Sleeping,
        MachineState::Unreachable => wire::MachineState::Unreachable,
        MachineState::SshInteractionRequired => wire::MachineState::SshInteractionRequired,
    };
    let status = match row.status {
        MachineQueryStatus::Answered => wire::QueryStatus::Answered,
        MachineQueryStatus::Unavailable => wire::QueryStatus::Unavailable,
        MachineQueryStatus::TimedOut => wire::QueryStatus::TimedOut,
        MachineQueryStatus::Error => wire::QueryStatus::Error,
    };
    wire::MachineQuery {
        machine_id: row.machine_id,
        short_id: row.short_id,
        name: row.name,
        selector: row.selector,
        state,
        status,
        build: row.build,
        last_seen: row.last_seen,
        ssh_error: row.ssh_error,
        error: row.error,
    }
}

pub(crate) fn message_ref(reference: wire::MessageRef) -> facade_base::model::message::MessageRef {
    facade_base::model::message::MessageRef {
        machine_id: reference.machine_id,
        message_id: reference.message_id,
    }
}

pub(crate) fn wire_message_ref(
    reference: facade_base::model::message::MessageRef,
) -> wire::MessageRef {
    wire::MessageRef {
        machine_id: reference.machine_id,
        message_id: reference.message_id,
    }
}

pub(crate) fn call<O: Operation>(args: O::Args) -> wire::CallParams {
    wire::CallParams {
        op: O::NAME.into(),
        args: value_of(args),
    }
}
