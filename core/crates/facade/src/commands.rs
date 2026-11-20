//! The terminal commands: each uses the connection it is given and prints the result.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;
use std::time::SystemTime;

use facade_base::daemon::{
    DEFAULT_TERMINAL_SIZE, DeliveryFailure, DeliveryStatus, HowEnded, WaitKind, display_line, plain,
};
use facade_base::daemon_client::{DaemonClient, made_request_id};
use facade_base::jsonrpc::ErrorBody;
use facade_base::operations::Operation;
use facade_base::time::parse_iso_time;
use facade_base::v3::address::{exact_machine_selector, parse_machine_selector};
use facade_base::v3::{
    AgentCreator, AgentInfo, AgentInspect, AgentInspectResult, AgentKind, AgentList,
    AgentListResult, AgentListRow, AgentRemove, AgentRename, AgentRenameArgs, AgentResume,
    AgentResumeList, AgentScreen, AgentScreenArgs, AgentSelectorArgs, AgentSend, AgentSendArgs,
    AgentStart, AgentState, AgentStop, AgentTarget, AgentType, AgentTypeArgs, CliList, CliListArgs,
    DaemonStatus, MachineIdentity, MachineList, MachineQueryArgs, MachineQueryResult,
    MachineQueryStatus, MachineState, NoArgs, ResumeArgs, ResumeListArgs, ResumeTarget, SendResult,
    StartArgs, StatusArgs, StatusResult,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::cli::StartOptions;
use crate::errors::{Change, Problem, about_agent, about_change, about_start, repair_command};
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

/// Starts an agent. Prints its address when detached, or returns it for attachment.
pub(crate) fn start(
    client: &mut DaemonClient,
    opts: StartOptions,
    terminal: Option<(u16, u16)>,
) -> anyhow::Result<Option<Shown>> {
    let StartOptions {
        name,
        prompt,
        mut machine,
        folder,
        worktree,
        model,
        effort,
        cli_and_args,
    } = opts;
    let Some((cli, args)) = cli_and_args.split_first() else {
        let folder = match folder {
            None if machine.is_none() => {
                Some(std::env::current_dir()?.to_string_lossy().into_owned())
            }
            folder => folder,
        };
        let listed = client.call::<CliList>(CliListArgs {
            machine,
            folder,
            env: environment(),
        })?;
        if let Some(problem) = listed.settings_problem {
            eprintln!("{}", single_line(&problem));
        }
        let available = listed
            .clis
            .into_iter()
            .filter(|entry| entry.available)
            .map(|entry| entry.cli)
            .collect();
        return Err(Problem::MissingCli { available }.into());
    };
    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
    let folder_is_default = folder.is_none();
    let on = machine.clone();
    let folder = match folder {
        Some(folder) if Path::new(&folder).is_relative() => {
            let local = match machine.as_deref() {
                None => true,
                Some(selector) => selects_local_machine(client, selector)?,
            };
            if local {
                // Keep the resolved folder on this machine even if its name changes.
                if machine.is_some() {
                    machine = Some(exact_machine_selector(&client.hello_result.machine_id));
                }
                std::path::absolute(folder)?.to_string_lossy().into_owned()
            } else {
                folder
            }
        }
        Some(folder) => folder,
        None => std::env::current_dir()?.to_string_lossy().into_owned(),
    };
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
        prompt,
        call_id: None,
        result_message_id: None,
        result_message_machine_id: None,
        request_id: Some(made_request_id()),
        worktree,
        model,
        effort,
    };
    let (started, _) = client
        .call_with_request_id::<AgentStart>(args, false)
        .map_err(|error| match &on {
            Some(machine) => about_start(machine, error),
            None => error,
        })?;
    let opening = Opening::Started {
        name: started.agent.name,
    };
    Ok(show(started.agent.address, opening, terminal))
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
    target: ResumeTarget,
    terminal: Option<(u16, u16)>,
) -> anyhow::Result<Option<Shown>> {
    let (cols, rows) = terminal.unwrap_or(DEFAULT_TERMINAL_SIZE);
    let reference = target.reference.clone();
    let mut env = environment();
    if target.folder.is_none() {
        env.insert(
            "PWD".into(),
            std::env::current_dir()?.to_string_lossy().into_owned(),
        );
    }
    let resumed = client
        .call::<AgentResume>(ResumeArgs {
            target,
            machine_id: None,
            env,
            cols,
            rows,
        })
        .map_err(|error| about_agent(&reference, error))?;
    let opening = Opening::Resumed {
        name: resumed.agent.name,
    };
    Ok(show(resumed.agent.address, opening, terminal))
}

pub(crate) fn resume_list(
    client: &mut DaemonClient,
    mut args: ResumeListArgs,
    format: Format,
) -> anyhow::Result<()> {
    if args.machine.is_none() && args.folder.is_none() {
        args.folder = Some(std::env::current_dir()?.to_string_lossy().into_owned());
    }
    let listed = client.call::<AgentResumeList>(args)?;
    match format {
        Format::Json => println_or_end!("{}", serde_json::to_string_pretty(&listed)?),
        Format::Text => {
            for item in &listed.items {
                let mut words = Vec::new();
                if let Some(machine) = &item.target.machine {
                    words.extend(["--machine".into(), machine.clone()]);
                }
                if let Some(folder) = &item.target.folder {
                    words.extend(["--folder".into(), folder.clone()]);
                }
                if item.target.reference.starts_with('-') {
                    words.push("--".into());
                }
                words.push(item.target.reference.clone());
                match repair_command(&words) {
                    Ok(arguments) => println_or_end!("{arguments}"),
                    Err(_) => eprintln!(
                        "warning: use --json to read the arguments for {}",
                        single_line(&item.target.reference)
                    ),
                }
            }
            report_machines(&listed.machines, "list resumable sessions");
        }
    }
    Ok(())
}

/// Returns the canonical address for an attachment or prints it when detached.
fn show(address: String, opening: Opening, terminal: Option<(u16, u16)>) -> Option<Shown> {
    if terminal.is_some() {
        return Some(Shown {
            agent: address,
            opening,
        });
    }
    println_or_end!("{address}");
    None
}

pub(crate) fn list(
    client: &mut DaemonClient,
    args: MachineQueryArgs,
    listing: Listing,
) -> anyhow::Result<()> {
    let listed = client.call::<AgentList>(args)?;
    if let Listing::Json = listing {
        let json = agent_list_json(&listed)?;
        println_or_end!("{}", serde_json::to_string_pretty(&json)?);
        return Ok(());
    }
    let rows: Vec<&AgentListRow> = listed.agents.iter().map(|entry| &entry.row).collect();
    match listing {
        Listing::Table if rows.is_empty() => eprintln!("No agents."),
        Listing::Table => println_or_end!("{}", list_text(&rows, SystemTime::now())),
        Listing::Quiet if !rows.is_empty() => println_or_end!("{}", quiet_text(&rows)),
        Listing::Quiet | Listing::Json => {}
    }
    report_machines(&listed.machines, "list agents");
    Ok(())
}

pub(crate) fn agent_list_json(listed: &AgentListResult) -> serde_json::Result<Value> {
    let agents: Vec<&AgentListRow> = listed.agents.iter().map(|entry| &entry.row).collect();
    Ok(json!({ "agents": serde_json::to_value(agents)?, "machines": listed.machines }))
}

fn report_machines(machines: &[MachineQueryResult], operation: &str) {
    for machine in machines {
        let status = match machine.state {
            MachineState::Online => match machine.status {
                MachineQueryStatus::Answered => continue,
                MachineQueryStatus::Unavailable => "query unavailable",
                MachineQueryStatus::TimedOut => "query timed out",
                MachineQueryStatus::Error => "query failed",
            },
            MachineState::Connecting => "connecting",
            MachineState::Sleeping => "sleeping",
            MachineState::Unreachable => "unreachable",
            MachineState::SshInteractionRequired => "needs SSH login",
        };
        let machine_name = single_line(&machine.selector);
        let mut detail = status.to_string();
        if let Some(last_seen) = &machine.last_seen {
            let _ = write!(detail, ", last seen {}", single_line(last_seen));
        }
        if let Some(ssh_error) = &machine.ssh_error {
            let _ = write!(detail, ", {}", single_line(ssh_error));
        }
        eprintln!("warning: could not {operation} on {machine_name}: {detail}");
    }
}

pub(crate) fn inspect(
    client: &mut DaemonClient,
    agent: String,
    format: Format,
) -> anyhow::Result<()> {
    let inspected = client
        .call::<AgentInspect>(AgentSelectorArgs {
            target: AgentTarget::Address {
                agent: agent.clone(),
            },
        })
        .map_err(|error| about_agent(&agent, error))?;
    let output = Inspection::from(&inspected);
    match format {
        Format::Text => println_or_end!("{}", output.text()),
        Format::Json => println_or_end!("{}", serde_json::to_string_pretty(&output)?),
    }
    Ok(())
}

/// Prints the screen's plain text or the same structured result that MCP uses.
pub(crate) fn screen(
    client: &mut DaemonClient,
    agent: String,
    lines: u16,
    format: Format,
) -> anyhow::Result<()> {
    let screen = client
        .call::<AgentScreen>(AgentScreenArgs {
            agent: agent.clone(),
            lines: Some(lines),
        })
        .map_err(|error| about_agent(&agent, error))?;
    match format {
        Format::Text if screen.line_count > 0 => println_or_end!("{}", plain(&screen.text)),
        Format::Text => {}
        Format::Json => println_or_end!("{}", serde_json::to_string_pretty(&screen)?),
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
    client
        .call::<AgentType>(AgentTypeArgs {
            target: AgentTarget::Address {
                agent: agent.clone(),
            },
            raw: None,
            text,
            enter,
            keys: (!keys.is_empty()).then_some(keys),
        })
        .map_err(|error| about_agent(&agent, error))?;
    Ok(())
}

pub(crate) fn send(client: &mut DaemonClient, to: String, text: String) -> anyhow::Result<()> {
    let args = AgentSendArgs {
        to: to.clone(),
        text,
        reply_to: None,
        reply_to_machine_id: None,
        request_id: Some(made_request_id()),
        time_left_ms: None,
        allow_unsupported_receipt: false,
    };
    let (result, _) = client
        .call_with_request_id::<AgentSend>(args, false)
        .map_err(|error| about_agent(&to, error))?;
    println_or_end!("{}", sent(result, &to)?);
    Ok(())
}

pub(crate) fn rename(client: &mut DaemonClient, agent: String, name: String) -> anyhow::Result<()> {
    let renamed = client
        .call::<AgentRename>(AgentRenameArgs {
            target: AgentTarget::Address {
                agent: agent.clone(),
            },
            name,
        })
        .map_err(|error| about_agent(&agent, error))?;
    println_or_end!(
        "{} {}",
        renamed.agent.address,
        single_line(&renamed.agent.name)
    );
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
        |stopped| stopped.address,
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
        |removed| removed.address,
        report,
    ))
}

/// Run one operation per argument. A service refusal leaves the connection usable.
fn change_agents<O: Operation<Args = AgentSelectorArgs>>(
    client: &mut DaemonClient,
    agents: Vec<String>,
    change: Change,
    address: impl Fn(O::Result) -> String,
    report: &dyn Fn(&anyhow::Error) -> i32,
) -> i32 {
    let mut code = 0;
    for agent in agents {
        match client.call::<O>(AgentSelectorArgs {
            target: AgentTarget::Address {
                agent: agent.clone(),
            },
        }) {
            Ok(result) => println_or_end!("{}", address(result)),
            Err(error) => {
                let refused = error.chain().any(|cause| cause.is::<ErrorBody>());
                code = code.max(report(&about_change(&agent, change, error)));
                if !refused {
                    return code.max(1);
                }
            }
        }
    }
    code
}

pub(crate) fn status(
    client: Option<&mut DaemonClient>,
    machine: Option<String>,
    format: Format,
) -> anyhow::Result<()> {
    match client {
        Some(client) => {
            let result = client.call::<DaemonStatus>(StatusArgs { machine })?;
            match format {
                Format::Text => {
                    println_or_end!("{}", status_text(&result, &facade_base::build_id()))
                }
                Format::Json => {
                    let mut output = serde_json::to_value(&result)?;
                    output["running"] = json!(true);
                    output["version"] = json!(facade_base::build_version(&result.build));
                    println_or_end!("{}", serde_json::to_string_pretty(&output)?);
                }
            }
        }
        None => {
            let home = facade_base::paths::facade_home()?;
            let settings = facade_base::settings::settings_file()?;
            let version = facade_base::version();
            let (home, settings) = (home.to_string_lossy(), settings.to_string_lossy());
            match format {
                Format::Text => println_or_end!("{}", sleeping_text(&home, &settings, &version)),
                Format::Json => println_or_end!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "running": false,
                        "home": home,
                        "settings_file": settings,
                        "version": version,
                    }))?
                ),
            }
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

pub(crate) fn age(started_at: &str, now: SystemTime) -> String {
    let Some(at) = parse_iso_time(started_at) else {
        return single_line(started_at);
    };
    let minutes = now.duration_since(at).unwrap_or_default().as_secs() / 60;
    match minutes {
        0..=59 => format!("{minutes}m"),
        60..=1439 => format!("{}h", minutes / 60),
        _ => format!("{}d", minutes / 1440),
    }
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

fn kind_words(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Managed => "managed",
        AgentKind::Guest => "guest",
    }
}

pub(crate) fn state_words(agent: &AgentInfo) -> String {
    let detail = agent.state_detail.as_ref();
    match agent.state {
        AgentState::WaitingForYou => match detail.and_then(|detail| detail.kind) {
            Some(WaitKind::Permission) => "waiting for you: permission".into(),
            Some(WaitKind::Question) => "waiting for you: question".into(),
            Some(WaitKind::Auth) => "waiting for you: sign-in".into(),
            _ => "waiting for you".into(),
        },
        AgentState::JustDone => "turn finished".into(),
        AgentState::Unrecognized => "unknown".into(),
        AgentState::Ended if detail.and_then(|detail| detail.how) == Some(HowEnded::Stopped) => {
            "stopped".into()
        }
        AgentState::Ended => match &agent.exit {
            Some(exit) if exit.code.is_some() => format!("exited: {}", ExitText(exit)),
            Some(exit) if exit.signal.is_some() => format!("ended by {}", ExitText(exit)),
            _ => "ended".into(),
        },
        state => state.as_str().into(),
    }
}

pub(crate) fn list_text(agents: &[&AgentListRow], now: SystemTime) -> String {
    let rows: Vec<Vec<String>> = agents
        .iter()
        .map(|agent| {
            vec![
                agent.id.clone(),
                agent.name.clone(),
                kind_words(agent.kind).into(),
                agent.state.as_str().into(),
                agent.cli.clone(),
                agent
                    .title
                    .as_deref()
                    .map_or_else(|| "-".into(), |title| display_line(title, 40)),
                agent.folder.clone(),
                age(&agent.started_at, now),
            ]
        })
        .collect();
    table(
        &[
            "ID", "NAME", "TYPE", "STATE", "CLI", "TITLE", "FOLDER", "AGE",
        ],
        &rows,
    )
}

pub(crate) fn quiet_text(agents: &[&AgentListRow]) -> String {
    agents
        .iter()
        .map(|agent| agent.id.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The same inspection facts are available to the reader and to scripts.
#[derive(Serialize)]
pub(crate) struct Inspection<'a> {
    id: &'a str,
    name: &'a str,
    #[serde(rename = "type")]
    kind: AgentKind,
    state: AgentState,
    state_detail: String,
    machine: &'a str,
    cli: &'a str,
    custom_program: bool,
    folder: &'a str,
    args: &'a [String],
    model: Option<&'a str>,
    effort: Option<&'a str>,
    session: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_by: Option<&'a AgentCreator>,
    viewers: &'a [String],
    yolo: bool,
}

impl<'a> From<&'a AgentInspectResult> for Inspection<'a> {
    fn from(inspected: &'a AgentInspectResult) -> Self {
        let agent = &inspected.agent;
        let mut detail = state_words(agent);
        if let Some(explanation) = agent.state_detail.as_ref().and_then(|detail| {
            detail
                .text
                .as_deref()
                .or_else(|| detail.reason.map(|reason| reason.words()))
        }) {
            let _ = write!(detail, " ({})", single_line(explanation));
        }
        Self {
            id: &agent.address,
            name: &agent.name,
            kind: agent.kind,
            state: agent.state,
            state_detail: detail,
            machine: agent
                .address
                .rsplit_once('@')
                .map_or(agent.machine_id.as_str(), |(_, machine)| machine),
            cli: &agent.cli,
            custom_program: agent.kind == AgentKind::Managed && inspected.rule.is_none(),
            folder: &agent.cwd,
            args: &agent.args,
            model: agent.model.as_deref(),
            effort: agent.effort.as_deref(),
            session: agent.session.as_deref(),
            started_by: inspected.started_by.as_ref(),
            viewers: &inspected.viewers,
            yolo: agent.yolo,
        }
    }
}

impl Inspection<'_> {
    pub(crate) fn text(&self) -> String {
        let cli = if self.custom_program {
            format!("{} (custom program)", self.cli)
        } else {
            self.cli.to_owned()
        };
        let args = if self.args.is_empty() {
            "none".into()
        } else {
            json!(self.args).to_string()
        };
        let viewers = if self.viewers.is_empty() {
            "none".into()
        } else {
            self.viewers.join(", ")
        };
        let started_by = match self.started_by {
            Some(AgentCreator::Agent { address }) => address,
            Some(AgentCreator::CommandLine) => "command line",
            Some(AgentCreator::VsCode) => "VS Code",
            None => "none",
        };
        [
            ("ID", self.id),
            ("Name", self.name),
            ("Type", kind_words(self.kind)),
            ("State", &self.state_detail),
            ("Machine", self.machine),
            ("CLI", &cli),
            ("Folder", self.folder),
            ("Args", &args),
            ("Model", self.model.unwrap_or("none")),
            ("Effort", self.effort.unwrap_or("none")),
            ("Session", self.session.unwrap_or("none")),
            ("Started by", started_by),
            ("Viewers", &viewers),
            ("YOLO", if self.yolo { "on" } else { "off" }),
        ]
        .iter()
        .map(|(label, value)| format!("{:<15}{}", format!("{label}:"), single_line(value)))
        .collect::<Vec<_>>()
        .join("\n")
    }
}

pub(crate) fn sleeping_text(home: &str, settings: &str, version: &str) -> String {
    format!(
        "Orchestrator sleeping.\n  Home:      {}\n  Settings:  {}\n  Version:   {}",
        single_line(home),
        single_line(settings),
        single_line(version),
    )
}

pub(crate) fn status_text(status: &StatusResult, local_build: &str) -> String {
    let version = facade_base::build_version(&status.build);
    let daemon = if status.build == local_build {
        format!("pid {}", status.daemon_pid)
    } else {
        format!("pid {} ({})", status.daemon_pid, single_line(&status.build))
    };
    let keeper = status
        .keeper_pid
        .map_or_else(|| "none".into(), |pid| format!("pid {pid}"));
    let machines = status
        .machines
        .iter()
        .filter(|machine| machine.state == MachineState::Online)
        .map(|machine| single_line(&machine.selector))
        .collect::<Vec<_>>()
        .join(", ");
    let machines = if machines.is_empty() {
        "none"
    } else {
        &machines
    };
    format!(
        "Orchestrator running.\n  Home:      {}\n  Settings:  {}\n  Version:   {}\n  Daemon:    {daemon}\n  Keeper:    {keeper}\n  Agents:    {}\n  Machines:  {machines}",
        single_line(&status.home),
        single_line(&status.settings_file),
        single_line(version),
        quantity(status.agents as u64),
    )
}

/// Only a finished delivery earns a receipt. Keep the daemon's failure reason and progress.
pub(crate) fn sent(result: SendResult, to: &str) -> Result<String, Problem> {
    let delivery = result.message.delivery;
    if delivery.status == DeliveryStatus::Success {
        return Ok(result.id);
    }
    let to = single_line(to);
    let why = delivery.failure_words(&to);
    if delivery.reason == Some(DeliveryFailure::SubmissionUnconfirmed) {
        return Err(Problem::Unconfirmed {
            message: result.id,
            to,
            progress: why,
        });
    }
    Err(Problem::NotDelivered {
        message: result.id,
        to,
        why,
    })
}
