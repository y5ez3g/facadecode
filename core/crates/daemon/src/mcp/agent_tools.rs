//! The agent tools: `start_agent` starts a CLI in a folder of a window, `list_agents` lists the
//! windows and the agents, and `stop_agent` stops one.

use std::path::Path;

use facade_base::daemon::{
    AgentArgs, AgentInfo, AgentInspect, AgentStart, AgentState, AgentStop, AgentsTopic,
    DEFAULT_TERMINAL_SIZE, StartArgs, TERMINAL_WINDOW, WaitKind, WindowInfo, WindowsTopic,
    Worktree, check_message_text,
};
use facade_base::daemon_client::DaemonClient;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::operations::NoArgs;
use facade_base::process::ProcessState;
use serde_json::{Map, Value, json};

use super::daemon_calls::failed;
use super::envelope::{self, MAX_INLINE_CHARS};
use super::result_files::{self, ResultFile};
use super::schema::Problems;
use super::tool_calls::{ToolCall, optional, text};

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

/// The folders a window's agents can work in: its locations' paths, worktrees included, each once.
fn folders_of(window: &WindowInfo) -> Vec<&str> {
    let mut folders = Vec::new();
    for location in &window.locations {
        if !folders.contains(&location.path.as_str()) {
            folders.push(location.path.as_str());
        }
    }
    folders
}

/// The CLIs that can start in a window now.
fn available_clis(window: &WindowInfo) -> Vec<&str> {
    window
        .clis
        .iter()
        .filter(|known| known.available)
        .map(|known| known.cli.as_str())
        .collect()
}

/// Why `cli` cannot start in `window`, where it cannot; `nothing` says nothing was started.
fn start_problem(window: &WindowInfo, cli: &str, path: &str, nothing: &str) -> Option<Value> {
    let id = &window.window_id;
    if !window.connected {
        let message = format!(
            "window {id} is not there now: its editor is closed or has lost its connection; \
             {nothing}"
        );
        return Some(envelope::failure("unavailable", message));
    }
    if let Some(problem) = &window.settings_problem {
        let message = format!("{problem}; {nothing}; correct the settings file, then start again");
        return Some(envelope::failure("configuration_invalid", message));
    }
    let known = window.clis.iter().find(|known| known.cli == cli);
    if let Some(problem) = known
        .filter(|known| !known.available)
        .and_then(|known| known.problem.as_deref())
    {
        let problem = problem.trim_end_matches(&format!("; {nothing}"));
        let message = format!("{cli} cannot start in window {id}: {problem}; {nothing}");
        return Some(envelope::failure("unavailable", message));
    }
    if !known.is_some_and(|known| known.available) {
        let message = format!(
            "window {id} starts no CLI {cli}; {nothing}; it starts {}",
            available_clis(window).join(", ")
        );
        return Some(envelope::failure("invalid_argument", message));
    }
    // The terminal window starts an agent in any folder.
    let folders = folders_of(window);
    if *id != TERMINAL_WINDOW && !folders.contains(&path) {
        let message = format!(
            "window {id} has no folder {path}; {nothing}; its folders are {}",
            folders.join(", ")
        );
        return Some(envelope::failure("invalid_argument", message));
    }
    None
}

/// Starts a CLI in a folder of a window for `me`, the agent the server acts for, at `me`'s terminal
/// size, first making a worktree there where `worktree` names a branch. The daemon gives the new
/// agent `me`'s environment. Answers once the new agent's CLI runs; its prompt, where one was given,
/// owes `me` a 🔔 result that names the call. The relay's request ID makes a start the relay gives
/// a second daemon answer what the first did.
pub(super) fn start(
    client: &mut DaemonClient,
    me: &str,
    arguments: &Map<String, Value>,
    call: &ToolCall,
) -> Value {
    let nothing = "nothing was started";
    let me = match client.call::<AgentInspect>(AgentArgs {
        agent: me.to_string(),
    }) {
        Ok(inspected) => inspected.agent,
        Err(err) => return failed(&err, nothing),
    };
    let windows = match client.snapshot::<WindowsTopic>(NoArgs {}) {
        Ok(windows) => windows,
        Err(err) => return failed(&err, nothing),
    };
    let (window_id, cli) = (text(arguments, "window"), text(arguments, "cli"));
    let Some(window) = windows.iter().find(|window| window.window_id == window_id) else {
        let ids: Vec<&str> = windows
            .iter()
            .map(|window| window.window_id.as_str())
            .collect();
        let message = format!(
            "no window {window_id}; {nothing}; the windows are {}",
            ids.join(", ")
        );
        return envelope::failure("invalid_argument", message);
    };
    let path = Path::new(&me.cwd)
        .join(text(arguments, "path"))
        .to_string_lossy()
        .into_owned();
    if let Some(problem) = start_problem(window, &cli, &path, nothing) {
        return problem;
    }
    let worktree = optional(arguments, "worktree").map(|branch| Worktree {
        branch,
        base_ref: "HEAD".to_string(),
    });
    // A guest has no terminal of Facade's to size the new one by.
    let (cols, rows) = DEFAULT_TERMINAL_SIZE;
    let start = StartArgs {
        command: vec![cli],
        name: optional(arguments, "name"),
        cwd: path,
        window_id: Some(window_id),
        env: Default::default(),
        cols: me.cols.unwrap_or(cols),
        rows: me.rows.unwrap_or(rows),
        prompt: optional(arguments, "prompt"),
        call_id: Some(call.id.clone()),
        request_id: Some(call.request_id.clone()),
        worktree,
        model: optional(arguments, "model"),
        effort: optional(arguments, "effort"),
        session: None,
    };
    let err = match client.call_with_request_id::<AgentStart>(start, true) {
        Ok((started, _)) => {
            let agent = started.agent;
            return envelope::success(json!({
                "id": format!("#{}", agent.agent_id), "name": agent.name, "path": agent.cwd,
                "window": agent.window_id,
            }));
        }
        Err(err) => err,
    };
    match err.downcast_ref::<ErrorBody>() {
        Some(error) => start_refused(error),
        None => failed(
            &err,
            "whether the agent started is not known: list_agents lists it if it did",
        ),
    }
}

/// A start the daemon refused, saying where a worktree it made stays. A window or folder it does
/// not find is the caller's argument.
fn start_refused(error: &ErrorBody) -> Value {
    let mut refused = envelope::refusal(error);
    let kept_worktree = error
        .data
        .kept
        .as_ref()
        .and_then(|kept| kept.path.as_deref());
    if let Some(path) = kept_worktree {
        refused["message"] = json!(format!(
            "{}; the worktree it made stays at {path}",
            error.message
        ));
    }
    if error.data.reason == Reason::NotFound {
        refused["reason"] = json!("invalid_argument");
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

/// An agent as `list_agents` shows it: who and where it is, what it is doing, what it waits for
/// while it waits for the person, and who started it.
fn agent_row(agent: &AgentInfo) -> Value {
    let state = state_word(agent);
    let mut row = json!({
        "id": format!("#{}", agent.agent_id), "name": agent.name, "cli": agent.cli,
        "window": agent.window_id, "path": agent.cwd, "state": state,
    });
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
        Some(creator) => format!("#{creator}"),
        None => "#human".to_string(),
    };
    row["creator"] = json!(creator);
    row
}

/// A window as `list_agents` shows it: the CLIs that can start there and, but for the terminal
/// window, where any folder will do, the folders its agents can work in.
fn window_row(window: &WindowInfo) -> Value {
    let mut row = json!({ "id": window.window_id, "name": window.label });
    if window.window_id != TERMINAL_WINDOW {
        row["folders"] = json!(folders_of(window));
    }
    row["clis"] = json!(available_clis(window));
    row
}

/// The windows on this computer that are there, each with its folders and CLIs, and the agents in
/// the caller's reach, ended ones included, oldest first. A list longer than a result carries goes
/// to a JSON file.
pub(super) fn list(client: &mut DaemonClient) -> Value {
    let nothing = "nothing was changed";
    let windows = match client.snapshot::<WindowsTopic>(NoArgs {}) {
        Ok(windows) => windows,
        Err(err) => return failed(&err, nothing),
    };
    let mut agents = match client.snapshot::<AgentsTopic>(NoArgs {}) {
        Ok(agents) => agents,
        Err(err) => return failed(&err, nothing),
    };
    agents.sort_by_key(|agent| {
        agent
            .agent_id
            .strip_prefix('a')
            .and_then(|number| number.parse::<u64>().ok())
    });
    let windows: Vec<Value> = windows
        .iter()
        .filter(|window| window.connected)
        .map(window_row)
        .collect();
    let agents: Vec<Value> = agents.iter().map(agent_row).collect();
    let data = json!({ "windows": windows, "agents": agents });
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
    let agent = match client.call::<AgentInspect>(AgentArgs {
        agent: text(arguments, "agent"),
    }) {
        Ok(inspected) => inspected.agent,
        Err(err) => return failed(&err, "nothing was stopped"),
    };
    if agent.process == ProcessState::Ended {
        return envelope::success(json!({}));
    }
    let id = format!("#{}", agent.agent_id);
    let err = match client.call::<AgentStop>(AgentArgs {
        agent: agent.agent_id,
    }) {
        Ok(_) => return envelope::success(json!({})),
        Err(err) => err,
    };
    let unconfirmed = err
        .downcast_ref::<ErrorBody>()
        .is_some_and(|error| error.data.reason == Reason::Unavailable);
    if unconfirmed {
        let message = format!(
            "{id} was told to stop, but its end is not confirmed; check it with list_agents"
        );
        return envelope::failure("stop_unconfirmed", message);
    }
    failed(
        &err,
        "whether the agent ended is not known; check it with list_agents",
    )
}
