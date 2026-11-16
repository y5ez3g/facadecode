//! What both protocols say of a process: its state, its exit, and its identity.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The reported process state of an agent.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Running,
    Ended,
    /// A process state this build does not recognize. The daemon never sends it.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl ProcessState {
    /// The state's name on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Ended => "ended",
            Self::Unknown => "unknown",
        }
    }
}

/// Why an exit has no code or signal.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    /// Neither service held the CLI's terminal, so it closed. A CLI that ignores hangup may still
    /// be running.
    TerminalClosed,
    /// A reason this build does not recognize. It is never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl EndReason {
    /// The reason's name on the wire, and in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TerminalClosed => "terminal_closed",
            Self::Unknown => "unknown",
        }
    }

    /// The reason a stored `name` names; `Unknown` for a name this build does not know.
    pub fn from_name(name: &str) -> EndReason {
        if name == Self::TerminalClosed.as_str() {
            Self::TerminalClosed
        } else {
            Self::Unknown
        }
    }
}

/// Whether `reason` says nothing worth sending.
fn says_nothing(reason: &Option<EndReason>) -> bool {
    matches!(reason, None | Some(EndReason::Unknown))
}

/// A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as
/// exit code zero.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProcessExit {
    /// The exit code, if the CLI exited normally and its status is known. On Windows every exit
    /// has one: the process's 32-bit exit code carried as an `i32`, so that 0xC000013A is
    /// -1073741510.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    /// The terminating signal name, such as `SIGKILL`. Signal numbers vary by system. Never on
    /// Windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    /// Why no code or signal is available, if known. If all three fields are absent, the exit
    /// status is unavailable.
    #[serde(default, skip_serializing_if = "says_nothing")]
    pub reason: Option<EndReason>,
    /// The exit time in UTC ISO 8601 format with milliseconds. For an exit without a code or
    /// signal, the time Facade noticed it.
    pub at: String,
}

/// A process ID with the process's birth value. The birth value tells a process apart from a later
/// one given the same ID: on Linux, its start time from `/proc/<pid>/stat`; on macOS, its start
/// time in seconds and microseconds; on Windows, its creation time in 100-nanosecond intervals.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct ProcessIdentity {
    /// The process ID.
    pub pid: u32,
    /// The process's birth value.
    pub birth: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const AT: &str = "2026-11-10T00:00:00.000Z";

    #[test]
    fn a_reason_this_build_does_not_know_reads_as_unknown_and_is_never_sent() {
        let exit: ProcessExit =
            serde_json::from_value(json!({ "reason": "lost_in_space", "at": AT })).unwrap();
        assert_eq!(exit.reason, Some(EndReason::Unknown));
        assert_eq!(serde_json::to_value(&exit).unwrap(), json!({ "at": AT }));
        let closed = ProcessExit {
            code: None,
            signal: None,
            reason: Some(EndReason::TerminalClosed),
            at: AT.into(),
        };
        assert_eq!(
            serde_json::to_value(&closed).unwrap(),
            json!({ "reason": "terminal_closed", "at": AT })
        );
        assert_eq!(
            EndReason::from_name("terminal_closed"),
            EndReason::TerminalClosed
        );
        assert_eq!(EndReason::from_name("later"), EndReason::Unknown);
        assert_eq!(
            serde_json::from_value::<ProcessState>(json!("lost")).unwrap(),
            ProcessState::Unknown,
            "an unrecognized process state is read as unknown"
        );
    }
}
