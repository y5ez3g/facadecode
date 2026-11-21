//! What a failed command prints: the catalog of failures whose cause the command knows, and, for
//! every other failure of Facade's services, the service's own words without its reason code.
//! Also the words of the failures that make them up, of `machine serve`'s failures, and the line
//! a command prints on taking over an older running Facade.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use facade_base::address::{default_machine_name, short_machine_id};
use facade_base::daemon::{DeliveryFailure, DeliveryStatus, display_line};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::ExecutionOutcome;
use facade_base::v3::{
    AgentLabel, AgentState, MachineQueryResult, MachineQueryStatus, MachineState, SendResult,
};

use crate::single_line;

/// The service's refusal of a machine reference that names no machine.
const NO_MACHINE: &str = "no machine matches that address";

/// How the service begins its refusal where SSH found no `facade` on the other machine.
const NO_FACADE: &str = "SSH could not find facade on ";

/// How the service begins its refusal where the other machine's startup files printed text.
const STARTUP_PRINTS: &str = "Unexpected SSH stdout during the machine handshake";

/// A failure whose cause the command knows, worded for the reader.
#[derive(Debug)]
pub(crate) enum Problem {
    /// A Shell operation failure with its complete diagnostic and any guidance.
    Operation(String),
    /// A Shell diagnostic with guidance that a batch can print once.
    OperationWithFollowUp {
        message: String,
        follow_up: &'static str,
    },
    /// An operation wanted a running agent and the Orchestrator found an ended one.
    Ended { diagnostic: String, agent: String },
    /// The start command omitted the CLI name.
    MissingCli { available: Vec<String> },
    /// Facade could not be reached or started; `log` is the log that says why, where known.
    Unreachable { why: String, log: Option<PathBuf> },
    /// Facade's settings file cannot be used.
    Settings { diagnostic: String },
    /// No machine has the name or ID the reader gave.
    NoMachine { given: String },
    /// The request's machine could not be reached.
    MachineUnreachable { diagnostic: String },
    /// A machine stopped responding after a call reached it, so its result is unknown.
    MachineStoppedResponding { machine: String },
    /// SSH reached the other machine, but no `facade` there.
    NoFacade { destination: String },
    /// The other machine's shell startup files printed text into the connection.
    StartupPrints { destination: String },
    /// The two machines' builds share no protocol version.
    Version {
        machine: String,
        theirs: String,
        ours: String,
    },
    /// Two running machines share a machine ID: a copied Facade home.
    SameMachineId { short: String, paths: [String; 2] },
    /// A saved connection's SSH needs a person: the command that repairs it.
    SshLogin {
        machine: String,
        repair: Vec<String>,
    },
    /// The daemon authorized a connection without naming its SSH destination.
    NoSshDestination,
}

impl Problem {
    /// The exit code of a command that ends with this problem.
    pub(crate) fn exit_code(&self) -> i32 {
        match self {
            Problem::MissingCli { .. } => 2,
            _ => 1,
        }
    }

    /// What happened, and the next step where there is one.
    fn lines(&self) -> (String, Option<String>) {
        match self {
            Problem::Operation(message) => (message.clone(), None),
            Problem::OperationWithFollowUp { message, follow_up } => {
                (format!("{message}\n{follow_up}"), None)
            }
            Problem::Ended { diagnostic, agent } => (
                service_words(diagnostic),
                Some(format!(
                    "run 'facade screen {agent}' for the last screen or 'facade resume {agent}' to continue"
                )),
            ),
            Problem::MissingCli { available } => {
                let choices = if available.is_empty() {
                    "Install a coding CLI or check facade.json.".into()
                } else {
                    available_clis(available)
                };
                (
                    format!(
                        "Choose a coding CLI to start.\n{choices}\n\
                     Usage: facade start [OPTIONS] <CLI> [CLI_ARGS]...\n\
                     Example: facade start codex\n\
                     Run 'facade start --help' for all options."
                    ),
                    None,
                )
            }
            Problem::Unreachable { why, log } => (
                format!("could not connect to the Orchestrator: {why}"),
                log.as_ref()
                    .map(|log| format!("check '{}' for details", log.display())),
            ),
            Problem::Settings { diagnostic } => (
                format!("could not use the settings file: {diagnostic}"),
                Some("fix the settings file and try again".into()),
            ),
            Problem::NoMachine { given } => (
                format!("no machine '{given}'"),
                Some("run 'facade machine list' to see your machines".into()),
            ),
            Problem::MachineUnreachable { diagnostic } => (
                service_words(diagnostic),
                Some("run 'facade machine list' to check the connection".into()),
            ),
            Problem::MachineStoppedResponding { machine } => (
                format!("could not confirm the result: {machine} stopped responding"),
                Some("run 'facade machine list' to check the connection".into()),
            ),
            Problem::NoFacade { destination } => (
                format!("could not find facade on {destination}"),
                Some(format!(
                    "run the Facade Code installer on {destination} and try again"
                )),
            ),
            Problem::StartupPrints { destination } => (
                format!(
                    "the shell startup files on {destination} print text, which breaks the \
                     connection"
                ),
                Some("make them print nothing when SSH runs a command, then try again".into()),
            ),
            Problem::Version {
                machine,
                theirs,
                ours,
            } => (
                format!("{machine} runs Orchestrator {theirs}, which cannot connect to {ours}"),
                Some(if facade_base::takes_over(theirs, ours) {
                    "run 'facade upgrade' here and try again".into()
                } else {
                    format!("install Facade Code {ours} on {machine}")
                }),
            ),
            Problem::SameMachineId { short, paths } => (
                format!(
                    "two running machines have the same ID {short}: {} and {}",
                    paths[0], paths[1]
                ),
                Some("a Facade home was copied; give the copy a new, empty Facade home".into()),
            ),
            Problem::SshLogin { machine, repair } => (
                format!("SSH to {machine} needs you to log in"),
                Some(repair_tip(repair)),
            ),
            Problem::NoSshDestination => (
                "the daemon did not supply the authorized SSH destination".into(),
                None,
            ),
        }
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (what, tip) = self.lines();
        write!(f, "error: {what}")?;
        match tip {
            Some(tip) => write!(f, "\n  tip: {tip}"),
            None => Ok(()),
        }
    }
}

impl std::error::Error for Problem {}

/// The service's refusal in `error`, if that is what it is.
fn service_error(error: &anyhow::Error) -> Option<&ErrorBody> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ErrorBody>())
}

pub(crate) const CHECK_MACHINES: &str = "Run 'facade machine list' to check machine status.";
const FIND_AGENT: &str = "Run 'facade list' to find an agent.";
const FIND_MACHINE: &str = "Run 'facade machine list' to find a machine.";
const STOP_GUEST: &str = "Stop it from the application running it.";

pub(crate) fn unsupported_command(command: &str) -> Problem {
    Problem::Operation(format!(
        "The running Orchestrator does not support {command}.\nRun 'facade upgrade' and try again."
    ))
}

pub(crate) fn quoted(text: &str) -> String {
    format!("\"{}\"", single_line(text).replace('"', "\\\""))
}

pub(crate) fn agent_label(name: Option<&str>, address: &str) -> String {
    let address = single_line(address);
    name.map_or_else(
        || address.clone(),
        |name| format!("{} ({address})", single_line(name)),
    )
}

pub(crate) fn state_name(state: AgentState) -> &'static str {
    match state {
        AgentState::Starting => "Starting",
        AgentState::Working => "Working",
        AgentState::WaitingForYou => "Waiting for you",
        AgentState::JustDone => "Just done",
        AgentState::Idle => "Idle",
        AgentState::Error => "Error",
        AgentState::Ended => "Ended",
        AgentState::Unknown | AgentState::Unrecognized => "Unknown",
        AgentState::Online => "Online",
    }
}

fn label(agent: &AgentLabel) -> String {
    agent_label(Some(&agent.name), &agent.address)
}

fn available_clis(clis: &[String]) -> String {
    let clis: Vec<_> = clis.iter().map(|cli| single_line(cli)).collect();
    format!("Available CLIs: {}", clis.join(", "))
}

pub(crate) fn machine_query_detail(machine: &MachineQueryResult) -> String {
    let fallback = match machine.state {
        MachineState::Connecting => "The connection is still being established.",
        MachineState::Sleeping => "The remote service is sleeping.",
        MachineState::SshInteractionRequired => "SSH needs interaction.",
        _ => match machine.status {
            MachineQueryStatus::TimedOut => "The query timed out.",
            MachineQueryStatus::Error => "The query failed.",
            _ => "The machine did not answer the query.",
        },
    };
    single_line(
        machine
            .error
            .as_deref()
            .or(machine.ssh_error.as_deref())
            .unwrap_or(fallback),
    )
}

pub(crate) fn machine_query_unanswered(machine: &MachineQueryResult) -> bool {
    match machine.status {
        MachineQueryStatus::Answered => false,
        MachineQueryStatus::Unavailable => machine.state != MachineState::Sleeping,
        MachineQueryStatus::TimedOut | MachineQueryStatus::Error => true,
    }
}

pub(crate) fn machine_query_failed(machine: &MachineQueryResult) -> Problem {
    connection_failed(&machine.name, &machine_query_detail(machine))
}

fn connection_failed(machine: &str, detail: &str) -> Problem {
    Problem::OperationWithFollowUp {
        message: format!(
            "Could not connect to machine {}: {}",
            quoted(machine),
            single_line(detail)
        ),
        follow_up: CHECK_MACHINES,
    }
}

fn candidate_rows(rows: &[Vec<String>]) -> String {
    let table = crate::table(&["", "", ""], rows);
    table
        .lines()
        .skip(1)
        .map(|row| format!("  {row}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn machine_failure(command: &str, selector: &str, error: &ErrorBody) -> Option<Problem> {
    let data = &error.data;
    let diagnostic = service_words(&error.message);
    match data.reason {
        Reason::AmbiguousReference if !data.machines.is_empty() => {
            let rows: Vec<_> = data
                .machines
                .iter()
                .map(|machine| {
                    let state = match machine.state {
                        MachineState::Online => "Online",
                        MachineState::Connecting => "Connecting",
                        MachineState::Disconnected => "Disconnected",
                        MachineState::Sleeping => "Sleeping",
                        MachineState::Unreachable => "Unreachable",
                        MachineState::SshInteractionRequired => "Needs SSH login",
                    };
                    vec![machine.selector.clone(), state.into(), String::new()]
                })
                .collect();
            let example = &data.machines[0].selector;
            let selection = if data.machines.iter().all(|machine| machine.name == selector) {
                "is named"
            } else {
                "matches"
            };
            let cli = if command == "start" { " codex" } else { "" };
            let example = if matches!(command, "start" | "list" | "resume") {
                format!("Example: facade {command} --machine {example}{cli}")
            } else if command == "stop --machine" {
                format!("Example: facade stop --machine {example}")
            } else {
                "Use the machine ID in the agent reference.".into()
            };
            Some(Problem::Operation(format!(
                "More than one machine {selection} {}.\n{}\n\
                 Use an exact machine ID from 'facade machine list'.\n{example}",
                quoted(selector),
                candidate_rows(&rows)
            )))
        }
        Reason::NotFound if error.message == NO_MACHINE => Some(Problem::OperationWithFollowUp {
            message: format!("No machine matches {}.", quoted(selector)),
            follow_up: FIND_MACHINE,
        }),
        Reason::Unavailable | Reason::SshInteractionRequired => {
            if let Some(machine) = data.machines.first() {
                let detail = machine
                    .error
                    .as_deref()
                    .or(machine.ssh_error.as_deref())
                    .unwrap_or(&diagnostic);
                return Some(connection_failed(&machine.name, detail));
            }
            let unavailable = data.unavailable.as_ref()?;
            if unavailable.execution != ExecutionOutcome::NotExecuted
                || !unavailable.unanswered.is_empty()
            {
                return None;
            }
            let machine = unavailable.machine.as_ref()?;
            Some(connection_failed(&machine.name, &diagnostic))
        }
        _ => None,
    }
}

pub(crate) fn query_failed(
    command: &str,
    machine: Option<&str>,
    error: anyhow::Error,
) -> anyhow::Error {
    if let Some(machine) = machine
        && let Some(body) = service_error(&error)
    {
        if let Some(problem) = machine_failure(command, machine, body) {
            return problem.into();
        }
        if matches!(
            body.data.reason,
            Reason::Unavailable | Reason::SshInteractionRequired
        ) {
            return connection_failed(machine, &service_words(&body.message)).into();
        }
    }
    error
}

pub(crate) fn start_failed(
    cli: &str,
    machine: Option<&str>,
    branch: Option<&str>,
    error: anyhow::Error,
) -> anyhow::Error {
    let body = service_error(&error);
    if let Some(body) = body {
        if let Some(machine) = machine
            && let Some(problem) = machine_failure("start", machine, body)
        {
            return problem.into();
        }
        if body.data.reason == Reason::ConfigurationInvalid {
            return settings(error);
        }
        if body.data.reason == Reason::NotFound
            && body.data.entry.is_none()
            && body.message.starts_with("No CLI ")
        {
            let on = machine.map_or_else(String::new, |name| format!(" on {}", single_line(name)));
            let help = if machine.is_some() {
                format!("Add custom CLIs in facade.json{on} (default: ~/.facade/facade.json).")
            } else {
                "Add custom CLIs in facade.json (run 'facade status' to locate it).".into()
            };
            let choices = &body.data.available_clis;
            let choices = if choices.is_empty() {
                String::new()
            } else {
                format!("\n{}", available_clis(choices))
            };
            return Problem::Operation(format!(
                "CLI {} is not configured{on}.{choices}\n{help}",
                quoted(cli)
            ))
            .into();
        }
    }

    let local = || default_machine_name(&facade_base::system::hostname().unwrap_or_default());
    let name = machine.map_or_else(local, single_line);
    let diagnostic = if let Some(body) =
        body.filter(|body| body.data.reason == Reason::NotFound && body.data.entry.is_some())
    {
        single_line(body.message.lines().next().unwrap_or_default())
    } else {
        single_line(&cause(&error))
    };
    let reason = body.map(|body| body.data.reason);
    let (operation, detail) = match (branch, reason) {
        (Some(branch), Some(reason)) if is_worktree_failure(branch, reason, &diagnostic) => {
            let detail = if diagnostic == format!("a branch named {branch} already exists") {
                format!("Branch {} already exists.", quoted(branch))
            } else if let Some(folder) = diagnostic.strip_suffix(" is not in a Git repository") {
                format!("{folder} is not a Git repository.")
            } else {
                sentence(&diagnostic)
            };
            (
                format!("Could not create worktree {}", quoted(branch)),
                detail,
            )
        }
        _ => (
            format!("Could not start {}", quoted(cli)),
            start_detail(&diagnostic),
        ),
    };
    Problem::Operation(format!("{operation} on {name}. {detail}")).into()
}

fn is_worktree_failure(branch: &str, reason: Reason, diagnostic: &str) -> bool {
    reason == Reason::WorktreeFailed
        || (reason == Reason::InvalidArgument
            && (diagnostic == format!("a branch named {branch} already exists")
                || diagnostic.ends_with(" is not in a Git repository")
                || diagnostic.ends_with(" has no commits yet")
                || diagnostic.starts_with("invalid branch name ")
                || diagnostic.ends_with(" must name the new branch directly")))
}

fn start_detail(diagnostic: &str) -> String {
    if let Some(folder) = diagnostic
        .strip_prefix("the folder ")
        .and_then(|text| text.strip_suffix(" does not exist"))
    {
        return format!("Working directory {} does not exist.", quoted(folder));
    }
    if let Some((configured, _)) =
        diagnostic.split_once(", which was not found on the PATH of a terminal in ")
        && let Some((_, value)) = configured.rsplit_once(" is ")
        && let Ok(program) = serde_json::from_str::<String>(value)
    {
        return format!("{} was not found on PATH.", single_line(&program));
    }
    if let Some((program, _)) =
        diagnostic.split_once(" was not found on the PATH of a terminal in ")
    {
        return format!(
            "{} was not found on PATH.",
            program.rsplit(": ").next().unwrap_or(program)
        );
    }
    if let Some(text) = diagnostic.strip_suffix(" is not a program that can be run")
        && let Some((_, program)) = text.split_once(", and ")
    {
        return format!("{program} was not found.");
    }
    sentence(diagnostic)
}

fn sentence(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let end = if text.ends_with(['.', '?', '!']) {
        ""
    } else {
        "."
    };
    format!("{}{}{end}", first.to_uppercase(), chars.as_str())
}

#[derive(Clone, Copy)]
pub(crate) enum AgentCommand {
    Attach,
    Resume,
    Rename,
    Screen,
    Send,
    Status,
    Stop,
    Type,
}

impl AgentCommand {
    fn name(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Resume => "resume",
            Self::Rename => "rename",
            Self::Screen => "screen",
            Self::Send => "send",
            Self::Status => "status",
            Self::Stop => "stop",
            Self::Type => "type",
        }
    }

    fn example(self, address: &str) -> String {
        let args = match self {
            Self::Rename => " review",
            Self::Send => " \"Check the build\"",
            Self::Type => " --key Enter",
            _ => "",
        };
        format!("Example: facade {} {address}{args}", self.name())
    }
}

pub(crate) fn agent_failed(
    command: AgentCommand,
    input: &str,
    error: anyhow::Error,
) -> anyhow::Error {
    let Some(body) = service_error(&error) else {
        return error;
    };
    let data = &body.data;
    let agents = data.agents.as_slice();
    let reason = data.reason;
    let diagnostic = service_words(&body.message);
    if reason == Reason::AmbiguousReference && !data.sessions.is_empty() && agents.is_empty() {
        let rows: Vec<_> = data
            .sessions
            .iter()
            .map(|session| {
                let title = session
                    .title
                    .as_deref()
                    .map(|title| display_line(title, 40));
                vec![
                    session.id.clone(),
                    session.cli.clone(),
                    title
                        .filter(|title| !title.is_empty())
                        .unwrap_or_else(|| "-".into()),
                ]
            })
            .collect();
        return Problem::Operation(format!(
            "More than one saved session matches {}.\n{}\n\
             Use a full session ID.\n{}",
            quoted(input),
            candidate_rows(&rows),
            command.example(&data.sessions[0].id),
        ))
        .into();
    }
    if reason == Reason::AmbiguousReference && agents.len() > 1 && data.sessions.is_empty() {
        let rows: Vec<_> = agents
            .iter()
            .map(|agent| {
                vec![
                    agent.address.clone(),
                    agent.cli.clone(),
                    state_name(agent.state).into(),
                ]
            })
            .collect();
        let active = if agents.iter().all(|agent| agent.state != AgentState::Ended) {
            "active "
        } else {
            ""
        };
        let selection = if agents.iter().all(|agent| agent.name.trim() == input.trim()) {
            "is named"
        } else {
            "matches"
        };
        return Problem::Operation(format!(
            "More than one {active}agent or guest {selection} {}.\n{}\n\
             Use an exact agent reference.\n{}",
            quoted(input),
            candidate_rows(&rows),
            command.example(&agents[0].address),
        ))
        .into();
    }
    if let [agent] = agents {
        if matches!(command, AgentCommand::Stop)
            && data.unavailable.as_ref().is_some_and(|unavailable| {
                unavailable.execution == ExecutionOutcome::OutcomeUnknown
            })
        {
            return stop_unconfirmed(agent).into();
        }
        if let Some(problem) = agent_refusal(command, agent, reason, &diagnostic) {
            return problem.into();
        }
    }
    if let Some(problem) = machine_failure(command.name(), machine_of(input), body) {
        return problem.into();
    }
    if reason == Reason::NotFound && agents.is_empty() {
        let scope = match command {
            AgentCommand::Attach | AgentCommand::Stop | AgentCommand::Send | AgentCommand::Type => {
                "active "
            }
            _ => "",
        };
        return Problem::OperationWithFollowUp {
            message: format!("No {scope}agent or guest matches {}.", quoted(input)),
            follow_up: FIND_AGENT,
        }
        .into();
    }
    about_agent(input, error)
}

fn agent_refusal(
    command: AgentCommand,
    agent: &AgentLabel,
    reason: Reason,
    diagnostic: &str,
) -> Option<Problem> {
    let target = label(agent);
    let address = &agent.address;
    let message = match (command, reason) {
        (AgentCommand::Attach, Reason::Ended) => {
            format!(
                "{target} has stopped.\nRead its final screen with 'facade screen {address}'.{}",
                resume_tip(address, agent.resumable)
            )
        }
        (AgentCommand::Stop, Reason::Ended) => {
            return Some(already_stopped(&target, address, agent.resumable));
        }
        (AgentCommand::Send, Reason::Ended) if agent.state == AgentState::Ended => {
            return Some(stopped_send(&target, address, agent.resumable));
        }
        (AgentCommand::Type, Reason::Ended) => {
            format!("{target} has stopped and cannot accept input.")
        }
        (AgentCommand::Stop, Reason::Unsupported) if agent.state == AgentState::Online => {
            return Some(Problem::OperationWithFollowUp {
                message: format!("{target} is a guest and cannot be stopped by Facade."),
                follow_up: STOP_GUEST,
            });
        }
        (AgentCommand::Screen, Reason::Unsupported) if agent.state == AgentState::Online => {
            format!("{target} is a guest and has no terminal screen.")
        }
        (AgentCommand::Type, Reason::Unsupported) if agent.state == AgentState::Online => {
            format!(
                "{target} is a guest and has no terminal.\nUse 'facade send {address} ...' instead."
            )
        }
        (AgentCommand::Attach, Reason::Unsupported) if agent.state == AgentState::Online => {
            format!(
                "{target} is a guest and has no terminal.\nUse 'facade send {address} ...' to exchange messages with it."
            )
        }
        (AgentCommand::Resume, Reason::Unsupported) if agent.state == AgentState::Online => {
            format!("{target} is a guest and cannot be resumed by Facade.")
        }
        (AgentCommand::Resume, _)
            if diagnostic.contains("session")
                && (diagnostic.contains("is in use by")
                    || diagnostic.contains("is already open in")) =>
        {
            format!(
                "This session is already open in {target}.\nOpen it with 'facade attach {address}'."
            )
        }
        (AgentCommand::Resume, Reason::Unavailable | Reason::Refused)
            if diagnostic.contains("is running or already resuming")
                || diagnostic.contains("is already running") =>
        {
            format!("{target} is already running.\nOpen it with 'facade attach {address}'.")
        }
        (AgentCommand::Resume, Reason::Unavailable | Reason::Unsupported)
            if !agent.resumable
                && (diagnostic.contains("no recorded session")
                    || diagnostic.contains("no session to resume")
                    || diagnostic.contains("no saved session")
                    || diagnostic.contains("was not started by a CLI rule")
                    || diagnostic.contains("is a custom program")) =>
        {
            format!("{target} has no saved session to resume.")
        }
        (AgentCommand::Stop, Reason::Unavailable)
            if diagnostic.contains("stop wait") || diagnostic.contains("stopped responding") =>
        {
            return Some(stop_unconfirmed(agent));
        }
        _ => return None,
    };
    Some(Problem::Operation(message))
}

/// The batch prints shared guidance after reporting the failed targets and machines.
pub(crate) fn stop_diagnostic(
    error: &anyhow::Error,
    grouped: bool,
) -> (String, Option<&'static str>) {
    if grouped
        && let Some(Problem::OperationWithFollowUp { message, follow_up }) =
            error.downcast_ref::<Problem>()
    {
        let follow_up = match *follow_up {
            FIND_AGENT => Some("Run 'facade list' to check active agents."),
            FIND_MACHINE => Some(CHECK_MACHINES),
            STOP_GUEST => None,
            other => Some(other),
        };
        return (format!("error: {message}"), follow_up);
    }
    (words(error), None)
}

fn stop_unconfirmed(agent: &AgentLabel) -> Problem {
    Problem::Operation(format!(
        "Could not confirm that {} stopped. Check it with 'facade status {}'.",
        label(agent),
        agent.address,
    ))
}

pub(crate) fn already_stopped(agent: &str, address: &str, resumable: bool) -> Problem {
    Problem::Operation(format!(
        "{agent} is already stopped.{}",
        resume_tip(address, resumable)
    ))
}

fn stopped_send(agent: &str, address: &str, resumable: bool) -> Problem {
    Problem::Operation(format!(
        "{agent} has stopped and cannot receive messages.{}",
        resume_tip(address, resumable)
    ))
}

fn resume_tip(address: &str, resumable: bool) -> String {
    if resumable {
        format!("\nResume it with 'facade resume {address}'.")
    } else {
        String::new()
    }
}

pub(crate) fn delivery_receipt(result: &SendResult, given: &str) -> Result<String, Problem> {
    let recipient = result.recipient.as_ref();
    let target = recipient.map_or_else(|| single_line(given), label);
    let address = single_line(recipient.map_or(given, |agent| agent.address.as_str()));
    let id = &result.id;
    let delivery = &result.message.delivery;
    if delivery.status == DeliveryStatus::Success {
        return Ok(format!("Delivered {id} to {target}."));
    }
    let open = format!("Open it with 'facade attach {address}'");
    let check =
        format!("Check the terminal with 'facade attach {address}' or 'facade screen {address}'");
    let detail = match delivery.reason {
        Some(DeliveryFailure::Ended) => {
            return Err(stopped_send(
                &target,
                &address,
                recipient.is_some_and(|agent| agent.resumable),
            ));
        }
        Some(DeliveryFailure::SubmissionUnconfirmed) => {
            return Err(Problem::Operation(format!(
                "Could not confirm delivery of {id} to {target}.\n{check} before sending it again."
            )));
        }
        Some(DeliveryFailure::InputDraft) => {
            format!(
                "Its terminal has an unfinished draft.\n{open}. Submit or clear the draft, then try again."
            )
        }
        Some(DeliveryFailure::InputInteraction) => {
            format!(
                "Its CLI is waiting on a menu, sign-in, or prompt.\n{open} to answer first, then try again."
            )
        }
        Some(DeliveryFailure::Unsupported) if recipient.is_some() => format!(
            "Facade has no input rule configured for {}.\n{open} to type directly.",
            quoted(recipient.expect("resolved recipient").cli.as_str()),
        ),
        Some(DeliveryFailure::Timeout)
            if recipient.is_some_and(|agent| agent.state == AgentState::Online) =>
        {
            "The guest did not read its inbox within 30 seconds.".into()
        }
        Some(DeliveryFailure::InputUnknown | DeliveryFailure::Timeout) => {
            format!(
                "The delivery deadline passed before its terminal was ready.\n{check}, then try again."
            )
        }
        _ => sentence(&delivery.failure_words(&address)),
    };
    Err(Problem::Operation(format!(
        "Could not deliver {id} to {target}. {detail}"
    )))
}

/// Preserves the Orchestrator's lookup diagnostic and adds a command where it can help.
pub(crate) fn about_agent(given: &str, error: anyhow::Error) -> anyhow::Error {
    let Some(body) = service_error(&error) else {
        return error;
    };
    match body.data.reason {
        Reason::Ended => Problem::Ended {
            diagnostic: body.message.clone(),
            agent: body
                .data
                .candidates
                .first()
                .map_or_else(|| given.to_owned(), String::clone),
        }
        .into(),
        Reason::ConfigurationInvalid => settings(error),
        _ => about_machine(machine_of(given), error),
    }
}

/// The failure of a call that names `machine`, or reaches another machine for it, as a catalog row
/// where the service's facts identify one; otherwise `error` unchanged.
pub(crate) fn about_machine(machine: &str, error: anyhow::Error) -> anyhow::Error {
    let Some(body) = service_error(&error) else {
        return error;
    };
    let data = &body.data;
    let problem = match data.reason {
        Reason::NotFound if body.message == NO_MACHINE => Problem::NoMachine {
            given: machine.to_string(),
        },
        Reason::Unavailable => {
            let Some(unavailable) = &data.unavailable else {
                return error;
            };
            let name = unavailable
                .machine
                .as_ref()
                .map_or(machine.to_string(), |machine| machine.name.clone());
            match (unavailable.execution, unavailable.unanswered.is_empty()) {
                // A search can report which machines did not answer.
                (_, false) => return error,
                (ExecutionOutcome::NotExecuted, true) => Problem::MachineUnreachable {
                    diagnostic: body.message.clone(),
                },
                (ExecutionOutcome::OutcomeUnknown, true) => {
                    Problem::MachineStoppedResponding { machine: name }
                }
            }
        }
        Reason::SshInteractionRequired => match &data.ssh_interaction {
            Some(interaction) => Problem::SshLogin {
                machine: machine.to_string(),
                repair: interaction.command.clone(),
            },
            None => return error,
        },
        Reason::MachineIdConflict => match &data.machine_id_conflict {
            Some(conflict) => Problem::SameMachineId {
                short: short_machine_id(&conflict.machine_id),
                paths: conflict.paths.clone(),
            },
            None => return error,
        },
        _ => return error,
    };
    problem.into()
}

/// The failure of a connection to `destination` over SSH, as a catalog row where the service's
/// facts identify one; otherwise as [`about_machine`] does.
pub(crate) fn about_connection(destination: &str, error: anyhow::Error) -> anyhow::Error {
    let Some(body) = service_error(&error) else {
        return error;
    };
    let destination = destination.to_string();
    let problem = match body.data.reason {
        Reason::NotFound if body.message.starts_with(NO_FACADE) => {
            Problem::NoFacade { destination }
        }
        Reason::InvalidArgument if body.message.starts_with(STARTUP_PRINTS) => {
            Problem::StartupPrints { destination }
        }
        Reason::ProtocolIncompatible => match &body.data.protocol {
            // The service names the other machine only in its words: `… but gpu is running …`.
            Some(protocol) => Problem::Version {
                machine: body
                    .message
                    .split_once(" but ")
                    .and_then(|(_, rest)| rest.split_once(" is running Facade "))
                    .map_or(destination, |(name, _)| name.to_string()),
                theirs: protocol.remote_build.clone(),
                ours: protocol.local_build.clone(),
            },
            None => return error,
        },
        _ => return about_machine(&destination, error),
    };
    problem.into()
}

/// The machine `given` names after its last `@`, as `gpu` in `a17@gpu`; else `given`.
fn machine_of(given: &str) -> &str {
    given.rsplit_once('@').map_or(given, |(_, machine)| machine)
}

/// The tip with the command that repairs a saved connection: quoted for this system's shell, or,
/// where a word needs escaping no quoting gives safely, its words one per line.
pub(crate) fn repair_tip(words: &[String]) -> String {
    match repair_command(words) {
        Ok(command) => format!("run '{command}'"),
        Err(words) => {
            let mut tip = "run 'facade machine add' with these words, one per line:".to_string();
            for word in words {
                tip.push_str("\n        ");
                tip.push_str(&word);
            }
            tip
        }
    }
}

/// The repair command as one line for this system's shell, or each word, control characters
/// escaped, where one needs escaping that quoting cannot give.
pub(crate) fn repair_command(words: &[String]) -> Result<String, Vec<String>> {
    let windows = cfg!(windows);
    let unsafe_word = |word: &String| {
        word.chars().any(char::is_control)
            || (windows
                && (word.contains(['"', '%', '!', '$', '`', '“', '”'])
                    || (word.ends_with('\\') && !bare_word(word, windows))))
    };
    if words.iter().any(unsafe_word) {
        return Err(words
            .iter()
            .map(|word| match word.chars().any(char::is_control) {
                true => format!("{word:?}"),
                false => word.clone(),
            })
            .collect());
    }
    Ok(words
        .iter()
        .map(|word| {
            if bare_word(word, windows) {
                word.clone()
            } else if windows {
                format!("\"{word}\"")
            } else {
                format!("'{}'", word.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" "))
}

/// Whether `word` needs no quoting.
fn bare_word(word: &str, windows: bool) -> bool {
    !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./@:".contains(&b) || (windows && b == b'\\'))
}

/// The settings file's failure, with the service's diagnostic, which names its path.
fn settings(error: anyhow::Error) -> anyhow::Error {
    match service_error(&error) {
        Some(body) => Problem::Settings {
            diagnostic: service_words(&body.message),
        }
        .into(),
        None => error,
    }
}

/// A service's message without the clause meant for models: "nothing was done".
pub(crate) fn service_words(message: &str) -> String {
    message
        .split("; ")
        .filter(|clause| *clause != "nothing was done")
        .collect::<Vec<_>>()
        .join("; ")
}

/// What `error` prints: a catalog row, the service's own words, or the error's chain.
pub(crate) fn words(error: &anyhow::Error) -> String {
    if let Some(problem) = error.downcast_ref::<Problem>() {
        return problem.to_string();
    }
    match service_error(error) {
        Some(body) if body.data.reason == Reason::ConfigurationInvalid => Problem::Settings {
            diagnostic: service_words(&body.message),
        }
        .to_string(),
        Some(body) => {
            let message = service_words(&body.message);
            if body.data.reason == Reason::AmbiguousReference
                && body
                    .data
                    .candidates
                    .iter()
                    .any(|candidate| !message.contains(candidate))
            {
                format!(
                    "error: {message}\n  tip: choose {}",
                    body.data.candidates.join(", ")
                )
            } else {
                format!("error: {message}")
            }
        }
        None => format!("error: {error:#}"),
    }
}

/// Prints a command's error to stderr and returns the exit code it ends with.
pub(crate) fn report(error: &anyhow::Error) -> i32 {
    eprintln!("{}", words(error));
    exit_code(error)
}

pub(crate) fn exit_code(error: &anyhow::Error) -> i32 {
    if let Some(problem) = error.downcast_ref::<Problem>() {
        return problem.exit_code();
    }
    match service_error(error).map(|body| body.data.reason) {
        Some(Reason::InvalidArgument) => 2,
        _ => 1,
    }
}

/// Why `error` happened, without a prefix: the service's own words, or the error's chain.
pub(crate) fn cause(error: &anyhow::Error) -> String {
    match service_error(error) {
        Some(body) => service_words(&body.message),
        None => format!("{error:#}"),
    }
}

/// The context of a failure to start OpenSSH for `machine add` or `connect`.
pub(crate) const NO_OPENSSH: &str = "could not start OpenSSH";

/// Why SSH failed where it said nothing: its exit code, where it has one.
pub(crate) fn ssh_exit(code: Option<i32>) -> String {
    code.map_or_else(
        || "SSH ended without an exit code".to_string(),
        |code| format!("SSH exited with code {code}"),
    )
}

/// Why `machine serve`, which SSH runs for another machine, stopped. Like the other hidden
/// commands it prints after `facade: `; the connecting command passes it on to its reader.
#[derive(Debug)]
pub(crate) enum ServeFailure {
    /// `--home` names no absolute path.
    RelativeHome,
    /// The first frame was not a machine hello.
    NotMachineHello,
    /// The daemon closed, or sent something other than a response, after the hello.
    NoHelloAnswer,
    /// The daemon's response does not answer the hello.
    InvalidHelloAnswer,
    /// The daemon accepted the hello without a machine session.
    NoSession,
    /// The daemon's socket refused the connection.
    Socket { path: PathBuf, why: io::Error },
}

impl fmt::Display for ServeFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RelativeHome => f.write_str("the Facade home must be an absolute path"),
            Self::NotMachineHello => {
                f.write_str("machine serve requires a machine hello as its first frame")
            }
            Self::NoHelloAnswer => f.write_str("the daemon did not answer the machine hello"),
            Self::InvalidHelloAnswer => {
                f.write_str("the daemon returned an invalid machine hello response")
            }
            Self::NoSession => f.write_str("the daemon did not open a machine session"),
            Self::Socket { path, why } => write!(f, "cannot connect to {}: {why}", path.display()),
        }
    }
}

impl std::error::Error for ServeFailure {}

/// The line `machine serve` prints where copying one way between SSH and the daemon failed.
pub(crate) fn serve_copy_ended(to_daemon: bool, error: &io::Error) -> String {
    let direction = if to_daemon {
        "SSH input to daemon"
    } else {
        "daemon output to SSH"
    };
    format!(
        "facade: machine serve {direction} ended with {:?} ({error})",
        error.kind()
    )
}

/// Why Facade could not be reached where the keeper exited before it reported: the last line of
/// its log, where it logged one.
pub(crate) fn keeper_exited(line: Option<&str>) -> String {
    match line {
        Some(line) => format!("the Orchestrator keeper exited before it started, saying: {line}"),
        None => "the Orchestrator keeper exited before it started and logged nothing".to_string(),
    }
}

/// Why Facade could not be reached in `seconds`: a daemon that runs but is not ready, or none.
pub(crate) fn daemon_slow(daemon_runs: bool, seconds: u64) -> String {
    if daemon_runs {
        "Orchestrator is still starting".to_string()
    } else {
        format!("the Orchestrator daemon did not start within {seconds} seconds")
    }
}

/// `why`, with the log that says more, as `facade daemon --detach` prints it.
pub(crate) fn see_log(why: &str, log: &Path) -> String {
    format!("{why}; see {}", log.display())
}

/// The context of a takeover after which this build's daemon did not respond in `seconds`.
pub(crate) fn takeover_silent(ours: &str, seconds: u64) -> String {
    format!("Orchestrator {ours} did not respond within {seconds} seconds of taking over")
}

/// Why this build could not take over from the running Orchestrator.
pub(crate) fn takeover_refused(ours: &str, theirs: &str, error: &anyhow::Error) -> String {
    format!(
        "could not upgrade Orchestrator {theirs} to {ours}: {}",
        cause(error)
    )
}

/// The line a command prints where this build took over from `from`; `agents` says how many
/// agents kept running.
pub(crate) fn took_over(
    ours: &str,
    from: &str,
    agents: &str,
    took: Duration,
    hidden: bool,
) -> String {
    if hidden {
        return format!(
            "facade: Orchestrator {ours} took over from {from}. {agents} kept running ({:.1} s)",
            took.as_secs_f64()
        );
    }
    format!("note: upgraded Orchestrator {from} to {ours}. {agents} kept running")
}
