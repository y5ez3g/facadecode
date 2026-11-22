//! Public machine, agent and message addresses. The daemon supplies the machine view.

use std::fmt;

use crate::whitespace::is_space;

use crate::model::machine::MachineIdentity;

use super::is_number;
use super::{is_machine_name, short_machine_id};

/// A spelling to match as both a name and, where applicable, an ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MachineSelector<'a> {
    name: Option<&'a str>,
    id: Option<&'a str>,
}

impl MachineSelector<'_> {
    pub fn matches(self, machine: &MachineIdentity) -> bool {
        self.name == Some(machine.name.as_str()) || self.matches_id(&machine.machine_id)
    }

    fn matches_id(self, machine_id: &str) -> bool {
        self.id.is_some_and(|id| {
            let digits = machine_id.bytes().filter(|&byte| byte != b'-');
            let selected = id.bytes().filter(|&byte| byte != b'-');
            digits
                .zip(selected)
                .take_while(|(a, b)| a.eq_ignore_ascii_case(b))
                .count()
                == if id.len() == 8 { 8 } else { 32 }
        })
    }

    fn excludes_other_machines(self, machine_id: &str, visible: &[MachineIdentity]) -> bool {
        visible
            .iter()
            .all(|other| other.machine_id == machine_id || !self.matches(other))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentKey<'a> {
    Number(&'a str),
    Name(&'a str),
}

impl<'a> AgentKey<'a> {
    fn parse(input: &'a str) -> Self {
        if is_number(input, 'a') {
            Self::Number(input)
        } else {
            Self::Name(input)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentAddress<'a> {
    Local(AgentKey<'a>),
    Qualified {
        agent: AgentKey<'a>,
        machine: MachineSelector<'a>,
        /// Also look for this literal name, such as `Pixel@gpu`.
        literal_name: Option<&'a str>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageAddress<'a> {
    pub message_id: &'a str,
    pub machine: Option<MachineSelector<'a>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommandReplyAddress<'a> {
    pub number: &'a str,
    pub machine: Option<MachineSelector<'a>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressError {
    InvalidMachine,
    InvalidMessage,
    EmptyAgent,
    NoUniqueMachineSelector,
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidMachine => {
                "expected a machine name, an eight-digit hex ID, or a full machine UUID"
            }
            Self::InvalidMessage => "expected a message ID such as m42 or m42@gpu",
            Self::EmptyAgent => "an agent reference cannot be empty",
            Self::NoUniqueMachineSelector => {
                "no unique machine selector is available. Rename a conflicting machine and try again."
            }
        })
    }
}

impl std::error::Error for AddressError {}

pub fn parse_machine_selector(input: &str) -> Result<MachineSelector<'_>, AddressError> {
    let name = is_machine_name(input).then_some(input);
    let id = match input.len() {
        8 | 32 => input.bytes().all(|byte| byte.is_ascii_hexdigit()),
        36 => input.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        }),
        _ => false,
    }
    .then_some(input);
    if name.is_none() && id.is_none() {
        return Err(AddressError::InvalidMachine);
    }
    Ok(MachineSelector { name, id })
}

pub fn parse_agent_address(input: &str) -> Result<AgentAddress<'_>, AddressError> {
    let input = input.trim_matches(is_space);
    if input.is_empty() {
        return Err(AddressError::EmptyAgent);
    }
    if let Some((agent, machine)) = input.rsplit_once('@')
        && !agent.is_empty()
    {
        let agent = AgentKey::parse(agent);
        let machine = parse_machine_selector(machine);
        if matches!(agent, AgentKey::Number(_)) {
            return Ok(AgentAddress::Qualified {
                agent,
                machine: machine?,
                literal_name: None,
            });
        }
        if let Ok(machine) = machine {
            return Ok(AgentAddress::Qualified {
                agent,
                machine,
                literal_name: Some(input),
            });
        }
    }
    Ok(AgentAddress::Local(AgentKey::parse(input)))
}

pub fn parse_message_address(input: &str) -> Result<MessageAddress<'_>, AddressError> {
    let input = input.trim();
    let (message_id, machine) = match input.rsplit_once('@') {
        Some((id, machine)) => (id, Some(machine)),
        None => (input, None),
    };
    if !is_number(message_id, 'm') {
        return Err(AddressError::InvalidMessage);
    }
    let machine = machine.map(parse_machine_selector).transpose()?;
    Ok(MessageAddress {
        message_id,
        machine,
    })
}

pub fn parse_command_reply_address(
    input: &str,
) -> Result<Option<CommandReplyAddress<'_>>, AddressError> {
    let input = input.trim_matches(is_space);
    let (address, machine) = match input.split_once('@') {
        Some((address, machine)) => (address, Some(machine)),
        None => (input, None),
    };
    let Some(number) = address.strip_prefix("#c") else {
        return Ok(None);
    };
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    let machine = machine.map(parse_machine_selector).transpose()?;
    Ok(Some(CommandReplyAddress { number, machine }))
}

pub fn format_agent_address(agent_id: &str, machine: &str) -> String {
    format!("{agent_id}@{machine}")
}

pub fn format_message_address(message_id: &str, machine: &str) -> String {
    format!("{message_id}@{machine}")
}

pub fn format_command_reply_address(message_id: &str, machine: &str) -> String {
    let number = message_id
        .strip_prefix('m')
        .expect("an assigned message ID starts with m");
    format!("#c{number}@{machine}")
}

/// The full machine ID, with no address prefix. Use `display_machine_selector` for a checked
/// public selector.
pub fn exact_machine_selector(machine_id: &str) -> String {
    machine_id.to_ascii_lowercase()
}

/// The first spelling that selects only this machine in the supplied view.
pub fn display_machine_selector(
    machine: &MachineIdentity,
    visible: &[MachineIdentity],
) -> Result<String, AddressError> {
    if parse_machine_selector(&machine.name).is_ok_and(|selector| {
        selector.matches(machine) && selector.excludes_other_machines(&machine.machine_id, visible)
    }) {
        return Ok(machine.name.clone());
    }
    display_machine_id(&machine.machine_id, visible)
}

/// An ID spelling that selects only this machine in the supplied view.
/// Prefer the eight-digit ID, then the full UUID and its alternate spellings.
pub fn display_machine_id(
    machine_id: &str,
    visible: &[MachineIdentity],
) -> Result<String, AddressError> {
    let unique = |input: &str| {
        parse_machine_selector(input).is_ok_and(|selector| {
            selector.matches_id(machine_id) && selector.excludes_other_machines(machine_id, visible)
        })
    };
    let short = short_machine_id(machine_id);
    if unique(&short) {
        return Ok(short);
    }
    let full = exact_machine_selector(machine_id);
    if unique(&full) {
        return Ok(full);
    }
    // Machine names are lowercase. Try the other UUID spelling and case when a name matches.
    let compact = full.replace('-', "");
    if unique(&compact) {
        return Ok(compact);
    }
    let uppercase = full.to_ascii_uppercase();
    if unique(&uppercase) {
        return Ok(uppercase);
    }
    Err(AddressError::NoUniqueMachineSelector)
}
