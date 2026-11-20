//! The eight tools on an actor-authenticated daemon connection.

use std::time::Duration;

use facade_base::daemon::DEFAULT_TERMINAL_SIZE;
use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::v3::{self, AgentTarget, MachineIdentity, MessageRef};
use serde_json::{Map, Value, json};
use tokio::time::Instant;

use super::addresses::{Addresses, inbox_role};
use super::daemon_calls::{CONNECT_TIMEOUT, failed, open_with};
use super::{
    ActorIdentity, Relay, Tool, ToolCall, V3_DEFINITIONS, agent_tools, envelope, message_tools,
    optional, terminal_tools, text, validate,
};
use crate::messages::InboxRead;

const INBOX_WAIT: Duration = Duration::from_secs(30);

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
    let (tool, arguments) = match validate(name, given, &V3_DEFINITIONS) {
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
    let (mut cols, mut rows) = DEFAULT_TERMINAL_SIZE;
    let mut folder = optional(arguments, "folder");
    let mut folder_is_default = false;
    if actor.kind == v3::AgentKind::Managed {
        match client.call::<v3::AgentInspect>(v3::AgentSelectorArgs {
            target: AgentTarget::Reference {
                reference: actor.reference.clone(),
            },
        }) {
            Ok(inspected) => {
                cols = inspected.agent.cols.unwrap_or(cols);
                rows = inspected.agent.rows.unwrap_or(rows);
                if folder.is_none() {
                    folder = Some(inspected.agent.cwd);
                    folder_is_default = true;
                }
            }
            Err(err) => return failed(&err, "nothing was started"),
        }
    }
    let start = v3::StartArgs {
        cli: text(arguments, "cli"),
        args: Vec::new(),
        folder_is_default,
        folder,
        machine: optional(arguments, "machine"),
        worktree: optional(arguments, "worktree"),
        model: optional(arguments, "model"),
        effort: optional(arguments, "effort"),
        name: optional(arguments, "name"),
        prompt: optional(arguments, "prompt"),
        env: Default::default(),
        cols,
        rows,
        call_id: Some(call.id.clone()),
        result_message_id: None,
        result_message_machine_id: None,
        request_id: Some(call.request_id.clone()),
    };
    match client.call_with_request_id::<v3::AgentStart>(start, true) {
        Ok((started, _)) => {
            let agent = started.agent;
            let mut data = json!({
                "id": agent.address, "name": agent.name, "folder": agent.cwd,
                "machine_id": agent.machine_id,
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
        Err(err) => match err.downcast_ref::<ErrorBody>() {
            Some(error) => agent_tools::start_refused(error, &Addresses::default()),
            None => failed(
                &err,
                "whether the agent started is not known; check with list_agents",
            ),
        },
    }
}

fn list(client: &mut DaemonClient) -> Value {
    match client.call::<v3::AgentList>(v3::MachineQueryArgs::default()) {
        Ok(listed) => {
            let agents: Vec<_> = listed.agents.into_iter().map(|entry| entry.row).collect();
            envelope::success(json!({ "agents": agents, "machines": listed.machines }))
        }
        Err(err) => failed(&err, "nothing was changed"),
    }
}

fn stop(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let agent = text(arguments, "agent");
    let target = AgentTarget::Address {
        agent: agent.clone(),
    };
    match client.call::<v3::AgentStop>(v3::AgentSelectorArgs { target }) {
        Ok(stopped) => envelope::success(json!({ "id": stopped.address, "state": "ended" })),
        Err(err) => failed(
            &err,
            &format!("whether {agent} stopped is not confirmed; check with read_screen"),
        ),
    }
}

fn screen(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let args = v3::AgentScreenArgs {
        agent: text(arguments, "agent"),
        lines: arguments
            .get("lines")
            .and_then(Value::as_u64)
            .and_then(|lines| u16::try_from(lines).ok()),
    };
    match client.call::<v3::AgentScreen>(args) {
        Ok(mut screen) => {
            // The v3 label is for Shell receipts. Keep read_screen's existing MCP payload.
            screen.name = None;
            envelope::encode(screen).unwrap_or_else(|error| envelope::refusal(&error))
        }
        Err(err) => failed(&err, "nothing was changed"),
    }
}

fn type_into(client: &mut DaemonClient, arguments: &Map<String, Value>, press_keys: bool) -> Value {
    let agent = text(arguments, "agent");
    let input = v3::AgentTypeArgs {
        target: AgentTarget::Address {
            agent: agent.clone(),
        },
        raw: None,
        text: optional(arguments, "text"),
        enter: arguments.get("enter") == Some(&Value::Bool(true)),
        keys: press_keys.then(|| string_items(arguments, "keys")),
    };
    match client.call::<v3::AgentType>(input) {
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
    args: v3::ReadMessagesArgs,
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
    let address = v3::address::parse_message_address(input)
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
                let listed = client
                    .call::<v3::MachineList>(v3::NoArgs {})
                    .map_err(|err| {
                        err.downcast::<ErrorBody>().unwrap_or_else(|err| {
                            ErrorBody::new(
                                Reason::Unavailable,
                                format!("cannot list machines: {err:#}"),
                            )
                        })
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
