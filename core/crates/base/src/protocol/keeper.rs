//! The keeper protocol connects the daemon and keeper over JSON-RPC 2.0, one message per line
//! ([`super::jsonrpc`]), on the keeper's socket, `keeper-<key>.sock`. It shares framing and error
//! reasons with the daemon protocol. Version 1 is frozen: later versions only add optional fields,
//! and every daemon keeps speaking version 1. Unknown fields are ignored, and an unknown operation
//! is `invalid_argument`.
//!
//! The keeper checks its peer through the kernel as it accepts the connection: its user ID must be
//! this user's, and its process ID and birth must match the daemon lock's record. Any other peer
//! is closed at once, before a word. A connection it accepts replaces the one before. Send `hello`
//! first; each side then speaks the highest version both ranges share.
//!
//! The keeper holds one CLI per agent: the CLI process and its PTY master. `agent.start` answers
//! with a master descriptor, passed with `SCM_RIGHTS`; `agent.sync` passes one either way, from
//! the side that has it to the side that lacks it. Once a CLI ends, the keeper notifies `changed`
//! where a daemon is connected, reaps it, closes its master and forgets it: a daemon that misses
//! the notification finds the agent gone from the next hello. Only the keeper that started a CLI
//! has its exit code or signal; a CLI it took over by `agent.sync` ends without either.
//!
//! `agent.stop` sends SIGHUP to the CLI's process group, then SIGKILL to the group once the CLI
//! ends or [`STOP_TIMEOUT`] passes, whichever comes first. A repeated stop keeps the first
//! deadline. Each signal needs the group's leader proved by its process ID, birth and group.
//!
//! The daemon pings once a second from its hello on. After [`PING_TIMEOUT`] without one, the keeper
//! ends it with SIGKILL. Once the daemon ends, a keeper holding CLIs starts the launcher's daemon
//! again after a delay that starts at [`MIN_RESTART_DELAY`] and doubles up to
//! [`MAX_RESTART_DELAY`], starting over after a daemon that ran [`RESTART_DELAY_RESET`]; a keeper
//! holding none exits.

use std::collections::BTreeMap;
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::operations::{EmptyResult, NoArgs, Operation, OperationVisitor};
use crate::process::ProcessExit;

pub const KEEPER_PROTOCOL_VERSION: u32 = 1;
pub const MIN_KEEPER_PROTOCOL_VERSION: u32 = 1;

/// From a stop's SIGHUP to its SIGKILL, unless the CLI ends first.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(3);
/// How long the keeper waits for a ping before it ends the daemon.
pub const PING_TIMEOUT: Duration = Duration::from_secs(15);
/// The first delay before the keeper starts a daemon again.
pub const MIN_RESTART_DELAY: Duration = Duration::from_millis(500);
/// The longest delay before the keeper starts a daemon again.
pub const MAX_RESTART_DELAY: Duration = Duration::from_secs(30);
/// Once a daemon runs this long, the restart delay starts over.
pub const RESTART_DELAY_RESET: Duration = Duration::from_secs(60);

pub mod methods {
    pub const HELLO: &str = "hello";
    pub const CALL: &str = "call";
    pub const CHANGED: &str = "changed";
}

/// Method descriptions for the generated reference.
pub const METHODS: &[(&str, &str)] = &[
    (
        methods::HELLO,
        "Starts the connection (`HelloParams`), answered with the keeper's range and the CLIs it \
         holds (`HelloResult`).",
    ),
    (
        methods::CALL,
        "Runs a keeper operation and returns its result. `params` contains `op`, an operation name \
         from the table below, and `args`, that operation's argument object.",
    ),
    (
        methods::CHANGED,
        "Reports that a CLI ended (`AgentChange`).",
    ),
];

/// Parameters for `hello`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct HelloParams {
    /// The oldest and newest keeper protocol versions the daemon speaks.
    pub protocol: [u32; 2],
}

/// The result of `hello`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct HelloResult {
    /// The oldest and newest keeper protocol versions the keeper speaks. Each side speaks the
    /// highest version both ranges share.
    pub protocol: [u32; 2],
    /// The keeper's build.
    pub build: String,
    /// The CLIs the keeper holds, in no particular order: every one that has not ended.
    pub agents: Vec<HeldAgent>,
}

/// A CLI the keeper holds, as `hello` reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HeldAgent {
    /// The agent's ID, an opaque string.
    pub id: String,
    /// The CLI's process ID.
    pub pid: u32,
    /// The CLI's birth: an opaque string, compared for equality alone. On macOS it is the
    /// process's start time as `<seconds>.<6-digit microseconds>`; on Linux, the starttime field,
    /// the 22nd, of `/proc/<pid>/stat`, in decimal.
    pub birth: String,
    /// The keeper is stopping it. Absent means false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopping: bool,
}

/// Arguments for `agent.start`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StartArgs {
    /// The agent's ID, an opaque string.
    pub agent: String,
    /// The program followed by its arguments; not empty. The program is an absolute path, or a
    /// name looked up in `env`'s `PATH`.
    pub command: Vec<String>,
    /// The CLI's whole environment. The keeper adds no variable.
    pub env: BTreeMap<String, String>,
    /// The CLI's working folder, an absolute path.
    pub path: String,
    /// The terminal's first width in columns. Below 2 is 2.
    pub cols: u16,
    /// The terminal's first height in rows. Below 1 is 1.
    pub rows: u16,
}

/// The result of `agent.start`. Its response carries the PTY master.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StartResult {
    /// The CLI's process ID.
    pub pid: u32,
    /// The CLI's birth, as [`HeldAgent::birth`].
    pub birth: String,
}

/// Arguments for an operation on one agent's CLI.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentArgs {
    /// The agent's ID.
    pub agent: String,
}

/// Arguments for `agent.sync`: the CLI the daemon knows for the agent. The request carries the
/// daemon's PTY master where it has one.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SyncArgs {
    /// The agent's ID.
    pub agent: String,
    /// The CLI's process ID.
    pub pid: u32,
    /// The CLI's birth, as [`HeldAgent::birth`].
    pub birth: String,
}

/// A change the keeper reports. The daemon skips kinds it does not know.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChange {
    /// An agent's CLI ended. An exit with neither a code nor a signal says nothing of how; it is
    /// never exit code 0.
    Exit { agent: String, exit: ProcessExit },
    /// A kind this build does not know. Skip it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

pub struct AgentStart;
impl Operation for AgentStart {
    const NAME: &'static str = "agent.start";
    const DOC: &'static str = "Starts the agent's CLI in a new PTY, in a session and process \
                               group of its own, as its parent. Answers once the program runs, \
                               with the PTY master. Fails with `invalid_argument` for an empty \
                               command or an agent it holds, and `unavailable` where the PTY, the \
                               program, the folder or the CLI's birth cannot be had.";
    type Args = StartArgs;
    type Result = StartResult;
}

pub struct AgentStop;
impl Operation for AgentStop {
    const NAME: &'static str = "agent.stop";
    const DOC: &'static str = "Sends SIGHUP to the CLI's process group and answers. Sends SIGKILL \
                               to the group once the CLI ends or 3 seconds pass, whichever comes \
                               first; a repeated stop keeps the first deadline. A group whose \
                               leader cannot be proved gets no signal, and the stop still \
                               answers. Fails with `not_found` for an agent it does not hold.";
    type Args = AgentArgs;
    type Result = EmptyResult;
}

pub struct AgentSync;
impl Operation for AgentSync {
    const NAME: &'static str = "agent.sync";
    const DOC: &'static str = "Gives the PTY master to the side that lacks it. A request without \
                               one is answered with the keeper's; one with a master for a CLI the \
                               keeper lacks is held, and watched until it ends, without its exit \
                               code. A CLI that has already ended is answered as held and \
                               reported ended at once. Both sides holding one, the process ID and \
                               birth must match (`invalid_argument` otherwise); neither, \
                               `not_found`.";
    type Args = SyncArgs;
    type Result = EmptyResult;
}

pub struct DaemonPing;
impl Operation for DaemonPing {
    const NAME: &'static str = "daemon.ping";
    const DOC: &'static str = "Tells the keeper the daemon is alive; send it once a second from \
                               hello on. After 15 seconds without one, the keeper ends the daemon \
                               with SIGKILL.";
    type Args = NoArgs;
    type Result = EmptyResult;
}

/// Visits every keeper protocol operation.
pub fn visit_operations(visitor: &mut impl OperationVisitor) {
    visitor.operation::<AgentStart>();
    visitor.operation::<AgentStop>();
    visitor.operation::<AgentSync>();
    visitor.operation::<DaemonPing>();
}

pub fn operation_names() -> Vec<String> {
    super::operations::collect_names(visit_operations)
}

/// The version both ranges share, the highest, if any.
pub fn shared_version(ours: [u32; 2], theirs: [u32; 2]) -> Option<u32> {
    let newest = ours[1].min(theirs[1]);
    (newest >= ours[0].max(theirs[0])).then_some(newest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeper_v1_serialization_matches_wire_contract() {
        assert_eq!(
            operation_names(),
            ["agent.start", "agent.stop", "agent.sync", "daemon.ping"]
        );
        assert_eq!(
            (
                KEEPER_PROTOCOL_VERSION,
                MIN_KEEPER_PROTOCOL_VERSION,
                methods::HELLO,
                methods::CALL,
                methods::CHANGED
            ),
            (1, 1, "hello", "call", "changed")
        );
        assert_eq!(
            serde_json::to_value(HelloParams { protocol: [1, 1] }).unwrap(),
            json!({ "protocol": [1, 1] })
        );
        let welcome = HelloResult {
            protocol: [1, 1],
            build: "b".into(),
            agents: vec![
                HeldAgent {
                    id: "a1".into(),
                    pid: 4,
                    birth: "1762737725.123456".into(),
                    stopping: false,
                },
                HeldAgent {
                    id: "a2".into(),
                    pid: 5,
                    birth: "7".into(),
                    stopping: true,
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&welcome).unwrap(),
            json!({
                "protocol": [1, 1], "build": "b",
                "agents": [
                    { "id": "a1", "pid": 4, "birth": "1762737725.123456" },
                    { "id": "a2", "pid": 5, "birth": "7", "stopping": true },
                ],
            })
        );
        assert_eq!(
            serde_json::to_value(StartArgs {
                agent: "a1".into(),
                command: vec!["f".into(), "a".into()],
                env: BTreeMap::from([("K".into(), "V".into())]),
                path: "/".into(),
                cols: 80,
                rows: 24,
            })
            .unwrap(),
            json!({
                "agent": "a1", "command": ["f", "a"], "env": { "K": "V" }, "path": "/",
                "cols": 80, "rows": 24,
            })
        );
        assert_eq!(
            serde_json::to_value(StartResult {
                pid: 4,
                birth: "b".into()
            })
            .unwrap(),
            json!({ "pid": 4, "birth": "b" })
        );
        assert_eq!(
            serde_json::to_value(AgentArgs { agent: "a1".into() }).unwrap(),
            json!({ "agent": "a1" })
        );
        assert_eq!(
            serde_json::to_value(SyncArgs {
                agent: "a1".into(),
                pid: 4,
                birth: "b".into()
            })
            .unwrap(),
            json!({ "agent": "a1", "pid": 4, "birth": "b" })
        );
        let change = AgentChange::Exit {
            agent: "a1".into(),
            exit: ProcessExit {
                code: None,
                signal: Some("SIGKILL".into()),
                reason: None,
                at: "2026-11-09T17:22:05.123Z".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(change).unwrap(),
            json!({
                "kind": "exit", "agent": "a1",
                "exit": { "signal": "SIGKILL", "at": "2026-11-09T17:22:05.123Z" },
            })
        );
    }

    #[test]
    fn unknown_kinds_and_fields_are_skipped() {
        let change: AgentChange =
            serde_json::from_value(json!({ "kind": "renamed", "agent": "a1", "name": "x" }))
                .unwrap();
        assert_eq!(change, AgentChange::Unknown);
        let newer: HelloResult = serde_json::from_value(
            json!({ "protocol": [1, 2], "build": "b", "agents": [], "quantum": 1 }),
        )
        .unwrap();
        assert_eq!(newer.protocol, [1, 2], "unknown keeper fields are ignored");
        let held: HeldAgent =
            serde_json::from_value(json!({ "id": "a1", "pid": 4, "birth": "b" })).unwrap();
        assert!(!held.stopping, "an absent stopping is false");
    }

    #[test]
    fn each_side_speaks_the_highest_version_both_ranges_share() {
        assert_eq!(shared_version([1, 1], [1, 1]), Some(1));
        assert_eq!(shared_version([1, 3], [2, 5]), Some(3));
        assert_eq!(shared_version([1, 1], [2, 3]), None);
    }
}
