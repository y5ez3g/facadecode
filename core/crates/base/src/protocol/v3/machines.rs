//! Machine details and the saved and foreground connection payloads.

use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Deserializer, Serialize, de};

use super::{
    AgentRef, ConnectionKind, ConnectionState, LocationKind, MachineQueryStatus, SshInteraction,
    present,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MachineState {
    Online,
    Connecting,
    Sleeping,
    Unreachable,
    SshInteractionRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3MachineQueryResult")]
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
}

/// Lists CLIs using the selected machine's launch environment and working folder.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct CliListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// The client's launch environment for a local query.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct LocationListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3LocationListResult")]
pub struct LocationListResult {
    pub locations: Vec<LocationInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct StatusArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StatusResult {
    pub home: String,
    pub settings_file: String,
    pub build: String,
    pub daemon_pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keeper_pid: Option<u32>,
    pub agents: usize,
    pub machines: Vec<MachineQueryResult>,
}

/// One legacy workspace selector from the specified machine.
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[schemars(transform = legacy_workspace_selector)]
pub struct LegacyWorkspaceArgs {
    pub machine_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
}

impl<'de> Deserialize<'de> for LegacyWorkspaceArgs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            machine_id: String,
            #[serde(default, deserialize_with = "present")]
            workspace_key: Option<String>,
            #[serde(default, deserialize_with = "present")]
            window_id: Option<String>,
            #[serde(default, deserialize_with = "present")]
            instance_id: Option<String>,
        }

        let Fields {
            machine_id,
            workspace_key,
            window_id,
            instance_id,
        } = Fields::deserialize(deserializer)?;
        if [
            workspace_key.is_some(),
            window_id.is_some(),
            instance_id.is_some(),
        ]
        .into_iter()
        .filter(|&present| present)
        .count()
            != 1
        {
            return Err(de::Error::custom(
                "provide exactly one of workspace_key, window_id, or instance_id",
            ));
        }
        Ok(Self {
            machine_id,
            workspace_key,
            window_id,
            instance_id,
        })
    }
}

fn legacy_workspace_selector(schema: &mut Schema) {
    schema.insert("oneOf".into(), serde_json::json!([
        {
            "type": "object",
            "properties": { "workspace_key": { "type": "string" }, "window_id": false, "instance_id": false },
            "required": ["workspace_key"]
        },
        {
            "type": "object",
            "properties": { "workspace_key": false, "window_id": { "type": "string" }, "instance_id": false },
            "required": ["window_id"]
        },
        {
            "type": "object",
            "properties": { "workspace_key": false, "window_id": false, "instance_id": { "type": "string" } },
            "required": ["instance_id"]
        }
    ]));
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LegacyWorkspaceResult {
    pub agents: Vec<AgentRef>,
    pub machines: Vec<MachineQueryResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3LocationInfo")]
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
    /// The requested workspace folder that produced this local result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_folder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3MachineInfo")]
pub struct MachineInfo {
    pub machine_id: String,
    /// The running daemon, where observed. Every advertised route carries it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    pub name: String,
    pub selector: String,
    pub state: MachineState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    /// The remaining hops, ending at this machine. Empty for the table's own machine.
    /// Absent for a saved destination without a route.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<Vec<String>>,
    pub connections: Vec<MachineConnection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "V3MachineTransport")]
pub enum MachineTransport {
    Ssh {
        ssh_destination: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        ssh_args: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        remote_home: Option<String>,
    },
    /// A temporary channel supplied by the client, such as an editor's existing SSH connection.
    Bridge,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3MachineConnection")]
pub struct MachineConnection {
    /// The other end of the connection.
    pub machine_id: String,
    pub initiator_machine_id: String,
    pub kind: ConnectionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_destination: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ssh_args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    pub state: ConnectionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_interaction: Option<SshInteraction>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3MachineConnectResult")]
pub struct MachineConnectResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_destination: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ssh_args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_machine_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3MachineAddArgs")]
pub struct MachineAddArgs {
    pub ssh_destination: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ssh_args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
    pub machine_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3MachineListResult")]
pub struct MachineListResult {
    pub machines: Vec<MachineInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3MachineConnectArgs")]
pub struct MachineConnectArgs {
    pub transport: MachineTransport,
    /// A bridge is always temporary.
    pub kind: ConnectionKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "V3MachinesChange")]
pub enum MachinesChange {
    Updated {
        machine: MachineInfo,
    },
    Removed {
        machine_id: String,
    },
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3AdvertiseParams")]
pub struct AdvertiseParams {
    pub machines: Vec<MachineInfo>,
}
