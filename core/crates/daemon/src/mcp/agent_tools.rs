//! The agent tools: `start_agent` starts a CLI in a folder, `list_agents` lists the
//! windows and the agents, and `stop_agent` stops one.

use facade_base::address::{exact_machine_selector, parse_machine_selector};
use facade_base::daemon::{
    AgentInfo, AgentInspect, AgentSelectorArgs, AgentStart, AgentStartWireArgs, AgentState,
    AgentStop, DEFAULT_TERMINAL_SIZE, LocationInfo, LocationKind, WaitKind, WindowInfo, WindowRef,
    WindowsTopic, Worktree, check_message_text,
};
use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{
    AgentList, AgentRef, MachineIdentity, MachineList, MachineQueryArgs, MachineStateRow,
};
use facade_base::operations::NoArgs;
use facade_base::process::ProcessState;
use serde_json::{Map, Value, json};

use super::addresses::Addresses;
use super::daemon_calls::{CONNECT_TIMEOUT, agent_failed, failed};
use super::envelope::{self, MAX_INLINE_CHARS};
use super::result_files::{self, ResultFile};
use super::{Problems, ToolCall, optional, text};

/// Refuses a start's prompt as Facade refuses a message's text, and a model or an effort that is
/// blank: a start leaves either out for its CLI's own.
pub(super) fn check_start(arguments: &Map<String, Value>, problems: &mut Problems) {
    for field in ["model", "effort"] {
        let blank = arguments
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| value.chars().all(facade_base::settings::is_space));
        if blank {
            problems.add(format!(
                "{field} must not be blank; leave it out for the CLI's own"
            ));
        }
    }
    let prompt = arguments.get("prompt").and_then(Value::as_str);
    if let Some(Err(problem)) = prompt.map(check_message_text) {
        problems.add(problem);
    }
}

/// Resolve the start's machine and window selectors against the same selectable machines.
fn start_machines(
    client: &mut DaemonClient,
    running: Option<&str>,
    member: Option<&str>,
    source: Option<&str>,
) -> Result<(String, String, Vec<MachineIdentity>), Value> {
    let local = client.hello_result.machine_id.clone();
    if running.is_none() && member.is_none() && source.is_none() {
        return Ok((local.clone(), local, Vec::new()));
    }
    let machines: Vec<_> = client
        .call::<MachineList>(NoArgs {})
        .map_err(|error| failed(&error, "nothing was started"))?
        .machines
        .into_iter()
        .map(|machine| MachineIdentity {
            machine_id: machine.machine_id,
            name: machine.name,
        })
        .collect();
    let resolve = |selected| match selected {
        Some(selected) => select_machine(&machines, selected),
        None => Ok(local.clone()),
    };
    let running = resolve(running)?;
    if let Some(source) = source
        && select_machine(&machines, source)? != running
    {
        return Err(envelope::failure(
            "invalid_argument",
            "location_source_window must be on the running machine. Choose a window there or select its machine with 'machine'. Nothing was started.",
        ));
    }
    Ok((running, resolve(member)?, machines))
}

/// Both window roles accept a bare ID or an ID qualified by a machine selector.
fn window_parts<'a>(
    window: Option<&'a str>,
    field: &str,
) -> Result<(Option<&'a str>, Option<&'a str>), Value> {
    match window.and_then(|id| id.split_once('@')) {
        Some(("", _)) => Err(envelope::failure(
            "invalid_argument",
            format!("{field} requires a window ID"),
        )),
        Some((id, selector)) => Ok((Some(id), Some(selector))),
        None => Ok((window, None)),
    }
}

fn select_machine(machines: &[MachineIdentity], selected: &str) -> Result<String, Value> {
    let selector = parse_machine_selector(selected)
        .map_err(|error| envelope::failure("invalid_argument", error.to_string()))?;
    let matches: Vec<_> = machines
        .iter()
        .filter(|machine| selector.matches(machine))
        .map(|machine| machine.machine_id.as_str())
        .collect();
    match matches.as_slice() {
        [machine_id] => Ok(machine_id.to_string()),
        [] => Err(envelope::failure(
            "invalid_argument",
            format!("No machine matches {selected:?}. Nothing was started."),
        )),
        _ => {
            let mut error = ErrorBody::new(
                Reason::AmbiguousReference,
                format!("Several machines match {selected:?}. Choose a machine by its ID."),
            );
            error.data.candidates = matches
                .iter()
                .map(|id| exact_machine_selector(id))
                .collect();
            Err(envelope::refusal(&error))
        }
    }
}

fn exact_address(agent: &AgentInfo) -> String {
    AgentRef {
        machine_id: agent.machine_id.clone(),
        agent_id: agent.agent_id.clone(),
    }
    .exact_address()
}

/// Starts a CLI for `me` at its terminal size. The running daemon resolves and checks the folder.
/// A prompt owes `me` a result that names this call.
pub(super) fn start(
    client: &mut DaemonClient,
    me: &str,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Value {
    let nothing = "nothing was started";
    let me = match client.call::<AgentInspect>(AgentSelectorArgs {
        agent: me.to_string(),
    }) {
        Ok(inspected) => inspected.agent,
        Err(err) => return failed(&err, nothing),
    };
    let machine = optional(arguments, "machine");
    let window = optional(arguments, "window");
    let (window_id, member_selector) = match window_parts(window.as_deref(), "window") {
        Ok(parts) => parts,
        Err(failure) => return failure,
    };
    let source_window = optional(arguments, "location_source_window");
    let (source_id, source_selector) =
        match window_parts(source_window.as_deref(), "location_source_window") {
            Ok(parts) => parts,
            Err(failure) => return failure,
        };
    let (running_machine, member_machine, machines) =
        match start_machines(client, machine.as_deref(), member_selector, source_selector) {
            Ok(machines) => machines,
            Err(failure) => return failure,
        };
    let window = window_id.map(|window_id| WindowRef {
        machine_id: member_machine,
        window_id: window_id.to_string(),
    });
    let location_source_window = source_id.map(|window_id| WindowRef {
        machine_id: running_machine.clone(),
        window_id: window_id.to_string(),
    });
    let folder = optional(arguments, "folder");
    let worktree = arguments
        .get("worktree")
        .and_then(Value::as_object)
        .map(|worktree| Worktree {
            branch: text(worktree, "branch"),
            base_ref: text(worktree, "base_ref"),
        });
    // A guest has no terminal of Facade's to size the new one by.
    let (cols, rows) = DEFAULT_TERMINAL_SIZE;
    let start = AgentStartWireArgs {
        command: vec![text(arguments, "cli")],
        name: optional(arguments, "name"),
        cwd_is_default: folder.is_none(),
        cwd: folder.unwrap_or_default(),
        machine: machine.map(|_| exact_machine_selector(&running_machine)),
        window,
        initial_windows: None,
        location_source_window,
        env: Default::default(),
        cols: me.cols.unwrap_or(cols),
        rows: me.rows.unwrap_or(rows),
        prompt: optional(arguments, "prompt"),
        call_id: Some(call.id.clone()),
        request_id: Some(call.request_id.clone()),
        result_message_id: None,
        result_message_machine_id: None,
        worktree,
        model: optional(arguments, "model"),
        effort: optional(arguments, "effort"),
        session: None,
    };
    let started = client.call_with_request_id::<AgentStart>(start, true);
    let addresses = Addresses {
        here: &client.hello_result.machine_id,
        machines: &machines,
    };
    let err = match started {
        Ok((started, _)) => {
            let agent = started.agent;
            let mut data = json!({
                "id": format!("#{}", agent.agent_id), "name": agent.name, "folder": agent.cwd,
            });
            show_members(&mut data, &agent, &addresses);
            if let (Some(id), Some(machine_id)) =
                (started.result_message_id, started.result_message_machine_id)
            {
                data["result_message"] = json!(addresses.role(&format!("#{id}"), &machine_id));
            }
            return envelope::success(data);
        }
        Err(err) => err,
    };
    match err.downcast_ref::<ErrorBody>() {
        Some(error) => start_refused(error, &addresses),
        None => failed(
            &err,
            "whether the agent started is not known: list_agents lists it if it did",
        ),
    }
}

/// A start the daemon refused, saying where a worktree it made stays.
fn start_refused(error: &ErrorBody, addresses: &Addresses<'_>) -> Value {
    let mut refused = envelope::refusal_with_addresses(error, addresses);
    if let Some(unavailable) = &error.data.unavailable {
        refused["data"]["execution"] = json!(unavailable.execution);
    }
    let kept_worktree = error
        .data
        .kept
        .as_ref()
        .and_then(|kept| kept.path.as_deref());
    if let Some(folder) = kept_worktree {
        if let Some(kept) = refused["data"]["kept"].as_object_mut() {
            kept.remove("path");
            kept.insert("folder".to_string(), json!(folder));
        }
        refused["message"] = json!(format!(
            "{}; the worktree it made stays at {folder}",
            error.message
        ));
    }
    refused
}

/// What an agent is doing, as `list_agents` says it: an ended process is `ended`, and a state the
/// tools do not know `unknown`.
fn state_word(agent: &AgentInfo) -> &'static str {
    if agent.process == ProcessState::Ended {
        return "ended";
    }
    match agent.state {
        AgentState::Starting => "starting",
        AgentState::Working => "working",
        AgentState::WaitingForYou => "waiting_for_you",
        AgentState::JustDone => "just_done",
        AgentState::Idle => "idle",
        AgentState::Error => "error",
        AgentState::Ended => "ended",
        AgentState::Unknown | AgentState::Unrecognized => "unknown",
    }
}

/// Adds the window membership to an agent's list row or start result.
fn show_members(row: &mut Value, agent: &AgentInfo, addresses: &Addresses<'_>) {
    row["address"] = json!(agent.address.clone().unwrap_or_else(|| {
        addresses.qualified(&format!("#{}", agent.agent_id), &agent.machine_id)
    }));
    row["machine_id"] = json!(agent.machine_id);
    let windows: Vec<_> = agent
        .windows
        .iter()
        .map(|window| addresses.window(window))
        .collect();
    row["windows"] = json!(windows);
}

/// An agent as `list_agents` shows it: who and where it is, what it is doing, what it waits for
/// while it waits for the person, and who started it.
fn agent_row(agent: &AgentInfo, addresses: &Addresses<'_>) -> Value {
    let state = state_word(agent);
    let mut row = json!({
        "id": format!("#{}", agent.agent_id), "name": agent.name, "cli": agent.cli,
    });
    show_members(&mut row, agent, addresses);
    row["folder"] = json!(agent.cwd);
    row["state"] = json!(state);
    if agent.unreachable {
        row["unreachable"] = json!(true);
    }
    if state == "waiting_for_you" {
        let kind = agent
            .state_detail
            .as_ref()
            .and_then(|detail| detail.kind)
            .unwrap_or(WaitKind::Unknown);
        let waiting_for = match kind {
            WaitKind::Unrecognized => "unknown",
            kind => kind.as_str(),
        };
        row["waiting_for"] = json!(waiting_for);
    }
    let creator = match &agent.creator {
        Some(creator) => {
            let machine_id = agent
                .creator_machine_id
                .as_deref()
                .unwrap_or(&agent.machine_id);
            addresses.role(&format!("#{creator}"), machine_id)
        }
        None => "#human".to_string(),
    };
    row["creator"] = json!(creator);
    row
}

/// A v2 location in the MCP result, using its public kind and folder field.
fn location_row(location: &LocationInfo) -> Option<Value> {
    let kind = match location.kind {
        LocationKind::Folder => "folder",
        LocationKind::MainCheckout => "main_checkout",
        LocationKind::Worktree => "worktree",
        LocationKind::Unknown => return None,
    };
    Some(json!({
        "location_id": location.location_id, "label": location.label,
        "folder": location.path, "kind": kind,
    }))
}

/// A window as `list_agents` shows it, including launch locations and CLI facts while connected.
fn window_row(window: &WindowInfo, addresses: &Addresses<'_>) -> Value {
    let mut row = json!({
        "id": window.window_id, "address": addresses.qualified(&window.window_id, &window.machine_id),
        "machine_id": window.machine_id,
        "name": window.name, "connected": window.connected,
    });
    if window.connected {
        row["locations"] = json!(
            window
                .locations
                .iter()
                .filter_map(location_row)
                .collect::<Vec<_>>()
        );
        row["clis"] = json!(window.clis);
    }
    row
}

/// The local window details and the parent query's agents and per-machine results.
/// A list longer than a result carries goes to a JSON file.
pub(super) fn list(client: &mut DaemonClient) -> Value {
    let nothing = "nothing was changed";
    let windows = match client.snapshot::<WindowsTopic>(NoArgs {}) {
        Ok(windows) => windows,
        Err(err) => return failed(&err, nothing),
    };
    let listed = match client.call::<AgentList>(MachineQueryArgs::default()) {
        Ok(listed) => listed,
        Err(err) => return failed(&err, nothing),
    };
    let identities: Vec<_> = listed
        .machines
        .iter()
        .map(|machine| MachineIdentity {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
        })
        .collect();
    let addresses = Addresses {
        here: &client.hello_result.machine_id,
        machines: &identities,
    };
    let windows: Vec<Value> = windows
        .iter()
        .map(|window| window_row(window, &addresses))
        .collect();
    let agents: Vec<Value> = listed
        .agents
        .iter()
        .map(|agent| agent_row(agent, &addresses))
        .collect();
    let machines: Vec<_> = listed
        .machines
        .into_iter()
        .map(MachineStateRow::from)
        .collect();
    let data = json!({ "windows": windows, "agents": agents, "machines": machines });
    let written = data.to_string();
    if written.chars().count() <= MAX_INLINE_CHARS {
        return envelope::success(data);
    }
    match result_files::write(ResultFile::Agents, &written) {
        Ok(path) => envelope::success(json!({ "file": path })),
        Err(err) => envelope::failure(
            "unavailable",
            format!(
                "the list is too long to return here, and its file could not be written: {err:#}"
            ),
        ),
    }
}

/// Stops an agent's CLI and answers once it ended; its record and screen stay. An agent that had
/// ended already is left as it is. A stop that ran out of time went out and goes on, as the process
/// group still gets SIGKILL at its deadline, but its end is not confirmed.
pub(super) fn stop(client: &mut DaemonClient, arguments: &Map<String, Value>) -> Value {
    let requested = text(arguments, "agent");
    let agent = match client.call::<AgentInspect>(AgentSelectorArgs {
        agent: requested.clone(),
    }) {
        Ok(inspected) => inspected.agent,
        Err(err) => {
            return agent_failed(
                client,
                &err,
                &requested,
                "nothing was stopped",
                Some(CONNECT_TIMEOUT),
            );
        }
    };
    if agent.process == ProcessState::Ended {
        return envelope::success(json!({}));
    }
    let id = exact_address(&agent);
    let err = match client.call::<AgentStop>(AgentSelectorArgs { agent: id.clone() }) {
        Ok(_) => return envelope::success(json!({})),
        Err(err) => err,
    };
    let unconfirmed = !agent.guest
        && err.downcast_ref::<ErrorBody>().is_some_and(|error| {
            error.data.reason == Reason::Unavailable && error.data.unavailable.is_none()
        });
    if unconfirmed {
        let message = format!(
            "{id} was told to stop, but its end is not confirmed; check it with list_agents"
        );
        return envelope::failure("stop_unconfirmed", message);
    }
    agent_failed(
        client,
        &err,
        &id,
        "whether the agent ended is not known; check it with list_agents",
        Some(CONNECT_TIMEOUT),
    )
}

#[cfg(test)]
mod tests {
    use facade_base::daemon::Kept;

    use super::*;

    #[test]
    fn agent_activity_and_reachability_are_independent() {
        let mut agent: AgentInfo = serde_json::from_value(json!({
            "agent_id": "a7", "name": "Ada", "cli": "fake",
            "cwd": "/work/app", "machine_id": "00000000-0000-4000-8000-000000000001",
            "windows": [], "location_id": "app", "process": "running",
            "created_at": "2026-11-17T00:00:00.000Z", "root": "a7", "yolo": false,
            "state": "waiting_for_you", "state_detail": {"kind": "question"},
            "tools_state": "available",
        }))
        .unwrap();
        let addresses = Addresses::default();
        let mut expected = agent_row(&agent, &addresses);
        assert_eq!(expected["state"], "waiting_for_you");
        assert_eq!(expected["waiting_for"], "question");
        assert!(expected.get("unreachable").is_none());

        agent.unreachable = true;
        expected["unreachable"] = json!(true);
        assert_eq!(agent_row(&agent, &addresses), expected);
    }

    #[test]
    fn a_start_failure_names_the_folder_of_its_kept_worktree() {
        let mut error = ErrorBody::new(Reason::WorktreeFailed, "Git failed");
        error.data.kept = Some(Kept {
            branch: Some("review".into()),
            path: Some("/work/review".into()),
        });
        let refused = start_refused(&error, &Addresses::default());
        assert_eq!(refused["reason"], "worktree_failed");
        assert_eq!(
            refused["data"]["kept"],
            json!({ "branch": "review", "folder": "/work/review" })
        );
        assert_eq!(
            refused["message"],
            "Git failed; the worktree it made stays at /work/review"
        );
        assert_eq!(
            error.data.kept.unwrap().path.as_deref(),
            Some("/work/review")
        );
    }

    #[test]
    fn a_start_reports_a_daemon_not_found_as_not_found() {
        let error = ErrorBody::new(
            Reason::NotFound,
            "the agent this start acts for is no longer listed",
        );
        let refused = start_refused(&error, &Addresses::default());
        assert_eq!(refused["reason"], "not_found", "{refused}");
        assert_eq!(refused["message"], error.message, "{refused}");
    }
}
