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
use facade_base::machine::ExecutionOutcome;

/// The word that names the human as a recipient or an agent reference.
const HUMAN: &str = "human";

/// The service's refusal of a machine reference that names no machine.
const NO_MACHINE: &str = "no machine matches that address";

/// How the service begins its refusal where SSH found no `facade` on the other machine.
const NO_FACADE: &str = "SSH could not find facade on ";

/// How the service begins its refusal where the other machine's startup files printed text.
const STARTUP_PRINTS: &str = "Unexpected SSH stdout during the machine handshake";

/// How the service begins its refusal of a reference that names no agent: `no agent a9; …`.
const MISSING_AGENT: &str = "no agent ";

/// A failure whose cause the command knows, worded for the reader.
#[derive(Debug)]
pub(crate) enum Problem {
    /// No agent has the name or ID the reader gave.
    NoAgent { given: String },
    /// More than one agent has the name the reader gave.
    SeveralNamed { given: String },
    /// `human` names both the human and an agent; `sending` where the human could be meant.
    HumanCollision { given: String, sending: bool },
    /// The agent ended, so it takes no input or messages.
    Ended { agent: String },
    /// `resume` of an agent that runs.
    StillRunning { id: String },
    /// `resume` of an agent started as a plain program.
    PlainProgram { id: String },
    /// A guest, whose terminal is not Facade's.
    Guest { id: String },
    /// `attach` without an interactive terminal.
    NotInteractive { given: String },
    /// `messages` outside an agent's terminal.
    NotAgentTerminal,
    /// An option before `start`'s PROGRAM that Facade does not know.
    UnknownStartOption { option: String },
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
    /// A message to the human from an agent in no editor window, such as a guest.
    InNoWindow,
    /// A message to the human that none of the sender's windows showed, with each window's reason.
    NotShown { why: String },
    /// A message to the human whose windows' outcome is unknown.
    HumanUnconfirmed { message: String },
    /// A message whose delivery cannot be confirmed.
    Unconfirmed {
        message: String,
        to: String,
        progress: String,
    },
    /// No machine has the name or ID the reader gave.
    NoMachine { given: String },
    /// A machine an agent runs on could not be reached, so nothing was done; `change` is the
    /// agent `stop` or `remove` was asked to change.
    MachineUnreachable {
        machine: String,
        change: Option<(Change, String)>,
    },
    /// A machine stopped responding after a call reached it, so its result is unknown.
    MachineStoppedResponding {
        machine: String,
        change: Option<(Change, String)>,
    },
    /// A name no agent has on the machines that responded, while others did not respond.
    NoAgentWhereResponded { given: String, machines: String },
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
            Problem::UnknownStartOption { .. } => 2,
            _ => 1,
        }
    }

    /// What happened, and the next step where there is one.
    fn lines(&self) -> (String, Option<String>) {
        let list_tip = || Some("run 'facade list' and use the agent's ID".to_string());
        match self {
            Problem::NoAgent { given } => (
                format!("no agent '{given}'"),
                Some("run 'facade list' to see your agents".into()),
            ),
            Problem::SeveralNamed { given } => (
                format!("more than one agent is named '{given}'"),
                list_tip(),
            ),
            Problem::HumanCollision { given, sending } => (
                format!("'{given}' matches both the human and an agent named human"),
                match sending {
                    true => Some(
                        "quote '#human' for the human, or run 'facade list' for the agent's ID"
                            .into(),
                    ),
                    false => list_tip(),
                },
            ),
            Problem::Ended { agent } => (
                format!("{agent} has ended"),
                Some(format!(
                    "run 'facade inspect {agent}' to check for a saved session"
                )),
            ),
            Problem::StillRunning { id } => (
                format!("{id} is still running"),
                Some(format!("run 'facade attach {id}' to watch it")),
            ),
            Problem::PlainProgram { id } => (
                format!("{id} was started as a plain program and cannot resume"),
                None,
            ),
            Problem::Guest { id } => (
                format!("{id} was started outside Facade, so Facade cannot control it"),
                Some("use the program where the guest is running".into()),
            ),
            Problem::NotInteractive { given } => (
                "'facade attach' needs an interactive terminal".into(),
                Some(format!(
                    "run 'facade screen {given}' to see its recent output"
                )),
            ),
            Problem::NotAgentTerminal => (
                "'facade messages' reads an agent's inbox and must run in that agent's terminal"
                    .into(),
                Some("messages for the human appear in the editor window".into()),
            ),
            Problem::UnknownStartOption { option } => (
                format!("unexpected option '{option}' before the program"),
                Some(
                    "put the program's options after its name: 'facade start claude --model opus'"
                        .into(),
                ),
            ),
            Problem::Unreachable { why, log } => (
                format!("could not connect to Facade: {why}"),
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
            Problem::InNoWindow => (
                "the message was not delivered to the human: the agent is not in any editor window"
                    .into(),
                None,
            ),
            Problem::NotShown { why } => (
                format!("the message was not delivered to the human: {why}"),
                Some("open the agent in an editor window that shows Facade messages".into()),
            ),
            Problem::HumanUnconfirmed { message } => (
                format!("could not confirm delivery of {message} to the human"),
                Some(format!(
                    "look for {message} in your editor windows before sending it again"
                )),
            ),
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
            Problem::MachineUnreachable { machine, change } => (
                match change {
                    Some((Change::Stop, id)) => {
                        format!("could not connect to {machine} to stop {id}")
                    }
                    Some((Change::Remove, id)) => {
                        format!("could not connect to {machine} to remove {id}")
                    }
                    None => format!("could not connect to {machine}"),
                },
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
                Some("run 'facade list' to check".into()),
            ),
            Problem::NoAgentWhereResponded { given, machines } => (
                format!(
                    "no agent '{given}' on the machines that responded; {machines} did not respond"
                ),
                Some("run 'facade list' to see your agents".into()),
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
                    "install Facade on {destination} and add its folder to the PATH that SSH \
                     commands use"
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
                format!("{machine} runs Facade {theirs}, which cannot connect to Facade {ours}"),
                Some(format!("install Facade {ours} on {machine}")),
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

/// Whether `given` names the human: `human` or `@human`, in any case.
fn names_human(given: &str) -> bool {
    let name = given.trim();
    let name = name.strip_prefix('@').unwrap_or(name);
    name.eq_ignore_ascii_case(HUMAN)
}

/// The failure of a call that names one agent, `given` as the reader typed it, as a catalog row
/// where the service's reason identifies one; otherwise `error` unchanged.
pub(crate) fn about_agent(given: &str, error: anyhow::Error) -> anyhow::Error {
    let Some(body) = service_error(&error) else {
        return error;
    };
    // Only the service's own "no agent …" says the agent named is missing: a missing caller or
    // terminal is not found either.
    let missing = body.message.starts_with(MISSING_AGENT);
    let reason = body.data.reason;
    let given = given.to_string();
    let problem = match reason {
        Reason::NotFound if missing => Problem::NoAgent { given },
        Reason::AmbiguousReference if names_human(&given) => Problem::HumanCollision {
            given,
            sending: false,
        },
        Reason::AmbiguousReference => Problem::SeveralNamed { given },
        // The service names the ended agent by its ID only in these words; any other text, such
        // as input that partly reached the terminal, keeps the service's words.
        Reason::Ended => match ended_agent(&body.message) {
            Some(agent) => Problem::Ended { agent },
            None => return error,
        },
        Reason::ConfigurationInvalid => return settings(error),
        Reason::Unavailable
            if let Some(unavailable) = &body.data.unavailable
                && !unavailable.unanswered.is_empty()
                && unavailable.matches.is_empty() =>
        {
            Problem::NoAgentWhereResponded {
                given,
                machines: unavailable
                    .unanswered
                    .iter()
                    .map(|machine| machine.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            }
        }
        _ => return about_machine(machine_of(&given), None, error),
    };
    problem.into()
}

/// The failure of `stop` or `remove` of `given`, as [`about_agent`] does, saying what was not done
/// where the agent's machine could not be reached.
pub(crate) fn about_change(given: &str, change: Change, error: anyhow::Error) -> anyhow::Error {
    // A name search that some machines did not answer is `about_agent`'s to word.
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
                // A name lookup that some machines did not answer: `about_agent` words it.
                (_, false) => return error,
                (ExecutionOutcome::NotExecuted, true) => Problem::MachineUnreachable {
                    machine: name,
                    change,
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

/// The failure of `agent.send` to recipient `to`, as [`about_agent`] does, with the tip for a
/// recipient that may be the human, and the ended agent a unique name named.
pub(crate) fn about_send(to: &str, error: anyhow::Error) -> anyhow::Error {
    let Some(body) = service_error(&error) else {
        return error;
    };
    let reason = body.data.reason;
    if reason == Reason::Ended
        && let Some(agent) = ended_by_name(to, &body.message)
    {
        return Problem::Ended { agent }.into();
    }
    match reason {
        Reason::AmbiguousReference if names_human(to) => Problem::HumanCollision {
            given: to.to_string(),
            sending: true,
        }
        .into(),
        _ => about_agent(to, error),
    }
}

/// The agent ID in the service's refusal of a message to `to`, a name only one ended agent has:
/// `Ada ended: #a3 takes no messages`. None where the name is several agents', or for other words.
pub(crate) fn ended_by_name(to: &str, message: &str) -> Option<String> {
    let id = message
        .strip_prefix(to)?
        .strip_prefix(" ended: #")?
        .strip_suffix(" takes no messages")?;
    agent_id(id)
}

/// `id` where it is an agent ID, `a` and digits.
fn agent_id(id: &str) -> Option<String> {
    let digits = id.strip_prefix('a')?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| id.to_string())
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
        Some(body) => format!("error: {}", service_words(&body.message)),
        None => format!("error: {error:#}"),
    }
}

/// Prints a command's error to stderr and returns the exit code it ends with.
pub(crate) fn report(error: &anyhow::Error) -> i32 {
    eprintln!("{}", words(error));
    error
        .downcast_ref::<Problem>()
        .map_or(1, Problem::exit_code)
}

/// Why `error` happened, without a prefix: the service's own words, or the error's chain.
pub(crate) fn cause(error: &anyhow::Error) -> String {
    match service_error(error) {
        Some(body) => service_words(&body.message),
        None => format!("{error:#}"),
    }
}

/// The agent ID in the service's refusal of input or a message to an agent that ended:
/// `#a3 ended; nothing was typed` from `agent.type`, `#a3 ended; it takes no messages` from
/// `agent.send`. None for any other words.
pub(crate) fn ended_agent(message: &str) -> Option<String> {
    let ended = ["; nothing was typed", "; it takes no messages"]
        .iter()
        .find_map(|clause| message.strip_suffix(clause))?;
    agent_id(ended.strip_prefix('#')?.strip_suffix(" ended")?)
}

/// The bare agent ID that `given` writes, as `a3`, `#a3` or `3` do; None for a name.
pub(crate) fn bare_id(given: &str) -> Option<String> {
    let rest = given.trim();
    let rest = rest.strip_prefix('#').unwrap_or(rest);
    let digits = rest.strip_prefix('a').unwrap_or(rest);
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| format!("a{digits}"))
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
        Some(line) => format!("the Facade keeper exited before it started, saying: {line}"),
        None => "the Facade keeper exited before it started and logged nothing".to_string(),
    }
}

/// Why Facade could not be reached in `seconds`: a daemon that runs but is not ready, or none.
pub(crate) fn daemon_slow(daemon_runs: bool, seconds: u64) -> String {
    if daemon_runs {
        "Facade is still starting".to_string()
    } else {
        format!("the Facade daemon did not start within {seconds} seconds")
    }
}

/// `why`, with the log that says more, as `facade daemon --detach` prints it.
pub(crate) fn see_log(why: &str, log: &Path) -> String {
    format!("{why}; see {}", log.display())
}

/// The context of a takeover after which this build's daemon did not answer in `seconds`.
pub(crate) fn takeover_silent(ours: &str, seconds: u64) -> String {
    format!("Facade {ours} did not answer within {seconds} seconds of taking over")
}

/// The line a command prints where the running Facade `theirs` refused to let this build take
/// over. `hidden` is `facade daemon --detach`'s line for a program's log.
pub(crate) fn takeover_refused(
    ours: &str,
    theirs: &str,
    error: &anyhow::Error,
    hidden: bool,
) -> String {
    if hidden {
        return format!("facade: Facade {ours} could not take over from {theirs}: {error:#}");
    }
    format!(
        "warning: could not upgrade running Facade {theirs}: {}; continuing with {theirs}",
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
            "facade: Facade {ours} took over from {from}; {agents} kept running ({:.1} s)",
            took.as_secs_f64()
        );
    }
    format!("note: upgraded running Facade {from} to {ours}; {agents} kept running")
}

/// The line a command prints where the running Facade `theirs` answered again after a takeover
/// began: it runs on, and the logs say why.
pub(crate) fn older_runs_on(ours: &str, theirs: &str, logs: &str, hidden: bool) -> String {
    if hidden {
        return format!(
            "facade: Facade {ours} could not take over from {theirs}, which runs on; see {logs}"
        );
    }
    format!(
        "warning: could not upgrade running Facade {theirs}: check '{logs}' for details; \
         continuing with {theirs}"
    )
}
