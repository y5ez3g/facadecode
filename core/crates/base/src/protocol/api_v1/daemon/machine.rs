//! Machine roster and connection types.

use schemars::{JsonSchema, Schema, json_schema};
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::json;

use super::super::frame::{empty_variant, present};
use super::{Environment, LocationKind, SingleMachineScope};

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
    /// The requested workspace folder that produced this local result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_folder: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CliListArgs {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "SingleMachineScope")]
    pub scope: Option<SingleMachineScope>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub folder: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Environment")]
    pub env: Option<Environment>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LocationListArgs {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "SingleMachineScope")]
    pub scope: Option<SingleMachineScope>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LocationListResult {
    pub locations: Vec<LocationInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MachineState {
    Online,
    Connecting,
    Disconnected,
    Sleeping,
    Unreachable,
    SshInteractionRequired,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryStatus {
    Answered,
    Unavailable,
    TimedOut,
    Error,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionKind {
    Saved,
    Temporary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Connected,
    Disconnected,
    SshInteractionRequired,
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MachineTransportInput {
    Ssh {
        ssh_destination: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "Vec<String>")]
        ssh_args: Option<Vec<String>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "String")]
        remote_home: Option<String>,
    },
    #[serde(deserialize_with = "empty_variant")]
    Bridge,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MachineTransport {
    Bridge,
    #[serde(untagged)]
    Ssh(SshTransport),
}

/// Normalized SSH arguments, including an empty argv when no options are required.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "kind", rename = "ssh")]
#[schemars(rename = "SshTransport", transform = ssh_transport_schema)]
pub struct SshTransport {
    pub ssh_destination: String,
    pub ssh_args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_home: Option<String>,
}

fn ssh_transport_schema(schema: &mut Schema) {
    schema.get_mut("properties").expect("transport properties")["kind"] =
        json_schema!({"type":"string","const":"ssh"}).into();
    schema
        .get_mut("required")
        .and_then(serde_json::Value::as_array_mut)
        .expect("required transport properties")
        .push(json!("kind"));
}

impl<'de> Deserialize<'de> for SshTransport {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case")]
        enum Transport {
            Ssh {
                ssh_destination: String,
                ssh_args: Vec<String>,
                remote_home: Option<String>,
            },
        }

        let Transport::Ssh {
            ssh_destination,
            ssh_args,
            remote_home,
        } = Transport::deserialize(deserializer)?;
        Ok(Self {
            ssh_destination,
            ssh_args,
            remote_home,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineInfo {
    pub machine_id: String,
    pub short_id: String,
    pub name: String,
    pub selector: String,
    pub state: MachineState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<Vec<String>>,
    pub connections: Vec<MachineConnection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineQuery {
    pub machine_id: String,
    pub short_id: String,
    pub name: String,
    pub selector: String,
    pub state: MachineState,
    pub status: QueryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineConnection {
    pub machine_id: String,
    pub initiator_machine_id: String,
    pub kind: ConnectionKind,
    pub state: ConnectionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<SshTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_interaction: Option<SshInteraction>,
}

/// A diagnostic and the command that repairs the saved SSH connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SshInteraction {
    pub message: String,
    pub command: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineListResult {
    pub machines: Vec<MachineInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MachineConnectArgs {
    pub transport: MachineTransportInput,
    pub kind: ConnectionKind,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub expected_machine_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineConnectResult {
    pub transport: MachineTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_machine_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MachineRemoveArgs {
    pub machine: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub expected_machine_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineRemoveResult {
    pub machine_id: String,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<SshTransport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MachineRenameArgs {
    pub machine: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachineRenameResult {
    pub machine_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    clippy::large_enum_variant,
    reason = "Keep the MachineInfo payload inline for watch consumers"
)]
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

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LogArgs {
    #[serde(
        default,
        deserialize_with = "log_lines",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "u32", range(max = 200))]
    pub lines: Option<u32>,
}

fn log_lines<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    let lines = u32::deserialize(deserializer)?;
    if lines > 200 {
        return Err(de::Error::custom("daemon.log gives at most 200 lines"));
    }
    Ok(Some(lines))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LogResult {
    pub lines: Vec<String>,
}
