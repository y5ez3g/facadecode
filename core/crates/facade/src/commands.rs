//! The terminal commands: each uses the connection it is given and prints the result.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::SystemTime;

use facade_base::daemon::{DEFAULT_TERMINAL_SIZE, HowEnded, WaitKind, display_line, plain};
use facade_base::daemon_client::{DaemonClient, made_request_id};
use facade_base::process::ProcessState;
use facade_base::time::parse_iso_time;
use facade_base::v3::address::{
    default_machine_name, exact_machine_selector, parse_machine_selector,
};
use facade_base::v3::{
    AgentCreator, AgentInfo, AgentInspect, AgentInspectResult, AgentKind, AgentList, AgentListRow,
    AgentRename, AgentRenameArgs, AgentResume, AgentResumeList, AgentScreen, AgentScreenArgs,
    AgentSelectorArgs, AgentSend, AgentSendArgs, AgentStart, AgentState, AgentStop, AgentTarget,
    AgentType, AgentTypeArgs, AttachmentKind, CliList, CliListArgs, DaemonStatus, MachineIdentity,
    MachineList, MachineQueryArgs, MachineQueryResult, MachineQueryStatus, MachineState, NoArgs,
    ResumeArgs, ResumeCandidate, ResumeListArgs, ResumeTarget, StartArgs, StatusArgs, StatusResult,
};

use crate::cli::StartOptions;
use crate::errors::{self, AgentCommand, Problem};
use crate::{ExitText, Opening, Shown, single_line, table};

const ROSTER_COLUMNS: [&str; 8] = [
    "NAME",
    "REF",
    "STATE",
    "CLI",
    "TYPE",
    "WORKING DIRECTORY",
    "STARTED",
    "TITLE",
];

pub(crate) fn start(
    client: &mut DaemonClient,
    options: StartOptions,
    terminal: Option<(u16, u16)>,
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

    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
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
        machine,
        env: environment(),
        cols,
        rows,
        prompt: None,
        call_id: None,
        result_message_id: None,
        result_message_machine_id: None,
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
    if terminal.is_some() {
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
        machine,
        env: environment(),
    })?;
    if listed.settings_problem.is_some() {
        return Ok(Vec::new());
    }
    Ok(listed
        .clis
        .into_iter()
        .filter(|entry| entry.available)
        .map(|entry| entry.cli)
        .collect())
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
    terminal: Option<(u16, u16)>,
) -> anyhow::Result<Option<Shown>> {
    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
    let mut env = environment();
    env.insert("PWD".into(), current_dir()?);
    let resumed = client
        .call::<AgentResume>(ResumeArgs {
            target: ResumeTarget {
                reference: reference.clone(),
                machine: None,
                folder: None,
            },
            machine_id: None,
            env,
            cols,
            rows,
        })
        .map_err(|error| errors::agent_failed(AgentCommand::Resume, &reference, error))?;
    let cli = &resumed.agent.cli;
    if terminal.is_some() {
        let opening = if resumed.from_saved_session {
            Opening::SavedSession { cli: cli.clone() }
        } else {
            Opening::Resumed
        };
        return Ok(Some(shown(&resumed.agent, opening)));
    }
    let agent = label(&resumed.agent);
    if resumed.from_saved_session {
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
        target: AgentTarget::Reference {
            reference: agent.reference(),
        },
        opening,
    }
}

pub(crate) fn resume_list(
    client: &mut DaemonClient,
    machine: Option<String>,
) -> anyhow::Result<()> {
    let folder = if machine.is_none() {
        Some(current_dir()?)
    } else {
        None
    };
    let listed = client
        .call::<AgentResumeList>(ResumeListArgs {
            machine: machine.clone(),
            folder,
            all: true,
        })
        .map_err(|error| errors::query_failed("resume", machine.as_deref(), error))?;
    let (on, option) = query_scope(&listed.machines, machine.as_deref())?;
    if listed.items.is_empty() {
        eprintln!("No resumable agents or sessions found{on}.");
        eprintln!("Start a new agent with 'facade start{option} codex'.");
    } else {
        println_or_end!("{}", resume_list_text(&listed.items, SystemTime::now()));
        eprintln!("Resume one with 'facade resume <REFERENCE>'.");
    }
    if machine.is_none() {
        report_machines(&listed.machines);
    }
    Ok(())
}

pub(crate) fn list(client: &mut DaemonClient, machine: Option<String>) -> anyhow::Result<()> {
    let listed = client
        .call::<AgentList>(MachineQueryArgs {
            machine: machine.clone(),
        })
        .map_err(|error| errors::query_failed("list", machine.as_deref(), error))?;
    let (on, option) = query_scope(&listed.machines, machine.as_deref())?;
    if listed.agents.is_empty() {
        eprintln!("No active agents{on}.");
        eprintln!(
            "Start one with 'facade start{option} codex', or run 'facade resume{option}' to find saved sessions."
        );
    } else {
        let rows: Vec<_> = listed.agents.iter().map(|entry| &entry.row).collect();
        println_or_end!("{}", list_text(&rows, SystemTime::now()));
    }
    if machine.is_none() {
        report_machines(&listed.machines);
    }
    Ok(())
}

/// Use the selected machine's label for empty results and its copyable selector for commands.
fn query_scope(
    machines: &[MachineQueryResult],
    given: Option<&str>,
) -> anyhow::Result<(String, String)> {
    let Some(given) = given else {
        return Ok((String::new(), String::new()));
    };
    if let Some(machine) = machines.first() {
        if machine.status != MachineQueryStatus::Answered {
            return Err(errors::machine_query_failed(machine).into());
        }
        return Ok((
            format!(" on {}", single_line(&machine.name)),
            format!(" --machine {}", machine.selector),
        ));
    }
    Ok((
        format!(" on {}", single_line(given)),
        format!(" --machine {}", single_line(given)),
    ))
}

fn report_machines(machines: &[MachineQueryResult]) {
    let mut failed = false;
    for machine in machines {
        if machine.status == MachineQueryStatus::Answered || machine.state == MachineState::Sleeping
        {
            continue;
        }
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
        .call::<AgentScreen>(AgentScreenArgs {
            agent: agent.clone(),
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
    text: Option<String>,
    enter: bool,
    keys: Vec<String>,
) -> anyhow::Result<()> {
    let action = match keys.as_slice() {
        [key] => TypeAction::Key(single_line(key)),
        [] => TypeAction::Text { enter },
        keys => TypeAction::Keys(keys.len()),
    };
    let typed = client
        .call::<AgentType>(AgentTypeArgs {
            target: agent_selector(&agent).target,
            raw: None,
            text,
            enter,
            keys: (!keys.is_empty()).then_some(keys),
        })
        .map_err(|error| errors::agent_failed(AgentCommand::Type, &agent, error))?;
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
        }
    }
}

pub(crate) fn send(client: &mut DaemonClient, to: String, text: String) -> anyhow::Result<()> {
    let args = AgentSendArgs {
        to: to.clone(),
        text,
        reply_to: None,
        reply_to_machine_id: None,
        request_id: Some(made_request_id()),
        time_left_ms: None,
        allow_unsupported_receipt: true,
    };
    let (result, _) = client
        .call_with_request_id::<AgentSend>(args, false)
        .map_err(|error| errors::agent_failed(AgentCommand::Send, &to, error))?;
    println_or_end!("{}", errors::delivery_receipt(&result, &to)?);
    Ok(())
}

pub(crate) fn rename(client: &mut DaemonClient, agent: String, name: String) -> anyhow::Result<()> {
    let renamed = client
        .call::<AgentRename>(AgentRenameArgs {
            target: agent_selector(&agent).target,
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

pub(crate) fn stop(client: &mut DaemonClient, agent: String) -> anyhow::Result<()> {
    let stopped = client
        .call::<AgentStop>(agent_selector(&agent))
        .map_err(|error| errors::agent_failed(AgentCommand::Stop, &agent, error))?;
    let label = errors::agent_label(
        stopped.agent.as_ref().map(|agent| agent.name.as_str()),
        &stopped.address,
    );
    if stopped.already_ended {
        return Err(errors::already_stopped(
            &label,
            &stopped.address,
            stopped.agent.as_ref().is_some_and(|agent| agent.resumable),
        )
        .into());
    }
    println_or_end!("Stopped {label}.");
    Ok(())
}

fn agent_selector(agent: &str) -> AgentSelectorArgs {
    AgentSelectorArgs {
        target: AgentTarget::Address {
            agent: agent.to_owned(),
        },
    }
}

pub(crate) fn status(client: Option<&mut DaemonClient>) -> anyhow::Result<()> {
    let launcher = facade_base::programs::launcher("facade-mcp")
        .ok()
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "facade-mcp".into());
    let cli_version = facade_base::version();
    let text = match client {
        Some(client) => {
            let result = client.call::<DaemonStatus>(StatusArgs::default())?;
            status_text(
                &result,
                &client.hello_result.machine_id,
                &cli_version,
                &launcher,
            )
        }
        None => {
            let home = facade_base::paths::facade_home()?;
            let settings = facade_base::settings::settings_file()?;
            let machine = facade_daemon::offline_machine_name().unwrap_or_else(default_local_name);
            sleeping_text(
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

/// Pass the shell's environment to the daemon for local launches.
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
            return "Stopped".into();
        }
        return match &agent.exit {
            Some(exit) if exit.code.is_some() => format!("Exited ({})", ExitText(exit)),
            Some(exit) if exit.signal.is_some() => format!("Ended by signal {}", ExitText(exit)),
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

fn title_cell(title: Option<&str>) -> String {
    let title = title.map_or(String::new(), |title| display_line(title, 40));
    value_or_dash(&title).into()
}

pub(crate) fn list_text(agents: &[&AgentListRow], now: SystemTime) -> String {
    let rows: Vec<_> = agents
        .iter()
        .map(|agent| {
            vec![
                agent.name.clone(),
                agent.id.clone(),
                errors::state_name(agent.state).into(),
                agent.cli.clone(),
                kind_words(agent.kind).into(),
                if agent.kind == AgentKind::Managed {
                    value_or_dash(&agent.folder).into()
                } else {
                    "-".into()
                },
                age(&agent.started_at, now),
                title_cell(agent.title.as_deref()),
            ]
        })
        .collect();
    table(&ROSTER_COLUMNS, &rows)
}

pub(crate) fn resume_list_text(items: &[ResumeCandidate], now: SystemTime) -> String {
    let mut prefixes = HashMap::new();
    for item in items.iter().filter(|item| item.agent.is_none()) {
        *prefixes.entry(session_prefix(&item.session)).or_insert(0) += 1;
    }
    let rows: Vec<_> = items
        .iter()
        .map(|item| {
            let (reference, state, kind) = if item.agent.is_some() {
                let state = if item.stopped { "Stopped" } else { "Exited" };
                (item.target.reference.as_str(), state, "Managed")
            } else {
                let prefix = session_prefix(&item.session);
                let id = if prefixes[prefix] > 1 {
                    &item.session
                } else {
                    prefix
                };
                (id, "Saved", "Session")
            };
            vec![
                item.name.as_deref().unwrap_or("-").into(),
                reference.into(),
                state.into(),
                item.cli.clone(),
                kind.into(),
                value_or_dash(&item.folder).into(),
                item.at
                    .as_deref()
                    .map_or_else(|| "-".into(), |at| age(at, now)),
                title_cell(item.title.as_deref()),
            ]
        })
        .collect();
    let mut columns = ROSTER_COLUMNS;
    columns[6] = "UPDATED";
    table(&columns, &rows)
}

fn session_prefix(id: &str) -> &str {
    let end = id.char_indices().nth(8).map_or(id.len(), |(end, _)| end);
    &id[..end]
}

pub(crate) fn inspect_text(
    inspected: &AgentInspectResult,
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
        .map_or(agent.machine_id.as_str(), |(_, machine)| machine);
    let (folder, launch_command, session) = if managed {
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
                ("Title", agent.title.as_deref().unwrap_or("-")),
                ("Session", session),
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
            home,
            settings,
            ..ServiceFields::default()
        },
    )
}

pub(crate) fn status_text(
    status: &StatusResult,
    local_id: &str,
    cli_version: &str,
    launcher: &str,
) -> String {
    let version = facade_base::build_version(&status.build);
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
    let machines = status
        .machines
        .iter()
        .filter(|machine| machine.state == MachineState::Online && machine.machine_id != local_id)
        .map(|machine| machine.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    service_text(
        &headline,
        launcher,
        ServiceFields {
            cli_version: (version != cli_version).then_some(cli_version),
            agents: Some(status.agents),
            machines: &machines,
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
    agents: Option<usize>,
    machines: &'a str,
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
    summary.extend([
        ("Active agents", agents.as_str()),
        ("Connected machines", status.machines),
    ]);
    format!(
        "{headline}\n{}\n\n{}\n\n{}",
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
    )
}
