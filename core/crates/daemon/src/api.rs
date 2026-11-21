//! Translates daemon wire values at the boundary with stored and in-process records.

use facade_base::api_v1::{self, daemon as wire};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{AgentRef, ConnectionKind, ConnectionState};
use facade_base::operations::Operation;
use facade_base::v3;
use serde_json::{Map, Value, json};

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
        "partial_input" => &["text_written", "enter_written", "keys_sent"],
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
    fields.retain(|key, _| allowed.contains(&key.as_str()));
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

pub(crate) fn caller(caller: wire::Caller) -> v3::Caller {
    match caller {
        wire::Caller::Terminal { machine_id } => v3::Caller::Terminal { machine_id },
        wire::Caller::Ide { machine_id } => v3::Caller::Ide { machine_id },
        wire::Caller::Agent { agent, root, yolo } => v3::Caller::Agent {
            agent: agent_ref(agent),
            root: agent_ref(root),
            yolo,
        },
    }
}

pub(crate) fn wire_caller(caller: &v3::Caller) -> wire::Caller {
    match caller {
        v3::Caller::Terminal { machine_id } => wire::Caller::Terminal {
            machine_id: machine_id.clone(),
        },
        v3::Caller::Ide { machine_id } => wire::Caller::Ide {
            machine_id: machine_id.clone(),
        },
        v3::Caller::Agent { agent, root, yolo } => wire::Caller::Agent {
            agent: wire_ref(agent),
            root: wire_ref(root),
            yolo: *yolo,
        },
    }
}

pub(crate) fn target(target: wire::AgentTarget) -> v3::AgentTarget {
    match target {
        wire::AgentTarget::Selector(agent) => v3::AgentTarget::Address { agent },
        wire::AgentTarget::Reference(reference) => v3::AgentTarget::Reference {
            reference: agent_ref(reference),
        },
    }
}

pub(crate) fn wire_target(target: &v3::AgentTarget) -> wire::AgentTarget {
    match target {
        v3::AgentTarget::Address { agent } => wire::AgentTarget::Selector(agent.clone()),
        v3::AgentTarget::Reference { reference } => {
            wire::AgentTarget::Reference(wire_ref(reference))
        }
    }
}

pub(crate) fn scope(scope: wire::Scope) -> v3::Scope {
    match scope {
        wire::Scope::Local => v3::Scope::Local,
        wire::Scope::Reachable => v3::Scope::Reachable,
        wire::Scope::Machine { machine } => v3::Scope::Machine { machine },
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

pub(crate) fn project_agent(agent: &mut Value) {
    let Some(fields) = agent.as_object_mut() else {
        return;
    };
    let (Some(machine_id), Some(agent_id)) =
        (fields.remove("machine_id"), fields.remove("agent_id"))
    else {
        return;
    };
    fields.insert(
        "reference".into(),
        json!({ "machine_id": machine_id, "agent_id": agent_id }),
    );
    for (agent, machine) in [
        ("creator", "creator_machine_id"),
        ("root", "root_machine_id"),
    ] {
        if let Some(id) = fields.remove(agent) {
            let home = fields.remove(machine).unwrap_or_else(|| machine_id.clone());
            fields.insert(agent.into(), json!({ "machine_id": home, "agent_id": id }));
        }
    }
    project_size(fields);
}

/// Collapse the pair only when both dimensions were recorded.
fn project_size(fields: &mut Map<String, Value>) {
    if let (Some(cols), Some(rows)) = (fields.remove("cols"), fields.remove("rows")) {
        fields.insert("size".into(), json!({ "cols": cols, "rows": rows }));
    }
}

fn receive_size(fields: &mut Map<String, Value>) {
    if let Some(Value::Object(size)) = fields.remove("size") {
        fields.extend(size);
    }
}

fn receive_reference(fields: &mut Map<String, Value>) {
    if let Some(Value::Object(reference)) = fields.remove("reference") {
        fields.extend(reference);
    }
}

pub(crate) fn received_agent(agent: &mut Value) {
    let Some(fields) = agent.as_object_mut() else {
        return;
    };
    let machine_id = fields
        .get("reference")
        .and_then(|reference| reference.get("machine_id"))
        .cloned();
    for (agent, machine) in [
        ("creator", "creator_machine_id"),
        ("root", "root_machine_id"),
    ] {
        if let Some(Value::Object(mut reference)) = fields.remove(agent) {
            if let Some(id) = reference.remove("agent_id") {
                fields.insert(agent.into(), id);
            }
            if let Some(home) = reference.remove("machine_id")
                && Some(&home) != machine_id.as_ref()
            {
                fields.insert(machine.into(), home);
            }
        }
    }
    receive_reference(fields);
    receive_size(fields);
}

pub(crate) fn agents_snapshot(mut value: Value, outgoing: bool) -> Value {
    let project = if outgoing {
        project_agent
    } else {
        received_agent
    };
    if let Some(Value::Array(agents)) = value.get_mut("agents") {
        for agent in agents {
            project(agent);
        }
    }
    if let Some(Value::Array(machines)) = value.get_mut("machines") {
        for machine in machines {
            if let Some(Value::Array(agents)) = machine.get_mut("agents") {
                for agent in agents {
                    project(agent);
                }
            }
        }
    }
    value
}

pub(crate) fn agents_change(mut value: Value, outgoing: bool) -> Value {
    let project = if outgoing {
        project_agent
    } else {
        received_agent
    };
    if let Some(agent) = value.get_mut("agent") {
        project(agent);
    }
    if let Some(Value::Array(agents)) = value
        .get_mut("machine")
        .and_then(|machine| machine.get_mut("agents"))
    {
        for agent in agents {
            project(agent);
        }
    }
    value
}

pub(crate) fn project_machine(mut machine: v3::MachineInfo, disclose_ssh: bool) -> Value {
    let connections: Vec<_> = std::mem::take(&mut machine.connections)
        .into_iter()
        .map(|connection| {
            let kind = match connection.kind {
                ConnectionKind::Saved => wire::ConnectionKind::Saved,
                ConnectionKind::Temporary => wire::ConnectionKind::Temporary,
            };
            let state = match connection.state {
                ConnectionState::Connected => wire::ConnectionState::Connected,
                ConnectionState::Disconnected => wire::ConnectionState::Disconnected,
                ConnectionState::SshInteractionRequired => {
                    wire::ConnectionState::SshInteractionRequired
                }
            };
            let transport =
                connection
                    .ssh_destination
                    .filter(|_| disclose_ssh)
                    .map(|ssh_destination| {
                        let mut ssh_args = connection.ssh_args;
                        if ssh_args.is_empty() {
                            ssh_args.push(ssh_destination.clone());
                        }
                        wire::SshTransport {
                            ssh_destination,
                            ssh_args,
                            remote_home: connection.remote_home,
                        }
                    });
            let ssh_interaction =
                connection
                    .ssh_interaction
                    .filter(|_| disclose_ssh)
                    .map(|interaction| wire::SshInteraction {
                        message: interaction.reason,
                        command: interaction.command,
                    });
            wire::MachineConnection {
                machine_id: connection.machine_id,
                initiator_machine_id: connection.initiator_machine_id,
                kind,
                state,
                transport,
                ssh_interaction,
            }
        })
        .collect();
    let short_id = v3::address::short_machine_id(&machine.machine_id).to_owned();
    let mut fields = object(value_of(machine));
    fields.insert("short_id".into(), value_of(short_id));
    fields.remove("capabilities");
    fields.insert("connections".into(), value_of(connections));
    Value::Object(fields)
}

pub(crate) fn start_args(args: wire::StartArgs) -> v3::StartArgs {
    v3::StartArgs {
        cli: args.cli,
        args: args.args,
        folder: args.folder,
        folder_is_default: args.folder_is_default,
        machine: single_machine(args.scope),
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
        result_message_id: None,
        result_message_machine_id: None,
    }
}

pub(crate) fn send_args(
    args: wire::SendArgs,
) -> Result<(v3::AgentSendArgs, Option<AgentRef>), ErrorBody> {
    let mut fields = object(value_of(args));
    let to: wire::AgentTarget = decode_arguments(fields.remove("to").unwrap_or_default())?;
    let (address, recipient) = match to {
        wire::AgentTarget::Selector(address) => (address, None),
        wire::AgentTarget::Reference(reference) => {
            let recipient = agent_ref(reference);
            (recipient.exact_address(), Some(recipient))
        }
    };
    fields.insert("to".into(), value_of(address));
    if let Some(Value::Object(reply)) = fields.get("reply_to") {
        let id = reply.get("message_id").cloned().unwrap_or_default();
        let machine = reply.get("machine_id").cloned().unwrap_or_default();
        fields.insert("reply_to".into(), id);
        fields.insert("reply_to_machine_id".into(), machine);
    }
    Ok((decode_arguments(Value::Object(fields))?, recipient))
}

pub(crate) fn type_fields(input: wire::TerminalInput) -> Value {
    match input {
        wire::TerminalInput::Text { text, enter } => json!({ "text": text, "enter": enter }),
        wire::TerminalInput::Keys { keys } => json!({ "keys": keys }),
        wire::TerminalInput::Raw { raw } => json!({ "raw": raw }),
    }
}

pub(crate) fn stop_selection(selection: wire::StopSelection) -> v3::StopSelection {
    match selection {
        wire::StopSelection::Targets { targets } => v3::StopSelection::Targets {
            targets: targets.into_iter().map(target).collect(),
        },
        wire::StopSelection::All { scope: selected } => v3::StopSelection::All {
            scope: scope(selected),
        },
    }
}

pub(crate) fn stop_result(result: v3::BatchStopResult) -> Value {
    let items: Vec<_> = result
        .items
        .into_iter()
        .map(|item| {
            let mut fields = object(json!({ "target": wire_target(&item.target) }));
            if let Some(agent) = item.agent {
                let mut label = value_of(agent);
                project_label(&mut label);
                fields.insert("agent".into(), label);
            }
            match item.outcome {
                v3::StopOutcome::Stopped { exit } => {
                    fields.insert("status".into(), value_of("stopped"));
                    fields.insert("exit".into(), value_of(exit));
                }
                v3::StopOutcome::Failed { error } => {
                    fields.insert("status".into(), value_of("failed"));
                    fields.insert("error".into(), value_of(project_error(error)));
                }
                v3::StopOutcome::Skipped => {
                    fields.insert("status".into(), value_of("skipped"));
                }
            }
            Value::Object(fields)
        })
        .collect();
    let mut answer = object(json!({ "items": items }));
    if !result.machines.is_empty() {
        answer.insert("machines".into(), value_of(result.machines));
    }
    Value::Object(answer)
}

pub(crate) fn list_result(result: v3::AgentListResult) -> Value {
    let mut value = value_of(result);
    if let Some(Value::Array(rows)) = value.get_mut("agents") {
        for row in rows {
            if let Some(fields) = row.as_object_mut() {
                rename(fields, "id", "address");
            }
        }
    }
    value
}

pub(crate) fn resume_candidate(candidate: v3::ResumeCandidate) -> Value {
    let target = if let Some(agent) = &candidate.agent {
        wire::ResumeTarget::Agent {
            reference: wire_ref(agent),
        }
    } else {
        wire::ResumeTarget::Session {
            machine_id: candidate.machine_id.clone(),
            cli: candidate.cli.clone(),
            session: candidate.session.clone(),
            folder: candidate.folder.clone(),
        }
    };
    let mut value = value_of(candidate);
    value["target"] = value_of(target);
    value
}

pub(crate) fn resume_list_result(result: v3::ResumeListResult) -> Value {
    let items: Vec<_> = result.items.into_iter().map(resume_candidate).collect();
    json!({ "items": items, "machines": result.machines })
}

pub(crate) fn receive_candidate(value: Value) -> Result<v3::ResumeCandidate, ErrorBody> {
    let mut fields = object(value);
    let target: wire::ResumeTarget = decode_arguments(fields.remove("target").unwrap_or_default())?;
    let target = match target {
        wire::ResumeTarget::Agent { reference } => v3::ResumeTarget {
            reference: agent_ref(reference).exact_address(),
            machine: None,
            folder: None,
        },
        wire::ResumeTarget::Session {
            machine_id,
            cli,
            session,
            folder,
        } => v3::ResumeTarget {
            reference: format!("{cli}:{session}"),
            machine: Some(machine_id),
            folder: Some(folder),
        },
        wire::ResumeTarget::Selector { .. } => {
            return Err(ErrorBody::invalid_argument(
                "expected an exact resume candidate",
            ));
        }
    };
    fields.insert("target".into(), value_of(target));
    decode_arguments(Value::Object(fields))
}

fn project_message(message: &mut Value) {
    if let Some(agent) = message
        .get_mut("result")
        .and_then(|result| result.get_mut("agent"))
    {
        project_agent(agent);
    }
}

pub(crate) fn receive_message(message: &mut Value) {
    if let Some(agent) = message
        .get_mut("result")
        .and_then(|result| result.get_mut("agent"))
    {
        received_agent(agent);
    }
}

pub(crate) fn project_call_result(operation: &str, mut result: Value) -> Value {
    match operation {
        "agent.rename" => {
            let mut fields = object(result);
            let previous = fields.remove("previous_name");
            let mut agent = Value::Object(fields);
            project_agent(&mut agent);
            let mut result = object(json!({ "agent": agent }));
            if let Some(previous) = previous {
                result.insert("previous_name".into(), previous);
            }
            Value::Object(result)
        }
        "agent.inspect" | "agent.start" | "agent.resume" => {
            if let Some(agent) = result.get_mut("agent") {
                project_agent(agent);
            }
            if let Some(prompt) = result.get_mut("prompt") {
                project_message(prompt);
            }
            result
        }
        "agent.send" => {
            if let Some(recipient) = result.get_mut("recipient") {
                project_label(recipient);
            }
            if let Some(message) = result.get_mut("message") {
                project_message(message);
            }
            result
        }
        "agent.type" => {
            if let Some(agent) = result.get_mut("agent") {
                project_label(agent);
            }
            result
        }
        "daemon.status" => {
            if let Some(fields) = result.as_object_mut() {
                rename(fields, "agents", "agent_count");
            }
            result
        }
        _ => result,
    }
}

pub(crate) fn receive_call_result(operation: &str, mut result: Value) -> Result<Value, ErrorBody> {
    match operation {
        "agent.rename" => {
            let mut fields = object(result);
            let mut agent = fields.remove("agent").unwrap_or_default();
            received_agent(&mut agent);
            fields.extend(object(agent));
            Ok(Value::Object(fields))
        }
        "agent.inspect" | "agent.start" | "agent.resume" => {
            if let Some(agent) = result.get_mut("agent") {
                received_agent(agent);
            }
            if let Some(prompt) = result.get_mut("prompt") {
                receive_message(prompt);
            }
            Ok(result)
        }
        "agent.stop" => {
            let item = result
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
            let mut value = object(exit.clone());
            value.insert("address".into(), agent["address"].clone());
            value.insert("reference".into(), agent["reference"].clone());
            value.insert("agent".into(), agent.clone());
            Ok(Value::Object(value))
        }
        "agent.send" => {
            if let Some(message) = result.get_mut("message") {
                receive_message(message);
            }
            Ok(result)
        }
        "daemon.status" => {
            if let Some(fields) = result.as_object_mut() {
                rename(fields, "agent_count", "agents");
            }
            Ok(result)
        }
        crate::network_operations::AGENT_RECORDS => {
            if let Some(records) = result.as_array_mut() {
                for record in records {
                    if let Some(agent) = record.get_mut("agent") {
                        received_agent(agent);
                    }
                    if let Some(fields) = record.as_object_mut() {
                        rename(fields, "agent", "info");
                    }
                }
            }
            Ok(result)
        }
        crate::resume::RESUME_RECORDS => {
            let records: Vec<Value> = decode_arguments(result)?;
            let records = records
                .into_iter()
                .map(receive_candidate)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(value_of(records))
        }
        "agent.resume_list" => {
            if let Some(Value::Array(items)) = result.get_mut("items") {
                for item in items {
                    *item = value_of(receive_candidate(item.take())?);
                }
            }
            Ok(result)
        }
        _ => Ok(result),
    }
}

pub(crate) fn forward_arguments(
    operation: &str,
    args: Value,
    recipient: Option<AgentRef>,
    request_id: Option<String>,
) -> Result<(wire::CallParams, Option<wire::MessageRef>), ErrorBody> {
    let mut fields = object(args);
    fields.retain(|_, value| !value.is_null());
    let mut operation = operation;
    let mut start_result = None;
    match operation {
        "agent.inspect" | "agent.remove" | "agent.rename" | "agent.screen" | "agent.type" => {
            let target = fields.remove("reference").ok_or_else(missing_reference)?;
            fields.insert("target".into(), target);
            if operation == "agent.type" {
                let input = if let Some(raw) = fields.remove("raw") {
                    json!({ "kind": "raw", "raw": raw })
                } else if let Some(keys) = fields.remove("keys") {
                    json!({ "kind": "keys", "keys": keys })
                } else {
                    json!({
                        "kind": "text",
                        "text": fields.remove("text").unwrap_or_else(|| value_of("")),
                        "enter": fields.remove("enter").unwrap_or_else(|| value_of(false)),
                    })
                };
                fields.insert("input".into(), input);
            }
        }
        "agent.stop" => {
            let target = fields.remove("reference").ok_or_else(missing_reference)?;
            fields = object(json!({ "selection": { "kind": "targets", "targets": [target] } }));
        }
        "agent.start" => {
            project_size(&mut fields);
            if let (Some(message_id), Some(machine_id)) = (
                fields.remove("result_message_id"),
                fields.remove("result_message_machine_id"),
            ) {
                start_result = Some(decode_arguments(json!({
                    "machine_id": machine_id, "message_id": message_id,
                }))?);
            }
        }
        "agent.send" => {
            let recipient = recipient.ok_or_else(missing_reference)?;
            fields.insert("to".into(), value_of(wire_ref(&recipient)));
            if let Some(machine_id) = fields.remove("reply_to_machine_id")
                && let Some(message_id) = fields.remove("reply_to")
            {
                fields.insert(
                    "reply_to".into(),
                    json!({
                        "machine_id": machine_id, "message_id": message_id
                    }),
                );
            }
        }
        "agent.resume_list" => {
            fields.remove("local");
            if let Some(machine) = fields.remove("machine") {
                fields.insert(
                    "scope".into(),
                    json!({ "kind": "machine", "machine": machine }),
                );
            }
            if fields.remove("all").and_then(|value| value.as_bool()) == Some(true) {
                fields.insert("folder_scope".into(), value_of("all"));
            }
        }
        crate::resume::RESUME_RECORDS => fields.clear(),
        v3::AgentDeliverStartResult::NAME => {
            operation = "internal.deliver_start_result";
            if let Some(message) = fields.get_mut("message") {
                project_message(message);
            }
        }
        _ => {}
    }
    if let Some(request_id) = request_id {
        fields.insert("request_id".into(), value_of(request_id));
    }
    Ok((
        wire::CallParams {
            op: operation.into(),
            args: Value::Object(fields),
        },
        start_result,
    ))
}

fn missing_reference() -> ErrorBody {
    ErrorBody::invalid_argument("the forwarded operation needs an exact reference")
}
