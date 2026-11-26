//! The terminal commands: each uses the connection it is given and prints the result.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::{Instant, SystemTime};

use facade_base::address::default_machine_name;
use facade_base::address::selector::{exact_machine_selector, parse_machine_selector};
use facade_base::api_v1::daemon::{
    AgentCreator, AgentInfo, AgentInspect, AgentKind, AgentList, AgentListArgs, AgentListEntry,
    AgentRename, AgentResume, AgentResumeList, AgentScreen, AgentSend, AgentStart, AgentState,
    AgentStop, AgentTarget, AgentTargetArgs, AgentType, AgentTypeArgs, AttachmentKind,
    BatchStopResult, CliList, CliListArgs, DaemonStatus, FolderScope, InputStep, InspectResult,
    MachineIdentity, MachineList, MachineQuery, MachineState, ProcessState, QueryStatus,
    RenameArgs, ResumeArgs, ResumeCandidate, ResumeListArgs, ResumeTarget, Scope, ScreenArgs,
    SendArgs, SendWait, SingleMachineScope, StartArgs, StatusArgs, StatusResult, StopArgs,
    StopItem, StopOutcome, StopSelection, TerminalInput,
};
use facade_base::api_v1::daemon_client::{Cut, DaemonClient, upgrading};
use facade_base::api_v1::{NoArgs, Size};
use facade_base::model::agent::{HowEnded, WaitKind};
use facade_base::model::terminal::{display_line, plain};
use facade_base::time::parse_iso_time;
use unicode_width::UnicodeWidthStr;

use crate::errors::{self, AgentCommand, Problem};
use crate::{
    ExitText, LaunchConsole, Opening, Shown, StartOptions, agent_address, roster_table, single_line,
};

const ROSTER_COLUMNS: [&str; 8] = [
    "NAME",
    "REFERENCE",
    "STATE",
    "CLI",
    "TYPE",
    "WORKING DIRECTORY",
    "STARTED",
    "SESSION",
];

pub(crate) fn start(
    client: &mut DaemonClient,
    options: StartOptions,
    terminal: &LaunchConsole,
) -> anyhow::Result<Option<Shown>> {
    let StartOptions {
        name,
        machine,
        workdir,
        worktree,
        cli_and_args,
    } = options;
    let Some((cli, args)) = cli_and_args.split_first() else {
        let available = available_clis(client, machine, workdir).unwrap_or_default();
        return Err(Problem::MissingCli { available }.into());
    };

    let (cols, rows) = terminal.size;
    let folder_is_default = workdir.is_none();
    let selected = machine.clone();
    let (machine, folder) = start_folder(client, machine, workdir).map_err(|error| {
        errors::start_failed(cli, selected.as_deref(), worktree.as_deref(), error)
    })?;
    let args = StartArgs {
        cli: cli.clone(),
        args: args.to_vec(),
        name,
        folder: Some(folder),
        folder_is_default,
        scope: Some(single_machine_scope(machine)),
        env: Some(terminal_environment(terminal)),
        size: Size { cols, rows },
        prompt: None,
        call_id: None,
        request_id: Some(made_request_id()),
        worktree: worktree.clone(),
        model: None,
        effort: None,
    };
    let (started, _) = client
        .call_with_request_id::<AgentStart>(args, false)
        .map_err(|error| {
            errors::start_failed(cli, selected.as_deref(), worktree.as_deref(), error)
        })?;
    if terminal.view.is_some() {
        return Ok(Some(shown(&started.agent, Opening::Started)));
    }
    println_or_end!("Started {} in the background.", label(&started.agent));
    if worktree.is_some() {
        println_or_end!("Worktree: {}", single_line(&started.agent.cwd));
    }
    Ok(None)
}

fn available_clis(
    client: &mut DaemonClient,
    machine: Option<String>,
    workdir: Option<String>,
) -> anyhow::Result<Vec<String>> {
    let (machine, folder) = match (machine, workdir) {
        (Some(machine), None) if !selects_local_machine(client, &machine)? => (Some(machine), None),
        (machine, workdir) => {
            let (machine, folder) = start_folder(client, machine, workdir)?;
            (machine, Some(folder))
        }
    };
    let listed = client.call::<CliList>(CliListArgs {
        folder,
        scope: Some(single_machine_scope(machine)),
        env: Some(environment()),
    })?;
    if let Some(problem) = listed.settings_problem {
        anyhow::bail!("{problem}");
    }
    Ok(listed
        .clis
        .into_iter()
        .filter(|entry| entry.available)
        .map(|entry| entry.cli)
        .collect())
}

fn single_machine_scope(machine: Option<String>) -> SingleMachineScope {
    match machine {
        Some(machine) => SingleMachineScope::Machine { machine },
        None => SingleMachineScope::Local,
    }
}

fn start_folder(
    client: &mut DaemonClient,
    mut machine: Option<String>,
    workdir: Option<String>,
) -> anyhow::Result<(Option<String>, String)> {
    let folder = match workdir {
        Some(folder) if Path::new(&folder).is_relative() => {
            let local = match machine.as_deref() {
                None => true,
                Some(selector) => selects_local_machine(client, selector)?,
            };
            if local {
                // Keep the resolved folder on this machine if its name changes.
                if machine.is_some() {
                    machine = Some(exact_machine_selector(&client.hello_result.machine_id));
                }
                std::path::absolute(folder)?.to_string_lossy().into_owned()
            } else {
                folder
            }
        }
        Some(folder) => folder,
        None => current_dir()?,
    };
    Ok((machine, folder))
}

fn selects_local_machine(client: &mut DaemonClient, selector: &str) -> anyhow::Result<bool> {
    let Ok(selector) = parse_machine_selector(selector) else {
        return Ok(false);
    };
    let listed = client.call::<MachineList>(NoArgs {})?;
    let mut matches = listed.machines.into_iter().filter(|machine| {
        selector.matches(&MachineIdentity {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
        })
    });
    Ok(matches
        .next()
        .is_some_and(|machine| machine.machine_id == client.hello_result.machine_id)
        && matches.next().is_none())
}

pub(crate) fn resume(
    client: &mut DaemonClient,
    reference: String,
    terminal: &LaunchConsole,
) -> anyhow::Result<Option<Shown>> {
    let (cols, rows) = terminal.size;
    let mut env = terminal_environment(terminal);
    env.insert("PWD".into(), current_dir()?);
    let resumed = client
        .call::<AgentResume>(ResumeArgs {
            target: ResumeTarget::Selector {
                selector: reference.clone(),
                scope: None,
                folder: None,
            },
            env: Some(env),
            size: Size { cols, rows },
        })
        .map_err(|error| errors::agent_failed(AgentCommand::Resume, &reference, error))?;
    let cli = &resumed.agent.cli;
    if terminal.view.is_some() {
        let opening = if resumed.from_saved_session == Some(true) {
            Opening::SavedSession { cli: cli.clone() }
        } else {
            Opening::Resumed
        };
        return Ok(Some(shown(&resumed.agent, opening)));
    }
    let agent = label(&resumed.agent);
    if resumed.from_saved_session == Some(true) {
        println_or_end!(
            "Started {agent} in the background from a saved {} session.",
            single_line(cli)
        );
    } else {
        println_or_end!("Resumed {agent} in the background.");
    }
    Ok(None)
}

fn shown(agent: &AgentInfo, opening: Opening) -> Shown {
    Shown {
        target: AgentTarget::Reference(agent.reference.clone()),
        opening,
    }
}

pub(crate) fn resume_list(client: &mut DaemonClient, scope: Scope) -> anyhow::Result<()> {
    let local = matches!(scope, Scope::Local);
    let machine = named_machine(&scope);
    let folder = if machine.is_none() {
        Some(current_dir()?)
    } else {
        None
    };
    let args = ResumeListArgs {
        scope: Some(scope.clone()),
        folder,
        folder_scope: Some(FolderScope::All),
    };
    let listed = if local {
        // Keep local resume on the negotiated connection.
        let id = client.begin_call::<AgentResumeList>(args)?;
        client.result::<AgentResumeList>(id)
    } else {
        client.call::<AgentResumeList>(args)
    }
    .map_err(|error| errors::query_failed("resume", machine, error))?;
    check_named_query(&scope, &listed.machines)?;
    if listed.items.is_empty() {
        let (on, option) = query_scope(&scope, &listed.machines);
        eprintln!("No resumable agents or sessions found{on}.");
        eprintln!("Start a new agent with 'facade start{option} codex'.");
    } else {
        println_or_end!(
            "{}",
            resume_list_text(&listed.items, &listed.machines, SystemTime::now())
        );
        eprintln!("Resume one with 'facade resume <REFERENCE>'.");
    }
    if matches!(scope, Scope::Reachable) {
        report_machines(&listed.machines);
    }
    Ok(())
}

pub(crate) fn list(client: &mut DaemonClient, scope: Scope) -> anyhow::Result<()> {
    let machine = named_machine(&scope);
    let listed = client
        .call::<AgentList>(AgentListArgs {
            scope: Some(scope.clone()),
        })
        .map_err(|error| errors::query_failed("list", machine, error))?;
    check_named_query(&scope, &listed.machines)?;
    if listed.agents.is_empty() {
        let (on, option) = query_scope(&scope, &listed.machines);
        eprintln!("No active agents{on}.");
        eprintln!(
            "Start one with 'facade start{option} codex', or run 'facade resume{option}' to find saved sessions."
        );
    } else {
        println_or_end!("{}", list_text(&listed.agents, SystemTime::now()));
    }
    if matches!(scope, Scope::Reachable) {
        report_machines(&listed.machines);
    }
    Ok(())
}

fn named_machine(scope: &Scope) -> Option<&str> {
    match scope {
        Scope::Machine { machine } => Some(machine),
        _ => None,
    }
}

fn check_named_query(scope: &Scope, machines: &[MachineQuery]) -> anyhow::Result<()> {
    if matches!(scope, Scope::Machine { .. })
        && let Some(machine) = machines.first()
        && machine.status != QueryStatus::Answered
    {
        return Err(errors::machine_query_failed(machine).into());
    }
    Ok(())
}

/// Use the selected machine's name for empty results and its copyable selector for commands.
fn query_scope(scope: &Scope, machines: &[MachineQuery]) -> (String, String) {
    match scope {
        Scope::Reachable => (String::new(), String::new()),
        Scope::Local => {
            let on = machines
                .first()
                .map(|local| format!(" on {}", single_line(&local.name)))
                .unwrap_or_default();
            (on, String::new())
        }
        Scope::Machine { machine } => {
            let (name, selector) = machines
                .first()
                .map_or((machine.as_str(), machine.as_str()), |result| {
                    (result.name.as_str(), result.selector.as_str())
                });
            (
                format!(" on {}", single_line(name)),
                format!(" --machine {}", single_line(selector)),
            )
        }
    }
}

fn report_machines(machines: &[MachineQuery]) {
    let mut failed = false;
    for machine in machines
        .iter()
        .filter(|machine| errors::machine_query_unanswered(machine))
    {
        eprintln!(
            "warning: Could not query machine {}: {}",
            errors::quoted(&machine.name),
            errors::machine_query_detail(machine)
        );
        failed = true;
    }
    if failed {
        eprintln!("{}", errors::CHECK_MACHINES);
    }
}

pub(crate) fn inspect(client: &mut DaemonClient, agent: String) -> anyhow::Result<()> {
    let inspected = client
        .call::<AgentInspect>(agent_selector(&agent))
        .map_err(|error| errors::agent_failed(AgentCommand::Status, &agent, error))?;
    let machine_names = if inspected
        .attachments
        .iter()
        .any(|attachment| attachment.kind == AttachmentKind::Shell)
    {
        client
            .call::<MachineList>(NoArgs {})
            .map(|listed| {
                listed
                    .machines
                    .into_iter()
                    .map(|machine| (machine.machine_id, machine.name))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    println_or_end!("{}", inspect_text(&inspected, &machine_names));
    Ok(())
}

pub(crate) fn screen(client: &mut DaemonClient, agent: String, lines: u16) -> anyhow::Result<()> {
    let screen = client
        .call::<AgentScreen>(ScreenArgs {
            target: AgentTarget::Selector(agent.clone()),
            lines: Some(lines),
        })
        .map_err(|error| errors::agent_failed(AgentCommand::Screen, &agent, error))?;
    let text = plain(&screen.text);
    if screen.line_count == 0 {
        let agent = errors::agent_label(screen.name.as_deref(), &screen.address);
        eprintln!("{agent} has no terminal output yet.");
    } else {
        print_or_end!("{text}");
    }
    Ok(())
}

pub(crate) fn type_input(
    client: &mut DaemonClient,
    agent: String,
    input: TerminalInput,
) -> anyhow::Result<()> {
    let sequence = matches!(&input, TerminalInput::Sequence { .. });
    let action = match &input {
        TerminalInput::Text { enter, .. } => TypeAction::Text { enter: *enter },
        TerminalInput::Keys { keys } => match keys.as_slice() {
            [key] => TypeAction::Key(single_line(key)),
            keys => TypeAction::Keys(keys.len()),
        },
        TerminalInput::Sequence { steps } => {
            if steps
                .iter()
                .any(|step| matches!(step, InputStep::Key { .. }))
            {
                TypeAction::Mixed
            } else {
                TypeAction::Text { enter: false }
            }
        }
        TerminalInput::Raw { .. } => unreachable!("the CLI does not submit raw terminal input"),
    };
    let args = AgentTypeArgs {
        target: AgentTarget::Selector(agent.clone()),
        input,
    };
    let typed = if sequence {
        client
            .begin_call::<AgentType>(args)
            .and_then(|id| client.result::<AgentType>(id))
    } else {
        // Keep reconnect on a pre-admission takeover refusal for existing input forms.
        client.call::<AgentType>(args)
    }
    .map_err(|error| errors::type_failed(&agent, sequence, error))?;
    let recipient = typed.agent.as_ref().map_or_else(
        || single_line(&agent),
        |agent| errors::agent_label(Some(&agent.name), &agent.address),
    );
    println_or_end!("{}", action.receipt(&recipient));
    Ok(())
}

enum TypeAction {
    Text { enter: bool },
    Key(String),
    Keys(usize),
    Mixed,
}

impl TypeAction {
    fn receipt(&self, agent: &str) -> String {
        match self {
            Self::Text { enter: true } => {
                format!("Typed into {agent}'s terminal and pressed Enter.")
            }
            Self::Text { enter: false } => format!("Typed into {agent}'s terminal."),
            Self::Key(key) => format!("Pressed {key} in {agent}'s terminal."),
            Self::Keys(count) => format!("Sent {count} key presses to {agent}'s terminal."),
            Self::Mixed => format!("Typed text and pressed keys in {agent}'s terminal."),
        }
    }
}

pub(crate) fn send(
    client: &mut DaemonClient,
    to: String,
    text: String,
    wait_for: SendWait,
    timeout: u16,
    until: Instant,
) -> anyhow::Result<()> {
    let args = SendArgs {
        to: AgentTarget::Selector(to.clone()),
        text,
        reply_to: None,
        request_id: Some(made_request_id()),
        time_left_ms: None,
        wait_for: Some(wait_for),
        allow_unsupported_receipt: true,
    };
    let mut replaying = false;
    let result = loop {
        let time_left_ms = until.saturating_duration_since(Instant::now()).as_millis() as u64;
        if time_left_ms == 0 {
            if replaying {
                break Err(Cut.into());
            }
            anyhow::bail!("the delivery time expired before the message was sent");
        }
        let attempt = client.call_until::<AgentSend>(
            SendArgs {
                time_left_ms: Some(time_left_ms),
                ..args.clone()
            },
            until,
        );
        match &attempt {
            // This refusal comes before the call is admitted, even for a reply wait.
            Err(error) if upgrading(error) => {}
            Err(error)
                if !replaying
                    && matches!(wait_for, SendWait::Inbox | SendWait::Delivery)
                    && error.is::<Cut>()
                    && client.closing.is_some() =>
            {
                replaying = true;
            }
            _ => break attempt,
        }
        if let Err(error) = client.reconnect_until(until) {
            if replaying {
                break Err(Cut.into());
            }
            return Err(
                error.context("could not reconnect after Facade refused the send during takeover")
            );
        }
    }
    .map_err(|error| errors::send_failed(wait_for, &to, timeout, error))?;
    match wait_for {
        SendWait::Inbox => {
            let recipient = result.recipient.as_ref().map_or_else(
                || single_line(&to),
                |agent| errors::agent_label(Some(&agent.name), &agent.address),
            );
            println_or_end!("Saved {} in {recipient}'s inbox.", result.id);
        }
        SendWait::Delivery => {
            println_or_end!("{}", errors::delivery_receipt(&result, &to, timeout)?)
        }
        SendWait::Result => {
            if let Some(reply) = result.reply.as_ref() {
                print_or_end!("{}", reply.text);
            } else {
                errors::delivery_receipt(&result, &to, timeout)?;
                anyhow::bail!("the daemon returned delivery without a reply");
            }
        }
    }
    Ok(())
}

pub(crate) fn rename(client: &mut DaemonClient, agent: String, name: String) -> anyhow::Result<()> {
    let renamed = client
        .call::<AgentRename>(RenameArgs {
            target: AgentTarget::Selector(agent.clone()),
            name,
        })
        .map_err(|error| errors::agent_failed(AgentCommand::Rename, &agent, error))?;
    let name = errors::quoted(&renamed.agent.name);
    let address = single_line(&renamed.agent.address);
    if let Some(previous) = renamed.previous_name {
        println_or_end!(
            "Renamed {} to {name} ({address}).",
            errors::quoted(&previous)
        );
    } else {
        println_or_end!("Renamed {address} to {name}.");
    }
    Ok(())
}

pub(crate) fn stop(client: &mut DaemonClient, selection: StopSelection) -> anyhow::Result<i32> {
    let (scope, grouped) = match &selection {
        StopSelection::All { scope } => (Some(scope.clone()), true),
        StopSelection::Targets { targets } => (None, targets.len() != 1),
    };
    let result = client
        .call::<AgentStop>(StopArgs { selection })
        .map_err(|error| {
            errors::query_failed(
                "stop --machine",
                scope.as_ref().and_then(named_machine),
                error,
            )
        })?;
    Ok(report_stop(scope.as_ref(), grouped, result))
}

fn report_stop(scope: Option<&Scope>, grouped: bool, result: BatchStopResult) -> i32 {
    let mut stopped = false;
    let mut guests = Vec::new();
    for item in &result.items {
        match item.outcome {
            StopOutcome::Stopped { .. } => {
                let name = item.agent.as_ref().map(|agent| agent.name.as_str());
                println_or_end!(
                    "Stopped {}.",
                    errors::agent_label(name, &stop_address(item))
                );
                stopped = true;
            }
            StopOutcome::Skipped if scope.is_some() => {
                let address = single_line(&stop_address(item));
                guests.push(item.agent.as_ref().map_or_else(
                    || address.clone(),
                    |agent| format!("{} {address}", single_line(&agent.name)),
                ));
            }
            _ => {}
        }
    }
    if !guests.is_empty() {
        let noun = if guests.len() == 1 { "guest" } else { "guests" };
        eprintln!(
            "note: skipped {} connected {noun} ({}); stop guests from their host apps.",
            guests.len(),
            guests.join(", ")
        );
    }

    let target_failures = result.items.into_iter().filter_map(|item| {
        let StopOutcome::Failed { error } = item.outcome else {
            return None;
        };
        Some(errors::stop_failed(
            &target_address(&item.target),
            item.agent.as_ref(),
            error,
        ))
    });
    let machines = result.machines.as_deref().unwrap_or_default();
    let machine_failures = machines
        .iter()
        .filter(|machine| errors::machine_query_unanswered(machine))
        .map(|machine| errors::machine_query_failed(machine).into());
    let mut failed = false;
    let mut follow_ups = Vec::new();
    for error in target_failures.chain(machine_failures) {
        failed = true;
        let (diagnostic, follow_up) = errors::stop_diagnostic(&error, grouped);
        eprintln!("{diagnostic}");
        if let Some(follow_up) = follow_up
            && !follow_ups.contains(&follow_up)
        {
            follow_ups.push(follow_up);
        }
    }
    for follow_up in follow_ups {
        eprintln!("{follow_up}");
    }
    if !failed
        && !stopped
        && let Some(scope) = scope
    {
        let (on, _) = query_scope(scope, machines);
        eprintln!("No running managed agents to stop{on}.");
    }
    i32::from(failed)
}

fn target_address(target: &AgentTarget) -> Cow<'_, str> {
    match target {
        AgentTarget::Selector(agent) => Cow::Borrowed(agent),
        AgentTarget::Reference(reference) => Cow::Owned(agent_address(reference, None)),
    }
}

fn stop_address(item: &StopItem) -> Cow<'_, str> {
    item.agent.as_ref().map_or_else(
        || target_address(&item.target),
        |agent| Cow::Borrowed(&agent.address),
    )
}

fn agent_selector(agent: &str) -> AgentTargetArgs {
    AgentTargetArgs {
        target: AgentTarget::Selector(agent.to_owned()),
    }
}

pub(crate) fn status(client: Option<&mut DaemonClient>) -> anyhow::Result<()> {
    let launcher = facade_base::programs::launcher("facade-mcp")
        .ok()
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "facade-mcp".into());
    let cli_version = facade_base::build_id();
    let text = match client {
        Some(client) => {
            let result = client.call::<DaemonStatus>(StatusArgs {
                scope: Some(SingleMachineScope::Local),
            })?;
            let local_id = client.hello_result.machine_id.clone();
            let mut clis = vec![machine_clis(available_clis(client, None, None))];
            for machine in connected_machines(&result, &local_id) {
                let listed = available_clis(client, Some(machine.selector.clone()), None);
                clis.push(machine_clis(listed));
            }
            status_text(&result, &clis, &local_id, &cli_version, &launcher)
        }
        None => {
            let home = facade_base::paths::facade_home()?;
            let settings = facade_base::settings::settings_file()?;
            let machine = facade_daemon::offline_machine_name().unwrap_or_else(default_local_name);
            let listed = current_dir()
                .map_err(anyhow::Error::from)
                .and_then(|folder| {
                    facade_daemon::offline_clis(environment(), &folder).map_err(anyhow::Error::msg)
                });
            let clis = machine_clis(listed);
            sleeping_text(
                &clis,
                &home.to_string_lossy(),
                &settings.to_string_lossy(),
                &cli_version,
                &launcher,
                &machine,
            )
        }
    };
    println_or_end!("{text}");
    Ok(())
}

fn current_dir() -> std::io::Result<String> {
    Ok(std::env::current_dir()?.to_string_lossy().into_owned())
}

/// A request ID of this process's own, for a send or a start a command makes:
/// `facade-<pid>-<ms since 1970>-1`.
fn made_request_id() -> String {
    let since_1970 = SystemTime::UNIX_EPOCH.elapsed().unwrap_or_default();
    format!("facade-{}-{}-1", std::process::id(), since_1970.as_millis())
}

fn terminal_environment(terminal: &LaunchConsole) -> BTreeMap<String, String> {
    let mut env = environment();
    facade_base::start::carry_terminal_colors(&mut env, &terminal.colors);
    env
}

/// Pass the shell's environment to the daemon for local launches.
fn environment() -> BTreeMap<String, String> {
    let (mut variables, left_out) = crate::launch_environment();
    facade_rules::restore_config_environment(&mut variables);
    if !left_out.is_empty() {
        crate::attach::write_console_warning(format_args!(
            "warning: omitted non-UTF-8 environment variables: {}",
            left_out.join(", ")
        ));
    }
    variables
}

pub(crate) fn age(at: &str, now: SystemTime) -> String {
    let Some(at) = parse_iso_time(at) else {
        return single_line(at);
    };
    let minutes = now.duration_since(at).unwrap_or_default().as_secs() / 60;
    match minutes {
        0..=59 => format!("{minutes}m ago"),
        60..=1439 => format!("{}h ago", minutes / 60),
        _ => format!("{}d ago", minutes / 1440),
    }
}

fn kind_words(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Managed => "Managed",
        AgentKind::Guest => "Guest",
    }
}

pub(crate) fn state_words(agent: &AgentInfo) -> String {
    let detail = agent.state_detail.as_ref();
    if agent.process == ProcessState::Ended {
        if detail.and_then(|detail| detail.how) == Some(HowEnded::Stopped) {
            return "Ended (stopped by Facade)".into();
        }
        return match &agent.exit {
            Some(exit) if exit.code.is_some() => format!("Ended ({})", ExitText(exit)),
            Some(exit) if exit.signal.is_some() => format!("Ended (signal {})", ExitText(exit)),
            _ => "Ended".into(),
        };
    }
    let state = errors::state_name(agent.state);
    let Some(detail) =
        detail.filter(|_| matches!(agent.state, AgentState::WaitingForYou | AgentState::Error))
    else {
        return state.into();
    };
    let explanation = detail
        .text
        .as_deref()
        .map(single_line)
        .filter(|text| !text.trim().is_empty())
        .or_else(|| detail.reason.map(|reason| reason.words().to_owned()));
    let kind = match detail.kind {
        Some(WaitKind::Permission) => Some("permission"),
        Some(WaitKind::Question) => Some("question"),
        Some(WaitKind::Auth) => Some("sign-in"),
        _ => None,
    };
    match (kind, explanation) {
        (Some(kind), Some(explanation)) => format!("{state} ({kind}: {explanation})"),
        (None, Some(explanation)) => format!("{state} ({explanation})"),
        (Some(kind), None) => format!("{state} ({kind})"),
        (None, None) => state.into(),
    }
}

fn label(agent: &AgentInfo) -> String {
    errors::agent_label(Some(&agent.name), &agent.address)
}

fn value_or_dash(value: &str) -> &str {
    if value.trim().is_empty() { "-" } else { value }
}

fn session_cell(name: Option<&str>) -> String {
    let name = name.map_or(String::new(), |name| display_line(name, 40));
    value_or_dash(&name).into()
}

pub(crate) fn list_text(agents: &[AgentListEntry], now: SystemTime) -> String {
    let rows: Vec<_> = agents
        .iter()
        .map(|agent| {
            vec![
                agent.name.clone(),
                agent.address.clone(),
                errors::state_name(agent.state).into(),
                agent.cli.clone(),
                kind_words(agent.kind).into(),
                if agent.kind == AgentKind::Managed {
                    value_or_dash(&agent.folder).into()
                } else {
                    "-".into()
                },
                age(&agent.started_at, now),
                session_cell(agent.session_name.as_deref()),
            ]
        })
        .collect();
    roster_table(&ROSTER_COLUMNS, &rows)
}

pub(crate) fn resume_list_text(
    items: &[ResumeCandidate],
    machines: &[MachineQuery],
    now: SystemTime,
) -> String {
    let rows: Vec<_> = items
        .iter()
        .map(|item| {
            let (reference, state, kind) = if let ResumeTarget::Agent { reference } = &item.target {
                let machine = machines
                    .iter()
                    .find(|machine| machine.machine_id == reference.machine_id)
                    .map(|machine| machine.selector.as_str());
                (agent_address(reference, machine), "Ended", "Managed")
            } else {
                let selector = item.session_selector.as_deref().unwrap_or(&item.session);
                (selector.to_owned(), "Saved", "Session")
            };
            vec![
                item.name.as_deref().unwrap_or("-").into(),
                reference,
                state.into(),
                item.cli.clone(),
                kind.into(),
                value_or_dash(&item.folder).into(),
                item.at
                    .as_deref()
                    .map_or_else(|| "-".into(), |at| age(at, now)),
                session_cell(item.session_name.as_deref()),
            ]
        })
        .collect();
    let mut columns = ROSTER_COLUMNS;
    columns[6] = "UPDATED";
    roster_table(&columns, &rows)
}

pub(crate) fn inspect_text(
    inspected: &InspectResult,
    machine_names: &HashMap<String, String>,
) -> String {
    let agent = &inspected.agent;
    let managed = agent.kind == AgentKind::Managed;
    let running = managed && agent.process == ProcessState::Running;
    let pid = if running {
        number(agent.pid)
    } else {
        "-".into()
    };
    let machine = agent
        .address
        .rsplit_once('@')
        .map_or(agent.reference.machine_id.as_str(), |(_, machine)| machine);
    let (folder, launch_command, session_id) = if managed {
        (
            agent.cwd.as_str(),
            inspected.launch_command.as_deref().unwrap_or("-"),
            agent.session.as_deref().unwrap_or("-"),
        )
    } else {
        ("-", "-", "-")
    };
    let started_by = match inspected.started_by.as_ref().filter(|_| managed) {
        Some(AgentCreator::Agent { address }) => address,
        Some(AgentCreator::CommandLine) => "Shell",
        Some(AgentCreator::VsCode) => "VS Code",
        None => "-",
    };
    let viewers = if !running {
        String::new()
    } else if inspected.attachments.is_empty() {
        inspected.viewers.join(", ")
    } else {
        inspected
            .attachments
            .iter()
            .map(|attachment| match attachment.kind {
                AttachmentKind::VsCode => "VS Code".into(),
                AttachmentKind::Shell => machine_names.get(&attachment.machine_id).map_or_else(
                    || "Shell".into(),
                    |name| format!("Shell ({})", single_line(name)),
                ),
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "{}\n{}\n\n{}",
        label(agent),
        fields(
            19,
            &[
                ("State", &state_words(agent)),
                ("CLI", &agent.cli),
                ("PID", &pid),
                ("Working directory", folder),
                ("Launch command", launch_command),
            ]
        ),
        fields(
            19,
            &[
                ("Type", kind_words(agent.kind)),
                ("Machine", machine),
                ("Session", inspected.session_name.as_deref().unwrap_or("-")),
                ("Session ID", session_id),
                ("Started by", started_by),
                ("Attached in", &viewers),
                ("YOLO", if agent.yolo { "on" } else { "off" }),
            ]
        ),
    )
}

fn fields(width: usize, fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(name, value)| {
            let value = single_line(value);
            format!("{name:<width$}{}", value_or_dash(&value))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn number(value: Option<impl ToString>) -> String {
    value.map_or_else(|| "-".into(), |value| value.to_string())
}

fn default_local_name() -> String {
    default_machine_name(&facade_base::system::hostname().unwrap_or_default())
}

pub(crate) fn sleeping_text(
    clis: &str,
    home: &str,
    settings: &str,
    version: &str,
    launcher: &str,
    machine: &str,
) -> String {
    let headline = format!(
        "Facade {version} is not running on {}.",
        single_line(machine)
    );
    service_text(
        &headline,
        launcher,
        ServiceFields {
            clis: &[(single_line(machine), clis.to_owned())],
            home,
            settings,
            ..ServiceFields::default()
        },
    )
}

/// The online machines other than this one, as `status` lists them.
fn connected_machines<'a>(
    status: &'a StatusResult,
    local_id: &'a str,
) -> impl Iterator<Item = &'a MachineQuery> {
    status.machines.iter().filter(move |machine| {
        machine.state == MachineState::Online && machine.machine_id != local_id
    })
}

/// The CLIs a machine can start, or why they could not be listed.
fn machine_clis(listed: anyhow::Result<Vec<String>>) -> String {
    match listed {
        Ok(clis) => clis.join(", "),
        Err(error) => format!("could not be listed: {error}"),
    }
}

/// `clis` holds what [`machine_clis`] says for this machine, then for each connected one.
pub(crate) fn status_text(
    status: &StatusResult,
    clis: &[String],
    local_id: &str,
    cli_version: &str,
    launcher: &str,
) -> String {
    let version = status.build.as_str();
    let local = status
        .machines
        .iter()
        .find(|machine| machine.machine_id == local_id);
    let fallback;
    let name = if let Some(local) = local {
        &local.name
    } else {
        fallback = default_local_name();
        &fallback
    };
    let headline = format!("Facade {version} is running on {}.", single_line(name));
    let names = std::iter::once(name.as_str())
        .chain(connected_machines(status, local_id).map(|machine| machine.name.as_str()));
    let machines: Vec<(String, String)> = names
        .zip(clis)
        .map(|(name, clis)| (single_line(name), clis.clone()))
        .collect();
    service_text(
        &headline,
        launcher,
        ServiceFields {
            cli_version: (version != cli_version).then_some(cli_version),
            clis: &machines,
            agents: Some(status.agent_count),
            home: &status.home,
            settings: &status.settings_file,
            daemon_pid: Some(status.daemon_pid),
            keeper_pid: status.keeper_pid,
        },
    )
}

#[derive(Default)]
struct ServiceFields<'a> {
    cli_version: Option<&'a str>,
    /// Each machine's name and the CLIs it can start, this machine's first.
    clis: &'a [(String, String)],
    agents: Option<u64>,
    home: &'a str,
    settings: &'a str,
    daemon_pid: Option<u32>,
    keeper_pid: Option<u32>,
}

fn service_text(headline: &str, launcher: &str, status: ServiceFields<'_>) -> String {
    let mut summary = Vec::new();
    if let Some(version) = status.cli_version {
        summary.push(("CLI version", version));
    }
    let agents = number(status.agents);
    summary.push(("Active agents", agents.as_str()));
    let machines: Vec<(&str, &str)> = status
        .clis
        .iter()
        .map(|(machine, clis)| (machine.as_str(), clis.as_str()))
        .collect();
    // A machine name as long as the labels still leaves two spaces before its CLIs.
    let width = machines
        .iter()
        .map(|(machine, _)| machine.width() + 2)
        .fold(20, usize::max);
    format!(
        "{headline}\n{}\n\n{}\n\n{}\n\nAvailable CLIs\n{}",
        fields(20, &summary),
        fields(
            20,
            &[
                ("Home", status.home),
                ("Settings", status.settings),
                ("Daemon PID", &number(status.daemon_pid)),
                ("Keeper PID", &number(status.keeper_pid)),
            ]
        ),
        fields(
            20,
            &[(
                "Guest MCP",
                &format!("Add {} as a stdio server.", errors::quoted(launcher))
            )]
        ),
        fields(width, &machines),
    )
}
