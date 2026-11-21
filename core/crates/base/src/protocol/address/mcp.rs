//! Public MCP addresses use numbered references with '#' and machine IDs with 'id:'.

use std::fmt;

use crate::model::machine::MachineIdentity;

use super::{compact_id, is_machine_name, is_number};

/// A machine name or a prefix of its machine ID without hyphens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MachineSelector<'a> {
    Name(&'a str),
    IdPrefix(&'a str),
}

impl MachineSelector<'_> {
    pub fn matches(self, machine: &MachineIdentity) -> bool {
        match self {
            Self::Name(name) => name == machine.name,
            Self::IdPrefix(prefix) => compact_id(&machine.machine_id)
                .get(..prefix.len())
                .is_some_and(|id| id.eq_ignore_ascii_case(prefix)),
        }
    }
}

/// An agent reference to resolve at the entrance to the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentAddress<'a> {
    /// Existing agent reference syntax. A bare name can be looked up on several machines.
    Local(&'a str),
    Qualified {
        agent: &'a str,
        machine: MachineSelector<'a>,
        /// Also look for this literal name before interpreting the text as a qualified name.
        literal_name: Option<&'a str>,
    },
}

/// The message number and an optional machine selector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageAddress<'a> {
    pub message_id: &'a str,
    pub machine: Option<MachineSelector<'a>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressError {
    InvalidMachine,
    InvalidMessage,
    QualifiedHuman,
    EmptyAgent,
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidMachine => "expected a machine name or id: followed by 8 to 32 hex digits",
            Self::InvalidMessage => "expected a message ID such as #m42 or #m42@gpu",
            Self::QualifiedHuman => "#human does not take a machine",
            Self::EmptyAgent => "an agent reference cannot be empty",
        })
    }
}

impl std::error::Error for AddressError {}

pub fn parse_machine_selector(input: &str) -> Result<MachineSelector<'_>, AddressError> {
    if let Some(prefix) = input.strip_prefix("id:") {
        if (8..=32).contains(&prefix.len()) && prefix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(MachineSelector::IdPrefix(prefix));
        }
    } else if is_machine_name(input) {
        return Ok(MachineSelector::Name(input));
    }
    Err(AddressError::InvalidMachine)
}

pub fn parse_agent_address(input: &str) -> Result<AgentAddress<'_>, AddressError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(AddressError::EmptyAgent);
    }
    if let Some((agent, machine)) = input.rsplit_once('@') {
        if agent.eq_ignore_ascii_case("#human") {
            return Err(AddressError::QualifiedHuman);
        }
        let id = agent.strip_prefix('#').unwrap_or(agent);
        if is_number(id, 'a') {
            return Ok(AgentAddress::Qualified {
                agent: id,
                machine: parse_machine_selector(machine)?,
                literal_name: None,
            });
        }
        if !agent.starts_with('#')
            && !agent.strip_prefix('@').unwrap_or(agent).trim().is_empty()
            && let Ok(machine) = parse_machine_selector(machine)
        {
            return Ok(AgentAddress::Qualified {
                agent,
                machine,
                literal_name: Some(input),
            });
        }
    }
    Ok(AgentAddress::Local(input))
}

pub fn parse_message_address(input: &str) -> Result<MessageAddress<'_>, AddressError> {
    let input = input.trim();
    let (id, machine) = if let Some((id, machine)) = input.rsplit_once('@') {
        let id = id.strip_prefix('#').unwrap_or(id);
        if !is_number(id, 'm') {
            return Err(AddressError::InvalidMessage);
        }
        (id, Some(parse_machine_selector(machine)?))
    } else {
        (input.strip_prefix('#').unwrap_or(input), None)
    };
    if !is_number(id, 'm') {
        return Err(AddressError::InvalidMessage);
    }
    Ok(MessageAddress {
        message_id: id,
        machine,
    })
}

pub fn format_reference(id: &str, machine_selector: Option<&str>) -> String {
    match machine_selector {
        Some(machine) => format!("#{id}@{machine}"),
        None => format!("#{id}"),
    }
}

/// Selects this machine by its full ID without hyphens.
pub fn exact_machine_selector(machine_id: &str) -> String {
    format!("id:{}", compact_id(machine_id))
}

/// A selector unique among the supplied machines. Prefer the name, then the shortest ID prefix
/// of at least eight digits. Supply every machine that can be selected by the display's reader.
pub fn display_machine_selector(machine: &MachineIdentity, machines: &[MachineIdentity]) -> String {
    if is_machine_name(&machine.name)
        && !machines
            .iter()
            .any(|other| other.machine_id != machine.machine_id && other.name == machine.name)
    {
        return machine.name.clone();
    }
    machine_id_selector(&machine.machine_id, machines)
}

/// The shortest unique `id:` selector of at least eight hex digits for this machine.
/// Supply every machine that can be selected by the display's reader.
pub fn machine_id_selector(machine_id: &str, machines: &[MachineIdentity]) -> String {
    let id = compact_id(machine_id);
    let mut length = 8;
    for other in machines
        .iter()
        .filter(|other| other.machine_id != machine_id)
    {
        let other_id = compact_id(&other.machine_id);
        let shared = id
            .bytes()
            .zip(other_id.bytes())
            .take_while(|(left, right)| left == right)
            .count();
        length = length.max(shared + 1);
    }
    let prefix: String = id.chars().take(length).collect();
    format!("id:{prefix}")
}
