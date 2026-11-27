//! Agent identity, records and presentation state.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::address::mcp::{exact_machine_selector, format_reference};
use crate::process::{EndReason, ProcessExit, ProcessState};

use super::machine::WindowRef;

impl ManagedAgent {
    pub fn reference(&self) -> AgentRef {
        AgentRef {
            machine_id: self.machine_id.clone(),
            agent_id: self.agent_id.clone(),
        }
    }

    pub fn creator_ref(&self) -> Option<AgentRef> {
        Some(AgentRef {
            machine_id: self
                .creator_machine_id
                .as_ref()
                .unwrap_or(&self.machine_id)
                .clone(),
            agent_id: self.creator.clone()?,
        })
    }
}

/// A CLI a start can run: an entry of Facade Code Framework's settings file (CONFIGURATION-2.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CliInfo {
    /// The name a start gives: a built-in's, such as `claude`, or the name of a CLI the settings
    /// file adds.
    pub cli: String,
    /// The name people know it by: a built-in's, such as `Claude Code`, or an added CLI's own.
    pub display_name: String,
    /// Whether it can be started: its entry is right and its program is found.
    pub available: bool,
    /// Why it cannot be started: what is wrong with its entry, or that its program cannot run where
    /// it would start, each said by its setting. Omitted where it can.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// A built-in CLI whose entry has no problem and names no program of its own, and whose
    /// program is not found where the start would run: not installed. Only with `available` false.
    /// A client may leave it out of its list instead of showing it as one that cannot start.
    /// Omitted otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub not_installed: bool,
    /// Whether a start can choose its model and its effort (CLIS-1.4).
    pub overrides: Overrides,
}

/// Whether a start can choose a CLI's model and its effort.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Overrides {
    pub model: bool,
    pub effort: bool,
}

/// `count` agents in words: `1 agent`, `3 agents`.
pub fn agents_word(count: usize) -> String {
    if count == 1 {
        "1 agent".into()
    } else {
        format!("{count} agents")
    }
}

/// An agent record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ManagedAgent {
    /// The stable ID is `a` followed by a number. It is unique within its Facade home while
    /// that home's SQLite database (`framework/facade.db`) retains the agent number counter.
    pub agent_id: String,
    /// The copyable address, including a machine selector. The serving daemon fills client views.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// The label in the serving client's machine view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The running machine is currently unreachable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unreachable: bool,
    /// The display name. Names are nonempty but may repeat.
    pub name: String,
    /// The CLI: the name of its entry in Facade Code Framework's settings file, a built-in's such as `claude` or
    /// an added one such as `Codex · work` (CONFIGURATION-2.1), or the program's file name for a
    /// program started by its path or name.
    pub cli: String,
    /// The CLI's working folder at startup.
    pub cwd: String,
    /// The ID of the Facade Code Framework machine that runs the agent.
    pub machine_id: String,
    /// One or more member windows, unique and sorted by machine ID and window ID.
    pub windows: Vec<WindowRef>,
    /// The ID of its location: the location `cwd` is, or the innermost one that contains `cwd`.
    pub location_id: String,
    /// The window that provided the agent's running location, where a window supplied it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_source_window: Option<WindowRef>,
    /// The CLI's process ID. Omitted for a guest, whose process Facade Code Framework does not know.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Whether the CLI is running or ended.
    pub process: ProcessState,
    /// Terminal width in columns. Omitted for a guest, which has no terminal of Facade Code Framework's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    /// Terminal height in rows. Omitted for a guest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    /// The start time in UTC ISO 8601 format with milliseconds.
    pub created_at: String,
    /// The agent whose client started it. Omitted where the person started it, and for a guest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    /// The creator's machine ID. Omitted when it is the record's own machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator_machine_id: Option<String>,
    /// The first agent of its creation tree: itself where it has no creator, or else its creator's
    /// root. It stays when agents of the tree end or go.
    pub root: String,
    /// The root agent's machine ID. Omitted when it is the record's own machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_machine_id: Option<String>,
    /// Whether its run has YOLO on: its CLI runs without asking, and it reaches every agent. With
    /// YOLO off, its CLI runs as it natively does, and it reaches only the agents of its creation
    /// tree. A launch takes it from Facade Code Framework's settings file, `facade.json`, as it is accepted; a
    /// guest as it joins.
    pub yolo: bool,
    /// The recorded exit. Omitted while the agent is running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<ProcessExit>,
    /// The ID of the CLI session the agent's CLI last reported, which `agent.resume` continues.
    /// Omitted until one is reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// What the agent is doing.
    pub state: ManagedAgentState,
    /// More about the state: what the CLI waits for, its own words, how its process ended, or why
    /// the state is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_detail: Option<StateDetail>,
    /// The last thing that went into the agent's message input. Omitted until something has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub said: Option<Said>,
    /// Whether the agent's CLI can use Facade Code Framework's tools.
    pub tools_state: ToolsState,
    /// Why the agent's CLI cannot use Facade Code Framework's tools. Omitted unless they are unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_reason: Option<ToolsReason>,
    /// A guest: a session of a CLI the person started outside Facade Code Framework, which joined through the
    /// CLI's hooks. Its terminal is not Facade Code Framework's: Facade Code Framework cannot read its screen, type into it,
    /// resize, stop or resume it. Omitted for an agent Facade Code Framework started.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub guest: bool,
}

/// Whether an agent's CLI can use Facade Code Framework's tools: `facade-mcp`, the MCP server that a CLI started
/// by its rule is given for its run.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolsState {
    /// The CLI was not given the tools: it has no rule, or its rule does not give them.
    NotInjected,
    /// The CLI was given the tools, and its server has not answered the CLI's `tools/list` yet.
    Connecting,
    /// The CLI's server answered its `tools/list` and holds a connection.
    Available,
    /// The CLI was given the tools but cannot use them; `tools_reason` says why.
    Unavailable,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl ToolsState {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolsState::NotInjected => "not_injected",
            ToolsState::Connecting => "connecting",
            ToolsState::Available => "available",
            ToolsState::Unavailable => "unavailable",
            ToolsState::Unknown => "unknown",
        }
    }
}

/// Why an agent's CLI cannot use the Facade Code Framework tools it was given.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolsReason {
    /// Facade Code Framework could not give them to this run's CLI; the daemon's log says why.
    NotGiven,
    /// Its Facade Code Framework server did not connect within 30 seconds of the run's start or resume, or of a
    /// daemon's recovery of the run.
    NotConnected,
    /// Its CLI starts its servers only with its first turn or its panel of servers, and the run's
    /// start could not have the panel start Facade Code Framework's server before the first turn; the daemon's log
    /// says why. The first turn starts it.
    NotStarted,
    /// Its Facade Code Framework server's last connection closed while the run went on.
    Disconnected,
    /// The CLI ended.
    Ended,
    /// A reason this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl ToolsReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolsReason::NotGiven => "not_given",
            ToolsReason::NotConnected => "not_connected",
            ToolsReason::NotStarted => "not_started",
            ToolsReason::Disconnected => "disconnected",
            ToolsReason::Ended => "ended",
            ToolsReason::Unknown => "unknown",
        }
    }

    /// The reason as words a person reads after the tools' state:
    /// `its Facade Code Framework server's connection closed`.
    pub fn words(self) -> &'static str {
        match self {
            ToolsReason::NotGiven => "Facade Code Framework could not give them to its CLI",
            ToolsReason::NotConnected => {
                "its Facade Code Framework server did not connect within 30 seconds"
            }
            ToolsReason::NotStarted => {
                "its CLI did not start its Facade Code Framework server before its first turn"
            }
            ToolsReason::Disconnected => "its Facade Code Framework server's connection closed",
            ToolsReason::Ended => "its CLI ended",
            ToolsReason::Unknown => "a reason this build does not recognize",
        }
    }
}

/// What an agent is doing, from its CLI's own status reports, from its screen where its CLI's rule
/// reads it, and from Facade Code Framework's own facts. The first state that holds, in this order, is the
/// agent's: `waiting_for_you`, `error`, `just_done`, `working`, `idle`, `starting`, then `unknown`;
/// `ended` once its process ended.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagedAgentState {
    /// The CLI has not shown what it is doing yet, within 30 seconds of its start or resume.
    Starting,
    /// The CLI is working, or stopped working less than a second ago.
    Working,
    /// The CLI waits for the person; `state_detail.kind` says for what. A menu or question it draws
    /// in place of its input counts, with `kind` `unknown` where it did not say, also while it
    /// starts.
    WaitingForYou,
    /// A turn ended while no terminal showed the agent. It stays so until one does. Work before the
    /// CLI is asked to do anything is no turn: an Enter typed into it asks, unless it answers a
    /// question the CLI shows. Words after the CLI's name at its start are the CLI's own and ask
    /// nothing.
    JustDone,
    /// The CLI is not working and waits for nothing.
    Idle,
    /// The CLI reported an error or its screen shows that the turn it reported ended failed, or,
    /// started by its rule's name, it showed nothing of what it is doing within 30 seconds of its
    /// start or resume.
    Error,
    /// The CLI's process ended; `state_detail.how` says how, where that is known.
    Ended,
    /// Nothing shows what the CLI is doing; `state_detail.reason` says why.
    Unknown,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

impl ManagedAgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            ManagedAgentState::Starting => "starting",
            ManagedAgentState::Working => "working",
            ManagedAgentState::WaitingForYou => "waiting_for_you",
            ManagedAgentState::JustDone => "just_done",
            ManagedAgentState::Idle => "idle",
            ManagedAgentState::Error => "error",
            ManagedAgentState::Ended => "ended",
            ManagedAgentState::Unknown => "unknown",
            ManagedAgentState::Unrecognized => "unrecognized",
        }
    }
}

/// More about an agent's state.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct StateDetail {
    /// What the CLI waits for, on `waiting_for_you`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<WaitKind>,
    /// The CLI's own words where it gave any, on `waiting_for_you` and on an `error` the CLI
    /// reported. Untrusted text on one line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// How the process ended, on `ended`. Omitted when its exit status is unavailable and Facade Code Framework
    /// did not stop it; `exit.reason` says what is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub how: Option<HowEnded>,
    /// Why nothing shows what the CLI is doing, on `unknown`, or what Facade Code Framework found wrong, on an
    /// `error` it found: a start that showed nothing, or tools the CLI cannot use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<StateReason>,
}

/// Why nothing shows what an agent's CLI is doing, or what Facade Code Framework found wrong with it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StateReason {
    /// `unknown`: a program without a rule has shown nothing of what it is doing since it started.
    NotShown,
    /// `unknown`: the CLI asked to report what it is doing and has not reported since.
    Asked,
    /// `unknown`: the CLI took back what it reported, or a full reset or a shell's new prompt ended
    /// it.
    TakenBack,
    /// `unknown`: the CLI's screen shows nothing its rule recognizes.
    Unrecognized,
    /// `error`: a CLI started by its rule's name showed nothing of what it is doing within 30
    /// seconds of its start or resume.
    NotReady,
    /// `error`: the CLI cannot use the Facade Code Framework tools it was given; `tools_reason` says why.
    ToolsUnavailable,
    /// A reason this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl StateReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StateReason::NotShown => "not_shown",
            StateReason::Asked => "asked",
            StateReason::TakenBack => "taken_back",
            StateReason::Unrecognized => "unrecognized",
            StateReason::NotReady => "not_ready",
            StateReason::ToolsUnavailable => "tools_unavailable",
            StateReason::Unknown => "unknown",
        }
    }

    /// The reason as words a person reads after the state: `its CLI took back what it reported`.
    pub fn words(self) -> &'static str {
        match self {
            StateReason::NotShown => {
                "its CLI has shown nothing of what it is doing since it started"
            }
            StateReason::Asked => {
                "its CLI asked to report what it is doing and has not reported since"
            }
            StateReason::TakenBack => "its CLI took back what it reported",
            StateReason::Unrecognized => "its screen shows nothing its CLI's rule recognizes",
            StateReason::NotReady => {
                "its CLI showed nothing of what it is doing within 30 seconds of its start"
            }
            StateReason::ToolsUnavailable => {
                "its CLI cannot use the Facade Code Framework tools it was given"
            }
            StateReason::Unknown => "a reason this build does not recognize",
        }
    }
}

/// What a CLI waits for.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WaitKind {
    /// The person's permission to go on.
    Permission,
    /// The person's answer to a question.
    Question,
    /// The person to sign in.
    Auth,
    /// The CLI did not say.
    Unknown,
    /// A kind this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

impl WaitKind {
    pub fn waiting_for(self) -> Option<&'static str> {
        match self {
            Self::Permission => Some("permission"),
            Self::Question => Some("an answer to its question"),
            Self::Auth => Some("someone to sign in"),
            Self::Unknown | Self::Unrecognized => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WaitKind::Permission => "permission",
            WaitKind::Question => "question",
            WaitKind::Auth => "auth",
            WaitKind::Unknown => "unknown",
            WaitKind::Unrecognized => "unrecognized",
        }
    }
}

/// How an agent's process ended.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HowEnded {
    /// It exited with code 0.
    Normal,
    /// Facade Code Framework stopped it.
    Stopped,
    /// It exited with another code, or a signal ended it.
    Crashed,
    /// A value this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl HowEnded {
    pub fn as_str(self) -> &'static str {
        match self {
            HowEnded::Normal => "normal",
            HowEnded::Stopped => "stopped",
            HowEnded::Crashed => "crashed",
            HowEnded::Unknown => "unknown",
        }
    }
}

pub fn exit_words(exit: &ProcessExit, how: Option<HowEnded>) -> String {
    let action = match how {
        Some(HowEnded::Stopped) => "was stopped",
        Some(HowEnded::Crashed) => "crashed",
        _ => "ended",
    };
    if let Some(code) = exit.code {
        format!("{action} with exit code {code}")
    } else if let Some(signal) = &exit.signal {
        format!(
            "{action} with signal {}",
            crate::model::terminal::display_name(signal)
        )
    } else if exit.reason == Some(EndReason::TerminalClosed) {
        format!("{action} after its terminal closed")
    } else {
        format!("{action}. Its exit status is unavailable")
    }
}

pub fn error_words(detail: Option<&StateDetail>, tools: Option<ToolsReason>) -> String {
    if let Some(text) = detail.and_then(|detail| detail.text.as_deref()) {
        format!(
            "reported an error: {}",
            crate::model::terminal::display_name(text)
        )
    } else if let Some(reason) = tools {
        format!(
            "is in Error because its Facade Code Framework tools are unavailable: {}",
            reason.words()
        )
    } else if let Some(reason) = detail.and_then(|detail| detail.reason) {
        format!("is in Error because {}", reason.words())
    } else {
        "is in Error".into()
    }
}

pub const ANSWER_WAIT: &str =
    "Use `read_screen` to read its screen, then `press_keys` or `type_text` to respond.";

/// The latest submission through an agent's terminal, from a person, an `agent.type` call with
/// `enter`, or a message Facade Code Framework delivered.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct Said {
    /// The text on one line, at most 1,024 characters.
    pub text: String,
    /// Who said it: an agent ID, or `human` for the person.
    pub from: String,
    /// The agent's name when it said it. Omitted for the person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// When, in UTC ISO 8601 format with milliseconds.
    pub at: String,
}

/// A change in the daemon's agent view before choosing a client representation.
#[derive(Clone, Debug)]
pub enum AgentsUpdate {
    Updated {
        agent: Box<ManagedAgent>,
    },
    Removed {
        machine_id: String,
        agent_id: String,
    },
}

/// Whether `text` can be a CLI's session ID, or a CLI's name: 1 to 128 letters, digits, `_`, `.`,
/// `:` and `-`. Claude Code, Codex, Muse Code and Pi give UUIDs, OpenCode IDs such as
/// `ses_e3274d49fffen6SKUCQGgsRrNF`.
pub fn is_session_id(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// An agent's durable identity, independently of names and routes.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
pub struct AgentRef {
    pub machine_id: String,
    pub agent_id: String,
}

impl AgentRef {
    pub fn exact_address(&self) -> String {
        self.address(&exact_machine_selector(&self.machine_id))
    }

    pub fn address(&self, machine_selector: &str) -> String {
        format_reference(&self.agent_id, Some(machine_selector))
    }

    pub fn label(&self, local_machine_id: &str, machine_selector: &str) -> String {
        format_reference(
            &self.agent_id,
            (self.machine_id != local_machine_id).then_some(machine_selector),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Managed,
    Guest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CreatorKind {
    Agent,
    CommandLine,
    VsCode,
}

/// The source of an agent's start, as displayed to the caller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentCreator {
    Agent { address: String },
    CommandLine,
    VsCode,
}

/// A saved session that matched the requested session ID.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionMatch {
    /// The full CLI session ID.
    pub id: String,
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// The identity and state of the reachable agent selected by an operation or offered as a match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentLabel {
    pub reference: AgentRef,
    /// The agent's address in the requesting daemon's machine view.
    pub address: String,
    pub name: String,
    pub cli: String,
    pub state: AgentState,
    /// The managed agent has a recorded session that Facade Code Framework can resume.
    pub resumable: bool,
}

/// The agent's current state.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    /// The CLI has not shown what it is doing yet, within 30 seconds of its start or resume.
    Starting,
    /// The CLI is working, or stopped working less than a second ago.
    Working,
    /// The CLI waits for the person; `state_detail.kind` says for what. A menu or question it draws
    /// in place of its input counts, with `kind` `unknown` where it did not say, also while it
    /// starts.
    WaitingForYou,
    /// A turn ended while no terminal showed the agent. It stays so until one does. Work before the
    /// CLI is asked to do anything is no turn: an Enter typed into it asks, unless it answers a
    /// question the CLI shows. Words after the CLI's name at its start are the CLI's own and ask
    /// nothing.
    JustDone,
    /// The CLI is not working and waits for nothing.
    Idle,
    /// The CLI reported an error or its screen shows that the turn it reported ended failed, or,
    /// started by its rule's name, it showed nothing of what it is doing within 30 seconds of its
    /// start or resume.
    Error,
    /// The CLI's process ended; `state_detail.how` says how, where that is known.
    Ended,
    /// Nothing shows what the CLI is doing; `state_detail.reason` says why.
    Unknown,
    /// A Guest is connected and can take messages.
    Online,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Online => "online",
            AgentState::Starting => "starting",
            AgentState::Working => "working",
            AgentState::WaitingForYou => "waiting_for_you",
            AgentState::JustDone => "just_done",
            AgentState::Idle => "idle",
            AgentState::Error => "error",
            AgentState::Ended => "ended",
            AgentState::Unknown => "unknown",
            AgentState::Unrecognized => "unrecognized",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Shell,
    VsCode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AttachmentInfo {
    pub kind: AttachmentKind,
    pub machine_id: String,
}

#[cfg(test)]
mod tests {
    use super::super::message::TextWritten;
    use super::*;
    use serde_json::json;

    #[test]
    fn a_state_s_reason_is_a_value_with_its_words_and_one_this_build_does_not_know_reads_as_unknown()
     {
        let reasons = [
            StateReason::NotShown,
            StateReason::Asked,
            StateReason::TakenBack,
            StateReason::Unrecognized,
            StateReason::NotReady,
        ];
        for reason in reasons {
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                json!(reason.as_str())
            );
            assert_eq!(
                serde_json::from_value::<StateReason>(json!(reason.as_str())).unwrap(),
                reason
            );
            assert!(
                reason.words().starts_with("its "),
                "{reason:?} reads after the state"
            );
        }
        assert_eq!(
            serde_json::from_value::<StateReason>(json!("asleep")).unwrap(),
            StateReason::Unknown
        );
        let detail = StateDetail {
            reason: Some(StateReason::NotReady),
            ..StateDetail::default()
        };
        assert_eq!(
            serde_json::to_value(detail).unwrap(),
            json!({ "reason": "not_ready" })
        );
    }

    #[test]
    fn values_this_build_does_not_know_read_as_unknown() {
        assert_eq!(
            serde_json::from_str::<ProcessState>("\"hibernating\"").unwrap(),
            ProcessState::Unknown
        );
        // `unknown` is a value of its own where a type has `Unrecognized`.
        assert_eq!(
            serde_json::from_str::<TextWritten>("\"unknown\"").unwrap(),
            TextWritten::Unknown
        );
        assert_eq!(
            serde_json::from_str::<TextWritten>("\"most\"").unwrap(),
            TextWritten::Unrecognized
        );
    }
}
