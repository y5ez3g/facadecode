//! The eight tools for a verified relay actor.

use std::time::{Duration, Instant};

use facade_base::address::selector::{self, MessageAddress};
use facade_base::api_v1::daemon::{
    self as wire, AgentKind, AgentListArgs, AgentRef, AgentState, AgentTarget, AgentTargetArgs,
    AgentTypeArgs, DaemonCall, ScreenArgs, SingleMachineScope, StartArgs, StopArgs, StopItem,
    StopOutcome, StopSelection, TerminalInput,
};
use facade_base::api_v1::{NoArgs, Size};
use facade_base::jsonrpc::decode_arguments;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::machine::MachineIdentity;
use facade_base::model::message::MessageRef;
use facade_base::model::terminal::DEFAULT_TERMINAL_SIZE;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::daemon_calls::{CALL_TIMEOUT, call as daemon_call, query, result};
use super::{
    ActorIdentity, InboxAnswer, InboxOutput, Relay, Tool, ToolCall, agent_tools, envelope,
    message_tools, optional, terminal_tools, text, validate,
};
use crate::delivery::SendTurn;
use crate::messages::{InboxRead, read_before_deadline};
use crate::service::{CallResult, launch_environment};

const EFFECT_TIMEOUT: Duration = Duration::from_secs(30);

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

#[derive(Serialize)]
struct ListedMachine {
    machine_id: String,
    short_id: String,
    name: String,
    selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    build: Option<String>,
    state: wire::MachineState,
    status: wire::QueryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ssh_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clis: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cli_error: Option<String>,
}

#[derive(Deserialize)]
struct ReadMessagesArgs {
    after: Option<String>,
    last: Option<u16>,
    #[serde(default)]
    timeout_seconds: u64,
    reply_to: Option<String>,
}

pub(super) enum ToolReply {
    Result(Value),
    Cancelled,
    Answered,
}

impl From<Value> for ToolReply {
    fn from(result: Value) -> Self {
        Self::Result(result)
    }
}

pub(super) async fn dispatch(
    relay: &Relay,
    name: &str,
    given: Value,
    call: &ToolCall,
    meta: Option<Value>,
    send_turn: Option<SendTurn>,
) -> ToolReply {
    let (tool, arguments) = match validate(name, &given) {
        Ok(checked) => checked,
        Err(failure) => return failure.into(),
    };
    let actor = match relay.verified.actor(relay, meta.as_ref()).await {
        Ok(actor) => actor,
        Err(error) => return envelope::refusal(&error).into(),
    };
    drop((given, meta));
    if matches!(tool, Tool::ReadMessages) && call.replay == super::lines::Replay::Interrupted {
        return envelope::failure(
            "unavailable",
            "the inbox read's result is unknown; use last to read the latest messages",
        )
        .into();
    }
    let effect = match call.output.as_ref() {
        Some(output)
            if matches!(
                tool,
                Tool::TypeText | Tool::PressKeys | Tool::StartAgent | Tool::StopAgent
            ) =>
        {
            match output.command().await {
                Ok(room) => Some((output, room)),
                Err(error) => return envelope::refusal(&error).into(),
            }
        }
        _ => None,
    };
    let deadline = call.arrived + EFFECT_TIMEOUT;
    let response = match tool {
        Tool::SendMessage => {
            return message_tools::send_verified(relay, &actor, arguments, call, send_turn).await;
        }
        Tool::ReadMessages => return read(relay, &actor, arguments, call).await,
        Tool::ListAgents => list(relay, &actor, call.arrived + CALL_TIMEOUT).await,
        Tool::StartAgent => start(relay, &actor, &arguments, call, deadline).await,
        Tool::StopAgent => stop(relay, &actor, &arguments, deadline).await,
        Tool::ReadScreen => screen(relay, &actor, &arguments).await,
        Tool::TypeText => type_into(relay, &actor, &arguments, false, deadline).await,
        Tool::PressKeys => type_into(relay, &actor, &arguments, true, deadline).await,
    };
    if let Some((output, room)) = effect {
        room.send(output.line(response));
        ToolReply::Answered
    } else {
        response.into()
    }
}

async fn start(
    relay: &Relay,
    actor: &ActorIdentity,
    arguments: &Map<String, Value>,
    call: &ToolCall,
    deadline: Instant,
) -> Value {
    let (cols, rows) = DEFAULT_TERMINAL_SIZE;
    let mut size = Size { cols, rows };
    let mut folder = optional(arguments, "folder");
    let mut folder_is_default = false;
    let mut env = None;
    if actor.kind == AgentKind::Managed {
        let inspect = DaemonCall::AgentInspect(AgentTargetArgs {
            target: AgentTarget::Reference(AgentRef {
                machine_id: actor.reference.machine_id.clone(),
                agent_id: actor.reference.agent_id.clone(),
            }),
        });
        match daemon_call(relay, actor, inspect, None).await {
            Ok(CallResult::Inspected(inspected, colors)) => {
                size = inspected.agent.size.unwrap_or(size);
                env = launch_environment(Some(&colors), false);
                if folder.is_none() {
                    folder = Some(inspected.agent.cwd);
                    folder_is_default = true;
                }
            }
            Ok(_) => {
                return envelope::failure(
                    "internal",
                    "Facade returned the result of a different operation",
                );
            }
            Err(error) => return envelope::daemon_refusal(&error),
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
        env,
        call_id: Some(call.id.clone()),
        request_id: Some(call.request_id.clone()),
    };
    match result!(
        daemon_call(relay, actor, DaemonCall::AgentStart(start), Some(deadline)).await,
        Started
    ) {
        Ok(started) => {
            let agent = started.agent;
            envelope::success(json!({
                "id": agent.address, "name": agent.name, "folder": agent.cwd,
                "machine_id": agent.reference.machine_id,
            }))
        }
        Err(error) => agent_tools::start_daemon_refused(&error),
    }
}

async fn list(relay: &Relay, actor: &ActorIdentity, deadline: Instant) -> Value {
    let op = DaemonCall::AgentList(AgentListArgs { scope: None });
    match result!(query(relay, actor, op, deadline).await, Listed) {
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
            let mut discovered = if let Some(discover) = relay
                .verified
                .discover_clis
                .as_ref()
                .filter(|_| Instant::now() < deadline)
            {
                discover(&actor.reference, &listed.machines, deadline).await
            } else {
                Default::default()
            };
            let machines: Vec<_> = listed
                .machines
                .into_iter()
                .map(|machine| {
                    let mut row = ListedMachine {
                        machine_id: machine.machine_id,
                        short_id: machine.short_id,
                        name: machine.name,
                        selector: machine.selector,
                        build: machine.build,
                        state: machine.state,
                        status: machine.status,
                        last_seen: machine.last_seen,
                        ssh_error: machine.ssh_error,
                        error: machine.error,
                        clis: None,
                        cli_error: None,
                    };
                    if row.status == wire::QueryStatus::Answered {
                        match discovered.remove(&row.machine_id) {
                            Some(Ok(clis)) => row.clis = Some(clis),
                            Some(Err(error)) => row.cli_error = Some(error),
                            None => {}
                        }
                    }
                    row
                })
                .collect();
            envelope::success(json!({ "agents": agents, "machines": machines }))
        }
        Err(error) => envelope::daemon_refusal(&error),
    }
}

async fn stop(
    relay: &Relay,
    actor: &ActorIdentity,
    arguments: &Map<String, Value>,
    deadline: Instant,
) -> Value {
    let agent = text(arguments, "agent");
    let selection = StopSelection::Targets {
        targets: vec![AgentTarget::Selector(agent.clone())],
    };
    let consequence =
        || format!("whether {agent} stopped is not confirmed; check with read_screen");
    let op = DaemonCall::AgentStop(StopArgs { selection });
    match result!(daemon_call(relay, actor, op, Some(deadline)).await, Stopped) {
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
        Err(error) => envelope::daemon_refusal(&error),
    }
}

async fn screen(relay: &Relay, actor: &ActorIdentity, arguments: &Map<String, Value>) -> Value {
    let args = ScreenArgs {
        target: AgentTarget::Selector(text(arguments, "agent")),
        lines: arguments
            .get("lines")
            .and_then(Value::as_u64)
            .and_then(|lines| u16::try_from(lines).ok()),
    };
    match result!(
        daemon_call(relay, actor, DaemonCall::AgentScreen(args), None).await,
        Screen
    ) {
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
        Err(error) => envelope::daemon_refusal(&error),
    }
}

async fn type_into(
    relay: &Relay,
    actor: &ActorIdentity,
    arguments: &Map<String, Value>,
    press_keys: bool,
    deadline: Instant,
) -> Value {
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
    let op = DaemonCall::AgentType(AgentTypeArgs {
        target: AgentTarget::Selector(agent.clone()),
        input,
    });
    match result!(daemon_call(relay, actor, op, Some(deadline)).await, Typed) {
        Ok(_) => envelope::success(json!({})),
        Err(error) => terminal_tools::input_failure(&error, &agent),
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

async fn read(
    relay: &Relay,
    actor: &ActorIdentity,
    arguments: Map<String, Value>,
    call: &ToolCall,
) -> ToolReply {
    let cancel = call.cancellation();
    if cancel.is_requested() {
        return ToolReply::Cancelled;
    }
    let args: ReadMessagesArgs = match decode_arguments(Value::Object(arguments)) {
        Ok(args) => args,
        Err(error) => return envelope::refusal(&error).into(),
    };
    let positive = args.timeout_seconds > 0;
    if positive && actor.receives_terminal_messages {
        return envelope::failure(
            "unsupported",
            "read_messages cannot wait in this managed run. This call did not check your inbox. \
             End this turn so Facade can deliver incoming messages to your input.",
        )
        .into();
    }
    let budget = if positive {
        Duration::from_secs(args.timeout_seconds)
    } else {
        CALL_TIMEOUT
    };
    let deadline = call.arrived + budget;
    let timed_out = || inbox_timeout(args.reply_to.as_deref(), args.timeout_seconds);
    let parsed = parse_read(&args);
    let (after, reply_to) = match parsed {
        Ok(parsed) => parsed,
        Err(error) => return envelope::refusal(&error).into(),
    };
    if Instant::now() >= deadline {
        return if positive {
            timed_out()
        } else {
            envelope::refusal(&read_before_deadline())
        }
        .into();
    }
    let read = match inbox_read(relay, actor, after, args.last, reply_to, positive, deadline).await
    {
        Ok(read) => read,
        Err(error)
            if positive
                && error.data.reason == Reason::Unavailable
                && Instant::now() >= deadline =>
        {
            return timed_out().into();
        }
        Err(error) => return envelope::refusal(&error).into(),
    };
    let output = call
        .output
        .clone()
        .map(|target| InboxOutput { target, sent: None });
    let result =
        (relay.verified.services.read_inbox)(&actor.reference, read, cancel.clone(), output).await;
    match result {
        Ok(InboxAnswer::Page(result))
            if positive
                && result["data"]["messages"]
                    .as_array()
                    .is_some_and(Vec::is_empty) =>
        {
            timed_out().into()
        }
        Ok(InboxAnswer::Page(result)) => result.into(),
        Ok(InboxAnswer::Answered) => ToolReply::Answered,
        Err(error) if error.data.reason == Reason::Cancelled && cancel.is_requested() => {
            ToolReply::Cancelled
        }
        Err(error) if positive && error.data.reason == Reason::ReplyTimeout => timed_out().into(),
        Err(error) => envelope::refusal(&error).into(),
    }
}

fn inbox_timeout(reply_to: Option<&str>, seconds: u64) -> Value {
    if let Some(id) = reply_to {
        let mut failure = envelope::failure(
            "reply_timeout",
            format!("No matching reply to {id} within {seconds} seconds."),
        );
        failure["data"] = json!({ "id": id });
        failure
    } else {
        envelope::failure(
            "timeout",
            format!("No matching inbox message within {seconds} seconds."),
        )
    }
}

fn parse_read(
    args: &ReadMessagesArgs,
) -> Result<(Option<MessageAddress<'_>>, Option<MessageAddress<'_>>), ErrorBody> {
    let parse = |input| {
        selector::parse_message_address(input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))
    };
    let after = args.after.as_deref().map(parse).transpose()?;
    let reply_to = args.reply_to.as_deref().map(parse).transpose()?;
    if reply_to
        .as_ref()
        .is_some_and(|address| address.machine.is_none())
    {
        return Err(ErrorBody::invalid_argument(
            "reply_to takes the full address that send_message returned as data.id, such as m42@devbox",
        ));
    }
    Ok((after, reply_to))
}

async fn inbox_read(
    relay: &Relay,
    actor: &ActorIdentity,
    after: Option<MessageAddress<'_>>,
    last: Option<u16>,
    reply_to: Option<MessageAddress<'_>>,
    positive: bool,
    deadline: Instant,
) -> Result<InboxRead, ErrorBody> {
    let local = &actor.reference.machine_id;
    let qualified = after
        .iter()
        .chain(reply_to.iter())
        .any(|address| address.machine.is_some());
    let machines: Vec<MachineIdentity> = if qualified {
        let op = DaemonCall::MachineList(NoArgs {});
        result!(query(relay, actor, op, deadline).await, Machines)
            .map_err(|error| envelope::tool_error(&error))?
            .machines
            .into_iter()
            .map(|machine| MachineIdentity {
                machine_id: machine.machine_id,
                name: machine.name,
            })
            .collect()
    } else {
        Vec::new()
    };
    let resolve = |address| message_reference(local, &machines, address);
    let after = after.map(resolve).transpose()?;
    if after
        .as_ref()
        .is_some_and(|reference| &reference.machine_id != local)
    {
        return Err(ErrorBody::invalid_argument(
            "after takes a message from your inbox",
        ));
    }
    let deadline = tokio::time::Instant::from_std(deadline);
    Ok(InboxRead {
        after: after.map(|reference| reference.message_id),
        last,
        reply_to: reply_to.map(resolve).transpose()?,
        wait_until: positive.then_some(deadline),
        admit_by: (!positive).then_some(deadline),
    })
}

fn message_reference(
    local: &str,
    machines: &[MachineIdentity],
    address: MessageAddress<'_>,
) -> Result<MessageRef, ErrorBody> {
    let machine_id = match address.machine {
        None => local.to_string(),
        Some(selector) => {
            let mut matched = machines.iter().filter(|machine| selector.matches(machine));
            match (matched.next(), matched.next()) {
                (Some(machine), None) => machine.machine_id.clone(),
                (None, _) => {
                    return Err(ErrorBody::invalid_argument(format!(
                        "no machine matches the address of {}",
                        address.message_id
                    )));
                }
                _ => {
                    return Err(ErrorBody::new(
                        Reason::AmbiguousReference,
                        format!(
                            "several machines match the address of {}; choose a machine by its full ID",
                            address.message_id,
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
