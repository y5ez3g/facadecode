//! The eight tools on an actor-authenticated daemon connection.

use std::time::Duration;

use facade_base::address::selector;
use facade_base::api_v1::daemon::{
    AgentInspect, AgentKind, AgentList, AgentListArgs, AgentRef, AgentScreen, AgentStart,
    AgentState, AgentStop, AgentTarget, AgentTargetArgs, AgentType, AgentTypeArgs, MachineList,
    ScreenArgs, SingleMachineScope, StartArgs, StopArgs, StopItem, StopOutcome, StopSelection,
    TerminalInput,
};
use facade_base::api_v1::{self, NoArgs, Size, daemon_client::DaemonClient};
use facade_base::jsonrpc::decode_arguments;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::machine::{MachineIdentity, MachineQueryResult};
use facade_base::model::message::MessageRef;
use facade_base::model::terminal::DEFAULT_TERMINAL_SIZE;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::time::Instant;

use super::addresses::inbox_role;
use super::daemon_calls::{CONNECT_TIMEOUT, failed, open_with};
use super::{
    ActorIdentity, Relay, Tool, ToolCall, agent_tools, envelope, message_tools, optional,
    terminal_tools, text, validate,
};
use crate::messages::InboxRead;

const INBOX_WAIT: Duration = Duration::from_secs(30);

#[derive(Serialize)]
struct ListedAgent {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: AgentKind,
    state: AgentState,
    cli: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    folder: String,
    started_at: String,
}

#[derive(Deserialize)]
struct ReadMessagesArgs {
    after: Option<String>,
    last: Option<u16>,
    #[serde(default)]
    wait: bool,
    reply_to: Option<String>,
}

pub(super) fn dispatch(
    relay: &Relay,
    name: &str,
    given: &Value,
    call: &ToolCall,
    meta: Option<&Value>,
) -> Option<Value> {
    let actor = match relay.verified.actor(relay, meta) {
        Ok(actor) => actor,
        Err(error) => return Some(envelope::refusal(&error)),
    };
    let (tool, arguments) = match validate(name, given) {
        Ok(checked) => checked,
        Err(failure) => return Some(failure),
    };
    if let Tool::SendMessage = tool {
        return message_tools::send_verified(relay, &actor, &arguments, call);
    }
    let mut client = match open_with(
        || (relay.verified.services.connect)(&actor.reference),
        CONNECT_TIMEOUT,
    ) {
        Ok(client) => client,
        Err(failure) => return Some(failure),
    };
    let client = &mut client;
    Some(match tool {
        Tool::StartAgent => start(client, &actor, &arguments, call),
        Tool::ListAgents => list(client),
        Tool::StopAgent => stop(client, &arguments),
        Tool::ReadMessages => return read(relay, &actor, client, &arguments, call),
        Tool::ReadScreen => screen(client, &arguments),
        Tool::TypeText => type_into(client, &arguments, false),
        Tool::PressKeys => type_into(client, &arguments, true),
        Tool::SendMessage => unreachable!("the send was made above"),
    })
}

fn start(
    client: &mut DaemonClient,
    actor: &ActorIdentity,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Value {
    let (cols, rows) = DEFAULT_TERMINAL_SIZE;
    let mut size = Size { cols, rows };
    let mut folder = optional(arguments, "folder");
    let mut folder_is_default = false;
    if actor.kind == AgentKind::Managed {
        match client.call::<AgentInspect>(AgentTargetArgs {
            target: AgentTarget::Reference(AgentRef {
                machine_id: actor.reference.machine_id.clone(),
                agent_id: actor.reference.agent_id.clone(),
            }),
        }) {
            Ok(inspected) => {
                size = inspected.agent.size.unwrap_or(size);
                if folder.is_none() {
                    folder = Some(inspected.agent.cwd);
                    folder_is_default = true;
                }
            }
            Err(err) => return failed(&err, "nothing was started"),
        }
    }
    let start = StartArgs {
        cli: text(arguments, "cli"),
        size,
        args: Vec::new(),
        folder_is_default,
        folder,
        scope: optional(arguments, "machine")
            .map(|machine| SingleMachineScope::Machine { machine }),
        worktree: optional(arguments, "worktree"),
        model: optional(arguments, "model"),
        effort: optional(arguments, "effort"),
        name: optional(arguments, "name"),
        prompt: optional(arguments, "prompt"),
        env: None,
        call_id: Some(call.id.clone()),
        request_id: Some(call.request_id.clone()),
    };
    match client.call_with_request_id::<AgentStart>(start, true) {
        Ok((started, _)) => {
            let agent = started.agent;
            let mut data = json!({
                "id": agent.address, "name": agent.name, "folder": agent.cwd,
                "machine_id": agent.reference.machine_id,
            });
            if let (Some(id), Some(machine)) =
                (started.result_message_id, started.result_message_machine_id)
            {
                match inbox_role(&id, &machine, &actor.reference.machine_id, &[]) {
                    Ok(address) => data["result_message"] = json!(address),
                    Err(error) => return envelope::refusal(&error),
                }
            }
            envelope::success(data)
        }
        Err(err) => match err.downcast_ref::<api_v1::ErrorBody>() {
            Some(error) => agent_tools::start_daemon_refused(error),
            None => failed(
                &err,
                "whether the agent started is not known; check with list_agents",
            ),
        },
    }
}

fn list(client: &mut DaemonClient) -> Value {
    match client.call::<AgentList>(AgentListArgs { scope: None }) {
        Ok(listed) => {
            let agents: Vec<_> = listed
                .agents
                .into_iter()
                .map(|entry| ListedAgent {
                    id: entry.address,
                    name: entry.name,
                    kind: entry.kind,
                    state: entry.state,
                    cli: entry.cli,
                    title: entry.title,
                    folder: entry.folder,
                    started_at: entry.started_at,
                })
                .collect();
            // Keep the MCP machine receipt's field order.
            let machines: Vec<MachineQueryResult> =
                match serde_json::from_value(json!(listed.machines)) {
                    Ok(machines) => machines,
                    Err(error) => return envelope::refusal(&ErrorBody::internal(error)),
                };
            envelope::success(json!({ "agents": agents, "machines": machines }))
        }
        Err(err) => failed(&err, "nothing was changed"),
    }
}

fn stop(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let agent = text(arguments, "agent");
    let selection = StopSelection::Targets {
        targets: vec![AgentTarget::Selector(agent.clone())],
    };
    let consequence =
        || format!("whether {agent} stopped is not confirmed; check with read_screen");
    match client.call::<AgentStop>(StopArgs { selection }) {
        Ok(stopped) => match stopped.items.as_slice() {
            [
                StopItem {
                    agent: Some(agent),
                    outcome: StopOutcome::Stopped { .. },
                    ..
                },
            ] => envelope::success(json!({ "id": agent.address, "state": "ended" })),
            [
                StopItem {
                    outcome: StopOutcome::Failed { error },
                    ..
                },
            ] => envelope::daemon_refusal(error),
            _ => envelope::failure("unavailable", consequence()),
        },
        Err(err) => failed(&err, &consequence()),
    }
}

fn screen(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let args = ScreenArgs {
        target: AgentTarget::Selector(text(arguments, "agent")),
        lines: arguments
            .get("lines")
            .and_then(Value::as_u64)
            .and_then(|lines| u16::try_from(lines).ok()),
    };
    match client.call::<AgentScreen>(args) {
        Ok(screen) => envelope::success(json!({
            "agent_id": screen.reference.agent_id,
            "address": screen.address,
            "process": screen.process,
            "observed_at": screen.observed_at,
            "buffer": screen.buffer,
            "text": screen.text,
            "line_count": screen.line_count,
            "older_lines": screen.older_lines,
            "trimmed": screen.trimmed,
        })),
        Err(err) => failed(&err, "nothing was changed"),
    }
}

fn type_into(client: &mut DaemonClient, arguments: &Map<String, Value>, press_keys: bool) -> Value {
    let agent = text(arguments, "agent");
    let input = if press_keys {
        TerminalInput::Keys {
            keys: string_items(arguments, "keys"),
        }
    } else {
        TerminalInput::Text {
            text: text(arguments, "text"),
            enter: arguments.get("enter") == Some(&Value::Bool(true)),
        }
    };
    match client.call::<AgentType>(AgentTypeArgs {
        target: AgentTarget::Selector(agent.clone()),
        input,
    }) {
        Ok(_) => envelope::success(json!({})),
        Err(err) => {
            terminal_tools::input_failure(&err, &agent, |consequence| failed(&err, consequence))
        }
    }
}

fn string_items(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn read(
    relay: &Relay,
    actor: &ActorIdentity,
    client: &mut DaemonClient,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Option<Value> {
    let cancel = relay.sends.read_cancel(&call.key);
    if cancel.is_requested() {
        return None;
    }
    let args = decode_arguments(Value::Object(arguments.clone()))
        .and_then(|args| inbox_read(client, args, call));
    let result = args.and_then(|args| {
        (relay.verified.services.read_inbox)(&actor.reference, args, cancel.clone())
    });
    match result {
        Ok(result) => Some(result),
        Err(error) if error.data.reason == Reason::Cancelled && cancel.is_requested() => None,
        Err(error) => Some(envelope::refusal(&error)),
    }
}

fn inbox_read(
    client: &mut DaemonClient,
    args: ReadMessagesArgs,
    call: &ToolCall,
) -> Result<InboxRead, ErrorBody> {
    let local = client.hello_result.machine_id.clone();
    let mut machines = None;
    let mut resolve =
        |input, qualified| message_reference(client, &local, &mut machines, input, qualified);
    let after = args
        .after
        .as_deref()
        .map(|input| resolve(input, false))
        .transpose()?;
    if after
        .as_ref()
        .is_some_and(|reference| reference.machine_id != local)
    {
        return Err(ErrorBody::invalid_argument(
            "after takes a message from your inbox",
        ));
    }
    Ok(InboxRead {
        after: after.map(|reference| reference.message_id),
        last: args.last,
        reply_to: args
            .reply_to
            .as_deref()
            .map(|input| resolve(input, true))
            .transpose()?,
        wait_until: args
            .wait
            .then(|| Instant::from_std(call.arrived) + INBOX_WAIT),
    })
}

fn message_reference(
    client: &mut DaemonClient,
    local: &str,
    machines: &mut Option<Vec<MachineIdentity>>,
    input: &str,
    qualified: bool,
) -> Result<MessageRef, ErrorBody> {
    let address = selector::parse_message_address(input)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
    let machine_id = match address.machine {
        None if qualified => {
            return Err(ErrorBody::invalid_argument(
                "reply_to takes the full message ID returned by send_message",
            ));
        }
        None => local.to_string(),
        Some(selector) => {
            if machines.is_none() {
                let listed =
                    client
                        .call::<MachineList>(NoArgs {})
                        .map_err(|err| match err.downcast_ref::<api_v1::ErrorBody>() {
                            Some(error) => envelope::tool_error(error),
                            None => ErrorBody::new(
                                Reason::Unavailable,
                                format!("cannot list machines: {err:#}"),
                            ),
                        })?;
                *machines = Some(
                    listed
                        .machines
                        .into_iter()
                        .map(|machine| MachineIdentity {
                            machine_id: machine.machine_id,
                            name: machine.name,
                        })
                        .collect(),
                );
            }
            let mut matched = machines
                .iter()
                .flatten()
                .filter(|machine| selector.matches(machine));
            match (matched.next(), matched.next()) {
                (Some(machine), None) => machine.machine_id.clone(),
                (None, _) => {
                    return Err(ErrorBody::invalid_argument(format!(
                        "no machine matches {input:?}"
                    )));
                }
                _ => {
                    return Err(ErrorBody::new(
                        Reason::AmbiguousReference,
                        format!(
                            "several machines match {input:?}; choose a machine by its full ID"
                        ),
                    ));
                }
            }
        }
    };
    Ok(MessageRef {
        machine_id,
        message_id: address.message_id.to_string(),
    })
}
