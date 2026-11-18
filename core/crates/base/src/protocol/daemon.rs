//! The daemon protocol connects clients to the daemon over JSON-RPC 2.0, one message per line
//! ([`super::jsonrpc`]).
//!
//! An agent ID is `a` followed by a number, such as `a3`, unique within a Facade home. The counter
//! is saved before each number is assigned and continues across restarts while the home remains.
//! Separate homes count separately; deleting a home resets its counter. Clients can select an agent
//! by ID, `#a3`, `3`, a unique name with or without `@`, or a name followed by its ID, such as
//! `@Pixel #a3`.
//!
//! Absent optional fields are omitted. Ignore fields you do not recognize. Treat an unrecognized
//! enumeration value as unknown locally, and skip changes whose `kind` you do not recognize. The
//! Rust types provide `Unknown` variants for this purpose, or `Unrecognized` where `unknown` is a
//! value of its own. The daemon rejects unsupported client kinds at `hello`.

use std::collections::BTreeMap;
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

use super::address::{format_reference, parse_machine_selector};
use super::jsonrpc::ErrorBody;
use super::machine::{AgentRef, MachineHello, MessageRef};
use super::operations::{EmptyResult, NoArgs, Operation, OperationVisitor, Topic, TopicVisitor};
use crate::process::{ProcessExit, ProcessState};

impl AgentInfo {
    pub fn reference(&self) -> AgentRef {
        AgentRef {
            machine_id: self.machine_id.clone(),
            agent_id: self.agent_id.clone(),
        }
    }
}

impl ScreenSnapshot {
    pub fn reference(&self) -> AgentRef {
        AgentRef {
            machine_id: self.machine_id.clone(),
            agent_id: self.agent_id.clone(),
        }
    }
}

/// The supported daemon protocol version. `hello` selects the highest version shared by the client
/// and daemon.
pub const DAEMON_PROTOCOL_VERSION: u32 = 2;
pub const MIN_DAEMON_PROTOCOL_VERSION: u32 = 2;

/// The default number of lines returned by `agent.screen`.
pub const DEFAULT_SCREEN_LINES: u16 = 50;
/// The maximum number of lines returned by `agent.screen`.
pub const MAX_SCREEN_LINES: u16 = 2000;

/// The most characters (Unicode code points) a message carries.
pub const MAX_MESSAGE_CHARS: usize = 8000;
/// The most lines a message carries, whoever receives it: the most the slowest CLI to take a paste,
/// Antigravity, takes within a delivery.
pub const MAX_MESSAGE_LINES: usize = 540;
/// The default and largest number of messages in a page of the `messages` topic.
pub const DEFAULT_MESSAGES_LIMIT: u16 = 100;
pub const MAX_MESSAGES_LIMIT: u16 = 200;
/// The most message IDs one `messages` watch selects.
pub const MAX_MESSAGE_IDS: usize = 100;

/// The ID of the terminal window, which holds the agents started from a terminal rather than in an
/// editor window.
pub const TERMINAL_WINDOW: &str = "terminal";
/// The terminal window's name.
pub const TERMINAL_WINDOW_NAME: &str = "Terminal";

/// How Antigravity marks a long argument it cut to its last 8,000 characters before passing it on.
pub const CUT_MARK: &str = "[Earlier output truncated]";

/// How long the calls under way have to finish once a daemon hands over to a newer build,
/// `daemon.upgrade`.
pub const DRAIN_TIME: Duration = Duration::from_secs(3);
/// How long the agents of a daemon handing over have to stop reading their terminals, writing what
/// is queued for them first.
pub const QUIET_TIME: Duration = Duration::from_millis(500);
/// How long the connections of a daemon handing over have to answer `closing` before it ends.
pub const CLOSING_TIME: Duration = Duration::from_millis(300);
/// The longest a daemon takes to hand over once it answers `daemon.upgrade`, before the keeper
/// starts the new daemon: its drain, its agents going quiet, its connections' `closing`, and the
/// keys attached terminals sent until they answered.
pub const HANDOVER_TIME: Duration = DRAIN_TIME
    .saturating_add(QUIET_TIME)
    .saturating_add(CLOSING_TIME)
    .saturating_add(QUIET_TIME)
    .saturating_add(QUIET_TIME);

/// Refuses text a message cannot carry, saying why: blank text, more than [`MAX_MESSAGE_CHARS`]
/// characters or [`MAX_MESSAGE_LINES`] lines, a control character other than tab and line breaks,
/// or a beginning cut off on its way.
pub fn check_message_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("text is blank: a message needs text".into());
    }
    let length = text.chars().count();
    if length > MAX_MESSAGE_CHARS {
        return Err(format!(
            "text has {length} characters; a message carries at most {MAX_MESSAGE_CHARS}: send it \
             in shorter parts"
        ));
    }
    // A carriage return breaks a line as a line feed does, and the two together break it once.
    let lines = text.replace("\r\n", "\n").split(['\n', '\r']).count();
    if lines > MAX_MESSAGE_LINES {
        return Err(format!(
            "text has {lines} lines; a message carries at most {MAX_MESSAGE_LINES}: send it in \
             shorter parts"
        ));
    }
    if let Some(control) = first_control(text) {
        return Err(control);
    }
    if text.starts_with(CUT_MARK) {
        return Err(format!(
            "text starts with {CUT_MARK:?}: its beginning was cut on its way; send it in \
             shorter parts"
        ));
    }
    Ok(())
}

pub mod methods {
    pub const HELLO: &str = "hello";
    pub const CALL: &str = "call";
    pub const WATCH: &str = "watch";
    pub const UNWATCH: &str = "unwatch";
    pub const CANCEL: &str = "cancel";
    pub const CHANGED: &str = "changed";
    pub const CLOSING: &str = "closing";
    pub const WATCH_ENDED: &str = "watch_ended";
    pub const ADVERTISE: &str = "advertise";
    pub const FORWARD: &str = "forward";
    pub const CONNECTED: &str = "connected";
    pub const CONNECT_FAILED: &str = "connect_failed";
}

/// Method descriptions for the generated reference.
pub const METHODS: &[(&str, &str)] = &[
    (
        methods::HELLO,
        "Starts the connection (`HelloParams`). The result (`HelloResult`) describes the daemon.",
    ),
    (
        methods::CALL,
        "Runs an operation (`CallParams`) and returns its result.",
    ),
    (
        methods::WATCH,
        "Follows a topic (`WatchParams`). The result (`WatchResult`) contains its snapshot; \
         `changed` notifications follow.",
    ),
    (methods::UNWATCH, "Ends a watch (`UnwatchParams`)."),
    (
        methods::CANCEL,
        "Cancels a call still under way on this connection, by that call's request ID \
         (`CancelParams`), and answers `{}`. It withdraws only an `agent.send` whose message's \
         paste has not begun, which then answers `cancelled` and is not kept; every other call \
         goes on, and its own answer says what it did. Closing the connection withdraws nothing.",
    ),
    (
        methods::CHANGED,
        "Reports a change for one watch (`ChangedParams`).",
    ),
    (
        methods::WATCH_ENDED,
        "Ends a forwarded watch (`WatchEndedParams`).",
    ),
    (
        methods::ADVERTISE,
        "Replaces the directly connected machine's table (`AdvertiseParams`).",
    ),
    (
        methods::FORWARD,
        "Forwards a request to its destination (`ForwardParams`).",
    ),
    (
        methods::CONNECTED,
        "Reports the foreground connection's successful handshake to the local CLI (`ConnectedParams`).",
    ),
    (
        methods::CONNECT_FAILED,
        "Reports a foreground connection failure to the local CLI (`ConnectFailedParams`).",
    ),
    (
        methods::CLOSING,
        "From the daemon, a notification: a newer Facade takes over (`ClosingParams`). Every \
         answer this connection waits for has been written. The client sends nothing more but \
         `closing` back, a notification without params, and connects again; the new daemon answers \
         within seconds. A client that does not answer within 0.2 seconds is cut.",
    ),
];

/// The kind of client connecting to the daemon.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    /// A `facade` command, or a client that reads as one does, as `facade-mcp` does to learn where
    /// its agent works.
    Terminal,
    /// `facade-mcp`, the MCP server of one agent's CLI. Its hello names the agent it acts for.
    Mcp,
    /// An editor window: the part of it that runs where its agents run. Its hello describes the
    /// window, and it acts for the person.
    Ide,
    /// The start of a symmetric daemon machine session over SSH.
    Machine,
    /// A client kind this build does not support.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Parameters for `hello`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct HelloParams {
    /// The oldest and newest daemon protocol versions the client supports.
    #[serde(rename = "protocol")]
    pub protocol_range: [u32; 2],
    /// The client's build.
    pub build: String,
    /// The client kind. Unsupported kinds are rejected at hello.
    pub kind: ClientKind,
    /// The agent this client acts for, by ID: the agent of `facade-mcp`, or the agent in whose
    /// terminal a `facade` command runs. Messages the client sends come from that agent, and the
    /// `messages` topic reads its inbox. Required for `mcp`, whose agent must be listed: a hello
    /// naming one that is not is refused with `not_found`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The sessions the client's CLI names in its environment, such as `CLAUDE_CODE_SESSION_ID`.
    /// The client acts for the agent that has one of them, the newest where several do, ahead of
    /// `agent`: a command a guest's model runs acts for the guest.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<String>,
    /// The editor window this client is part of. Required for `ide`, and refused for any other
    /// kind. Every connection of a window describes it; the window is there while one of them is
    /// open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowDescription>,
    /// For an `ide` client: the highest agent and message numbers its editor gave before, such as 41
    /// for `#a41`. The daemon's next numbers are above both these and its own, from then on.
    /// Refused for any other kind with `invalid_argument`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numbers_given: Option<NumbersGiven>,
    /// Required on a machine session, absent on a local client connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineHello>,
}

impl HelloParams {
    pub fn for_machine(machine: MachineHello) -> Self {
        Self {
            protocol_range: machine.protocol_range,
            build: machine.build.clone(),
            kind: ClientKind::Machine,
            agent: None,
            sessions: Vec::new(),
            window: None,
            numbers_given: None,
            machine: Some(machine),
        }
    }
}

/// The highest numbers an editor gave before.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NumbersGiven {
    /// The highest agent number, such as 41 for `#a41`; 0 for none. At most 2^53 - 1.
    pub agent: u64,
    /// The highest message number, such as 230 for `#m230`; 0 for none. At most 2^53 - 1.
    pub message: u64,
}

/// An editor window as it describes itself, in `hello` and again with `window.update` whenever any
/// of it changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowDescription {
    /// The editor window instance's ID. It survives reloads and changes when the window reopens.
    /// The daemon returns the logical window in `HelloResult.window`.
    #[serde(rename = "id")]
    pub instance_id: String,
    /// The window's name.
    #[serde(rename = "label")]
    pub name: String,
    /// `local`, or the remote authority, such as `ssh-remote+devbox`, of a window whose user
    /// interface is on another computer.
    pub environment: String,
    /// A workspace the daemon can use to bind a reopened window to an earlier logical window.
    /// Omitted for a window with no workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// The window's folders, as absolute paths, in the editor's order. Each is a location, and so
    /// is every checkout of a Git repository one of them is in.
    #[serde(default)]
    pub folders: Vec<String>,
    /// The window's Git branch prefix, which a new worktree's folder name leaves out. Omitted where
    /// none is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_prefix: Option<String>,
    /// The colors the window supplies for its agents' terminal color queries. `window.update`
    /// sends them again when the editor's theme changes. An omitted color gets no reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<TerminalColors>,
    /// The environment the window's agents start with, as the editor works it out for its first
    /// folder's terminals. Facade looks for each CLI's program on its `PATH` to say in `clis` which
    /// can start. Omitted, the window lists neither `clis` nor `settings_problem` to an `ide` client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

/// The colors an editor window's terminals draw with, each `#rrggbb`. An agent of the window
/// replies to its CLI's OSC 10, 11 and 12 queries with them; a color left out gets no reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TerminalColors {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// A place an agent can work: a window's folder, or a checkout of a Git repository one of its
/// folders is in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LocationInfo {
    /// `loc-` followed by 16 hexadecimal digits of the SHA-256 of the location's path: the same in
    /// every window that lists it.
    pub location_id: String,
    /// The checkout's branch, or else the folder's name.
    pub label: String,
    /// The absolute path, with symbolic links resolved.
    pub path: String,
    /// What the location is: a folder, a repository's main checkout, or a linked worktree.
    pub kind: LocationKind,
}

/// The ID of the location at `path`: `loc-` followed by the first 16 hexadecimal digits of the
/// SHA-256 of the path.
pub fn location_id(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(path.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("loc-{digest}")
}

/// What a location is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LocationKind {
    /// A folder outside any Git checkout, or one inside a checkout that is not its root.
    Folder,
    /// A repository's main checkout.
    #[serde(rename = "main")]
    MainCheckout,
    /// A linked worktree of a repository.
    Worktree,
    /// A kind this build does not recognize.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A logical window on a Facade machine.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
pub struct WindowRef {
    /// The Facade machine's ID, a lowercase UUID version 4.
    pub machine_id: String,
    /// The logical window's ID, or `terminal` for that machine's terminal window.
    pub window_id: String,
}

/// A window: an editor window, or the terminal window, `terminal`, which holds the agents started
/// from a terminal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowInfo {
    /// The ID of the Facade machine that owns the window.
    pub machine_id: String,
    /// The logical window's ID, or `terminal`.
    pub window_id: String,
    /// The window's name.
    #[serde(rename = "label")]
    pub name: String,
    /// `local`, or the remote authority of an editor window whose user interface is on another
    /// computer.
    pub environment: String,
    /// Whether the logical window has a current connection. The terminal window always reports
    /// connected.
    pub connected: bool,
    /// The window's folders, in its order. The terminal window has none.
    pub folders: Vec<String>,
    /// Where an agent of the window can start: each folder and Git checkout once, a repository's
    /// main checkout first. The terminal window's are the folders its running agents work in.
    pub locations: Vec<LocationInfo>,
    /// What Facade could not read of the window's locations, which are then as last read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub problems: Vec<String>,
    /// When Facade last read the window's locations, in UTC ISO 8601 format with milliseconds; for
    /// the terminal window, when it was listed. Omitted for a window whose locations this daemon
    /// has not read yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
    /// The CLIs a start can run in this window, each found on a `PATH` or not: for a client that
    /// acts for an agent, that agent's; for an `ide` client, the one in the window's own `env`.
    /// None for a window with no folder, and none where Facade's settings file cannot be read as a
    /// whole. Omitted for a client that acts for no agent, and for an `ide` client where the window
    /// gave no `env`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clis: Vec<CliInfo>,
    /// For a client that acts for an agent, or an `ide` client where the window gave `env`, what is
    /// wrong with Facade's settings file where it cannot be read as a whole, which then lists no
    /// CLI and stops every start, as one text. Omitted where the file reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_problem: Option<String>,
}

/// A CLI a start can run: an entry of Facade's settings file (CONFIGURATION-2.1).
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

/// A change to the windows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WindowsChange {
    /// Insert or replace the window by its machine ID and logical window ID.
    Updated { window: Box<WindowInfo> },
    /// Remove the logical window identified by both fields.
    Removed {
        machine_id: String,
        window_id: String,
    },
    /// A change this build does not recognize. Skip it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Arguments for `worktree.create`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WorktreeCreateArgs {
    /// A logical window ID on this machine, including `terminal`.
    pub window_id: String,
    /// A location of that window: the checkout the worktree branches from.
    pub cwd: String,
    #[serde(flatten)]
    pub worktree: Worktree,
}

/// What a worktree creation that failed partway made, which stays: its branch, its folder, or both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Kept {
    /// The branch it made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The folder it made, an absolute path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// A new worktree: its branch and where the branch starts.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Worktree {
    /// The new branch, which must not exist yet.
    pub branch: String,
    /// The commit the branch starts from, as Git reads it: `HEAD`, a branch, a tag, or a commit.
    pub base_ref: String,
}

/// The result of `hello`: daemon details and supported topics and operations.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct HelloResult {
    /// The highest protocol version shared by the client and daemon.
    pub protocol: u32,
    /// The daemon's build.
    pub build: String,
    /// The daemon's Facade machine ID.
    pub machine_id: String,
    /// The answering daemon's introduction on a machine session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineHello>,
    /// For an `ide` client, the logical window bound to this connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowRef>,
    /// The daemon's process ID.
    pub pid: u32,
    /// The agent this client acts for, as `agent` and `sessions` decided. Omitted where it acts for
    /// none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The number of agent records when `hello` runs. Watch `agents` to receive changes.
    #[serde(rename = "agents")]
    pub agent_count: usize,
    /// The keeper holding the agents' terminals. Omitted while no keeper runs; the daemon starts
    /// one for the first agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keeper: Option<KeeperInfo>,
    /// Topic names accepted by `watch`.
    pub topics: Vec<String>,
    /// Operation names accepted by `call`.
    pub ops: Vec<String>,
}

/// The keeper holding the agents' terminals.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct KeeperInfo {
    /// The keeper process ID.
    pub pid: u32,
    /// The keeper build identifier.
    pub build: String,
}

/// Parameters for `watch`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WatchParams {
    /// A topic listed in the `hello` result.
    pub topic: String,
    /// Arguments for the topic. Omit this field if the topic takes none.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub args: Value,
}

/// The result of `watch`, sent before any changes for that watch.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WatchResult {
    /// The watch number used by `changed` notifications and `unwatch`.
    pub watch: u64,
    /// The topic snapshot. Later changes arrive as ordered `changed` notifications.
    pub snapshot: Value,
}

/// Parameters for `unwatch`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct UnwatchParams {
    /// The watch number returned by `watch` on this connection.
    pub watch: u64,
}

/// Parameters for `cancel`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CancelParams {
    /// The request ID of the call to cancel, one still under way on this connection.
    pub id: u64,
}

/// A `closing` notification: the daemon ends, and a newer Facade takes over.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ClosingParams {
    /// The build that takes over.
    pub build: String,
}

/// Arguments for `daemon.upgrade`: the program of a newer build that takes over, as the command
/// that asks runs it.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "UpgradeArgs")]
pub struct DaemonUpgradeArgs {
    /// The program, a `facade`, with its `facade-mcp` beside it.
    pub program: String,
    /// Its build, as its `hello` says it.
    pub build: String,
    /// The daemon protocol range accepted for this takeover, lowest and highest.
    #[serde(rename = "daemon_protocol")]
    pub daemon_protocol_range: [u32; 2],
    /// The keeper protocol versions it speaks, lowest and highest.
    #[serde(rename = "keeper_protocol")]
    pub keeper_protocol_range: [u32; 2],
}

/// The result of `daemon.upgrade`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "UpgradeResult")]
pub struct DaemonUpgradeResult {
    /// The build that hands over.
    pub from: String,
    /// The agents that keep running through the takeover: those whose run runs.
    #[serde(rename = "agents")]
    pub agent_count: usize,
}

/// Arguments for `daemon.log`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct DaemonLogArgs {
    /// How many of the log's last lines to read: 200 where absent, and at most 200.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
}

/// The result of `daemon.log`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct DaemonLogResult {
    /// The last lines of `core/logs/daemon.log`, oldest first, the home folder written as `~`.
    /// Empty where there is no log.
    pub lines: Vec<String>,
}

/// `count` agents in words: `1 agent`, `3 agents`.
pub fn agents_word(count: usize) -> String {
    if count == 1 {
        "1 agent".into()
    } else {
        format!("{count} agents")
    }
}

/// A `changed` notification for one watch.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChangedParams {
    /// The watch number returned on this connection.
    pub watch: u64,
    /// A change with the type defined by the watched topic.
    pub change: Value,
}

/// A forwarded watch ended. A new watch starts with a fresh snapshot.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WatchEndedParams {
    pub watch: u64,
    pub error: ErrorBody,
}

/// An agent record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentInfo {
    /// The stable ID is `a` followed by a number. It is unique within its Facade home while
    /// that home's SQLite database (`core/facade.db`) retains the agent number counter.
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
    /// The CLI: the name of its entry in Facade's settings file, a built-in's such as `claude` or
    /// an added one such as `Codex · work` (CONFIGURATION-2.1), or the program's file name for a
    /// program started by its path or name.
    pub cli: String,
    /// The CLI's working folder at startup.
    pub cwd: String,
    /// The ID of the Facade machine that runs the agent.
    pub machine_id: String,
    /// One or more member windows, unique and sorted by machine ID and window ID.
    pub windows: Vec<WindowRef>,
    /// The ID of its location: the location `cwd` is, or the innermost one that contains `cwd`.
    pub location_id: String,
    /// The window that provided the agent's running location, where a window supplied it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_source_window: Option<WindowRef>,
    /// The CLI's process ID. Omitted for a guest, whose process Facade does not know.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Whether the CLI is running or ended.
    pub process: ProcessState,
    /// Terminal width in columns. Omitted for a guest, which has no terminal of Facade's.
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
    /// tree. A launch takes it from Facade's settings file, `facade.json`, as it is accepted; a
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
    pub state: AgentState,
    /// More about the state: what the CLI waits for, its own words, how its process ended, or why
    /// the state is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_detail: Option<StateDetail>,
    /// The last thing that went into the agent's message input. Omitted until something has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub said: Option<Said>,
    /// Whether the agent's CLI can use Facade's tools.
    pub tools_state: ToolsState,
    /// Why the agent's CLI cannot use Facade's tools. Omitted unless they are unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_reason: Option<ToolsReason>,
    /// A guest: a session of a CLI the person started outside Facade, which joined through the
    /// CLI's hooks. Its terminal is not Facade's: Facade cannot read its screen, type into it,
    /// resize, stop or resume it. Omitted for an agent Facade started.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub guest: bool,
}

/// Whether an agent's CLI can use Facade's tools: `facade-mcp`, the MCP server that a CLI started
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

/// Why an agent's CLI cannot use the Facade tools it was given.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolsReason {
    /// Facade could not give them to this run's CLI; the daemon's log says why.
    NotGiven,
    /// Its Facade server did not connect within 60 seconds of the run's start or resume, or of a
    /// daemon's recovery of the run.
    NotConnected,
    /// Its CLI starts its servers only with its first turn or its panel of servers, and the run's
    /// start could not have the panel start Facade's server before the first turn; the daemon's log
    /// says why. The first turn starts it.
    NotStarted,
    /// Its Facade server's last connection closed while the run went on.
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
    /// `its Facade server's connection closed`.
    pub fn words(self) -> &'static str {
        match self {
            ToolsReason::NotGiven => "Facade could not give them to its CLI",
            ToolsReason::NotConnected => "its Facade server did not connect within 60 seconds",
            ToolsReason::NotStarted => {
                "its CLI did not start its Facade server before its first turn"
            }
            ToolsReason::Disconnected => "its Facade server's connection closed",
            ToolsReason::Ended => "its CLI ended",
            ToolsReason::Unknown => "a reason this build does not recognize",
        }
    }
}

/// What an agent is doing, from its CLI's own status reports, from its screen where its CLI's rule
/// reads it, and from Facade's own facts. The first state that holds, in this order, is the
/// agent's: `waiting_for_you`, `error`, `just_done`, `working`, `idle`, `starting`, then `unknown`;
/// `ended` once its process ended.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    /// The CLI has not shown what it is doing yet, within 60 seconds of its start or resume.
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
    /// started by its rule's name, it showed nothing of what it is doing within 60 seconds of its
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

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
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
    /// How the process ended, on `ended`. Omitted when its exit status is unavailable and Facade
    /// did not stop it; `exit.reason` says what is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub how: Option<HowEnded>,
    /// Why nothing shows what the CLI is doing, on `unknown`, or what Facade found wrong, on an
    /// `error` it found: a start that showed nothing, or tools the CLI cannot use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<StateReason>,
}

/// Why nothing shows what an agent's CLI is doing, or what Facade found wrong with it.
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
    /// `error`: a CLI started by its rule's name showed nothing of what it is doing within 60
    /// seconds of its start or resume.
    NotReady,
    /// `error`: the CLI cannot use the Facade tools it was given; `tools_reason` says why.
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
                "its CLI showed nothing of what it is doing within 60 seconds of its start"
            }
            StateReason::ToolsUnavailable => "its CLI cannot use the Facade tools it was given",
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
    /// Facade stopped it.
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

/// What last went into an agent's message input with Enter: what the person submitted in its
/// terminal and its CLI took, text typed with `agent.type` and `enter`, or a message delivered
/// through the terminal.
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

/// Arguments for `agent.start`, supplied by the client.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "StartArgs")]
pub struct AgentStartWireArgs {
    /// The CLI followed by more of its arguments. The exact name of a CLI of Facade's settings
    /// file, `facade.json` in the Facade home - a built-in's, such as `claude`, or one its `clis`
    /// adds - starts that CLI as its entry says, its entry's `args` before these (CONFIGURATION-2,
    /// 3). Any other word, including a path, runs as that program, as given. A start from an `mcp`
    /// client names one CLI of the file and nothing more; another name is refused with `not_found`,
    /// naming the CLIs there. A file that cannot be read as a whole refuses every start with
    /// `configuration_invalid`, and so does a CLI whose entry is wrong, saying each problem; a CLI
    /// its entry turns off is refused with `unavailable`, and one whose program cannot run where it
    /// starts with `not_found`, saying so by its setting.
    pub command: Vec<String>,
    /// The display name, trimmed. A missing, empty, or blank name gets a name from the settings
    /// file's `names`, else from the built-in names: one unused in any of the initial member
    /// windows, ignoring case and surrounding spaces. If every name is taken or the list is empty,
    /// uses the agent's ID, such as `#a7` (LIFECYCLE-2.1). Given names may repeat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The CLI's absolute working folder. If `location_source_window` is set, `cwd` must be that
    /// window's location or a folder inside one.
    pub cwd: String,
    /// The machine selector at the entrance to a start. Omitted to use the caller's machine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// The caller supplied its default cwd. A remote start uses the running machine's login home.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cwd_is_default: bool,
    /// The one initial member window, when supplied. Omitted to use the caller's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowRef>,
    /// The initial members the originating daemon verified for a forwarded start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_windows: Option<Vec<WindowRef>>,
    /// The connected local window that supplies the running location for `cwd`, if selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location_source_window: Option<WindowRef>,
    /// The environment supplied by the client. If omitted, the CLI gets only `TERM`, `COLORTERM`,
    /// and `PWD`. It does not inherit the daemon's environment. Facade removes terminal, editor,
    /// and CLI session variables, but keeps `TERM_PROGRAM` and `TERM_PROGRAM_VERSION`, which tell
    /// the CLI which terminal app displays it; then it sets `TERM`, `COLORTERM`, and `PWD`. Supply
    /// the user's remaining environment explicitly. `facade start` does this, omitting non-UTF-8
    /// variables and naming them on stderr. A start from an `mcp` client takes its agent's
    /// environment instead, as that agent's CLI started with it, less what that CLI's rule added: a
    /// CLI chooses what it gives its MCP server, while a `facade` command sends its shell's. Where
    /// that environment cannot be read, as when the CLI is not running or the system hides it, the
    /// start fails with `unavailable` and starts nothing. A start that an agent asks for, from its
    /// tools or its terminal, inherits that environment as it is, including what the agent's own
    /// entry `env` set or removed, as a shell started from another inherits its variables; the
    /// started CLI's own entry applies on top (CONFIGURATION-2.1, 3.2).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The initial terminal width in columns, at least 2.
    pub cols: u16,
    /// The initial terminal height in rows, at least 1.
    pub rows: u16,
    /// The agent's first message, its text as `agent.send` takes it: from the agent the client acts
    /// for, or else from the person. It is kept as the start answers, and delivered once the CLI's
    /// tools connected or will not, before any other message. A prompt from an agent owes that
    /// agent a result once it is settled. Only a CLI of the settings file takes one: a program
    /// started by its path or name is refused one, and the program of a `custom` entry, whose input
    /// Facade does not read, starts and fails it as `unsupported` (CONFIGURATION-2.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// The ID of the MCP `tools/call` that asked for the start, which the prompt's result names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// The creator's reserved result message number for a forwarded start with a prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_id: Option<String>,
    /// The machine that reserved the result message number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_machine_id: Option<String>,
    /// The caller's own ID of this start, 1 to 200 characters. The same ID again from the same
    /// creator, including its machine, and target within an hour answers that agent as it stands, and starts
    /// nothing. A start that failed keeps none, and the ID goes with its agent's record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// A worktree with a new branch to make and start in. With a location source window, uses
    /// the supplied location. Otherwise, uses the repository of `cwd`. The daemon checks the
    /// request ID before it makes the worktree, so a repeat makes none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    /// The model this start chooses, over its entry's `model` (CONFIGURATION-3.3, CLIS-1.4). A CLI
    /// that takes none from Facade, as OpenCode and a program do not, refuses it with
    /// `unsupported`. Omitted, a model the command's own words choose, else the entry's, else the
    /// CLI's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The effort this start chooses, over its entry's `effort`, as `model` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// A session of the CLI to continue, as `agent.resume` continues one: the CLI's rule gives the
    /// arguments that continue it, the same way for every CLI. The start is a new agent, with its own
    /// number. A CLI whose rule does not resume sessions, and a program that is not a CLI of the
    /// settings file, refuse it with `unsupported` before anything starts. Refused from an `mcp`
    /// client, as more words are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// A start or preflight after decoding the v2 request. The running machine supplies the
/// folder when it is omitted.
#[derive(Debug)]
pub struct AgentStartArgs {
    pub launch: crate::start::StartCommand<Option<String>>,
    pub name: Option<String>,
    pub window: Option<WindowRef>,
    pub initial_windows: Option<Vec<WindowRef>>,
    pub location_source_window: Option<WindowRef>,
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub prompt: Option<String>,
    pub call_id: Option<String>,
    pub result_message_id: Option<String>,
    pub result_message_machine_id: Option<String>,
    pub request_id: Option<String>,
    pub worktree: Option<Worktree>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub session: Option<String>,
}

impl AgentStartWireArgs {
    fn folder_is_omitted(&self, forwarded: bool) -> bool {
        self.cwd_is_default && (forwarded || self.cwd.is_empty())
    }

    /// The machine protocol forwards the v2 argument object. The origin's default folder
    /// still travels as an empty `cwd` with the legacy marker set.
    pub fn for_forwarding(mut self) -> Self {
        if self.folder_is_omitted(true) {
            self.cwd.clear();
        }
        self
    }

    /// Decodes the legacy command and folder at the machine running the program. A v2 local
    /// CLI supplies its own current folder even when the default marker is set.
    pub fn into_start(self, forwarded: bool) -> AgentStartArgs {
        let folder = (!self.folder_is_omitted(forwarded)).then_some(self.cwd);
        AgentStartArgs {
            launch: crate::start::StartCommand::from_words(self.command, folder),
            name: self.name,
            window: self.window,
            initial_windows: self.initial_windows,
            location_source_window: self.location_source_window,
            env: self.env,
            cols: self.cols,
            rows: self.rows,
            prompt: self.prompt,
            call_id: self.call_id,
            result_message_id: self.result_message_id,
            result_message_machine_id: self.result_message_machine_id,
            request_id: self.request_id,
            worktree: self.worktree,
            model: self.model,
            effort: self.effort,
            session: self.session,
        }
    }
}

/// The result of `agent.start`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "StartResult")]
pub struct AgentStartResult {
    /// The agent's record.
    pub agent: AgentInfo,
    /// The prompt, kept and pending, where one was given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Message>,
    /// The ID of the result the prompt owes the agent the client acts for, a message from `facade`
    /// once the prompt is settled. Omitted where no result is owed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_message_id: Option<String>,
    /// The machine that assigned `result_message_id`, when a result is owed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_machine_id: Option<String>,
    /// The call repeated an earlier one by its request ID: the agent is that call's, as it stands
    /// now. Omitted otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repeated: bool,
}

/// Arguments for `agent.resume`, supplied by the client.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "ResumeArgs")]
pub struct AgentResumeArgs {
    /// An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by
    /// its ID, such as `@Pixel #a3`.
    pub agent: String,
    /// The environment supplied by the client, filtered as for `agent.start`. The agent's earlier
    /// environment is not reused.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The terminal width in columns, at least 2.
    pub cols: u16,
    /// The terminal height in rows, at least 1.
    pub rows: u16,
}

/// Arguments for an operation on one agent.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "AgentArgs")]
pub struct AgentSelectorArgs {
    /// An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by
    /// its ID, such as `@Pixel #a3`.
    pub agent: String,
}

/// Says where `text` first has a control character other than a tab or a line break, which typed
/// text and messages refuse: `text contains the control character U+001B at character 3; text takes
/// printable characters, tabs, and line breaks`. Each caller adds its own advice.
pub fn first_control(text: &str) -> Option<String> {
    let (at, control) = text
        .chars()
        .enumerate()
        .find(|(_, c)| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))?;
    Some(format!(
        "text contains the control character U+{:04X} at character {}; text takes printable \
         characters, tabs, and line breaks",
        control as u32,
        at + 1
    ))
}

/// The most characters an agent's name takes where Facade shows it.
const NAME_CHARS: usize = 120;

/// Untrusted text as one line to show (CLIS-2.3): invisible formatting removed, control characters
/// and runs of white space as one space, trimmed, and at most `most` characters, the last an
/// ellipsis where it was cut between whole graphemes.
pub fn display_line(text: &str, most: usize) -> String {
    let invisible = |c: char| {
        matches!(
            c,
            '\u{200b}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}' | '\u{feff}'
        )
    };
    let spaced: String = text
        .chars()
        .filter(|&c| !invisible(c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let line = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= most {
        return line;
    }
    let (mut kept, mut end) = (0, 0);
    for (at, grapheme) in line.grapheme_indices(true) {
        kept += grapheme.chars().count();
        if kept >= most {
            break;
        }
        end = at + grapheme.len();
    }
    format!("{}…", line[..end].trim_end())
}

/// An agent's name as Facade shows it: one line of at most 120 characters. The name itself stays as
/// given.
pub fn display_name(name: &str) -> String {
    display_line(name, NAME_CHARS)
}

/// Arguments for `agent.type`: exactly one of `raw`, `text`, or `keys`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "TypeArgs")]
pub struct AgentTypeArgs {
    /// An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by
    /// its ID, such as `@Pixel #a3`.
    pub agent: String,
    /// Bytes from an attached terminal, encoded as standard base64 with padding. They are queued as
    /// they are, also between a typed text and its Enter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// Text to paste as one input: printable characters, tabs, and line breaks. When the CLI turned
    /// on bracketed paste, the text goes between the paste brackets with each line break as a
    /// carriage return; otherwise it goes as given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Press Enter after `text`, in a write of its own 0.1 seconds and the CLI's settle time for
    /// the text after the whole text reached the terminal. Empty text with `enter` presses Enter
    /// alone. Defaults to false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub enter: bool,
    /// Keys to press in order: Enter (or Return), Escape (or Esc), Tab, Shift+Tab, Backspace,
    /// Delete, Up, Down, Left, Right (or ArrowUp, ArrowDown, ArrowLeft, ArrowRight), Home, End,
    /// PageUp, PageDown, Space, and Ctrl+A to Ctrl+Z, in any letter case, or any one character
    /// other than a control character, exactly as given. Each goes as a terminal sends it in the
    /// CLI's modes. After an Escape, the next key waits 50 ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
}

/// Arguments for `agent.rename`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "RenameArgs")]
pub struct AgentRenameArgs {
    /// An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by
    /// its ID, such as `@Pixel #a3`.
    pub agent: String,
    /// The new name, trimmed. An empty or blank name gets a default name chosen from the suggested
    /// names: unused while one is available, otherwise reused. Names may repeat.
    pub name: String,
}

/// Arguments for `agent.send`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "SendArgs")]
pub struct AgentSendArgs {
    /// The recipient: an agent ID (`a3`, `#a3`, or `3`), a unique name of a running agent with or
    /// without `@`, a name followed by its ID such as `@Pixel #a3`, or `#human` for the person.
    pub to: String,
    /// The complete message: at most 8,000 characters and 540 lines of text, tabs, and line breaks,
    /// not blank.
    pub text: String,
    /// The message this one answers, by ID or qualified reference such as `#m4@gpu`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The storage machine of the reply's reference, after the originating daemon verified it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_machine_id: Option<String>,
    /// The caller's own ID of this send, 1 to 200 characters. The same ID again from the same
    /// sender, including its machine, and target within an hour answers that message as it stands, joining its
    /// delivery while it lasts, and sends nothing again. A send refused or withdrawn keeps none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// What is left of the send's 30 seconds as it leaves the client, in milliseconds: its
    /// delivery's deadline counts that from the daemon's receipt, at most 29,500. Omitted, 29,500.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_left_ms: Option<u64>,
}

/// The response to `agent.send`: the message as it stands, whether the call repeated an earlier
/// one, and whether its failure withdrew it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "SendResult")]
pub struct AgentSendResult {
    #[serde(flatten)]
    pub message: Message,
    /// The call repeated an earlier one by its request ID: the message is that call's. Omitted
    /// otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub repeated: bool,
    /// Its delivery failed with nothing of it typed, and it was taken out of its recipient's inbox,
    /// so it can be sent again. Omitted otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub withdrawn: bool,
    /// Which windows' subscriptions took the message for `#human`. Omitted for messages to
    /// agents and for a `pending` result whose daemon ended before saving the window outcomes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<WindowDelivery>,
}

/// The result of a send before encoding it for a client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendOutcome {
    pub message: Message,
    pub repeated: bool,
    pub withdrawn: bool,
    pub window_delivery: Option<Vec<WindowDeliveryOutcome>>,
}

impl From<SendOutcome> for AgentSendResult {
    fn from(result: SendOutcome) -> Self {
        Self {
            message: result.message,
            repeated: result.repeated,
            withdrawn: result.withdrawn,
            windows: result.window_delivery.map(WindowDelivery::from_outcomes),
        }
    }
}

impl From<AgentSendResult> for SendOutcome {
    fn from(result: AgentSendResult) -> Self {
        Self {
            message: result.message,
            repeated: result.repeated,
            withdrawn: result.withdrawn,
            window_delivery: result.windows.map(WindowDelivery::into_outcomes),
        }
    }
}

/// One member window's outcome for a message to the person.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WindowDeliveryOutcome {
    Delivered { window: WindowRef },
    NotDelivered { window: WindowRef, reason: String },
    OutcomeUnknown { window: WindowRef },
}

impl WindowDeliveryOutcome {
    pub fn window(&self) -> &WindowRef {
        match self {
            Self::Delivered { window }
            | Self::NotDelivered { window, .. }
            | Self::OutcomeUnknown { window } => window,
        }
    }

    pub fn is_delivered(&self) -> bool {
        matches!(self, Self::Delivered { .. })
    }
}

/// The member windows' outcomes for one message to the person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowDelivery {
    /// Windows whose `messages` subscriptions took the notification.
    pub delivered: Vec<WindowRef>,
    /// Windows whose subscriptions did not take the notification.
    pub not_delivered: Vec<WindowDeliveryFailure>,
    /// The notification was sent, and its receipt was lost before delivery could be confirmed.
    pub outcome_unknown: Vec<WindowRef>,
}

impl WindowDelivery {
    /// Encodes the original v2 and SQLite grouping.
    pub fn from_outcomes(outcomes: impl IntoIterator<Item = WindowDeliveryOutcome>) -> Self {
        let mut delivery = Self {
            delivered: Vec::new(),
            not_delivered: Vec::new(),
            outcome_unknown: Vec::new(),
        };
        for outcome in outcomes {
            match outcome {
                WindowDeliveryOutcome::Delivered { window } => delivery.delivered.push(window),
                WindowDeliveryOutcome::NotDelivered { window, reason } => {
                    delivery
                        .not_delivered
                        .push(WindowDeliveryFailure { window, reason });
                }
                WindowDeliveryOutcome::OutcomeUnknown { window } => {
                    delivery.outcome_unknown.push(window)
                }
            }
        }
        delivery
    }

    /// Reads the v2 and SQLite grouping into individual outcomes.
    pub fn into_outcomes(self) -> Vec<WindowDeliveryOutcome> {
        self.delivered
            .into_iter()
            .map(|window| WindowDeliveryOutcome::Delivered { window })
            .chain(self.not_delivered.into_iter().map(
                |WindowDeliveryFailure { window, reason }| WindowDeliveryOutcome::NotDelivered {
                    window,
                    reason,
                },
            ))
            .chain(
                self.outcome_unknown
                    .into_iter()
                    .map(|window| WindowDeliveryOutcome::OutcomeUnknown { window }),
            )
            .collect()
    }
}

/// Why a member window did not take a notification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowDeliveryFailure {
    pub window: WindowRef,
    /// `window_disconnected` if the window has no connection, or `not_watching` if no current
    /// subscription took the notification, or `machine_unavailable` if it could not be sent to the
    /// window's machine.
    pub reason: String,
}

/// The sender of Facade's own results.
pub const FACADE: &str = "facade";

/// A message: one sender, one recipient, the complete text, and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Message {
    /// `m` followed by a number, unique within the Facade home.
    pub message_id: String,
    /// The full reference for a window notification to the person or a remote send receipt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_ref: Option<MessageRef>,
    /// The sender: an agent ID, `human` for the person, or `facade` for a result: Facade's own
    /// words on what became of a start, not an agent's.
    pub from: String,
    /// The sender's machine, when different from the one that stored the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_machine_id: Option<String>,
    /// The sender's name when it sent the message. Omitted for the person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// The recipient's agent ID, or `human` for the person.
    pub to: String,
    /// The complete text as sent.
    pub text: String,
    /// The message this one answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The replied-to message's machine, when different from the one that stored this message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_machine_id: Option<String>,
    /// The sender's window name if it had a single member window and the recipient did not belong
    /// to that window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_window: Option<String>,
    /// A result's call: the ID of the MCP `tools/call` it answers later. On a start's prompt, the
    /// call its result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// A result's facts, which its text words. Omitted for any other message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<StartOutcome>,
    /// When Facade received it, in UTC ISO 8601 format with milliseconds.
    pub at: String,
    pub delivery: Delivery,
}

/// What became of a start with a prompt, as its result tells the agent that started it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StartOutcome {
    /// The started agent as it was when its prompt was settled.
    pub agent: AgentInfo,
    pub prompt: PromptOutcome,
}

/// A start prompt's message ID and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PromptOutcome {
    pub message_id: String,
    pub delivery: Delivery,
}

/// A start result's words, as Facade's editor extension words them: the agent started, whether its
/// tools are there, and what became of its prompt, with what of it reached the terminal and, where
/// it was not delivered, why.
pub fn start_result_text(outcome: &StartOutcome) -> String {
    let agent = &outcome.agent;
    let mut lines = vec![format!(
        "{} (#{}) has started.",
        display_name(&agent.name),
        agent.agent_id
    )];
    match (agent.tools_state, agent.tools_reason) {
        (ToolsState::Connecting, _) => lines.push("Its Facade tools are still connecting.".into()),
        (ToolsState::Unavailable, Some(reason)) => lines.push(format!(
            "Its Facade tools are unavailable: {}.",
            reason.words()
        )),
        (ToolsState::Unavailable | ToolsState::NotInjected, _) => {
            lines.push("Its Facade tools are unavailable.".into())
        }
        _ => {}
    }
    let (id, delivery) = (
        format!("#{}", outcome.prompt.message_id),
        &outcome.prompt.delivery,
    );
    let untouched =
        delivery.text_written == TextWritten::None && delivery.enter_written == Some(false);
    match delivery.status {
        DeliveryStatus::Success
            if delivery.delivered_via == Some(DeliveredVia::ReadByRecipient) =>
        {
            lines.push(format!(
                "Your initial message {id} has been passed on through read_messages."
            ));
            if !untouched {
                lines.push(input_words(delivery, false));
            }
        }
        DeliveryStatus::Success => {
            lines.push(format!("Your initial message {id} has been passed on."))
        }
        _ => {
            lines.push(match untouched {
                true => format!(
                    "Your initial message {id} could not be delivered. {}",
                    input_words(delivery, true)
                ),
                false => format!(
                    "Delivery of your initial message {id} could not be confirmed. {}",
                    input_words(delivery, true)
                ),
            });
            let why = delivery.failure_reason(&format!("#{}", agent.agent_id));
            let mut letters = why.chars();
            lines.push(
                letters
                    .next()
                    .map(|first| first.to_uppercase().chain(letters).collect::<String>())
                    .unwrap_or_default()
                    + ".",
            );
        }
    }
    lines.join("\n")
}

/// What of a message reached the terminal, then what to check: before sending it again, or, after
/// it was delivered, for input left over.
fn input_words(delivery: &Delivery, before_retry: bool) -> String {
    if delivery.text_written == TextWritten::None && delivery.enter_written == Some(false) {
        return "Nothing was entered in the terminal.".into();
    }
    let text = match delivery.text_written {
        TextWritten::None => "No message text was entered.",
        TextWritten::Partial => "Only part of the message was entered.",
        TextWritten::Full => "The full message was entered.",
        TextWritten::Unknown | TextWritten::Unrecognized => "How much text was entered is unknown.",
    };
    let enter = match delivery.enter_written {
        Some(true) => "Enter was pressed.",
        Some(false) => "Enter was not pressed.",
        None => "Whether Enter was pressed is unknown.",
    };
    let check = if before_retry {
        "Check the terminal before sending it again."
    } else {
        "Check the terminal for leftover input."
    };
    format!("{text} {enter} {check}")
}

/// The message as its recipient's terminal shows it: a header naming its sender, its number, the
/// sender's window where that is another, and what it answers, then the text. A result shows `🔔`,
/// its first line and its number, then the rest.
pub fn typed_text(message: &Message) -> String {
    typed_text_with_machines(message, None, None)
}

/// Formats a message for its recipient's terminal. Give machine selectors from the recipient's
/// perspective for a remote sender or reply. The message's own number is local to the recipient.
pub fn typed_text_with_machines(
    message: &Message,
    from_machine: Option<&str>,
    reply_machine: Option<&str>,
) -> String {
    if message.from == FACADE {
        let (first, rest) = message.text.split_once('\n').unwrap_or((&message.text, ""));
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!("\n{rest}")
        };
        return format!("🔔 {first} · #{}{rest}", message.message_id);
    }
    let valid_selector = |selector: &&str| parse_machine_selector(selector).is_ok();
    let from_machine = from_machine.filter(valid_selector);
    let reply_machine = reply_machine.filter(valid_selector);
    let sender_ref = format_reference(
        &message.from,
        from_machine.filter(|_| message.from != "human"),
    );
    let sender = match &message.from_name {
        Some(name) => format!("{} ({sender_ref})", display_name(name)),
        None => sender_ref,
    };
    let origin = match (message.from_window.as_deref(), from_machine) {
        (Some(window), Some(machine)) => format!(" · From {} on {machine}", display_name(window)),
        (Some(window), None) => format!(" · From {}", display_name(window)),
        (None, Some(machine)) => format!(" · on {machine}"),
        (None, None) => String::new(),
    };
    let reply = message
        .reply_to
        .as_deref()
        .map(|reply| format!(" · Reply to {}", format_reference(reply, reply_machine)))
        .unwrap_or_default();
    format!(
        "📨 Message from {sender} · #{}{origin}{reply}\n{}",
        message.message_id, message.text
    )
}

/// What became of a message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Delivery {
    /// `pending` while the message is being delivered, then `success` or `failure`.
    pub status: DeliveryStatus,
    /// Why it was not delivered. Omitted unless it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<DeliveryFailure>,
    /// How much of the message reached the recipient's terminal.
    pub text_written: TextWritten,
    /// Whether the Enter that submits it reached the recipient's terminal. Omitted when that is not
    /// known: the recipient read the message while its typist was typing it, its typist did not say
    /// by the deadline, what it typed was still queued then, or the daemon before a restart had
    /// begun its paste.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter_written: Option<bool>,
    /// When a pending delivery fails if the message is not delivered by then. Omitted once it is
    /// settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    /// How the message was delivered. Omitted unless it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_via: Option<DeliveredVia>,
    /// When the message was delivered. Omitted unless it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
}

impl Delivery {
    /// Why the message to `to` was not delivered, then what of it was typed, in words: `a draft
    /// held #a2's input until the deadline; Facade never types over a draft; nothing was typed`. It
    /// says no more than `text_written` and `enter_written`.
    pub fn failure_words(&self, to: &str) -> String {
        let typed = match (self.text_written, self.enter_written) {
            (TextWritten::None, _) => "nothing was typed",
            (TextWritten::Partial, _) => "part of it was typed",
            (TextWritten::Full, Some(true)) => "all of it and its Enter were typed",
            (TextWritten::Full, Some(false)) => "all of it was typed, but not its Enter",
            (TextWritten::Full, None) => "all of it was typed",
            (TextWritten::Unknown | TextWritten::Unrecognized, _) => {
                "what of it was typed is not known"
            }
        };
        format!("{}; {typed}", self.failure_reason(to))
    }

    /// Why the message to `to` was not delivered, in words:
    /// `the deadline passed before #a2 took the message`.
    pub fn failure_reason(&self, to: &str) -> String {
        let known = !matches!(
            self.text_written,
            TextWritten::Unknown | TextWritten::Unrecognized
        );
        match self.reason.unwrap_or(DeliveryFailure::Unknown) {
            DeliveryFailure::Ended => format!("{to} ended before the message was delivered"),
            DeliveryFailure::InputDraft => format!(
                "a draft held {to}'s input until the deadline; Facade never types over a draft"
            ),
            DeliveryFailure::InputInteraction => format!(
                "a menu, login, or question of {to}'s CLI held its input until the deadline"
            ),
            DeliveryFailure::InputUnknown => {
                format!("{to}'s input was not recognized as empty until the deadline")
            }
            DeliveryFailure::Timeout => format!("the deadline passed before {to} took the message"),
            DeliveryFailure::SubmissionUnconfirmed if known => {
                format!("{to}'s CLI did not take the message before the deadline")
            }
            DeliveryFailure::SubmissionUnconfirmed => {
                format!("Facade could not confirm by the deadline that {to}'s CLI took the message")
            }
            DeliveryFailure::Unsupported => format!(
                "Facade types no messages into {to}'s CLI: it has no rule to read its input by"
            ),
            DeliveryFailure::Unknown => format!("the message was not delivered to {to}"),
        }
    }
}

/// The state of a message's delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    /// The message is being delivered, or waits for its guest's next turn.
    Pending,
    /// The message was delivered.
    Success,
    /// The message was not delivered.
    Failure,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Why a message was not delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryFailure {
    /// The recipient ended, or its terminal stopped taking input, before the message was delivered.
    Ended,
    /// A draft held the recipient's input until the deadline. A draft that is not the message's own
    /// is never typed over.
    InputDraft,
    /// A menu, login, or question of the recipient's CLI held its input until the deadline.
    InputInteraction,
    /// The recipient's input was not recognized as empty until the deadline: its screen did not
    /// show it as its CLI's rule describes it.
    InputUnknown,
    /// The input was empty, but the deadline passed before a paste of the message, its Enter, and
    /// its confirmation could fit.
    Timeout,
    /// Its paste began, but the recipient's CLI did not take the message before the deadline. A
    /// paste its terminal had not taken whole by then still goes in, and no Enter follows it.
    SubmissionUnconfirmed,
    /// The recipient's CLI has no rule to read its input by, so Facade types no message into it.
    Unsupported,
    /// A reason this build does not recognize.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// How much of a message reached the recipient's terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TextWritten {
    /// None of it.
    None,
    /// Part of it.
    Partial,
    /// All of it.
    Full,
    /// Not known: the recipient read the message while its typist was typing it, its typist did not
    /// say by the deadline, what it typed was still queued then, to reach the terminal once the CLI
    /// reads, or the daemon before a restart had begun its paste.
    Unknown,
    /// A value this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

/// How a message was delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveredVia {
    /// Typed into the recipient's terminal and submitted.
    #[serde(rename = "terminal")]
    TypedIntoInput,
    /// Returned by a snapshot of the recipient's `messages` topic.
    #[serde(rename = "read")]
    ReadByRecipient,
    /// A message to the person: delivered to one or more member windows' subscriptions.
    #[serde(rename = "notified")]
    DeliveredToWindows,
    /// A way this build does not recognize.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl DeliveredVia {
    /// The spelling still used by the v2 CLI and MCP projections.
    #[allow(non_upper_case_globals)]
    pub const Read: Self = Self::ReadByRecipient;
}

/// Arguments for `agent.resize`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "ResizeArgs")]
pub struct AgentResizeArgs {
    /// An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by
    /// its ID, such as `@Pixel #a3`.
    pub agent: String,
    /// Terminal width in columns, at least 2.
    pub cols: u16,
    /// Terminal height in rows, at least 1.
    pub rows: u16,
}

/// Arguments for `agent.screen`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "ScreenArgs")]
pub struct AgentScreenArgs {
    /// An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by
    /// its ID, such as `@Pixel #a3`.
    pub agent: String,
    /// The number of lines to return, from 1 to 2000. Defaults to 50.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u16>,
}

/// The result of `agent.screen`: the last logical lines of an agent's screen and scrollback, as
/// they show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScreenText {
    pub agent_id: String,
    /// Whether the agent's CLI is running. An ended agent's screen is the one it left.
    pub process: ProcessState,
    /// When the screen was read, in UTC ISO 8601 format with milliseconds; for an ended agent, when
    /// it ended, as its screen is the one it left.
    pub observed_at: String,
    pub buffer: ScreenBuffer,
    /// The lines, joined by line feeds, each wrapped row joined into its line. Inverse text is
    /// between `[[` and `]]` and dim text between `{{` and `}}`, inverse outside dim. Each
    /// backslash, bracket, and brace of the screen's own text is escaped with a backslash, so
    /// removing the marks and the escapes gives the text exactly; see [`plain`].
    pub text: String,
    /// How many lines `text` holds.
    pub line_count: u32,
    /// Whether output lies above the lines read.
    pub older_lines: bool,
    /// Whether the scrollback let go of its oldest lines.
    pub trimmed: bool,
}

/// The screen buffer a CLI shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScreenBuffer {
    /// The normal screen, with scrollback.
    Normal,
    /// The alternate screen, which a full-screen view draws on. It has no scrollback.
    Alternate,
    /// A buffer this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// The text of [`ScreenText::text`] without its marks and escapes: the screen's text as it shows.
pub fn plain(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => plain.extend(chars.next()),
            // The screen's own brackets and braces are escaped, so these are marks, each two of a
            // kind.
            '[' | ']' | '{' | '}' => drop(chars.next()),
            c => plain.push(c),
        }
    }
    plain
}

/// How an agent's message input reads on its screen. A reading never means input may be typed.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InputState {
    /// The CLI's input is drawn empty.
    Usable,
    /// The CLI's input holds text, typed, pasted, or recalled.
    Draft,
    /// A menu or question of the CLI's own is drawn in place of its input.
    Interaction,
    /// The screen does not show the input as the CLI's rule describes it.
    Unknown,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unrecognized,
}

impl InputState {
    pub fn as_str(self) -> &'static str {
        match self {
            InputState::Usable => "usable",
            InputState::Draft => "draft",
            InputState::Interaction => "interaction",
            InputState::Unknown => "unknown",
            InputState::Unrecognized => "unrecognized",
        }
    }
}

/// The layout a CLI's rule reads its input from.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InputMechanism {
    /// A prompt row inside a frame of two rules.
    Frame,
    /// A prompt row above a model line at the bottom of the screen.
    Prompt,
    /// An editor between two rules, with a cursor the CLI draws.
    Editor,
    /// A box of bar rows above a border.
    Box,
    /// The last row that starts with the prompt.
    PromptRow,
    /// A layout this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl InputMechanism {
    pub fn as_str(self) -> &'static str {
        match self {
            InputMechanism::Frame => "frame",
            InputMechanism::Prompt => "prompt",
            InputMechanism::Editor => "editor",
            InputMechanism::Box => "box",
            InputMechanism::PromptRow => "prompt_row",
            InputMechanism::Unknown => "unknown",
        }
    }
}

/// Rows of a draft scrolled out of the CLI's input, as the CLI marks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HiddenRows {
    /// Rows hidden above the visible input.
    pub above: u32,
    /// Rows hidden below the visible input.
    pub below: u32,
}

/// An agent's message input as its screen shows it now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InputInfo {
    pub state: InputState,
    /// What on the screen the state rests on, such as `the input frame at row 22 is empty`. Never
    /// the draft's text.
    pub evidence: String,
    /// The layout the agent's CLI rule reads. Omitted without a rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mechanism: Option<InputMechanism>,
    /// Draft rows scrolled out of the input. Omitted unless the CLI marks such rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<HiddenRows>,
}

/// The result of `agent.inspect`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "InspectResult")]
pub struct AgentInspectResult {
    pub agent: AgentInfo,
    /// The CLI rule the agent was started by: its CLI's name, such as `claude`. Omitted for an
    /// agent started by a program path or a name without a rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    pub input: InputInfo,
    /// Whether the running CLI reports its session to Facade. False for an ended agent.
    pub session_tracking: bool,
}

/// Arguments for the agents view. The member-machine filter is for internal forwarded watches.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct AgentsWatchArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_machine_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentSyncState {
    Synced,
    Pending,
    Unreachable,
}

/// How complete the agent view is for one remote running machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentMachineState {
    pub machine_id: String,
    pub state: AgentSyncState,
    /// For a synced machine, its complete records, including an empty list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<AgentInfo>>,
}

/// An agent subscription's contribution from one machine.
#[derive(Clone, Debug)]
pub struct AgentMachineView {
    pub row: crate::machine::MachineStateRow,
    pub agents: Option<Vec<AgentInfo>>,
}

impl From<AgentMachineView> for AgentMachineState {
    fn from(view: AgentMachineView) -> Self {
        use crate::machine::MachineResponseState;

        let state = match view.row.state {
            MachineResponseState::Responded => AgentSyncState::Synced,
            MachineResponseState::Waiting => AgentSyncState::Pending,
            MachineResponseState::Unreachable
            | MachineResponseState::TimedOut
            | MachineResponseState::Failed => AgentSyncState::Unreachable,
        };
        Self {
            machine_id: view.row.machine_id,
            state,
            agents: view.agents,
        }
    }
}

/// The agents view and the synchronization state of its remote contributors.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentsSnapshot {
    /// Records on the machine that serves this view.
    pub agents: Vec<AgentInfo>,
    pub machines: Vec<AgentMachineState>,
}

/// A change to the `agents` topic. Skip unknown change kinds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentsChange {
    /// Insert or replace the whole agent record by machine and agent ID.
    Updated { agent: Box<AgentInfo> },
    /// Remove the record with this machine and agent ID.
    Removed {
        machine_id: String,
        agent_id: String,
    },
    /// The state of this running machine's contribution to the view.
    #[serde(rename = "machine_state")]
    SyncUpdated { machine: AgentMachineState },
    /// An unknown change kind. Skip it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A change in the daemon's agent view before choosing a client representation.
#[derive(Clone, Debug)]
pub enum AgentsUpdate {
    Updated {
        agent: Box<AgentInfo>,
    },
    Removed {
        machine_id: String,
        agent_id: String,
    },
    MachineState {
        machine: AgentMachineView,
    },
}

impl From<AgentsUpdate> for AgentsChange {
    fn from(update: AgentsUpdate) -> Self {
        match update {
            AgentsUpdate::Updated { agent } => Self::Updated { agent },
            AgentsUpdate::Removed {
                machine_id,
                agent_id,
            } => Self::Removed {
                machine_id,
                agent_id,
            },
            AgentsUpdate::MachineState { machine } => Self::SyncUpdated {
                machine: machine.into(),
            },
        }
    }
}

/// Arguments for the `messages` topic: which messages of the inbox to read. Without `ids` or `all`,
/// the messages not yet delivered.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MessagesWatchArgs {
    /// These messages, by ID (`m4` or `#m4`): 1 to 100. Excludes `all` and `cursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
    /// Every message in the inbox, delivered or not: messages are kept 30 days.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
    /// Continues the previous page of the same selection from its `next_cursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// The most messages in a page, 1 to 200. Defaults to 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u16>,
    /// The newest messages of the selection, this many, 1 to 200, in one page. Excludes `ids`,
    /// `cursor` and `limit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<u16>,
}

/// The inbox at the start of a `messages` watch.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MessagesSnapshot {
    /// The selected messages, oldest first.
    pub messages: Vec<Message>,
    /// IDs in `ids` that are not in the inbox.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_found: Vec<String>,
    /// Pass as `cursor` to read the next page. Omitted on the last page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A change to the `messages` topic. Skip unknown change kinds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessagesChange {
    /// Insert or replace the whole message by `message_id`: a message arrived or its delivery
    /// changed. A change does not deliver the message.
    Updated { message: Box<Message> },
    /// The message is no longer kept: withdrawn by its send's `cancel` before its paste began, gone
    /// after its 30 days, or gone with its recipient's inbox.
    Removed { message_id: String },
    /// An unknown change kind. Skip it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Arguments for `integration.add` and `integration.remove`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct IntegrationArgs {
    /// The CLI's rule name from `facade_rules::integration::CLIS`, shown by
    /// `facade integration add --help`.
    pub cli: String,
    /// The caller's environment, as `agent.start` takes it. It says where the CLI keeps its user
    /// configuration (`HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and `PATH`
    /// finds `claude`.
    pub env: BTreeMap<String, String>,
}

/// Arguments for `integration.list`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "IntegrationsArgs")]
pub struct IntegrationListArgs {
    /// The caller's environment, as for `integration.add`.
    pub env: BTreeMap<String, String>,
}

/// Whether a file of a CLI's integration holds Facade's entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PartState {
    /// As `integration.add` writes them now.
    AsWritten,
    /// Some, but not as they would be written now: the person changed them, or another Facade home
    /// or version wrote them.
    Changed,
    /// None.
    Missing,
    /// A state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A file of a CLI's integration, and whether it holds Facade's entries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct IntegrationPart {
    /// The file, or `claude mcp` for Claude Code's user server, which only its own command changes.
    pub file: String,
    pub state: PartState,
}

/// A CLI's integration: Facade's entries in the CLI's user configuration, through which its
/// sessions join as guests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct IntegrationInfo {
    pub cli: String,
    /// When `integration.add` first wrote its files. Omitted where it did not, or the record is
    /// gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
    pub parts: Vec<IntegrationPart>,
    /// What the person should know, such as that Codex asks to review new hooks once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// What `integration.list` answers: each CLI Facade can integrate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "IntegrationsList")]
pub struct IntegrationListResult {
    pub integrations: Vec<IntegrationInfo>,
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

/// The size, in columns and rows, of a terminal started where no terminal gives one: without a
/// terminal of the caller's, or for a guest, which has none of Facade's.
pub const DEFAULT_TERMINAL_SIZE: (u16, u16) = (120, 30);

/// The session a CLI's hook reports on.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct HookSession {
    /// The CLI, by its rule's name, such as `claude`.
    pub cli: String,
    /// The session ID the CLI gives its hooks.
    pub session: String,
    /// The CLI's working folder, where the hook knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// For a CLI that has no hook for a session's end, Antigravity, the process of the CLI that ran
    /// the hook: its end is the session's end. Facade watches it for that alone, and a guest's
    /// record names no pid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// The session this one is part of, as a subagent's session is the session that started it. A
    /// part acts for the guest of the session it is part of, and its own turns leave that guest's
    /// state alone. Omitted for a session of its own.
    #[serde(default, rename = "parent", skip_serializing_if = "Option::is_none")]
    pub part_of_session: Option<String>,
    /// The environment the CLI gives the hook, or the server of this session alone, which joins it
    /// as it starts: an agent the guest starts runs with it. A server many sessions share gives
    /// none. Kept with the guest, in memory alone; a later one replaces it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    /// Where the CLI itself reports how the session stands, as Claude Code's prompt hook names it:
    /// Claude Code's file of its process, `sessions/<pid>.json` in its configuration folder. While
    /// the guest reads `working`, the daemon reads it once a second: `idle` there, written since
    /// the turn began, ends the turn as `hook.idle` does, for a turn the person cut short, which
    /// runs no hook. Omitted by the other hooks and CLIs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_file: Option<String>,
}

/// What `hook.session-start` answers.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartResult {
    /// The guest the session joined as. Omitted for a session of a run Facade started, which the
    /// hook leaves alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// What the guest's model is told: its ID, and how its messages reach it; then Facade's skill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

/// The messages `hook.prompt` and `hook.turn-end` take for a guest's model, at its next turn.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct HandOver {
    /// Every message that was not yet delivered to the guest, oldest first, now delivered through
    /// `read`.
    pub messages: Vec<Message>,
}

/// Arguments for the `screen` topic.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ScreenWatchArgs {
    /// An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by
    /// its ID, such as `@Pixel #a3`.
    pub agent: String,
    /// Keep the viewer's existing scrollback. Defaults to false: every snapshot and redraw clears
    /// it first. A main-screen snapshot then replays up to 1,000 rows of the agent's scrollback
    /// unless `include_scrollback` is false. Later redraws include only the visible screen.
    /// `facade attach` sets this option to true.
    #[serde(default)]
    pub keep_scrollback: bool,
    /// Include up to 1,000 main-screen scrollback rows before the visible screen in the snapshot.
    /// Defaults to true. `facade attach` sets it to false on reconnect so the viewer does not
    /// receive those rows twice.
    #[serde(default = "include_scrollback_by_default")]
    pub include_scrollback: bool,
}

fn include_scrollback_by_default() -> bool {
    true
}

/// A full screen snapshot at the start of a watch.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ScreenSnapshot {
    /// The ID of the agent being viewed.
    pub agent_id: String,
    /// The agent's running machine, for reconnecting to its exact reference.
    pub machine_id: String,
    /// Terminal width required to apply the redraw.
    pub cols: u16,
    /// Terminal height required to apply the redraw.
    pub rows: u16,
    /// Base64-encoded terminal bytes that redraw the screen at this size. Restores cursor state,
    /// charsets, and modes. On the main screen, up to 1,000 rows of agent scrollback come first
    /// unless `include_scrollback` is false. `keep_scrollback` controls whether the viewer's
    /// existing scrollback is cleared before the redraw.
    pub redraw: String,
    /// The recorded exit, if the agent has ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<ProcessExit>,
    /// The agent's process state captured with this snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessState>,
}

/// A change to the `screen` topic. `exit` follows all output the CLI wrote before ending; processes
/// still holding its terminal may write afterward. On macOS, the terminal is taken from those
/// processes when the CLI ends. `removed` is the watch's last change. Skip unknown change kinds.
///
/// `snapshot.redraw`, `output.data`, and `redraw.data` contain standard base64 with padding. Decode
/// them to bytes and feed those bytes to the viewer's terminal parser. Set the viewer to
/// `snapshot.cols` by `snapshot.rows` before the initial redraw. Each redraw change carries its own
/// `cols` and `rows`; use that size before applying its `data`. Process changes for each watch in
/// arrival order. Apply `output` as continuation bytes; `redraw` supplies a replacement terminal
/// sequence. Preserve parser state between messages. Do not treat the decoded bytes as plain text;
/// use `agent.screen` for plain text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScreenChange {
    /// Base64-encoded terminal output with queries removed.
    Output {
        /// Standard base64 with padding. Decode to bytes and continue the viewer's terminal parser
        /// with them.
        data: String,
    },
    /// A full redraw after missed output, a resize, or a return to the main screen. Apply it at its
    /// own size, which may differ from the snapshot.
    Redraw {
        /// Standard base64 with padding. Decode to terminal bytes and apply at this redraw's size.
        data: String,
        /// Terminal width required to apply this redraw.
        cols: u16,
        /// Terminal height required to apply this redraw.
        rows: u16,
    },
    /// The recorded exit of the agent.
    Exit { exit: ProcessExit },
    /// The agent was removed. No changes follow on this watch.
    Removed,
    /// An unknown change kind. Skip it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Starts an agent.
pub struct AgentStart;
impl Operation for AgentStart {
    const NAME: &'static str = "agent.start";
    const DOC: &'static str = "Starts an agent by running the CLI in a terminal of the requested \
                               size. A CLI rule's name starts that CLI as its rule says. The \
                               optional `window` selects the only initial member. Otherwise an \
                               agent's start inherits its members when listed. An editor start \
                               joins its bound window. A person's terminal start or a start from \
                               an agent not yet listed joins `terminal`. \
                               The optional `location_source_window` selects a connected local \
                               window that supplies `cwd`. Without it, `cwd` follows the terminal \
                               rules. A `prompt` is refused before anything starts where a message could \
                               not carry it. It is kept with the agent's record and answered \
                               pending, then delivered as the agent's first message once the CLI's \
                               tools connected or will not. A prompt from an agent owes it one \
                               result, under `result_message_id`, once the prompt is settled. A \
                               program or folder that cannot be used returns `unavailable`. With \
                               `worktree`, the start makes that worktree first, as \
                               `worktree.create` does, and starts in it: Git's failure answers \
                               `worktree_failed` with what it made in `data.kept`, and a start \
                               that fails after making the worktree keeps it, its error's `kept` \
                               naming it. A `request_id` of the creator's own is looked for before \
                               anything else: a start with the same ID under way answers once it \
                               does, and an agent the same creator started with it within the hour \
                               is answered as it stands now, `repeated`, with its prompt as it \
                               stands, starting nothing and making no worktree. A start that \
                               failed keeps no ID. Waits up to 10 seconds for a ready keeper \
                               before sending, then up to 10 more seconds for the reply. Either \
                               timeout returns `unavailable`. A timeout after sending leaves the \
                               outcome unknown.";
    type Args = AgentStartWireArgs;
    type Result = AgentStartResult;
}

pub struct AgentStop;
impl Operation for AgentStop {
    const NAME: &'static str = "agent.stop";
    const DOC: &'static str = "Stops a running agent's process group with SIGHUP and sends SIGKILL \
                               to anything left at the deadline. The daemon sets the deadline 3 \
                               seconds after accepting the stop, keeping an earlier pending \
                               deadline. Queueing can shorten the gap after SIGHUP. Signals are \
                               sent only if Facade can check that the group still belongs to the \
                               CLI. Waits up to 10 seconds for a ready keeper, up to 10 more \
                               seconds for its reply, then up to 10 more seconds for the CLI's \
                               exit. When no keeper runs, only the exit wait applies. Any timeout \
                               returns `unavailable`: the stop goes on. An agent with no terminal \
                               to stop returns `not_found`, and one whose actor stopped \
                               `internal`, both before anything is sent. Returns the recorded \
                               exit; its record stays listed. A timeout or service replacement \
                               does not cancel the stop or extend its deadline. An agent whose CLI \
                               had ended before the stop returns its recorded exit with \
                               `already_ended`, without another signal.";
    type Args = AgentSelectorArgs;
    type Result = AgentStopResult;
}

/// The result of `agent.stop`: the CLI's recorded exit, and whether it had ended before this stop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "StopResult")]
pub struct AgentStopResult {
    #[serde(flatten)]
    pub exit: ProcessExit,
    /// The CLI had ended before this stop, so the stop signaled nothing. Omitted when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub already_ended: bool,
}

pub struct AgentRemove;
impl Operation for AgentRemove {
    const NAME: &'static str = "agent.remove";
    const DOC: &'static str = "Removes the agent record. Stops a running agent first with \
                               `agent.stop`. Removing an ended agent sends no additional signal: \
                               processes left by a CLI that ended by itself can keep running if \
                               they ignore terminal hangup.";
    type Args = AgentSelectorArgs;
    type Result = EmptyResult;
}

pub struct AgentType;
impl Operation for AgentType {
    const NAME: &'static str = "agent.type";
    const DOC: &'static str = "Types into the agent's terminal. `raw` bytes from an attached \
                               terminal are queued as they are. `text` and `keys` go through the \
                               agent's typist, one call at a time, and their call is answered \
                               once they reached the terminal. If the agent ends first, the call \
                               fails with `ended` when nothing of it was typed, or with \
                               `partial_input`, whose data says what went in. One call carries \
                               at most 1 MiB as written, a paste counted with its brackets and \
                               Enter. A call with an ID fails with `capacity_exceeded` if the \
                               input does not fit in the agent's 1 MiB of waiting input or a \
                               resize is pending. A notification waits without a response; \
                               disconnection drops its waiting input. Success confirms that raw \
                               bytes were queued or that text and keys reached the terminal, not \
                               that the CLI processed them. Daemon failure can lose input not \
                               yet written; a missing response leaves the outcome unknown. An \
                               ended agent returns `ended`.";
    type Args = AgentTypeArgs;
    type Result = EmptyResult;
}

pub struct AgentRename;
impl Operation for AgentRename {
    const NAME: &'static str = "agent.rename";
    const DOC: &'static str = "Renames an agent and returns its record; the `agents` topic sends \
                               it as `updated`. A blank name gets a default name chosen from the \
                               suggested names.";
    type Args = AgentRenameArgs;
    type Result = AgentInfo;
}

pub struct AgentSend;
impl Operation for AgentSend {
    const NAME: &'static str = "agent.send";
    const DOC: &'static str = "Sends a message to an agent, from the agent the client acts for or \
                               else from the person, `human`. The recipient's typist types it into \
                               its terminal with a header naming the sender and the message, and \
                               presses Enter. Answers within the send's 30 seconds with the \
                               message: delivered through the terminal or read through the \
                               recipient's `messages` topic, or failed with a reason and what \
                               reached the terminal. Its delivery has what is left of the 30 \
                               seconds as the call reaches the daemon, `time_left_ms`, at most \
                               29.5 seconds, the rest kept for the answer's way back. A message to \
                               `#human` is delivered once a member window's current `messages` \
                               subscription takes it. The response reports the outcomes in \
                               `windows`. If none take it, `unavailable` lists their reasons in \
                               `data.windows` and the send keeps no message. A message to a guest \
                               waits for the guest's next turn: the send answers at once with its \
                               delivery `pending` and no deadline, and the guest's prompt or \
                               turn-end hook delivers it, through `read`. Refusals before the \
                               message exists are errors: invalid text, longer than 8,000 \
                               characters or 540 lines included, a sender or recipient not found, \
                               a recipient that ended, a message to the person from the person, \
                               or a reply to a message \
                               not in the sender's inbox. A recipient removed before the answer \
                               took the message with it: the call fails with `ended`. A daemon \
                               that ends before responding closes the connection. The next one \
                               goes on delivering a message to an agent within the same 30 \
                               seconds and never pastes again a message whose paste began. If \
                               the daemon ended after storing a `#human` message and before saving the \
                               window outcomes, a repeat returns the original message, still \
                               `pending` with no `windows`. Its outcome is unknown. A `request_id` \
                               of the sender's own is looked for before anything else: the same ID within the hour \
                               of the message it kept answers that message as it stands, \
                               `repeated`, joining its delivery while it lasts, and sends nothing \
                               again, across daemon restarts too. A refused or withdrawn send \
                               keeps no ID. A `cancel` of the call withdraws the message while its \
                               paste has not begun: it answers `cancelled`, and nothing of it is \
                               typed or kept; one whose paste began goes on.";
    type Args = AgentSendArgs;
    type Result = AgentSendResult;
}

pub struct AgentScreen;
impl Operation for AgentScreen {
    const NAME: &'static str = "agent.screen";
    const DOC: &'static str = "Reads the last logical lines of the agent's screen and scrollback \
                               as they show, inverse and dim text marked, with whether older lines \
                               lie above them. An ended agent's screen is the one it left.";
    type Args = AgentScreenArgs;
    type Result = ScreenText;
}

pub struct AgentResize;
impl Operation for AgentResize {
    const NAME: &'static str = "agent.resize";
    const DOC: &'static str = "Accepts a terminal size for all viewers; the last resize wins. When \
                               the applied size changes, every viewer receives a redraw at that \
                               size. If a full screen log is waiting for its checkpoint writer, \
                               only the latest requested size is kept and applied when the writer \
                               finishes. A daemon failure before application loses that request. \
                               Input sent afterward waits for the size: calls with IDs fail with \
                               `capacity_exceeded`, while notifications wait. An agent whose \
                               terminal closed accepts it without changing anything.";
    type Args = AgentResizeArgs;
    type Result = EmptyResult;
}

pub struct AgentInspect;
impl Operation for AgentInspect {
    const NAME: &'static str = "agent.inspect";
    const DOC: &'static str = "Reads the agent's record, its CLI rule, its message input as the \
                               screen shows it now, and whether its session is tracked. Sends no \
                               keys and starts nothing. Input reads `unknown` for an ended agent, \
                               without a rule, while a synchronized update is open, and after \
                               recovery or resume until the CLI writes again. A reading never \
                               means input may be typed.";
    type Args = AgentSelectorArgs;
    type Result = AgentInspectResult;
}

pub struct AgentResume;
impl Operation for AgentResume {
    const NAME: &'static str = "agent.resume";
    const DOC: &'static str = "Starts an ended agent's CLI again in its terminal, continuing its \
                               recorded session in its original folder. The agent keeps its ID, \
                               name, members, record, and screen. The screen gets a fresh \
                               terminal's modes. Uses the caller's environment and terminal size, and the CLI's \
                               current rule. An overlapping resume waits for the first. If the \
                               run number changed while it waited, it returns the current record, \
                               even if the new run has already ended. Otherwise it tries to \
                               resume. Returns `not_found` if the agent \
                               was removed, or `unavailable` if the agent was already running at \
                               entry, for an agent without a CLI rule that resumes \
                               sessions, one without a recorded session, or a CLI or folder that \
                               cannot be used. Waits for the keeper like `agent.start`. If the CLI \
                               cannot start, the agent stays ended with its earlier exit.";
    type Args = AgentResumeArgs;
    type Result = AgentInfo;
}

/// Adds the caller's editor window to an agent's members.
pub struct AgentAdopt;
impl Operation for AgentAdopt {
    const NAME: &'static str = "agent.adopt";
    const DOC: &'static str = "Adds a bound `ide` client's logical window \
                               to the agent's members and returns the record. Works for running and \
                               ended agents. An existing member is returned unchanged. Refuses \
                               a guest or a client without a bound editor window, and returns \
                               `not_found` for a missing record.";
    type Args = AgentSelectorArgs;
    type Result = AgentInfo;
}

pub struct HookSessionStart;
impl Operation for HookSessionStart {
    const NAME: &'static str = "hook.session-start";
    const DOC: &'static str = "For a CLI's session-start hook: a session of `cli` began. A session \
                               that is not of a run Facade started joins as a guest: the next \
                               agent ID, a default name and `guest: true`, listed until its \
                               session ends. Answers the guest's ID and what its model is told. In \
                               a run's own session it changes nothing: the session Facade records \
                               for the run of the same CLI that the client acts for, or any \
                               session while it records none. Another session of that CLI, nested \
                               in the run, is a guest's.";
    type Args = HookSession;
    type Result = SessionStartResult;
}

pub struct HookPrompt;
impl Operation for HookPrompt {
    const NAME: &'static str = "hook.prompt";
    const DOC: &'static str = "For a CLI's prompt hook: a turn of the session began, and its guest \
                               reads `working`. Takes every message not yet delivered to the \
                               guest, which delivers them through `read`, for the hook to give its \
                               model with the prompt. A CLI whose prompt hook runs before each of \
                               a turn's model calls, Antigravity, reports only the turn's first. \
                               Claude Code's names `status_file`, where Claude Code reports how \
                               its session stands: while the guest reads `working`, the daemon \
                               reads it once a second, and `idle` there, written since the turn \
                               began, ends the turn as `hook.idle` does, for a turn the person cut \
                               short, which runs no hook. A session not yet known joins first, as \
                               at its start. A subagent's prompt, and a run's, takes nothing.";
    type Args = HookSession;
    type Result = HandOver;
}

pub struct HookTurnEnd;
impl Operation for HookTurnEnd {
    const NAME: &'static str = "hook.turn-end";
    const DOC: &'static str = "For a CLI's turn-end hook: the session ended a turn, and its guest \
                               reads `idle`. Takes every message not yet delivered to the guest, \
                               which delivers them through `read` as a snapshot does, for the hook \
                               to give its model before the turn ends. A session not yet known \
                               joins first. A subagent's turn, and a run's, takes nothing.";
    type Args = HookSession;
    type Result = HandOver;
}

pub struct HookIdle;
impl Operation for HookIdle {
    const NAME: &'static str = "hook.idle";
    const DOC: &'static str = "For a CLI's sign that its turn ended without its turn-end hook, as \
                               one the person cut short does, or Claude Code's that ended in an \
                               error: its guest reads `idle`, and nothing is taken: its messages \
                               wait for the next prompt. A session not yet known joins first. A \
                               subagent's, and a run's, change nothing.";
    type Args = HookSession;
    type Result = EmptyResult;
}

pub struct HookSessionEnd;
impl Operation for HookSessionEnd {
    const NAME: &'static str = "hook.session-end";
    const DOC: &'static str = "For a CLI's session-end hook: the session ended. Its guest is \
                               removed: `removed` on the `agents` topic, and its waiting \
                               messages dropped.";
    type Args = HookSession;
    type Result = EmptyResult;
}

pub struct IntegrationAdd;
impl Operation for IntegrationAdd {
    const NAME: &'static str = "integration.add";
    const DOC: &'static str = "Writes Facade's entries in a CLI's user configuration, so that the \
                               sessions the person starts join as guests: Facade's MCP server, an \
                               approval of its own tools only, and the hooks, plugin or extension \
                               that report a session's start, turns and end. Nothing else changes. \
                               Each file is read first, and nothing is written where one cannot be \
                               read as its CLI writes it, or holds a `facade` entry of the \
                               person's own. Adding again brings Facade's entries up to date. \
                               Answers each file's state.";
    type Args = IntegrationArgs;
    type Result = IntegrationInfo;
}

pub struct IntegrationRemove;
impl Operation for IntegrationRemove {
    const NAME: &'static str = "integration.remove";
    const DOC: &'static str = "Takes Facade's entries out of a CLI's user configuration. A file \
                               nothing else changed since is put back as it was, byte for byte, \
                               and one Facade made is deleted; in a file changed since, only \
                               Facade's entries go. Answers each file's state after.";
    type Args = IntegrationArgs;
    type Result = IntegrationInfo;
}

pub struct IntegrationList;
impl Operation for IntegrationList {
    const NAME: &'static str = "integration.list";
    const DOC: &'static str = "Says, for each CLI Facade can integrate, whether its user \
                               configuration holds Facade's entries, file by file, and as they \
                               would be written now.";
    type Args = IntegrationListArgs;
    type Result = IntegrationListResult;
}

pub struct WindowUpdate;
impl Operation for WindowUpdate {
    const NAME: &'static str = "window.update";
    const DOC: &'static str = "For a bound `ide` client, replaces its window's description, \
                               keeping the same window instance ID, and reads its locations \
                               again, which the client asks for when a repository of the window \
                               changes. Responds once they are read. If the window stops offering \
                               an agent's location and is the agent's location source, the agent \
                               ends as `agent.stop` ends it.";
    type Args = WindowDescription;
    type Result = EmptyResult;
}

pub struct DaemonUpgrade;
impl Operation for DaemonUpgrade {
    const NAME: &'static str = "daemon.upgrade";
    const DOC: &'static str = "Hands the running Facade over to a newer build, `program`, while \
                               every agent runs on, and answers once the handover is under way; \
                               `closing` follows on every connection past `hello`. The build must \
                               be of a higher version than this daemon's and speak its daemon \
                               protocol version; while agents run, it must also speak the running \
                               keeper's protocol, as the keeper never changes build while it holds \
                               CLIs. This daemon installs the build, points the launchers at it, \
                               drains and exits; the keeper then starts the launcher's daemon, the \
                               new build, and starts it again with its restart delay where it does \
                               not come up. Nothing rolls back. Calls that arrive meanwhile answer \
                               `upgrading` and did nothing. A second request while a handover is \
                               under way answers when the first does.";
    type Args = DaemonUpgradeArgs;
    type Result = DaemonUpgradeResult;
}

pub struct LogRead;
impl Operation for LogRead {
    const NAME: &'static str = "daemon.log";
    const DOC: &'static str = "Reads the daemon's log, `core/logs/daemon.log`, which Facade keeps \
                               for 30 days: its last `lines` lines, oldest first. For the person's \
                               clients alone: the log names every agent and who sent whom a \
                               message, so a call that acts for an agent or a guest answers \
                               `refused`, YOLO or not. More than 200 lines answers \
                               `invalid_argument`.";
    type Args = DaemonLogArgs;
    type Result = DaemonLogResult;
}

pub struct WorktreeCreate;
impl Operation for WorktreeCreate {
    const NAME: &'static str = "worktree.create";
    const DOC: &'static str = "Makes a Git worktree from the checkout at `cwd`, a location of the \
                               window, with a new branch that starts at `base_ref`, at `<main \
                               folder>.worktrees/<branch>`: the branch less the window's branch \
                               prefix, with characters a folder name cannot hold replaced by `-`, \
                               and `-1`, `-2` and so on after it where that path is taken. Answers \
                               with the new location. Refuses before changing anything a branch \
                               Git does not accept, a folder name some system cannot hold, and a \
                               location that is not a checkout with a commit. Creations into one \
                               `.worktrees` folder run one at a time; one that waits more than 120 \
                               seconds for another fails. Git's failures answer `worktree_failed`: \
                               one partway keeps what it made, and its error says what in \
                               `data.kept`.";
    type Args = WorktreeCreateArgs;
    type Result = LocationInfo;
}

/// Visits every daemon protocol operation.
pub fn visit_operations(visitor: &mut impl OperationVisitor) {
    visitor.operation::<AgentStart>();
    visitor.operation::<AgentResume>();
    visitor.operation::<AgentAdopt>();
    visitor.operation::<AgentStop>();
    visitor.operation::<AgentRemove>();
    visitor.operation::<AgentInspect>();
    visitor.operation::<AgentType>();
    visitor.operation::<AgentScreen>();
    visitor.operation::<AgentResize>();
    visitor.operation::<AgentRename>();
    visitor.operation::<AgentSend>();
    visitor.operation::<HookSessionStart>();
    visitor.operation::<HookPrompt>();
    visitor.operation::<HookTurnEnd>();
    visitor.operation::<HookIdle>();
    visitor.operation::<HookSessionEnd>();
    visitor.operation::<IntegrationAdd>();
    visitor.operation::<IntegrationRemove>();
    visitor.operation::<IntegrationList>();
    visitor.operation::<WindowUpdate>();
    visitor.operation::<WorktreeCreate>();
    visitor.operation::<DaemonUpgrade>();
    visitor.operation::<LogRead>();
}

pub struct AgentsTopic;
impl Topic for AgentsTopic {
    const NAME: &'static str = "agents";
    const DOC: &'static str = "Lists agent records and machine sync states, then sends `updated` \
                               and `removed` by machine and agent ID. Starts, exits, \
                               removals, renames, and a state of waiting for the person or an \
                               error are published immediately. Other state changes, and title and \
                               size changes, are batched for up to 200 ms.";
    type Args = AgentsWatchArgs;
    type Snapshot = AgentsSnapshot;
    type Change = AgentsChange;
}

pub struct ScreenTopic;
impl Topic for ScreenTopic {
    const NAME: &'static str = "screen";
    const DOC: &'static str = "Follows one agent's screen: a full redraw, then `output`, \
                               `redraw`, `exit`, and `removed` changes. A viewer that is behind \
                               during removal receives the last screen, any exit it missed, and \
                               then `removed`.";
    type Args = ScreenWatchArgs;
    type Snapshot = ScreenSnapshot;
    type Change = ScreenChange;
}

pub struct MessagesTopic;
impl Topic for MessagesTopic {
    const NAME: &'static str = "messages";
    const DOC: &'static str = "Reads the inbox of the agent the client acts for: the selected \
                               messages, oldest first, then `updated` when a message arrives or \
                               its delivery changes, and `removed` when one is no longer kept: \
                               withdrawn by its send's `cancel`, gone after its 30 days, or gone \
                               with its inbox. A snapshot delivers every message it returns that \
                               was not yet delivered: its typist does not type it, or finishes a \
                               paste it began, and its sender learns that it was read. A change \
                               delivers nothing, so a client that hands messages to a model \
                               takes them through a snapshot. For an `ide` client it reads the \
                               person's inbox, `human`. Its snapshot includes the messages \
                               delivered to that logical window. Its changes carry new \
                               notifications sent to that window's subscription. Messages and \
                               what became of them are kept 30 days, across daemon restarts.";
    type Args = MessagesWatchArgs;
    type Snapshot = MessagesSnapshot;
    type Change = MessagesChange;
}

pub struct WindowsTopic;
impl Topic for WindowsTopic {
    const NAME: &'static str = "windows";
    const DOC: &'static str = "Lists logical editor windows, including disconnected windows \
                               retained for reopening, and the terminal window while it holds \
                               running agents. Then sends `updated` to insert or replace a \
                               window and `removed` to remove it, by machine ID and window ID. For a \
                               client that acts for an agent, each window lists the CLIs a start \
                               by that agent can run.";
    type Args = NoArgs;
    type Snapshot = Vec<WindowInfo>;
    type Change = WindowsChange;
}

/// Visits every daemon protocol topic.
pub fn visit_topics(visitor: &mut impl TopicVisitor) {
    visitor.topic::<AgentsTopic>();
    visitor.topic::<ScreenTopic>();
    visitor.topic::<MessagesTopic>();
    visitor.topic::<WindowsTopic>();
}

pub fn operation_names() -> Vec<String> {
    super::operations::collect_names(visit_operations)
}

pub fn topic_names() -> Vec<String> {
    super::operations::collect_names(visit_topics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn window_delivery_rows_keep_the_original_v2_grouping_and_methods() {
        let one = json!({ "machine_id": "here", "window_id": "one" });
        let two = json!({ "machine_id": "here", "window_id": "two" });
        let three = json!({ "machine_id": "there", "window_id": "three" });
        let v2 = json!({
            "delivered": [one],
            "not_delivered": [{ "window": two, "reason": "not_watching" }],
            "outcome_unknown": [three],
        });
        let legacy: WindowDelivery = serde_json::from_value(v2.clone()).unwrap();
        let outcomes = legacy.into_outcomes();
        assert_eq!(
            serde_json::to_value(&outcomes).unwrap(),
            json!([
                { "window": one, "state": "delivered" },
                { "window": two, "state": "not_delivered", "reason": "not_watching" },
                { "window": three, "state": "outcome_unknown" },
            ])
        );
        assert_eq!(
            serde_json::to_value(WindowDelivery::from_outcomes(outcomes)).unwrap(),
            v2
        );
        for (via, name) in [
            (DeliveredVia::TypedIntoInput, "terminal"),
            (DeliveredVia::ReadByRecipient, "read"),
            (DeliveredVia::DeliveredToWindows, "notified"),
        ] {
            assert_eq!(serde_json::to_value(via).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<DeliveredVia>(json!(name)).unwrap(),
                via
            );
        }
    }

    #[test]
    fn starts_and_preflights_keep_the_v2_folder_marker_and_command_vector() {
        use crate::machine::AgentCheckStart;

        assert_eq!(
            [MIN_DAEMON_PROTOCOL_VERSION, DAEMON_PROTOCOL_VERSION],
            [2, 2]
        );
        let local = json!({
            "command": ["fake", "--flag", "", "two words"],
            "cwd": "/caller/project",
            "cwd_is_default": true,
            "env": {},
            "cols": 80,
            "rows": 24,
        });
        let start: <AgentStart as Operation>::Args = serde_json::from_value(local.clone()).unwrap();
        let decoded = start.clone().into_start(false);
        assert_eq!(decoded.launch.folder.as_deref(), Some("/caller/project"));
        assert_eq!(decoded.launch.program, "fake");
        assert_eq!(decoded.launch.args, ["--flag", "", "two words"]);
        assert_eq!(serde_json::to_value(&start).unwrap(), local);

        let forwarded = start.for_forwarding();
        let mut remote_default = local;
        remote_default["cwd"] = json!("");
        assert_eq!(serde_json::to_value(forwarded).unwrap(), remote_default);
        let preflight: <AgentCheckStart as Operation>::Args =
            serde_json::from_value(remote_default.clone()).unwrap();
        assert_eq!(preflight.clone().into_start(true).launch.folder, None);
        assert_eq!(preflight.into_start(false).launch.folder, None);

        let fields = remote_default.as_object_mut().unwrap();
        fields.remove("cwd_is_default");
        fields.insert("cwd".to_string(), json!("C:\\Work\\Repo"));
        let explicit: AgentStartWireArgs = serde_json::from_value(remote_default.clone()).unwrap();
        assert_eq!(
            explicit.clone().into_start(true).launch.folder.as_deref(),
            Some("C:\\Work\\Repo")
        );
        assert_eq!(
            serde_json::to_value(explicit.for_forwarding()).unwrap(),
            remote_default
        );
        remote_default["cwd"] = json!("");
        let explicit_empty: AgentStartWireArgs = serde_json::from_value(remote_default).unwrap();
        assert_eq!(
            explicit_empty.into_start(true).launch.folder,
            Some("".into())
        );
    }

    #[test]
    fn hook_sessions_keep_the_v2_parent_field() {
        let nested = json!({ "cli": "opencode", "session": "child", "parent": "outer" });
        let hook: HookSession = serde_json::from_value(nested.clone()).unwrap();
        assert_eq!(hook.part_of_session.as_deref(), Some("outer"));
        assert_eq!(serde_json::to_value(&hook).unwrap(), nested);

        let whole = json!({ "cli": "opencode", "session": "outer" });
        let hook: HookSession = serde_json::from_value(whole.clone()).unwrap();
        assert_eq!(hook.part_of_session, None);
        assert_eq!(serde_json::to_value(&hook).unwrap(), whole);
    }

    #[test]
    fn values_this_build_does_not_know_read_as_unknown() {
        assert_eq!(
            serde_json::from_str::<ClientKind>("\"hologram\"").unwrap(),
            ClientKind::Unknown
        );
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
        // Unknown fields are ignored.
        let hello: HelloParams = serde_json::from_value(
            json!({ "protocol": [1, 9], "build": "9.0.0", "kind": "terminal", "telepathy": true }),
        )
        .unwrap();
        assert_eq!(hello.protocol_range, [1, 9]);
    }

    /// Untrusted text shows as one line: invisible formatting removed, controls and runs of white
    /// space as one space, trimmed, and cut between whole graphemes with an ellipsis. A name shows
    /// that way in at most 120 characters.
    #[test]
    fn untrusted_text_shows_as_one_line_cut_between_whole_graphemes() {
        assert_eq!(display_line("\u{202e}a\tb\r\n\u{feff} c ", 10), "a b c");
        assert_eq!(display_line("abcdef", 4), "abc…");
        assert_eq!(
            display_line("ab   cdef", 4),
            "ab…",
            "no space before the ellipsis"
        );
        assert_eq!(display_line("👍🏽xy", 3), "👍🏽…");
        assert_eq!(display_line("👍🏽x", 2), "…", "never half a grapheme");
        assert_eq!(
            display_name("evil\u{1b}[201~\r\nINJECTED"),
            "evil [201~ INJECTED"
        );
        assert_eq!(
            display_name(&"n".repeat(121)),
            format!("{}…", "n".repeat(119))
        );
    }

    /// A message shows under one header line: its sender's name and ID, its number, its sender's
    /// window where that is another, and what it answers.
    #[test]
    fn a_message_shows_its_sender_number_window_and_reply_above_its_text() {
        let delivery = Delivery {
            status: DeliveryStatus::Pending,
            reason: None,
            text_written: TextWritten::None,
            enter_written: Some(false),
            deadline: None,
            delivered_via: None,
            delivered_at: None,
        };
        let mut sent = Message {
            message_ref: None,
            from_machine_id: None,
            reply_to_machine_id: None,
            message_id: "m42".into(),
            from: "a1".into(),
            from_name: Some("Ada".into()),
            to: "a2".into(),
            text: "message 42".into(),
            reply_to: None,
            from_window: None,
            call_id: None,
            result: None,
            at: "2026-11-10T00:00:00.000Z".into(),
            delivery,
        };
        assert_eq!(
            typed_text(&sent),
            "📨 Message from Ada (#a1) · #m42\nmessage 42"
        );
        sent.reply_to = Some("m39".into());
        assert_eq!(
            typed_text(&sent),
            "📨 Message from Ada (#a1) · #m42 · Reply to #m39\nmessage 42"
        );
        sent.from_window = Some("Design".into());
        assert_eq!(
            typed_text(&sent),
            "📨 Message from Ada (#a1) · #m42 · From Design · Reply to #m39\nmessage 42",
            "the sender's window, where it is another"
        );
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu"), Some("id:3f9a2c1d")),
            "📨 Message from Ada (#a1@gpu) · #m42 · From Design on gpu · Reply to #m39@id:3f9a2c1d\nmessage 42"
        );
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu\n"), Some("gpu\n")),
            typed_text(&sent),
            "only valid selectors appear in the header"
        );
        sent.from_window = None;
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu"), None),
            "📨 Message from Ada (#a1@gpu) · #m42 · on gpu · Reply to #m39\nmessage 42"
        );
        sent.from_window = Some("evil\u{1b}[201~\r\nWINDOW".into());
        assert_eq!(
            typed_text(&sent).lines().count(),
            2,
            "a window's name shows on the header's one line"
        );
        sent.from_window = None;
        sent.from_name = Some("evil\u{1b}[201~\r\nINJECTED".into());
        sent.reply_to = None;
        let typed = typed_text(&sent);
        assert_eq!(
            typed.split_once('\n'),
            Some((
                "📨 Message from evil [201~ INJECTED (#a1) · #m42",
                "message 42"
            )),
            "a name shows on the header's one line"
        );
        sent.from = "human".into();
        sent.from_name = None;
        assert_eq!(
            typed_text(&sent),
            "📨 Message from #human · #m42\nmessage 42"
        );
        assert_eq!(
            typed_text_with_machines(&sent, Some("gpu"), None),
            "📨 Message from #human · #m42 · on gpu\nmessage 42",
            "the person always uses the reserved #human reference"
        );
    }

    /// A result shows `🔔`, its first line and its own number, then the rest: no sender's header
    /// and no reply. Its words say the agent started, whether its tools are there, and what became
    /// of its prompt: passed on, through a read, or not delivered with what reached the terminal
    /// and why.
    #[test]
    fn a_result_shows_under_a_bell_and_words_what_became_of_the_prompt() {
        let agent: AgentInfo = serde_json::from_value(serde_json::json!({
            "agent_id": "a5", "name": "helper", "cli": "claude", "cwd": "/w",
            "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "windows": [{
                "machine_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "window_id": "terminal"
            }],
            "location_id": "loc-1", "pid": 7, "process": "running",
            "cols": 80, "rows": 24, "created_at": "2026-11-11T00:00:00.000Z", "root": "a5",
            "yolo": true, "state": "idle", "tools_state": "available",
        }))
        .unwrap();
        let delivery = |status, reason, text_written, enter_written, delivered_via| Delivery {
            status,
            reason,
            text_written,
            enter_written,
            deadline: None,
            delivered_via,
            delivered_at: None,
        };
        let words = |agent: &AgentInfo, delivery: Delivery| {
            start_result_text(&StartOutcome {
                agent: agent.clone(),
                prompt: PromptOutcome {
                    message_id: "m42".into(),
                    delivery,
                },
            })
        };
        let typed = delivery(
            DeliveryStatus::Success,
            None,
            TextWritten::Full,
            Some(true),
            Some(DeliveredVia::TypedIntoInput),
        );
        assert_eq!(
            words(&agent, typed.clone()),
            "helper (#a5) has started.\nYour initial message #m42 has been passed on."
        );
        let read = delivery(
            DeliveryStatus::Success,
            None,
            TextWritten::None,
            Some(false),
            Some(DeliveredVia::ReadByRecipient),
        );
        assert_eq!(
            words(&agent, read),
            "helper (#a5) has started.\nYour initial message #m42 has been passed on through \
             read_messages."
        );
        let read_while_typed = delivery(
            DeliveryStatus::Success,
            None,
            TextWritten::Unknown,
            None,
            Some(DeliveredVia::ReadByRecipient),
        );
        assert_eq!(
            words(&agent, read_while_typed),
            "helper (#a5) has started.\nYour initial message #m42 has been passed on through \
             read_messages.\n\
             How much text was entered is unknown. Whether Enter was pressed is unknown. Check the \
             terminal for leftover input."
        );
        let ended = delivery(
            DeliveryStatus::Failure,
            Some(DeliveryFailure::Ended),
            TextWritten::None,
            Some(false),
            None,
        );
        assert_eq!(
            words(&agent, ended),
            "helper (#a5) has started.\nYour initial message #m42 could not be delivered. Nothing \
             was entered in the terminal.\n\
             #a5 ended before the message was delivered."
        );
        let unconfirmed = delivery(
            DeliveryStatus::Failure,
            Some(DeliveryFailure::SubmissionUnconfirmed),
            TextWritten::Full,
            Some(false),
            None,
        );
        assert_eq!(
            words(&agent, unconfirmed),
            "helper (#a5) has started.\nDelivery of your initial message #m42 could not be \
             confirmed. The full message was entered. Enter was not \
             pressed. Check the terminal before sending it again.\n#a5's CLI did not take the \
             message before the deadline."
        );
        let unavailable = AgentInfo {
            tools_state: ToolsState::Unavailable,
            tools_reason: Some(ToolsReason::NotConnected),
            ..agent.clone()
        };
        assert_eq!(
            words(&unavailable, typed.clone()).lines().nth(1),
            Some(
                "Its Facade tools are unavailable: its Facade server did not connect within \
                 60 seconds."
            )
        );
        let result = Message {
            message_ref: None,
            from_machine_id: None,
            reply_to_machine_id: None,
            message_id: "m43".into(),
            from: FACADE.into(),
            from_name: None,
            to: "a1".into(),
            text: words(&agent, typed),
            reply_to: None,
            from_window: None,
            call_id: Some("7".into()),
            result: None,
            at: "2026-11-11T00:00:00.000Z".into(),
            delivery: delivery(
                DeliveryStatus::Pending,
                None,
                TextWritten::None,
                Some(false),
                None,
            ),
        };
        assert_eq!(
            typed_text(&result),
            "🔔 helper (#a5) has started. · #m43\nYour initial message #m42 has been passed on."
        );
        assert_eq!(
            typed_text(&Message {
                text: "one line".into(),
                ..result
            }),
            "🔔 one line · #m43"
        );
    }

    /// A failed delivery says why, then what of it was typed, never more than its delivery says.
    #[test]
    fn a_failed_delivery_says_why_and_claims_no_more_than_is_known() {
        let failed = |reason, text_written, enter_written| {
            let delivery = Delivery {
                status: DeliveryStatus::Failure,
                reason: Some(reason),
                text_written,
                enter_written,
                deadline: None,
                delivered_via: None,
                delivered_at: None,
            };
            delivery.failure_words("#a2")
        };
        use DeliveryFailure::{InputDraft, SubmissionUnconfirmed, Timeout};
        assert_eq!(
            failed(InputDraft, TextWritten::None, Some(false)),
            "a draft held #a2's input until the deadline; Facade never types over a draft; \
             nothing was typed"
        );
        assert_eq!(
            failed(Timeout, TextWritten::None, Some(false)),
            "the deadline passed before #a2 took the message; nothing was typed"
        );
        let unconfirmed = "#a2's CLI did not take the message before the deadline";
        for (text_written, enter_written, typed) in [
            (TextWritten::None, Some(false), "nothing was typed"),
            (TextWritten::Partial, Some(false), "part of it was typed"),
            (
                TextWritten::Full,
                Some(false),
                "all of it was typed, but not its Enter",
            ),
            (
                TextWritten::Full,
                Some(true),
                "all of it and its Enter were typed",
            ),
        ] {
            assert_eq!(
                failed(SubmissionUnconfirmed, text_written, enter_written),
                format!("{unconfirmed}; {typed}")
            );
        }
        assert_eq!(
            failed(SubmissionUnconfirmed, TextWritten::Unknown, None),
            "Facade could not confirm by the deadline that #a2's CLI took the message; what of it \
             was typed is not known"
        );
    }

    #[test]
    fn a_change_of_a_kind_this_build_does_not_know_is_skipped_and_the_next_one_still_reads() {
        let changes = json!([
            { "kind": "removed", "agent_id": "a1", "machine_id": "fixture" },
            { "kind": "renamed", "agent_id": "a2", "name": "x" },
            { "kind": "removed", "agent_id": "a3", "machine_id": "fixture" },
        ]);
        let read: Vec<AgentsChange> = serde_json::from_value(changes).unwrap();
        assert_eq!(
            read,
            vec![
                AgentsChange::Removed {
                    machine_id: "fixture".into(),
                    agent_id: "a1".into()
                },
                AgentsChange::Unknown,
                AgentsChange::Removed {
                    machine_id: "fixture".into(),
                    agent_id: "a3".into()
                }
            ]
        );
        let screen: Vec<ScreenChange> = serde_json::from_value(
            json!([{ "kind": "resized", "cols": 80 }, { "kind": "removed" }]),
        )
        .unwrap();
        assert_eq!(screen, vec![ScreenChange::Unknown, ScreenChange::Removed]);
    }

    #[test]
    fn a_screen_watch_includes_scrollback_unless_asked_not_to() {
        let args: ScreenWatchArgs = serde_json::from_value(json!({ "agent": "a1" })).unwrap();
        assert!(args.include_scrollback && !args.keep_scrollback);
        let args: ScreenWatchArgs = serde_json::from_value(
            json!({ "agent": "a1", "keep_scrollback": true, "include_scrollback": false }),
        )
        .unwrap();
        assert!(!args.include_scrollback && args.keep_scrollback);
    }

    #[test]
    fn absent_values_are_left_out_and_changes_carry_their_kind() {
        let exit = ProcessExit {
            code: Some(0),
            signal: None,
            reason: None,
            at: "2026-11-09T17:22:05.123Z".into(),
        };
        assert_eq!(
            serde_json::to_value(ScreenChange::Exit { exit }).unwrap(),
            json!({ "kind": "exit", "exit": { "code": 0, "at": "2026-11-09T17:22:05.123Z" } })
        );
        assert_eq!(
            serde_json::to_value(ScreenChange::Output {
                data: "aGk=".into()
            })
            .unwrap(),
            json!({ "kind": "output", "data": "aGk=" })
        );
        let start = AgentStartWireArgs {
            machine: None,
            cwd_is_default: false,
            initial_windows: None,
            result_message_id: None,
            result_message_machine_id: None,
            command: vec!["claude".into()],
            name: None,
            cwd: "/".into(),
            window: None,
            location_source_window: None,
            env: BTreeMap::new(),
            cols: 80,
            rows: 24,
            prompt: None,
            call_id: None,
            request_id: None,
            worktree: None,
            model: None,
            effort: None,
            session: None,
        };
        assert_eq!(
            serde_json::to_value(start).unwrap(),
            json!({ "command": ["claude"], "cwd": "/", "env": {}, "cols": 80, "rows": 24 })
        );
        assert_eq!(serde_json::to_value(EmptyResult {}).unwrap(), json!({}));
        let keys = AgentTypeArgs {
            agent: "a1".into(),
            raw: Some("aGk=".into()),
            ..AgentTypeArgs::default()
        };
        assert_eq!(
            serde_json::to_value(keys).unwrap(),
            json!({ "agent": "a1", "raw": "aGk=" }),
            "an attached terminal's keys carry only raw"
        );
        let text = AgentTypeArgs {
            agent: "a1".into(),
            text: Some("hi".into()),
            enter: true,
            ..AgentTypeArgs::default()
        };
        assert_eq!(
            serde_json::to_value(text).unwrap(),
            json!({ "agent": "a1", "text": "hi", "enter": true })
        );
    }

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
    fn input_reads_unknown_as_a_state_of_its_own_and_a_state_this_build_does_not_know_as_unrecognized()
     {
        assert_eq!(
            serde_json::to_value(InputState::Unknown).unwrap(),
            json!("unknown")
        );
        assert_eq!(
            serde_json::from_value::<InputState>(json!("unknown")).unwrap(),
            InputState::Unknown
        );
        assert_eq!(
            serde_json::from_value::<InputState>(json!("typing")).unwrap(),
            InputState::Unrecognized
        );
        let schema = serde_json::to_value(schemars::schema_for!(InputState))
            .unwrap()
            .to_string();
        assert!(
            schema.contains("\"unknown\"") && !schema.contains("unrecognized"),
            "{schema}"
        );
        assert_eq!(
            serde_json::from_value::<InputMechanism>(json!("prompt_row")).unwrap(),
            InputMechanism::PromptRow
        );
        assert_eq!(
            serde_json::from_value::<InputMechanism>(json!("canvas")).unwrap(),
            InputMechanism::Unknown
        );
        let input = InputInfo {
            state: InputState::Unknown,
            evidence: "the agent ended".into(),
            mechanism: None,
            hidden: None,
        };
        assert_eq!(
            serde_json::to_value(&input).unwrap(),
            json!({ "state": "unknown", "evidence": "the agent ended" }),
            "absent values are left out"
        );
    }

    #[test]
    fn every_operation_is_a_thing_and_a_verb_and_every_name_is_there_once() {
        let mut names: Vec<String> = operation_names().into_iter().chain(topic_names()).collect();
        let count = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), count);
        assert!(
            operation_names()
                .iter()
                .all(|op| op.split('.').count() == 2),
            "{:?}",
            operation_names()
        );
    }
    #[test]
    fn plain_screen_text_drops_the_marks_and_keeps_what_the_screen_shows() {
        assert_eq!(
            plain("plain [[picked]] {{hint}} [[{{both}}]]\n\\[a\\] \\{b\\} \\\\c\n[[ ]]"),
            "plain picked hint both\n[a] {b} \\c\n "
        );
        assert_eq!(plain(""), "");
    }

    #[test]
    fn message_text_is_printable_characters_tabs_and_line_breaks_up_to_eight_thousand_characters() {
        assert!(check_message_text("hello\n\tworld 界").is_ok());
        assert!(
            check_message_text(&"界".repeat(MAX_MESSAGE_CHARS)).is_ok(),
            "characters, not bytes"
        );
        assert!(
            check_message_text(&"x".repeat(MAX_MESSAGE_CHARS + 1))
                .unwrap_err()
                .starts_with("text has 8001 characters")
        );
        let lines = |count: usize, between: &str| vec!["x"; count].join(between);
        assert!(check_message_text(&lines(MAX_MESSAGE_LINES, "\n")).is_ok());
        for between in ["\n", "\r", "\r\n"] {
            let refused = check_message_text(&lines(MAX_MESSAGE_LINES + 1, between)).unwrap_err();
            assert_eq!(
                refused,
                "text has 541 lines; a message carries at most 540: send it in shorter parts",
                "{between:?}"
            );
        }
        assert_eq!(
            check_message_text(" \n\t").unwrap_err(),
            "text is blank: a message needs text"
        );
        assert_eq!(
            check_message_text("a\u{1b}[2J").unwrap_err(),
            "text contains the control character U+001B at character 2; text takes printable \
             characters, tabs, and line breaks"
        );
        assert!(
            check_message_text("a\u{7f}")
                .unwrap_err()
                .contains("U+007F"),
            "DEL too"
        );
        assert!(
            check_message_text("[Earlier output truncated] the rest")
                .unwrap_err()
                .contains("its beginning was cut")
        );
    }
}
