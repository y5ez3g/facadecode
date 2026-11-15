//! The terminal commands that call the daemon: each one makes its protocol call on the connection
//! it is given and prints the answer for the person, as text or JSON.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use facade_base::daemon::{
    AgentArgs, AgentInfo, AgentInspect, AgentRemove, AgentRename, AgentResume, AgentScreen,
    AgentSend, AgentStart, AgentState, AgentStop, AgentType, AgentsTopic, DEFAULT_TERMINAL_SIZE,
    DeliveredVia, DeliveryStatus, InspectResult, IntegrationAdd, IntegrationArgs, IntegrationInfo,
    IntegrationList, IntegrationRemove, IntegrationsArgs, MessagesTopic, MessagesWatchArgs,
    PartState, RenameArgs, ResumeArgs, Said, ScreenArgs, SendArgs, StartArgs, StateReason,
    TypeArgs, display_name,
};
use facade_base::daemon_client::{DaemonClient, made_request_id};
use facade_base::operations::NoArgs;
use facade_base::process::EndReason;
use unicode_width::UnicodeWidthStr;

use crate::ExitText;

/// What `facade start` takes from its words: its own options, `--name` and `--prompt`, before the
/// CLI's name, and the CLI's name with every word after it, which are the CLI's.
pub(crate) struct StartWords {
    name: Option<String>,
    prompt: Option<String>,
    command: Vec<String>,
}

/// Splits `facade start`'s words into its own options and the CLI's command line. Words it cannot
/// use fail here, before any daemon is reached.
pub(crate) fn start_words(command_line: Vec<String>) -> anyhow::Result<StartWords> {
    let mut start = StartWords {
        name: None,
        prompt: None,
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
            _ if word.starts_with('-') => anyhow::bail!(
                "{word} is not an option of facade start, which takes --name and --prompt; the \
                 CLI's own options go after its name"
            ),
            _ => {
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
    let args = StartArgs {
        command: words.command,
        name: words.name,
        cwd: std::env::current_dir()?.to_string_lossy().into_owned(),
        window_id: None,
        env: environment(),
        cols,
        rows,
        prompt: words.prompt,
        call_id: None,
        // Where a newer Facade taking over cuts the start off, its request ID repeats it, and the
        // answer says what it did.
        request_id: Some(made_request_id()),
        worktree: None,
        model: None,
        effort: None,
    };
    let (started, _) = client.call_with_request_id::<AgentStart>(args, false)?;
    Ok(announce(&started.agent, "started", terminal))
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
    if earlier.exit.as_ref().and_then(|exit| exit.reason) == Some(EndReason::TerminalClosed) {
        eprintln!(
            "facade: #{}'s earlier CLI may still be running: its terminal closed while no Facade \
             service held it",
            earlier.agent_id
        );
    }
    let resumed = client.call::<AgentResume>(ResumeArgs {
        agent: earlier.agent_id,
        env: environment(),
        cols,
        rows,
        window_id: None,
    })?;
    Ok(announce(&resumed, "resumed", terminal))
}

/// Tells the person an agent's run began. Without their terminal the agent keeps running alone,
/// and its ID is all they need; with it, the agent comes back to be attached to.
fn announce(agent: &AgentInfo, began: &str, terminal: Option<(u16, u16)>) -> Option<String> {
    if terminal.is_none() {
        println!("#{}{}", agent.agent_id, pid_of(agent));
        return None;
    }
    eprintln!(
        "[facade: #{id} {name} {began}; Ctrl-] detaches and the agent keeps running; reconnect \
         with `facade attach {id}`]",
        id = agent.agent_id,
        name = display_name(&agent.name),
    );
    Some(agent.agent_id.clone())
}

/// How a command prints its answer: for the person, or as the protocol's JSON (`--json`).
pub(crate) enum Format {
    Text,
    Json,
}

/// Prints every agent, one line each in aligned columns, with what it waits for and what was last
/// said to it below.
pub(crate) fn list(client: &mut DaemonClient, format: Format) -> anyhow::Result<()> {
    let agents = client.snapshot::<AgentsTopic>(NoArgs {})?;
    if let Format::Json = format {
        println!("{}", serde_json::to_string_pretty(&agents)?);
        return Ok(());
    }
    if agents.is_empty() {
        println!("No agents.");
        return Ok(());
    }
    let rows: Vec<[String; 4]> = agents
        .iter()
        .map(|agent| {
            [
                format!("#{}", agent.agent_id),
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
        println!("{line}{process:<11} {}", agent.cwd);
        if let Some(text) = agent.state_detail.as_ref().and_then(|d| d.text.as_ref()) {
            println!("       {text}");
        }
        if let Some(said) = &agent.said {
            println!("       {} said: {}", speaker(said), said.text);
        }
    }
    Ok(())
}

/// Prints one agent in full: one fact a line, or the protocol's JSON.
pub(crate) fn inspect(
    client: &mut DaemonClient,
    agent: String,
    format: Format,
) -> anyhow::Result<()> {
    let inspected = client.call::<AgentInspect>(AgentArgs { agent })?;
    match format {
        Format::Json => println!("{}", serde_json::to_string_pretty(&inspected)?),
        Format::Text => print_inspection(&inspected),
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
        println!("{}", facade_base::daemon::plain(&screen.text));
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
        request_id: Some(made_request_id()),
        time_left_ms: None,
    };
    let message = client
        .call_with_request_id::<AgentSend>(args, false)?
        .0
        .message;
    let (id, to) = (&message.message_id, &message.to);
    match (message.delivery.status, message.delivery.delivered_via) {
        // A guest takes its messages at its next turn.
        (DeliveryStatus::Pending, _) => println!("#{id} waits for #{to}'s next turn"),
        (DeliveryStatus::Success, Some(DeliveredVia::Read)) => println!("#{id} was read by #{to}"),
        (DeliveryStatus::Success, Some(DeliveredVia::Notified)) => {
            println!("#{id} was handed to the person's editor window")
        }
        (DeliveryStatus::Success, _) => println!("#{id} was typed into #{to}"),
        _ => anyhow::bail!(
            "#{id} to #{to}: {}",
            message.delivery.failure_words(&format!("#{to}"))
        ),
    }
    Ok(())
}

/// Prints the messages waiting for the agent the connection speaks for, as its terminal would show
/// them; reading them delivers them.
pub(crate) fn messages(client: &mut DaemonClient) -> anyhow::Result<()> {
    // A page holds up to 100; the rest wait for the next read.
    let inbox = client.snapshot::<MessagesTopic>(MessagesWatchArgs::default())?;
    let shown: Vec<String> = inbox
        .messages
        .iter()
        .map(facade_base::daemon::typed_text)
        .collect();
    if !shown.is_empty() {
        println!("{}", shown.join("\n\n"));
    }
    Ok(())
}

/// Renames an agent and prints it with its new name.
pub(crate) fn rename(client: &mut DaemonClient, agent: String, name: String) -> anyhow::Result<()> {
    let renamed = client.call::<AgentRename>(RenameArgs { agent, name })?;
    println!("#{} {}", renamed.agent_id, display_name(&renamed.name));
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
        Some(keeper) => println!("{daemon}, keeper pid {} ({})", keeper.pid, keeper.build),
        None => println!("{daemon}; no keeper is running"),
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
fn print_inspection(inspected: &InspectResult) {
    let agent = &inspected.agent;
    let guest = if agent.guest { " guest" } else { "" };
    let mut process = agent.process.as_str().to_string();
    if let Some(exit) = &agent.exit {
        let _ = write!(process, " ({})", ExitText(exit));
    }
    println!(
        "#{} {}: {}{guest}, {process}",
        agent.agent_id,
        display_name(&agent.name),
        agent.cli
    );
    println!("Rule: {}", inspected.rule.as_deref().unwrap_or("none"));
    println!("Folder: {}", agent.cwd);
    println!("YOLO: {}", if agent.yolo { "on" } else { "off" });

    let why = agent
        .state_detail
        .as_ref()
        .and_then(|d| d.text.as_deref().or(d.reason.map(StateReason::words)));
    println!("State: {}{}", state_of(agent), reason(why));
    let tools_why = agent.tools_reason.map(|why| why.words());
    println!("Tools: {}{}", agent.tools_state.as_str(), reason(tools_why));

    let input = &inspected.input;
    let mechanism = input
        .mechanism
        .map(|mechanism| format!(" ({})", mechanism.as_str()))
        .unwrap_or_default();
    println!(
        "Input: {}{mechanism}; {}",
        input.state.as_str(),
        input.evidence
    );
    if let Some(hidden) = input.hidden {
        println!(
            "Hidden draft rows: {} above, {} below",
            hidden.above, hidden.below
        );
    }

    let said = match &agent.said {
        Some(said) => format!("Said by {} at {}: {}", speaker(said), said.at, said.text),
        None => "Said: nothing yet".to_string(),
    };
    println!("{said}");
    let session = agent.session.as_deref().unwrap_or("unknown");
    println!("Session: {session}");
    let tracking = if inspected.session_tracking {
        "available"
    } else {
        "unavailable"
    };
    println!("Session tracking: {tracking}");
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
    println!("{}{added}", info.cli);
    for part in &info.parts {
        println!("  {}: {}", part.file, entries(part.state));
    }
    for note in &info.notes {
        println!("  {note}");
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
        for (line, why) in [
            (&["--name", "x"][..], "specify a CLI program"),
            (&["--name"][..], "--name requires an agent name"),
            (
                &["--prompt"][..],
                "--prompt requires the agent's first message",
            ),
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
