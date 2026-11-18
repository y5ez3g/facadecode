//! The terminal commands that call the daemon: each one makes its protocol call on the connection
//! it is given and prints the answer for the person, as text or JSON.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use facade_base::address::{display_machine_selector, exact_machine_selector};
use facade_base::daemon::{
    AgentArgs, AgentInfo, AgentInspect, AgentRemove, AgentRename, AgentResume, AgentScreen,
    AgentSend, AgentStart, AgentState, AgentStop, AgentType, DEFAULT_TERMINAL_SIZE, DeliveredVia,
    DeliveryStatus, InspectResult, IntegrationAdd, IntegrationArgs, IntegrationInfo,
    IntegrationList, IntegrationRemove, IntegrationsArgs, MessagesTopic, MessagesWatchArgs,
    PartState, RenameArgs, ResumeArgs, Said, ScreenArgs, SendArgs, StartArgs, StateReason,
    TypeArgs, WindowDeliveryFailure, WindowRef, display_name, typed_text_with_machines,
};
use facade_base::daemon_client::{DaemonClient, made_request_id};
use facade_base::jsonrpc::ErrorBody;
use facade_base::machine::{
    AgentList, AgentRef, MachineIdentity, MachineList, MachineQueryArgs, MachineQueryStatus,
    MessageRef,
};
use facade_base::operations::NoArgs;
use facade_base::process::EndReason;
use unicode_width::UnicodeWidthStr;

use crate::ExitText;

/// The options before the CLI's name, followed by the CLI's name and arguments.
pub(crate) struct StartWords {
    name: Option<String>,
    prompt: Option<String>,
    machine: Option<String>,
    cwd: Option<String>,
    command: Vec<String>,
}

/// Splits `facade start`'s words into its own options and the CLI's command line. Words it cannot
/// use fail here, before any daemon is reached.
pub(crate) fn start_words(command_line: Vec<String>) -> anyhow::Result<StartWords> {
    let mut start = StartWords {
        name: None,
        prompt: None,
        machine: None,
        cwd: None,
        command: Vec::new(),
    };
    let mut words = command_line.into_iter();
    while let Some(word) = words.next() {
        let (option, value) = match word.split_once('=') {
            Some((option, value)) if word.starts_with("--") => (option, Some(value.to_string())),
            _ => (word.as_str(), None),
        };
        let (slot, missing) = match option {
            "--name" => (&mut start.name, "--name requires an agent name"),
            "--prompt" => (
                &mut start.prompt,
                "--prompt requires the agent's first message",
            ),
            "--on" => (&mut start.machine, "--on requires a machine name or ID"),
            "--cwd" => (&mut start.cwd, "--cwd requires a directory on the machine"),
            _ if word.starts_with('-') => anyhow::bail!(
                "{word} is not an option of facade start. Use --name, --prompt, --on, or --cwd \
                 before the CLI's name. Put the CLI's own options after its name"
            ),
            _ => {
                anyhow::ensure!(
                    start.cwd.is_none() || start.machine.is_some(),
                    "--cwd requires --on"
                );
                start.command.push(word);
                start.command.extend(words);
                return Ok(start);
            }
        };
        *slot = Some(match value {
            Some(value) => value,
            None => words.next().ok_or_else(|| anyhow::anyhow!(missing))?,
        });
    }
    anyhow::bail!("specify a CLI program, for example: facade start claude")
}

/// Starts an agent. With the person's terminal, says how to detach and returns the agent to attach
/// to; without one, prints the agent and its process.
pub(crate) fn start(
    client: &mut DaemonClient,
    words: StartWords,
    terminal: Option<(u16, u16)>,
) -> anyhow::Result<Option<String>> {
    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
    let cwd_is_default = words.cwd.is_none();
    let cwd = match words.cwd {
        Some(cwd) => cwd,
        None => std::env::current_dir()?.to_string_lossy().into_owned(),
    };
    let args = StartArgs {
        command: words.command,
        name: words.name,
        machine: words.machine,
        cwd,
        cwd_is_default,
        window: None,
        initial_windows: None,
        location_source_window: None,
        env: environment(),
        cols,
        rows,
        prompt: words.prompt,
        call_id: None,
        result_message_id: None,
        result_message_machine_id: None,
        // Where a newer Facade taking over cuts the start off, its request ID repeats it, and the
        // answer says what it did.
        request_id: Some(made_request_id()),
        worktree: None,
        model: None,
        effort: None,
        session: None,
    };
    let (started, _) = client.call_with_request_id::<AgentStart>(args, false)?;
    Ok(announce(
        &started.agent,
        &client.hello_result.machine_id,
        "started",
        terminal,
    ))
}

/// Resumes an agent's session in a new run, as `start` does, and warns first when its earlier
/// CLI may still be running.
pub(crate) fn resume(
    client: &mut DaemonClient,
    agent: String,
    terminal: Option<(u16, u16)>,
) -> anyhow::Result<Option<String>> {
    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
    let earlier = client.call::<AgentInspect>(AgentArgs { agent })?.agent;
    let local_machine_id = &client.hello_result.machine_id;
    let address = record_address(&earlier, local_machine_id);
    let env = if earlier.machine_id == *local_machine_id {
        environment()
    } else {
        BTreeMap::new()
    };
    if earlier.exit.as_ref().and_then(|exit| exit.reason) == Some(EndReason::TerminalClosed) {
        eprintln!(
            "facade: {address}'s earlier CLI may still be running: its terminal closed while no \
             Facade service held it"
        );
    }
    let resumed = client.call::<AgentResume>(ResumeArgs {
        agent: address,
        env,
        cols,
        rows,
    })?;
    Ok(announce(
        &resumed,
        &client.hello_result.machine_id,
        "resumed",
        terminal,
    ))
}

/// The local record's number or the remote record's exact address.
fn record_address(agent: &AgentInfo, local_machine_id: &str) -> String {
    if agent.machine_id == local_machine_id {
        return format!("#{}", agent.agent_id);
    }
    agent.reference().exact_address()
}

/// Tells the person an agent's run began. Without their terminal the agent keeps running alone,
/// and its address is all they need; with it, the agent comes back to be attached to.
fn announce(
    agent: &AgentInfo,
    local_machine_id: &str,
    began: &str,
    terminal: Option<(u16, u16)>,
) -> Option<String> {
    let address = record_address(agent, local_machine_id);
    if terminal.is_none() {
        println_or_end!("{address}{}", pid_of(agent));
        return None;
    }
    eprintln!(
        "[facade: {address} {name} {began}. Ctrl-] detaches and the agent keeps running. Reconnect \
         with `facade attach '{address}'`]",
        name = display_name(&agent.name),
    );
    Some(address)
}

/// How a command prints its answer: for the person, or as the protocol's JSON (`--json`).
pub(crate) enum Format {
    Text,
    Json,
}

/// Lists agents by running machine and reports the outcome of each machine's query.
pub(crate) fn list(client: &mut DaemonClient, format: Format) -> anyhow::Result<()> {
    let listed = client.call::<AgentList>(MachineQueryArgs { machine: None })?;
    if let Format::Json = format {
        println_or_end!("{}", serde_json::to_string_pretty(&listed)?);
        return Ok(());
    }
    let local = &client.hello_result.machine_id;
    for machine in &listed.machines {
        let state = match machine.status {
            MachineQueryStatus::Answered => "answered",
            MachineQueryStatus::Unavailable => "unreachable",
            MachineQueryStatus::TimedOut => "timed out",
            MachineQueryStatus::Error => "error",
        };
        let at = machine
            .answered_at
            .as_deref()
            .map_or_else(String::new, |at| format!(" at {at}"));
        let build = machine
            .build
            .as_deref()
            .map_or_else(String::new, |build| format!(" · Facade {build}"));
        println_or_end!(
            "{} (id:{}){build} · {state}{at}",
            display_name(&machine.name),
            machine.short_id,
        );
        if machine.status == MachineQueryStatus::Answered {
            let agents: Vec<_> = listed
                .agents
                .iter()
                .filter(|agent| agent.machine_id == machine.machine_id)
                .collect();
            print_agent_rows(&agents, local);
        }
    }
    Ok(())
}

fn print_agent_rows(agents: &[&AgentInfo], local: &str) {
    if agents.is_empty() {
        println_or_end!("No agents.");
        return;
    }
    let rows: Vec<[String; 4]> = agents
        .iter()
        .map(|agent| {
            [
                agent
                    .label
                    .clone()
                    .unwrap_or_else(|| record_address(agent, local)),
                display_name(&agent.name),
                agent.cli.clone(),
                state_of(agent),
            ]
        })
        .collect();
    // Each column is as wide as its widest cell, so a long name or state shifts no other column.
    let mut widths = [0; 4];
    for row in &rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = cell.width().max(*width);
        }
    }
    for (agent, row) in agents.iter().zip(&rows) {
        let mut line = String::new();
        for (cell, width) in row.iter().zip(widths) {
            let _ = write!(line, "{cell}{:pad$} ", "", pad = width - cell.width());
        }
        let process = if agent.guest {
            "guest".to_string()
        } else {
            agent
                .pid
                .map(|pid| format!("pid {pid}"))
                .unwrap_or_default()
        };
        println_or_end!("{line}{process:<11} {}", agent.cwd);
        if let Some(text) = agent.state_detail.as_ref().and_then(|d| d.text.as_ref()) {
            println_or_end!("       {text}");
        }
        if let Some(said) = &agent.said {
            println_or_end!("       {} said: {}", speaker(said), said.text);
        }
        let windows: Vec<_> = agent.windows.iter().map(window_text).collect();
        if !windows.is_empty() {
            println_or_end!("       Windows {}", windows.join(", "));
        }
    }
}

/// Prints one agent in full: one fact a line, or the protocol's JSON.
pub(crate) fn inspect(
    client: &mut DaemonClient,
    agent: String,
    format: Format,
) -> anyhow::Result<()> {
    let inspected = client.call::<AgentInspect>(AgentArgs { agent })?;
    match format {
        Format::Json => println_or_end!("{}", serde_json::to_string_pretty(&inspected)?),
        Format::Text => print_inspection(&inspected, &client.hello_result.machine_id),
    }
    Ok(())
}

/// Prints an agent's screen as plain text, the last `lines` of it when given.
pub(crate) fn screen(
    client: &mut DaemonClient,
    agent: String,
    lines: Option<u16>,
) -> anyhow::Result<()> {
    // The daemon renders the screen, so this needs no terminal parser.
    let screen = client.call::<AgentScreen>(ScreenArgs { agent, lines })?;
    if screen.line_count > 0 {
        println_or_end!("{}", facade_base::daemon::plain(&screen.text));
    }
    Ok(())
}

/// `facade type`: types text, then Enter if asked, or presses the named keys, into an agent.
pub(crate) fn type_input(
    client: &mut DaemonClient,
    agent: String,
    text: Option<String>,
    enter: bool,
    keys: Vec<String>,
) -> anyhow::Result<()> {
    client.call::<AgentType>(TypeArgs {
        agent,
        raw: None,
        text,
        enter,
        keys: (!keys.is_empty()).then_some(keys),
    })?;
    Ok(())
}

/// Sends a message and says how it reached the recipient; one that did not reach it is an error.
pub(crate) fn send(
    client: &mut DaemonClient,
    to: String,
    text: String,
    reply_to: Option<String>,
) -> anyhow::Result<()> {
    let args = SendArgs {
        to,
        text,
        reply_to,
        reply_to_machine_id: None,
        request_id: Some(made_request_id()),
        time_left_ms: None,
    };
    let local = client.hello_result.machine_id.clone();
    let (sent, _) = client
        .call_with_request_id::<AgentSend>(args, false)
        .inspect_err(|error| {
            let Some(body) = error.downcast_ref::<ErrorBody>() else {
                return;
            };
            if let Some(reference) = &body.data.message_ref {
                eprintln!("facade: Message {}", message_address(reference, &local));
            }
            if let Some(delivery) = &body.data.window_delivery {
                for failure in &delivery.not_delivered {
                    eprintln!("facade: {}", window_failure(failure));
                }
                for window in &delivery.outcome_unknown {
                    eprintln!("facade: {}", window_outcome_unknown(window));
                }
            } else if let Some(windows) = &body.data.windows {
                for failure in windows {
                    eprintln!("facade: {}", window_failure(failure));
                }
            }
        })?;
    let message = sent.message;
    let id = match &message.message_ref {
        Some(reference) => message_address(reference, &local),
        None => format!("#{}", message.message_id),
    };
    let to = match &message.message_ref {
        Some(reference) if reference.machine_id != local && message.to != "human" => AgentRef {
            machine_id: reference.machine_id.clone(),
            agent_id: message.to.clone(),
        }
        .exact_address(),
        _ => format!("#{}", message.to),
    };
    if let Some(windows) = sent.windows {
        println_or_end!("{id} was handed to these window subscriptions");
        for window in windows.delivered {
            println_or_end!("  {}", window_text(&window));
        }
        for failure in windows.not_delivered {
            println_or_end!("{}", window_failure(&failure));
        }
        for window in windows.outcome_unknown {
            println_or_end!("{}", window_outcome_unknown(&window));
        }
        return Ok(());
    }
    if message.to == "human" {
        if message.delivery.status == DeliveryStatus::Pending && sent.repeated {
            anyhow::bail!("delivery outcome is unknown for {id} to #human")
        }
        anyhow::bail!("missing window delivery receipt for {id} to #human");
    }
    match (message.delivery.status, message.delivery.delivered_via) {
        // A guest takes its messages at its next turn.
        (DeliveryStatus::Pending, _) => println_or_end!("{id} waits for {to}'s next turn"),
        (DeliveryStatus::Success, Some(DeliveredVia::Read)) => {
            println_or_end!("{id} was read by {to}")
        }
        (DeliveryStatus::Success, _) => println_or_end!("{id} was typed into {to}"),
        _ => anyhow::bail!("{id} to {to}: {}", message.delivery.failure_words(&to)),
    }
    Ok(())
}

fn message_address(reference: &MessageRef, local: &str) -> String {
    if reference.machine_id == local {
        return format!("#{}", reference.message_id);
    }
    reference.exact_address()
}

/// Identifies a window by its logical ID and machine.
fn window_text(window: &WindowRef) -> String {
    format!(
        "window {} on machine {}",
        display_name(&window.window_id),
        display_name(&window.machine_id)
    )
}

/// Why the message could not be handed to this window.
fn window_failure(failure: &WindowDeliveryFailure) -> String {
    let reason = match failure.reason.as_str() {
        "machine_unavailable" => "machine is unreachable",
        "window_disconnected" => "window is disconnected",
        "not_watching" => "window has no active messages subscription",
        reason => reason,
    };
    format!(
        "Could not hand the message to {} ({})",
        window_text(&failure.window),
        display_name(reason)
    )
}

fn window_outcome_unknown(window: &WindowRef) -> String {
    format!("Delivery outcome is unknown for {}", window_text(window))
}

/// Prints the messages waiting for the agent the connection speaks for, as its terminal would show
/// them; reading them delivers them.
pub(crate) fn messages(client: &mut DaemonClient) -> anyhow::Result<()> {
    // A page holds up to 100; the rest wait for the next read.
    let inbox = client.snapshot::<MessagesTopic>(MessagesWatchArgs::default())?;
    let local = client.hello_result.machine_id.clone();
    let remote = |id: Option<&str>| id.is_some_and(|id| id != local);
    let has_remote_messages = inbox.messages.iter().any(|message| {
        remote(message.from_machine_id.as_deref()) || remote(message.reply_to_machine_id.as_deref())
    });
    // The snapshot already delivered these messages. Fall back to exact IDs if the lookup fails.
    let machines: Vec<_> =
        if has_remote_messages && let Ok(listed) = client.call::<MachineList>(NoArgs {}) {
            listed
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
    let selector = |id: Option<&str>| {
        let id = id.filter(|id| *id != local)?;
        Some(
            machines
                .iter()
                .find(|machine| machine.machine_id == id)
                .map(|machine| display_machine_selector(machine, &machines))
                .unwrap_or_else(|| exact_machine_selector(id)),
        )
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
    if !shown.is_empty() {
        println_or_end!("{}", shown.join("\n\n"));
    }
    Ok(())
}

/// Renames an agent and prints it with its new name.
pub(crate) fn rename(client: &mut DaemonClient, agent: String, name: String) -> anyhow::Result<()> {
    let renamed = client.call::<AgentRename>(RenameArgs { agent, name })?;
    println_or_end!(
        "{} {}",
        record_address(&renamed, &client.hello_result.machine_id),
        display_name(&renamed.name)
    );
    Ok(())
}

/// Stops an agent's run.
pub(crate) fn stop(client: &mut DaemonClient, agent: String) -> anyhow::Result<()> {
    client.call::<AgentStop>(AgentArgs { agent })?;
    Ok(())
}

/// Removes an ended agent.
pub(crate) fn remove(client: &mut DaemonClient, agent: String) -> anyhow::Result<()> {
    client.call::<AgentRemove>(AgentArgs { agent })?;
    Ok(())
}

#[derive(clap::Subcommand)]
pub(crate) enum IntegrationAction {
    /// Write Facade's entries for a CLI: claude, codex, opencode, pi, muse or agy. Prints each
    /// file's state.
    Add { cli: String },
    /// Take Facade's entries for a CLI out. Prints each file's state, and any of Facade's entries
    /// that stay because they changed.
    Remove { cli: String },
    /// Print, for each CLI, whether its configuration holds Facade's entries as they would be
    /// written now.
    List,
}

/// Adds, removes or lists Facade's entries in the CLIs' configurations, and prints each CLI's.
pub(crate) fn integration(
    client: &mut DaemonClient,
    action: IntegrationAction,
) -> anyhow::Result<()> {
    let env = environment();
    let integrations = match action {
        IntegrationAction::Add { cli } => {
            vec![client.call::<IntegrationAdd>(IntegrationArgs { cli, env })?]
        }
        IntegrationAction::Remove { cli } => {
            vec![client.call::<IntegrationRemove>(IntegrationArgs { cli, env })?]
        }
        IntegrationAction::List => {
            client
                .call::<IntegrationList>(IntegrationsArgs { env })?
                .integrations
        }
    };
    integrations.iter().for_each(print_integration);
    Ok(())
}

/// Prints the Facade that answered: its build, its daemon and agents, and its keeper.
pub(crate) fn status(client: &DaemonClient) {
    let hello = &client.hello_result;
    let daemon = format!(
        "Facade {}: daemon pid {} with {} agents",
        hello.build, hello.pid, hello.agents
    );
    match &hello.keeper {
        Some(keeper) => println_or_end!("{daemon}, keeper pid {} ({})", keeper.pid, keeper.build),
        None => println_or_end!("{daemon}; no keeper is running"),
    }
}

/// This process's environment, for the daemon to start or configure CLIs with. Variables that are
/// not UTF-8 cannot travel, and stderr names them.
fn environment() -> BTreeMap<String, String> {
    let (variables, left_out) = facade_base::daemon_client::environment();
    if !left_out.is_empty() {
        eprintln!(
            "facade: omitted non-UTF-8 environment variables: {}",
            left_out.join(", ")
        );
    }
    variables
}

/// An agent's state, with what it waits for or how it ended, and its exit:
/// `waiting_for_you: permission`, `ended: crashed (code 3)`.
fn state_of(agent: &AgentInfo) -> String {
    let mut state = agent.state.as_str().to_string();
    let detail = agent.state_detail.as_ref();
    if let Some(word) = detail.and_then(|d| {
        d.kind
            .map(|kind| kind.as_str())
            .or(d.how.map(|how| how.as_str()))
    }) {
        let _ = write!(state, ": {word}");
    }
    if agent.state == AgentState::Ended
        && let Some(exit) = &agent.exit
    {
        let _ = write!(state, " ({})", ExitText(exit));
    }
    state
}

/// Who said something to an agent: `you` for the person, or the agent as `@name #a3`.
fn speaker(said: &Said) -> String {
    match (said.from.as_str(), &said.from_name) {
        ("human", _) => "you".into(),
        (id, Some(name)) => format!("@{} #{id}", display_name(name)),
        (id, None) => format!("#{id}"),
    }
}

/// ` pid 123` for an agent's process, or nothing for a guest, whose process Facade does not know.
fn pid_of(agent: &AgentInfo) -> String {
    agent
        .pid
        .map(|pid| format!(" pid {pid}"))
        .unwrap_or_default()
}

/// Prints an inspection one line a fact: the agent, its rule, its folder, its run's YOLO, its
/// state, its Facade tools, its input, what was last said to it, and its session.
fn print_inspection(inspected: &InspectResult, local_machine_id: &str) {
    let agent = &inspected.agent;
    let guest = if agent.guest { " guest" } else { "" };
    let mut process = agent.process.as_str().to_string();
    if let Some(exit) = &agent.exit {
        let _ = write!(process, " ({})", ExitText(exit));
    }
    println_or_end!(
        "{} {}: {}{guest}, {process}",
        record_address(agent, local_machine_id),
        display_name(&agent.name),
        agent.cli
    );
    println_or_end!("Rule: {}", inspected.rule.as_deref().unwrap_or("none"));
    println_or_end!("Folder: {}", agent.cwd);
    println_or_end!("YOLO: {}", if agent.yolo { "on" } else { "off" });

    let why = agent
        .state_detail
        .as_ref()
        .and_then(|d| d.text.as_deref().or(d.reason.map(StateReason::words)));
    println_or_end!("State: {}{}", state_of(agent), reason(why));
    let tools_why = agent.tools_reason.map(|why| why.words());
    println_or_end!("Tools: {}{}", agent.tools_state.as_str(), reason(tools_why));

    let input = &inspected.input;
    let mechanism = input
        .mechanism
        .map(|mechanism| format!(" ({})", mechanism.as_str()))
        .unwrap_or_default();
    println_or_end!(
        "Input: {}{mechanism}; {}",
        input.state.as_str(),
        input.evidence
    );
    if let Some(hidden) = input.hidden {
        println_or_end!(
            "Hidden draft rows: {} above, {} below",
            hidden.above,
            hidden.below
        );
    }

    let said = match &agent.said {
        Some(said) => format!("Said by {} at {}: {}", speaker(said), said.at, said.text),
        None => "Said: nothing yet".to_string(),
    };
    println_or_end!("{said}");
    let session = agent.session.as_deref().unwrap_or("unknown");
    println_or_end!("Session: {session}");
    let tracking = if inspected.session_tracking {
        "available"
    } else {
        "unavailable"
    };
    println_or_end!("Session tracking: {tracking}");
}

/// `; why` after a state, or nothing when there is no why.
fn reason(why: Option<&str>) -> String {
    why.map(|why| format!("; {why}")).unwrap_or_default()
}

/// Prints a CLI's integration: each file and its state, then what the person should know.
fn print_integration(info: &IntegrationInfo) {
    let added = info
        .added_at
        .as_ref()
        .map(|at| format!(": added {at}"))
        .unwrap_or_default();
    println_or_end!("{}{added}", info.cli);
    for part in &info.parts {
        println_or_end!("  {}: {}", part.file, entries(part.state));
    }
    for note in &info.notes {
        println_or_end!("  {note}");
    }
}

/// Whether a file holds Facade's entries, as `facade integration` names it.
fn entries(state: PartState) -> &'static str {
    match state {
        PartState::AsWritten => "Facade's entries",
        PartState::Changed => "Facade's entries, changed",
        PartState::Missing | PartState::Unknown => "none of Facade's",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &[&str]) -> Vec<String> {
        line.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn facade_s_options_come_before_the_cli_s_name_and_every_word_after_it_is_the_cli_s() {
        let started = |line: &[&str]| {
            start_words(words(line)).map(|start| (start.name, start.prompt, start.command))
        };
        assert_eq!(
            started(&[
                "--name",
                "review",
                "--prompt",
                "fix the bug",
                "claude",
                "--model",
                "haiku"
            ])
            .unwrap(),
            (
                Some("review".into()),
                Some("fix the bug".into()),
                words(&["claude", "--model", "haiku"])
            )
        );
        assert_eq!(
            started(&[
                "--prompt=-a dash first",
                "--name=boss",
                "codex",
                "--",
                "--name-like"
            ])
            .unwrap(),
            (
                Some("boss".into()),
                Some("-a dash first".into()),
                words(&["codex", "--", "--name-like"])
            )
        );
        assert_eq!(
            started(&["opencode", "--name", "review", "--prompt", "its own"]).unwrap(),
            (
                None,
                None,
                words(&["opencode", "--name", "review", "--prompt", "its own"])
            ),
            "after the CLI's name, both are the CLI's"
        );
        assert_eq!(
            started(&["claude"]).unwrap(),
            (None, None, words(&["claude"]))
        );
        let remote = start_words(words(&[
            "--on=gpu",
            "--cwd",
            "C:\\Work Files",
            "codex",
            "--on",
            "its own",
        ]))
        .unwrap();
        assert_eq!(remote.machine.as_deref(), Some("gpu"));
        assert_eq!(remote.cwd.as_deref(), Some("C:\\Work Files"));
        assert_eq!(remote.command, words(&["codex", "--on", "its own"]));
        for (line, why) in [
            (&["--name", "x"][..], "specify a CLI program"),
            (&["--name"][..], "--name requires an agent name"),
            (
                &["--prompt"][..],
                "--prompt requires the agent's first message",
            ),
            (&["--on"][..], "--on requires a machine name or ID"),
            (&["--cwd"][..], "--cwd requires a directory on the machine"),
            (&["--cwd", "/work", "codex"][..], "--cwd requires --on"),
            (
                &["--model", "opus", "claude"][..],
                "--model is not an option of facade start",
            ),
        ] {
            let refused = started(line).unwrap_err().to_string();
            assert!(refused.starts_with(why), "{line:?}: {refused}");
        }
    }
}
