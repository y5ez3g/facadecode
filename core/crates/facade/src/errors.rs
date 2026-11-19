//! What a failed command prints: the catalog of failures whose cause the command knows, and, for
//! every other failure of Facade's services, the service's own words without its reason code.
//! Also the words of the failures that make them up, of `machine serve`'s failures, and the line
//! a command prints on taking over an older running Facade.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use facade_base::address::short_machine_id;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::key_input::{KeyProblem, MAX_KEYS};
use facade_base::machine::ExecutionOutcome;

/// The service's refusal of a machine reference that names no machine.
const NO_MACHINE: &str = "no machine matches that address";

/// How the service begins its refusal where SSH found no `facade` on the other machine.
const NO_FACADE: &str = "SSH could not find facade on ";

/// How the service begins its refusal where the other machine's startup files printed text.
const STARTUP_PRINTS: &str = "Unexpected SSH stdout during the machine handshake";

/// A failure whose cause the command knows, worded for the reader.
#[derive(Debug)]
pub(crate) enum Problem {
    /// An operation wanted a running agent and the Orchestrator found an ended one.
    Ended { diagnostic: String, agent: String },
    /// `attach` without an interactive terminal.
    NotInteractive { given: String },
    /// The start command omitted the CLI name.
    MissingCli { available: Vec<String> },
    /// An option before `start`'s CLI that Facade does not know.
    UnknownStartOption { option: String },
    /// The execution machine requires an absolute folder.
    StartFolder { machine: String, folder: String },
    /// The key batch or a key in it did not match the public syntax.
    Keys(KeyProblem),
    /// Text contains a control character that needs a named key.
    TypeControl { diagnostic: String },
    /// Facade could not be reached or started; `log` is the log that says why, where known.
    Unreachable { why: String, log: Option<PathBuf> },
    /// Facade's settings file cannot be used.
    Settings { diagnostic: String },
    /// A message that failed, with why.
    NotDelivered {
        message: String,
        to: String,
        why: String,
    },
    /// A message whose delivery cannot be confirmed.
    Unconfirmed {
        message: String,
        to: String,
        progress: String,
    },
    /// No machine has the name or ID the reader gave.
    NoMachine { given: String },
    /// The request's machine could not be reached.
    MachineUnreachable { diagnostic: String },
    /// A machine stopped responding after a call reached it, so its result is unknown.
    MachineStoppedResponding {
        machine: String,
        change: Option<(Change, String)>,
    },
    /// SSH failed before the machines connected: its last line says why.
    SshFailed { destination: String, why: String },
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
    /// A temporary connection that ended while `machine connect` ran.
    ConnectionLost {
        machine: String,
        destination: String,
    },
    /// SSH exited cleanly before the machines connected; nothing says why, so no tip follows.
    SshClosed { destination: String },
    /// The daemon authorized a connection without naming its SSH destination.
    NoSshDestination,
}

/// What `stop` or `remove` was asked to do to an agent on another machine.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Change {
    Stop,
    Remove,
}

impl Problem {
    /// The exit code of a command that ends with this problem.
    pub(crate) fn exit_code(&self) -> i32 {
        match self {
            Problem::MissingCli { .. }
            | Problem::UnknownStartOption { .. }
            | Problem::StartFolder { .. }
            | Problem::Keys(_)
            | Problem::TypeControl { .. } => 2,
            _ => 1,
        }
    }

    /// What happened, and the next step where there is one.
    fn lines(&self) -> (String, Option<String>) {
        match self {
            Problem::Ended { diagnostic, agent } => (
                service_words(diagnostic),
                Some(format!(
                    "run 'facade screen {agent}' for the last screen or 'facade resume {agent}' to continue"
                )),
            ),
            Problem::NotInteractive { given } => (
                "'facade attach' needs an interactive terminal".into(),
                Some(format!(
                    "run 'facade screen {given}' to see its recent output"
                )),
            ),
            Problem::MissingCli { available } => (
                "choose a CLI to start".into(),
                Some(if available.is_empty() {
                    "check the CLI settings shown by 'facade status'".into()
                } else {
                    format!("available CLIs: {}", available.join(", "))
                }),
            ),
            Problem::UnknownStartOption { option } => (
                format!("unexpected option '{option}' before the CLI"),
                Some(if option == "--cwd" || option.starts_with("--cwd=") {
                    "use '--folder' to choose the agent's folder".into()
                } else {
                    "put CLI-specific options after the CLI name".into()
                }),
            ),
            Problem::StartFolder { machine, folder } => (
                format!("'--folder' needs an absolute path on '{machine}', got {folder:?}"),
                None,
            ),
            Problem::Keys(problem) => (
                problem.to_string(),
                Some(match problem {
                    KeyProblem::Count(_) => format!("use '--key' once per key, up to {MAX_KEYS}"),
                    KeyProblem::Unknown {
                        replacement: Some(name),
                        ..
                    } => format!("use {name:?}"),
                    KeyProblem::Unknown { .. } => "run 'facade type --help' to see the keys".into(),
                }),
            ),
            Problem::TypeControl { diagnostic } => (
                diagnostic.clone(),
                Some("press a control key with '--key', for example '--key Esc'".into()),
            ),
            Problem::Unreachable { why, log } => (
                format!("could not connect to the Orchestrator: {why}"),
                log.as_ref()
                    .map(|log| format!("check '{}' for details", log.display())),
            ),
            Problem::Settings { diagnostic } => (
                format!("could not use the settings file: {diagnostic}"),
                Some("fix the settings file and try again".into()),
            ),
            Problem::NotDelivered { message, to, why } => {
                (format!("{message} was not delivered to {to}: {why}"), None)
            }
            Problem::Unconfirmed {
                message,
                to,
                progress,
            } => (
                format!("could not confirm delivery of {message} to {to}: {progress}"),
                Some(format!(
                    "run 'facade screen {to}' and look for {message} in the input box or recent \
                     output before sending it again"
                )),
            ),
            Problem::NoMachine { given } => (
                format!("no machine '{given}'"),
                Some("run 'facade machine list' to see your machines".into()),
            ),
            Problem::MachineUnreachable { diagnostic } => (
                service_words(diagnostic),
                Some("run 'facade machine list' to check the connection".into()),
            ),
            Problem::MachineStoppedResponding { machine, change } => (
                match change {
                    Some((Change::Stop, id)) => {
                        format!("could not confirm that {id} stopped: {machine} stopped responding")
                    }
                    Some((Change::Remove, id)) => format!(
                        "could not confirm that {id} was removed: {machine} stopped responding"
                    ),
                    None => format!("could not confirm the result: {machine} stopped responding"),
                },
                Some(match change {
                    Some((_, id)) => format!("run 'facade inspect {id}' to check"),
                    None => "run 'facade machine list' to check the connection".into(),
                }),
            ),
            Problem::SshFailed { destination, why } => (
                format!("could not connect to {destination} over SSH: {why}"),
                Some(format!(
                    "run 'ssh {destination}' to check that you can log in"
                )),
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
            Problem::ConnectionLost {
                machine,
                destination,
            } => (
                format!("lost the connection to {machine}"),
                Some(format!(
                    "run 'facade machine connect {destination}' to connect again"
                )),
            ),
            Problem::SshClosed { destination } => (
                format!("SSH to {destination} closed before the machines connected"),
                None,
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
        _ => about_machine(machine_of(given), None, error),
    }
}

/// The failure of `stop` or `remove` of `given`, as [`about_agent`] does, saying what was not done
/// where the agent's machine could not be reached.
pub(crate) fn about_change(given: &str, change: Change, error: anyhow::Error) -> anyhow::Error {
    // Keep the Orchestrator's account of an incomplete search.
    if let Some(body) = service_error(&error)
        && body.data.reason == Reason::Unavailable
        && body
            .data
            .unavailable
            .as_ref()
            .is_some_and(|unavailable| unavailable.unanswered.is_empty())
    {
        return about_machine(machine_of(given), Some((change, given.to_string())), error);
    }
    about_agent(given, error)
}

/// A start's v2 folder refusal or machine error, using the names from the command line.
pub(crate) fn about_start(machine: &str, error: anyhow::Error) -> anyhow::Error {
    if let Some(body) = service_error(&error)
        && body.data.reason == Reason::InvalidArgument
        && let Some(folder) = body
            .message
            .strip_prefix("cwd must be an absolute path, not ")
    {
        return Problem::StartFolder {
            machine: machine.to_string(),
            folder: folder.to_string(),
        }
        .into();
    }
    about_machine(machine, None, error)
}

/// The failure of a call that names `machine`, or reaches another machine for it, as a catalog row
/// where the service's facts identify one; otherwise `error` unchanged.
pub(crate) fn about_machine(
    machine: &str,
    change: Option<(Change, String)>,
    error: anyhow::Error,
) -> anyhow::Error {
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
                (ExecutionOutcome::OutcomeUnknown, true) => Problem::MachineStoppedResponding {
                    machine: name,
                    change,
                },
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
        _ => return about_machine(&destination, None, error),
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
