//! What a failed command prints: the catalog of failures whose cause the command knows, and, for
//! every other failure of Facade's services, the service's own words without its reason code.

use std::fmt;
use std::path::PathBuf;

use facade_base::jsonrpc::{ErrorBody, Reason};

/// The word that names the human as a recipient or an agent reference.
const HUMAN: &str = "human";

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
    /// A message whose delivery cannot be confirmed.
    Unconfirmed {
        message: String,
        to: String,
        progress: String,
    },
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
        _ => return error,
    };
    problem.into()
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
