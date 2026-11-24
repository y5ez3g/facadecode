//! Machine identity, routes, and window and location data.

use std::collections::BTreeMap;
use std::time::SystemTime;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::agent::CliInfo;
use super::terminal::TerminalColors;

/// The recorded description of a logical editor window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowDescription {
    /// The editor window instance's ID. It survives reloads and changes when the window reopens.
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
    /// The colors supplied for agents' terminal color queries. An omitted color gets no reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<TerminalColors>,
    /// The environment that the editor provided for the window's agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

/// A place an agent can work: a window's folder, or a checkout of a Git repository one of its
/// folders is in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkingLocation {
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

/// A machine's persistent identity and current display name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineIdentity {
    pub machine_id: String,
    pub name: String,
}

/// What the originating machine knows about a query or the first snapshot of a subscription.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineResponseState {
    Waiting,
    Responded,
    TimedOut,
    Failed,
    Unreachable,
}

/// A machine's contribution to an agent list or watch, before projecting it for a client.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MachineStateRow {
    pub machine_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    pub state: MachineResponseState,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreachable: bool,
    /// When this machine's response was received at the origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responded_at: Option<String>,
}

impl MachineStateRow {
    pub fn observe(&mut self, state: MachineResponseState, received_at: Option<SystemTime>) {
        self.state = state;
        self.unreachable = state == MachineResponseState::Unreachable;
        self.responded_at = received_at.map(crate::time::iso_time);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MachineQueryStatus {
    Answered,
    Unavailable,
    TimedOut,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CliListResult {
    pub clis: Vec<CliInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineIdConflict {
    pub machine_id: String,
    /// Both conflicting connection paths, including their sources.
    pub paths: [String; 2],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SshInteraction {
    pub reason: String,
    /// The complete command and arguments with which to repair the saved connection.
    pub command: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOutcome {
    NotExecuted,
    OutcomeUnknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Unavailable {
    pub execution: ExecutionOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowRef>,
    /// Complete addresses returned before a name lookup could finish.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matches: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unanswered: Vec<MachineIdentity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MachineState {
    Online,
    Connecting,
    /// A saved connection without an active session or an observed failure.
    Disconnected,
    Sleeping,
    Unreachable,
    SshInteractionRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineQueryResult {
    pub machine_id: String,
    pub short_id: String,
    pub name: String,
    pub selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    pub state: MachineState,
    /// Whether this query obtained the machine's contribution.
    pub status: MachineQueryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_error: Option<String>,
    /// The reason this query failed, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A random UUID v4 for this daemon's lifetime.
pub fn new_boot_id() -> String {
    let first = crate::random_u64();
    let second = crate::random_u64();
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        first >> 32,
        (first >> 16) & 0xffff,
        (first & 0x0fff) | 0x4000,
        ((second >> 48) & 0x3fff) | 0x8000,
        second & 0xffff_ffff_ffff,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_shared_machine_row_keeps_the_observation() {
        use std::time::{Duration, UNIX_EPOCH};

        let mut row = MachineStateRow {
            machine_id: "c07cafe7-9a12-4b73-8e9f-cc2d44289832".into(),
            name: "gpu".into(),
            build: Some("test".into()),
            state: MachineResponseState::Waiting,
            unreachable: false,
            responded_at: None,
        };
        let now = Some(UNIX_EPOCH + Duration::from_secs(1));
        for (state, time) in [
            (MachineResponseState::Waiting, None),
            (MachineResponseState::Responded, now),
            (MachineResponseState::TimedOut, None),
            (MachineResponseState::Failed, now),
            (MachineResponseState::Unreachable, None),
        ] {
            row.observe(state, time);
            let canonical = serde_json::to_value(&row).unwrap();
            let mut expected = json!({
                "machine_id": row.machine_id, "name": "gpu", "build": "test",
                "state": state,
            });
            let at = "1970-01-01T00:00:01.000Z";
            if time.is_some() {
                expected["responded_at"] = json!(at);
            }
            if state == MachineResponseState::Unreachable {
                expected["unreachable"] = json!(true);
            }
            assert_eq!(canonical, expected);
        }
    }
}
