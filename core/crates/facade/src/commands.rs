//! The terminal commands: each uses the connection it is given and prints the result.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;
use std::time::SystemTime;

use facade_base::address::{
    display_machine_selector, exact_machine_selector, parse_machine_selector,
};
use facade_base::daemon::{
    AgentInfo, AgentInspect, AgentInspectResult, AgentRemove, AgentRename, AgentRenameArgs,
    AgentResume, AgentResumeArgs, AgentScreen, AgentScreenArgs, AgentSelectorArgs, AgentSend,
    AgentSendArgs, AgentStart, AgentStartWireArgs, AgentState, AgentStop, AgentType, AgentTypeArgs,
    DEFAULT_TERMINAL_SIZE, DeliveredVia, DeliveryFailure, DeliveryStatus, HelloResult, HowEnded,
    InputInfo, InputState, IntegrationAdd, IntegrationArgs, IntegrationInfo, IntegrationList,
    IntegrationListArgs, IntegrationRemove, Message, MessagesTopic, MessagesWatchArgs, PartState,
    TextWritten, ToolsState, WaitKind, WindowDeliveryFailure, WindowRef, typed_text_with_machines,
};
use facade_base::daemon_client::{DaemonClient, made_request_id};
use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::{
    AgentList, AgentListResult, MachineIdentity, MachineList, MachineQueryArgs, MachineQueryStatus,
    MachineStateRow,
};
use facade_base::operations::{NoArgs, Operation};
use facade_base::process::{EndReason, ProcessState};
use facade_base::time::parse_iso_time;
use facade_rules::integration::command_program;
use serde_json::{Value, json};
use unicode_width::UnicodeWidthStr;

use crate::errors::{Change, Problem, about_agent, about_change, about_send, about_start, bare_id};
use crate::{ExitText, Opening, Shown, single_line, table};

/// How a command prints: for the reader, or as JSON.
pub(crate) enum Format {
    Text,
    Json,
}

/// The three ways to list agents.
pub(crate) enum Listing {
    Table,
    Quiet,
    Json,
}

/// The available integration operations.
pub(crate) enum IntegrationAction {
    Add { cli: String },
    Remove { cli: String },
    List,
}

/// Starts an agent. Returns it for attachment, or prints its ID when detached.
pub(crate) fn start(
    client: &mut DaemonClient,
    name: Option<String>,
    prompt: Option<String>,
    (machine, folder): (Option<String>, Option<String>),
    command: Vec<String>,
    terminal: Option<(u16, u16)>,
) -> anyhow::Result<Option<Shown>> {
    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
    let on = machine.clone();
    let selected = if let Some(selector) = machine
        .as_deref()
        .and_then(|machine| parse_machine_selector(machine).ok())
    {
        let mut matches = machines(client)?
            .into_iter()
            .filter(|machine| selector.matches(machine));
        matches.next().filter(|_| matches.next().is_none())
    } else {
        None
    };
    let local = machine.is_none()
        || selected
            .as_ref()
            .is_some_and(|machine| machine.machine_id == client.hello_result.machine_id);
    // Pin a unique match so the folder and the start refer to the same machine even after a
    // rename. Let the daemon report an unresolved selector.
    let machine = selected
        .map(|machine| exact_machine_selector(&machine.machine_id))
        .or(machine);
    // v2 forwards an omitted remote folder as an empty cwd with cwd_is_default set.
    let cwd_is_default = !local && folder.is_none();
    let cwd = if local {
        match folder {
            Some(folder) => std::path::absolute(folder)?,
            None => std::env::current_dir()?,
        }
        .to_string_lossy()
        .into_owned()
    } else {
        folder.unwrap_or_default()
    };
    let args = AgentStartWireArgs {
        command,
        name,
        cwd,
        machine,
        cwd_is_default,
        window: None,
        initial_windows: None,
        location_source_window: None,
        env: environment(),
        cols,
        rows,
        prompt,
        call_id: None,
        result_message_id: None,
        result_message_machine_id: None,
        request_id: Some(made_request_id()),
        worktree: None,
        model: None,
        effort: None,
        session: None,
    };
    let (started, _) = client
        .call_with_request_id::<AgentStart>(args, false)
        .map_err(|error| match &on {
            Some(machine) => about_start(machine, error),
            None => error,
        })?;
    let here = client.hello_result.machine_id.clone();
    let shown = display_id(client, &started.agent);
    let opening = Opening::Started {
        name: started.agent.name.clone(),
    };
    Ok(show(&started.agent, &here, shown, opening, terminal))
}

/// Inspects the earlier run before resuming its session in a new run.
pub(crate) fn resume(
    client: &mut DaemonClient,
    agent: String,
    terminal: Option<(u16, u16)>,
) -> anyhow::Result<Option<Shown>> {
    let earlier = client
        .call::<AgentInspect>(AgentSelectorArgs {
            agent: agent.clone(),
        })
        .map_err(|error| about_agent(&agent, error))?;
    let here = client.hello_result.machine_id.clone();
    let remote = earlier.agent.machine_id != here;
    let exact = exact_id(&earlier.agent, &here);
    let id = shown_id(&earlier.agent);
    if earlier.agent.guest {
        return Err(Problem::Guest { id }.into());
    }
    if earlier.agent.process == ProcessState::Running {
        return Err(Problem::StillRunning { id }.into());
    }
    if earlier.rule.is_none() {
        return Err(Problem::PlainProgram { id }.into());
    }
    if earlier.agent.exit.and_then(|exit| exit.reason) == Some(EndReason::TerminalClosed) {
        eprintln!("warning: {id}'s earlier CLI may still be running because its terminal closed");
    }
    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
    let resumed = client
        .call::<AgentResume>(AgentResumeArgs {
            agent: exact,
            // The run on another machine takes that machine's login environment.
            env: if remote {
                BTreeMap::new()
            } else {
                environment()
            },
            cols,
            rows,
        })
        .map_err(|error| about_agent(&agent, error))?;
    let shown = display_id(client, &resumed);
    let opening = Opening::Resumed {
        name: resumed.name.clone(),
    };
    Ok(show(&resumed, &here, shown, opening, terminal))
}

/// Returns the agent to attach to, by its exact address, or prints its ID when detached.
fn show(
    agent: &AgentInfo,
    here: &str,
    shown: String,
    opening: Opening,
    terminal: Option<(u16, u16)>,
) -> Option<Shown> {
    if terminal.is_some() {
        return Some(Shown {
            agent: exact_id(agent, here),
            opening,
        });
    }
    println_or_end!("{shown}");
    None
}

/// The agent as the command line prints it, naming its machine where the record has no label.
fn display_id(client: &mut DaemonClient, agent: &AgentInfo) -> String {
    if agent.label.is_some() || agent.machine_id == client.hello_result.machine_id {
        return shown_id(agent);
    }
    format!(
        "{}@{}",
        agent.agent_id,
        machine_selector(client, &agent.machine_id)
    )
}

/// The agent as the command line prints it: `a3` here, `a17@gpu` on another machine.
fn shown_id(agent: &AgentInfo) -> String {
    agent
        .label
        .as_deref()
        .map_or(agent.agent_id.as_str(), |label| {
            label.trim_start_matches('#')
        })
        .to_string()
}

/// The agent as a later call names it: its ID here, its exact address on another machine.
fn exact_id(agent: &AgentInfo, here: &str) -> String {
    match agent.machine_id == here {
        true => agent.agent_id.clone(),
        false => agent.reference().exact_address(),
    }
}

/// Prints one row or one bare ID per agent, or the agent array as JSON.
pub(crate) fn list(client: &mut DaemonClient, listing: Listing) -> anyhow::Result<()> {
    let listed = client.call::<AgentList>(MachineQueryArgs { machine: None })?;
    if let Listing::Json = listing {
        let json = agent_list_json(listed)?;
        println_or_end!("{}", serde_json::to_string_pretty(&json)?);
        return Ok(());
    }
    for machine in &listed.machines {
        let why = match machine.status {
            MachineQueryStatus::Answered => continue,
            MachineQueryStatus::Unavailable => "it is unreachable",
            MachineQueryStatus::TimedOut => "it did not respond within 3 seconds",
            MachineQueryStatus::Error => "it failed",
        };
        eprintln!(
            "warning: could not list the agents on {}: {why}",
            single_line(&machine.name)
        );
    }
    let agents = listed.agents;
    match listing {
        Listing::Table => {
            let text = list_text(&agents, SystemTime::now());
            if text.is_empty() {
                eprintln!("No agents. Run 'facade start claude' to start one.");
            } else {
                println_or_end!("{text}");
            }
        }
        Listing::Quiet if !agents.is_empty() => println_or_end!("{}", quiet_text(&agents)),
        Listing::Quiet => {}
        Listing::Json => {}
    }
    Ok(())
}

/// Projects the agent records and the machine rows of a completed v2 list.
pub(crate) fn agent_list_json(listed: AgentListResult) -> serde_json::Result<Value> {
    let mut agents = serde_json::to_value(listed.agents)?;
    for agent in agents.as_array_mut().expect("agent list is an array") {
        name_agent_json_fields(agent);
    }
    let machines = listed
        .machines
        .into_iter()
        .map(|mut machine| {
            let short_id = std::mem::take(&mut machine.short_id);
            let mut row = serde_json::to_value(MachineStateRow::from(machine))?;
            row["short_id"] = Value::String(short_id);
            Ok(row)
        })
        .collect::<serde_json::Result<Vec<_>>>()?;
    Ok(json!({ "agents": agents, "machines": machines }))
}

pub(crate) fn inspect(
    client: &mut DaemonClient,
    agent: String,
    format: Format,
) -> anyhow::Result<()> {
    let inspected = client
        .call::<AgentInspect>(AgentSelectorArgs {
            agent: agent.clone(),
        })
        .map_err(|error| about_agent(&agent, error))?;
    match format {
        Format::Text => println_or_end!("{}", inspect_text(&inspected, SystemTime::now())),
        Format::Json => {
            let mut json = serde_json::to_value(inspected)?;
            name_agent_json_fields(&mut json["agent"]);
            println_or_end!("{}", serde_json::to_string_pretty(&json)?);
        }
    }
    Ok(())
}

/// Names the two CLI fields in a serialized v2 agent, keeping its field order and values.
fn name_agent_json_fields(agent: &mut Value) {
    let fields = agent.as_object_mut().expect("agent record is an object");
    *fields = std::mem::take(fields)
        .into_iter()
        .map(|(name, value)| {
            let name = match name.as_str() {
                "cwd" => "folder".into(),
                "said" => "last_input".into(),
                _ => name,
            };
            (name, value)
        })
        .collect();
}

/// Prints the requested number of screen and scrollback lines as plain text.
pub(crate) fn screen(client: &mut DaemonClient, agent: String, lines: u16) -> anyhow::Result<()> {
    let screen = client
        .call::<AgentScreen>(AgentScreenArgs {
            agent: agent.clone(),
            lines: Some(lines),
        })
        .map_err(|error| about_agent(&agent, error))?;
    if screen.line_count > 0 {
        println_or_end!("{}", facade_base::daemon::plain(&screen.text));
    }
    Ok(())
}

/// Types text, then Enter if asked, or presses the named keys.
pub(crate) fn type_input(
    client: &mut DaemonClient,
    agent: String,
    text: Option<String>,
    enter: bool,
    keys: Vec<String>,
) -> anyhow::Result<()> {
    client
        .call::<AgentType>(AgentTypeArgs {
            agent: agent.clone(),
            raw: None,
            text,
            enter,
            keys: (!keys.is_empty()).then_some(keys),
        })
        .map_err(|error| about_agent(&agent, error))?;
    Ok(())
}

pub(crate) fn send(
    client: &mut DaemonClient,
    to: String,
    text: String,
    reply_to: Option<String>,
) -> anyhow::Result<()> {
    let args = AgentSendArgs {
        to: to.clone(),
        text,
        reply_to,
        reply_to_machine_id: None,
        request_id: Some(made_request_id()),
        time_left_ms: None,
    };
    let here = client.hello_result.machine_id.clone();
    let (result, _) = client
        .call_with_request_id::<AgentSend>(args, false)
        .map_err(|error| match not_shown(&error, &here) {
            Some(problem) => problem.into(),
            None => about_send(&to, error),
        })?;
    let mut message = result.message;
    if let Some(reference) = message.message_ref.clone()
        && reference.machine_id != here
    {
        // A message to an agent on another machine is numbered there: m42@gpu to a17@gpu.
        let machine = machine_selector(client, &reference.machine_id);
        message.message_id = format!("{}@{machine}", message.message_id);
        if message.to != "human" {
            message.to = format!("{}@{machine}", message.to);
        }
    }
    let message = &message;
    if message.to != "human" {
        println_or_end!("{}", sent(message)?);
        return Ok(());
    }
    let id = &message.message_id;
    // Without the windows' outcome, the daemon ended before it saved them.
    let Some(windows) = result
        .windows
        .filter(|windows| !windows.delivered.is_empty())
    else {
        return Err(Problem::HumanUnconfirmed {
            message: id.clone(),
        }
        .into());
    };
    for window in &windows.delivered {
        println_or_end!(
            "{id} delivered to the human in {}",
            window_name(window, &here)
        );
    }
    for failure in &windows.not_delivered {
        eprintln!(
            "warning: {id} was not shown because {}",
            window_failure(failure, &here)
        );
    }
    for window in &windows.outcome_unknown {
        eprintln!(
            "warning: could not confirm that {} showed {id}",
            window_name(window, &here)
        );
    }
    Ok(())
}

/// The refusal of a message to the human that none of the sender's windows showed.
fn not_shown(error: &anyhow::Error, here: &str) -> Option<Problem> {
    let data = &error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ErrorBody>())?
        .data;
    let why: Vec<String> = match (&data.window_delivery, &data.windows) {
        (Some(delivery), _) => delivery
            .not_delivered
            .iter()
            .map(|failure| window_failure(failure, here))
            .chain(
                delivery
                    .outcome_unknown
                    .iter()
                    .map(|window| format!("{} may not have shown it", window_name(window, here))),
            )
            .collect(),
        (None, Some(windows)) if windows.is_empty() => return Some(Problem::InNoWindow),
        (None, Some(windows)) => windows
            .iter()
            .map(|failure| window_failure(failure, here))
            .collect(),
        (None, None) => return None,
    };
    Some(Problem::NotShown {
        why: why.join("; "),
    })
}

/// A window as the reader names it: `the terminal window` or `window w2`, with `@machine` where
/// another machine owns it.
fn window_name(window: &WindowRef, here: &str) -> String {
    let id = &window.window_id;
    let name = match id.as_str() {
        "terminal" => "the terminal window".to_string(),
        _ => format!("window {id}"),
    };
    match window.machine_id == here {
        true => name,
        false => format!("{name}@{}", window.machine_id),
    }
}

/// Why a window did not show the message: `window w2 is closed`.
fn window_failure(failure: &WindowDeliveryFailure, here: &str) -> String {
    let why = match failure.reason.as_str() {
        "window_disconnected" => "is closed",
        "not_watching" => "is not showing Facade messages",
        "machine_unavailable" => "is on a machine Facade could not connect to",
        reason => reason,
    };
    format!("{} {why}", window_name(&failure.window, here))
}

/// The identities in the daemon's machine table, including saved machines without a route.
fn machines(client: &mut DaemonClient) -> anyhow::Result<Vec<MachineIdentity>> {
    client.call::<MachineList>(NoArgs {}).map(|listed| {
        listed
            .machines
            .into_iter()
            .map(|machine| MachineIdentity {
                machine_id: machine.machine_id,
                name: machine.name,
            })
            .collect()
    })
}

/// How a reader names the machine `id` among `machines`: its name where unique, else `id:` and
/// enough of its ID.
fn selector_among(machines: &[MachineIdentity], id: &str) -> String {
    machines
        .iter()
        .find(|machine| machine.machine_id == id)
        .map(|machine| display_machine_selector(machine, machines))
        .unwrap_or_else(|| exact_machine_selector(id))
}

/// How a reader names the machine `id`.
fn machine_selector(client: &mut DaemonClient, id: &str) -> String {
    selector_among(&machines(client).unwrap_or_default(), id)
}

/// Prints and delivers up to 100 inbox messages as the recipient's terminal would show them.
pub(crate) fn messages(client: &mut DaemonClient) -> anyhow::Result<()> {
    let inbox = client.snapshot::<MessagesTopic>(MessagesWatchArgs::default())?;
    if inbox.messages.is_empty() {
        eprintln!("No messages waiting.");
    } else {
        let here = client.hello_result.machine_id.clone();
        let remote = |id: Option<&str>| id.is_some_and(|id| id != here);
        let machines = match inbox.messages.iter().any(|message| {
            remote(message.from_machine_id.as_deref())
                || remote(message.reply_to_machine_id.as_deref())
        }) {
            true => machines(client).unwrap_or_default(),
            false => Vec::new(),
        };
        let selector = |id: Option<&str>| {
            let id = id.filter(|id| *id != here)?;
            Some(selector_among(&machines, id))
        };
        let shown: Vec<String> = inbox
            .messages
            .iter()
            .map(|message| {
                typed_text_with_machines(
                    message,
                    selector(message.from_machine_id.as_deref()).as_deref(),
                    selector(message.reply_to_machine_id.as_deref()).as_deref(),
                )
            })
            .collect();
        println_or_end!("{}", shown.join("\n\n"));
    }
    Ok(())
}

pub(crate) fn rename(client: &mut DaemonClient, agent: String, name: String) -> anyhow::Result<()> {
    let renamed = client
        .call::<AgentRename>(AgentRenameArgs {
            agent: agent.clone(),
            name,
        })
        .map_err(|error| about_agent(&agent, error))?;
    println_or_end!("{} {}", shown_id(&renamed), single_line(&renamed.name));
    Ok(())
}

pub(crate) fn stop(
    client: &mut DaemonClient,
    agents: Vec<String>,
    report: &dyn Fn(&anyhow::Error) -> i32,
) -> anyhow::Result<i32> {
    Ok(change_agents::<AgentStop>(
        client,
        agents,
        Change::Stop,
        report,
    ))
}

pub(crate) fn remove(
    client: &mut DaemonClient,
    agents: Vec<String>,
    report: &dyn Fn(&anyhow::Error) -> i32,
) -> anyhow::Result<i32> {
    Ok(change_agents::<AgentRemove>(
        client,
        agents,
        Change::Remove,
        report,
    ))
}

/// Run one operation per argument. A service refusal leaves the connection usable.
fn change_agents<O: Operation<Args = AgentSelectorArgs>>(
    client: &mut DaemonClient,
    agents: Vec<String>,
    change: Change,
    report: &dyn Fn(&anyhow::Error) -> i32,
) -> i32 {
    let mut code = 0;
    for agent in agents {
        match client.call::<O>(AgentSelectorArgs {
            agent: agent.clone(),
        }) {
            Ok(_) => println_or_end!("{}", single_line(&agent)),
            Err(error) => {
                let refused = error.chain().any(|cause| cause.is::<ErrorBody>());
                report(&about_change(&agent, change, error));
                if !refused {
                    return 1;
                }
                code = 1;
            }
        }
    }
    code
}

pub(crate) fn integration(
    client: &mut DaemonClient,
    action: IntegrationAction,
    format: Format,
) -> anyhow::Result<()> {
    let env = environment();
    let removing = matches!(action, IntegrationAction::Remove { .. });
    let info = match action {
        IntegrationAction::Add { cli } => {
            client.call::<IntegrationAdd>(IntegrationArgs { cli, env })?
        }
        IntegrationAction::Remove { cli } => {
            client.call::<IntegrationRemove>(IntegrationArgs { cli, env })?
        }
        IntegrationAction::List => {
            let list = client.call::<IntegrationList>(IntegrationListArgs { env })?;
            match format {
                Format::Text => {
                    println_or_end!(
                        "{}",
                        integrations_text(&list.integrations, SystemTime::now())
                    );
                }
                Format::Json => println_or_end!("{}", serde_json::to_string_pretty(&list)?),
            }
            return Ok(());
        }
    };
    match format {
        Format::Text => {
            println_or_end!("{}", integration_text(&info, removing));
            for note in &info.notes {
                eprintln!("note: {}", note.trim_end_matches('.'));
            }
        }
        Format::Json => println_or_end!("{}", serde_json::to_string_pretty(&info)?),
    }
    Ok(())
}

pub(crate) fn status(
    home: &Path,
    reply: Option<&DaemonClient>,
    format: Format,
) -> anyhow::Result<()> {
    let hello = reply.map(|client| &client.hello_result);
    let version = facade_base::version();
    match format {
        Format::Text => {
            println_or_end!(
                "{}",
                status_text(home, hello, &version, &facade_base::build_id())
            );
            if hello.is_none() {
                eprintln!("Facade starts by itself when a command needs it.");
            }
        }
        Format::Json => {
            let value = match hello {
                Some(hello) => json!({
                    "running": true,
                    "home": home.to_string_lossy(),
                    "version": version,
                    "daemon": { "pid": hello.pid, "build": hello.build },
                    "keeper": hello.keeper,
                    "agents": hello.agent_count,
                }),
                None => json!({ "running": false, "home": home.to_string_lossy() }),
            };
            println_or_end!("{}", serde_json::to_string_pretty(&value)?);
        }
    }
    Ok(())
}

pub(crate) fn version(format: Format) -> anyhow::Result<()> {
    let version = facade_base::version();
    match format {
        Format::Text => println_or_end!("facade {version}"),
        Format::Json => println_or_end!(
            "{}",
            serde_json::to_string_pretty(&json!({ "version": version }))?
        ),
    }
    Ok(())
}

/// Pass the environment to the daemon to start or configure CLIs.
fn environment() -> BTreeMap<String, String> {
    let (variables, left_out) = facade_base::daemon_client::environment();
    if !left_out.is_empty() {
        eprintln!(
            "warning: omitted non-UTF-8 environment variables: {}",
            left_out.join(", ")
        );
    }
    variables
}

pub(crate) fn ago(at: SystemTime, now: SystemTime) -> String {
    let seconds = now.duration_since(at).unwrap_or_default().as_secs();
    let (count, unit) = match seconds {
        0..=59 => (seconds, "second"),
        60..=3599 => (seconds / 60, "minute"),
        3600..=7199 => return "about an hour ago".into(),
        7200..=86399 => (seconds / 3600, "hour"),
        86400..=1209599 => (seconds / 86400, "day"),
        _ => (seconds / 604800, "week"),
    };
    let plural = if count == 1 { "" } else { "s" };
    format!("{} {unit}{plural} ago", quantity(count))
}

/// Add grouping to quantities, leaving IDs, PIDs and dates as they are.
fn quantity(count: u64) -> String {
    let digits = count.to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

fn relative_time(time: &str, now: SystemTime) -> String {
    parse_iso_time(time).map_or_else(|| single_line(time), |at| ago(at, now))
}

fn detailed_time(time: &str, now: SystemTime) -> String {
    match parse_iso_time(time) {
        Some(at) => format!("{} ({} {} UTC)", ago(at, now), &time[..10], &time[11..19]),
        None => single_line(time),
    }
}

pub(crate) fn state_words(agent: &AgentInfo) -> String {
    match agent.state {
        AgentState::WaitingForYou => {
            match agent.state_detail.as_ref().and_then(|detail| detail.kind) {
                Some(WaitKind::Permission) => "waiting for you: permission".into(),
                Some(WaitKind::Question) => "waiting for you: question".into(),
                Some(WaitKind::Auth) => "waiting for you: sign-in".into(),
                _ => "waiting for you".into(),
            }
        }
        AgentState::JustDone => "turn finished".into(),
        AgentState::Ended => ended_words(agent),
        AgentState::Unrecognized => "unknown".into(),
        state => state.as_str().into(),
    }
}

fn ended_words(agent: &AgentInfo) -> String {
    if agent.state_detail.as_ref().and_then(|detail| detail.how) == Some(HowEnded::Stopped) {
        return "stopped".into();
    }
    match &agent.exit {
        Some(exit) if exit.code.is_some() => format!("exited: {}", ExitText(exit)),
        Some(exit) if exit.signal.is_some() => format!("ended by {}", ExitText(exit)),
        _ => "ended".into(),
    }
}

pub(crate) fn input_words(input: &InputInfo) -> String {
    let word = match input.state {
        InputState::Usable => "empty",
        InputState::Draft => "draft",
        InputState::Interaction => "menu or question",
        InputState::Unknown | InputState::Unrecognized => "unknown",
    };
    if let Some(hidden) = input.hidden {
        let above = quantity(hidden.above.into());
        let below = quantity(hidden.below.into());
        let lines = if hidden.above == 1 { "line" } else { "lines" };
        return format!("{word} ({above} more {lines} above, {below} below)");
    }
    word.into()
}

pub(crate) fn tools_words(agent: &AgentInfo) -> String {
    match agent.tools_state {
        ToolsState::NotInjected => "not provided".into(),
        ToolsState::Unavailable => match agent.tools_reason {
            Some(reason) => format!("unavailable: {}", reason.words()),
            None => "unavailable".into(),
        },
        state => state.as_str().into(),
    }
}

pub(crate) fn list_text(agents: &[AgentInfo], now: SystemTime) -> String {
    if agents.is_empty() {
        return String::new();
    }
    let rows: Vec<Vec<String>> = agents
        .iter()
        .map(|agent| {
            let cli = if agent.guest {
                format!("{} (guest)", agent.cli)
            } else {
                agent.cli.clone()
            };
            vec![
                shown_id(agent),
                agent.name.clone(),
                cli,
                state_words(agent),
                relative_time(&agent.created_at, now),
                agent.cwd.clone(),
            ]
        })
        .collect();
    table(&["ID", "NAME", "CLI", "STATE", "CREATED", "FOLDER"], &rows)
}

pub(crate) fn quiet_text(agents: &[AgentInfo]) -> String {
    agents.iter().map(shown_id).collect::<Vec<_>>().join("\n")
}

pub(crate) fn inspect_text(inspected: &AgentInspectResult, now: SystemTime) -> String {
    let agent = &inspected.agent;
    let mut lines = Vec::new();
    let mut field =
        |label: &str, value: &str| lines.push(format!("{label:<15}{}", single_line(value)));
    field("ID:", &shown_id(agent));
    field("Name:", &agent.name);
    let cli = if agent.guest {
        format!("{} (guest)", agent.cli)
    } else {
        agent.cli.clone()
    };
    field("CLI:", &cli);
    if !agent.guest {
        match inspected.rule.as_deref() {
            Some(rule) if rule != agent.cli => field("Kind:", rule),
            None => field("Kind:", "plain program"),
            Some(_) => {}
        }
    }
    field("Folder:", &agent.cwd);
    field("Created:", &detailed_time(&agent.created_at, now));
    if !agent.guest {
        field("Started by:", agent.creator.as_deref().unwrap_or("human"));
    }
    field("Process:", &process_words(agent, now));
    field(
        "YOLO:",
        if agent.yolo {
            "on: can address every agent"
        } else {
            "off"
        },
    );
    field("State:", &state_words(agent));
    if let Some(detail) = agent.state_detail.as_ref().and_then(|detail| {
        detail
            .text
            .as_deref()
            .or_else(|| detail.reason.map(|reason| reason.words()))
    }) {
        field("", detail);
    }
    field("Facade tools:", &tools_words(agent));
    field("Input box:", &input_words(&inspected.input));
    let last_input = match &agent.said {
        Some(said) => format!(
            "{}, {}: {}",
            said.from,
            detailed_time(&said.at, now),
            said.text
        ),
        None => "none".into(),
    };
    field("Last input:", &last_input);
    let session = agent.session.as_deref().unwrap_or(
        if agent.process == ProcessState::Running && !inspected.session_tracking {
            "none (not tracked)"
        } else {
            "none"
        },
    );
    field("Session:", session);
    lines.join("\n")
}

fn process_words(agent: &AgentInfo, now: SystemTime) -> String {
    if agent.guest {
        return "none (guest)".into();
    }
    match agent.process {
        ProcessState::Running => agent
            .pid
            .map_or_else(|| "running".into(), |pid| format!("running, pid {pid}")),
        ProcessState::Ended => {
            let end = ended_words(agent);
            match &agent.exit {
                Some(exit) => format!("{end}, {}", detailed_time(&exit.at, now)),
                None => end,
            }
        }
        ProcessState::Unknown => "unknown".into(),
    }
}

pub(crate) fn part_words(state: PartState) -> &'static str {
    match state {
        PartState::AsWritten => "up to date",
        PartState::Changed => "needs attention",
        PartState::Missing => "no Facade settings",
        PartState::Unknown => "unknown",
    }
}

pub(crate) fn integration_status(info: &IntegrationInfo) -> &'static str {
    if info
        .parts
        .iter()
        .any(|part| part.state == PartState::Unknown)
    {
        "unknown"
    } else if info
        .parts
        .iter()
        .all(|part| part.state == PartState::AsWritten)
    {
        "added"
    } else if info
        .parts
        .iter()
        .all(|part| part.state == PartState::Missing)
    {
        "not added"
    } else {
        "needs attention"
    }
}

pub(crate) fn integration_text(info: &IntegrationInfo, removing: bool) -> String {
    let cli = single_line(&info.cli);
    let mut text = if !removing {
        format!("Added Facade to {cli}.")
    } else if info
        .parts
        .iter()
        .all(|part| part.state == PartState::Missing)
    {
        format!("Removed Facade from {cli}.")
    } else {
        format!("Check {cli}'s settings to confirm removal.")
    };
    let command_label = command_program(&info.cli).map(|program| format!("{program} mcp"));
    let rows: Vec<(String, &str)> = info
        .parts
        .iter()
        .map(|part| {
            let label = if command_label.as_deref() == Some(&part.file)
                && let Ok(Some(rule)) = facade_rules::find(&info.cli)
            {
                format!("{} MCP servers", rule.display_name)
            } else {
                single_line(&part.file)
            };
            (label, part_words(part.state))
        })
        .collect();
    let width = rows
        .iter()
        .map(|(label, _)| label.width())
        .max()
        .unwrap_or_default();
    for (label, state) in rows {
        let _ = write!(
            text,
            "\n  {label}{:pad$}   {state}",
            "",
            pad = width - label.width()
        );
    }
    text
}

pub(crate) fn integrations_text(list: &[IntegrationInfo], now: SystemTime) -> String {
    let rows: Vec<Vec<String>> = list
        .iter()
        .map(|info| {
            vec![
                info.cli.clone(),
                integration_status(info).into(),
                info.added_at
                    .as_deref()
                    .map_or_else(String::new, |time| relative_time(time, now)),
            ]
        })
        .collect();
    table(&["CLI", "STATE", "ADDED"], &rows)
}

pub(crate) fn status_text(
    home: &Path,
    hello: Option<&HelloResult>,
    version: &str,
    build: &str,
) -> String {
    let home = single_line(&home.to_string_lossy());
    let Some(hello) = hello else {
        return format!("Facade did not respond.\n  Home:      {home}");
    };
    let service = |pid, service_build: &str| {
        if service_build == build {
            format!("pid {pid}")
        } else {
            format!("pid {pid} ({service_build})")
        }
    };
    let daemon = service(hello.pid, &hello.build);
    let keeper = hello.keeper.as_ref().map_or_else(
        || "none".into(),
        |keeper| service(keeper.pid, &keeper.build),
    );
    let agents = quantity(hello.agent_count as u64);
    format!(
        "Facade is running.\n  Home:      {home}\n  Version:   {version}\n  Daemon:    {daemon}\n  Keeper:    {keeper}\n  Agents:    {agents}"
    )
}

/// Word a send result using the recipient and delivery facts returned by the service.
pub(crate) fn sent(message: &Message) -> Result<String, Problem> {
    let id = &message.message_id;
    let to = &message.to;
    let delivery = &message.delivery;
    match (delivery.status, delivery.delivered_via) {
        (DeliveryStatus::Pending, _) => Ok(format!("{id} waiting in {to}'s inbox")),
        (DeliveryStatus::Success, Some(DeliveredVia::Read)) => Ok(format!("{id} read by {to}")),
        (DeliveryStatus::Success, _) => Ok(format!("{id} delivered to {to}")),
        _ if delivery.reason == Some(DeliveryFailure::SubmissionUnconfirmed) => {
            Err(Problem::Unconfirmed {
                message: id.clone(),
                to: to.clone(),
                progress: delivery.failure_words(to),
            })
        }
        _ if delivery.reason == Some(DeliveryFailure::Ended)
            && delivery.text_written == TextWritten::None
            && let Some(agent) = bare_id(to) =>
        {
            Err(Problem::Ended { agent })
        }
        _ => Err(Problem::NotDelivered {
            message: id.clone(),
            to: to.clone(),
            why: delivery.failure_words(to),
        }),
    }
}
