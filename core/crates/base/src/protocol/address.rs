//! Text references to machines, agents and messages. The caller resolves names against its machines.

use std::fmt;

use super::machine::MachineIdentity;

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

pub fn is_machine_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(name_letter) && bytes.all(|byte| name_letter(byte) || byte == b'-')
}

fn name_letter(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

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

pub(super) fn is_number(input: &str, prefix: char) -> bool {
    input.strip_prefix(prefix).is_some_and(|number| {
        !number.is_empty() && number.bytes().all(|digit| digit.is_ascii_digit())
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

fn compact_id(machine_id: &str) -> String {
    machine_id.replace('-', "").to_ascii_lowercase()
}

/// The first eight hex digits of the full machine ID. It can be shared by several machines.
pub fn short_machine_id(machine_id: &str) -> String {
    compact_id(machine_id).chars().take(8).collect()
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

/// Derives the machine's initial name from the part of its hostname before its first dot.
pub fn default_machine_name(hostname: &str) -> String {
    let mut name = String::new();
    let mut gap = false;
    for letter in hostname.chars().take_while(|letter| *letter != '.') {
        let letter = letter.to_ascii_lowercase();
        if letter.is_ascii_lowercase() || letter.is_ascii_digit() {
            if gap && !name.is_empty() {
                name.push('-');
            }
            name.push(letter);
            gap = false;
        } else {
            gap = true;
        }
    }
    if name.is_empty() {
        "machine".into()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_selectors_are_the_shortest_that_select_one_machine() {
        let machines = [
            ("3f9a2c1d-a120-4abc-8def-123456789abc", "gpu"),
            ("3f9a2c1d-a220-4abc-8def-123456789abc", "gpu"),
            ("734b9912-1234-4abc-8def-123456789abc", "lab"),
        ]
        .map(|(machine_id, name)| MachineIdentity {
            machine_id: machine_id.into(),
            name: name.into(),
        });
        for (machine, expected) in
            machines
                .iter()
                .zip(["id:3f9a2c1da1", "id:3f9a2c1da2", "id:734b9912"])
        {
            let printed = machine_id_selector(&machine.machine_id, &machines);
            assert_eq!(printed, expected);
            let selector = parse_machine_selector(&printed).unwrap();
            assert!(selector.matches(machine));
            assert_eq!(
                machines
                    .iter()
                    .filter(|other| selector.matches(other))
                    .count(),
                1
            );
        }
        assert_eq!(
            display_machine_selector(&machines[0], &machines),
            "id:3f9a2c1da1"
        );
        assert_eq!(display_machine_selector(&machines[2], &machines), "lab");

        let numeric = "12345678-1234-4123-8123-123456789012";
        let compact = "12345678123441238123123456789012";
        let machines = [
            (numeric, "gpu"),
            ("12345678-2222-4222-8222-222222222222", "gpu"),
            ("33333333-3333-4333-8333-333333333333", numeric),
            ("44444444-4444-4444-8444-444444444444", compact),
        ]
        .map(|(machine_id, name)| MachineIdentity {
            machine_id: machine_id.into(),
            name: name.into(),
        });
        use crate::v3::address::{AddressError, display_machine_selector as display_v3_selector};
        assert_eq!(
            display_v3_selector(&machines[0], &machines[..3]),
            Ok(compact.into())
        );
        assert_eq!(
            display_v3_selector(&machines[0], &machines),
            Err(AddressError::NoUniqueMachineSelector)
        );
    }

    /// The command line prints a17@gpu and m42@gpu; with or without `#`, they are addresses.
    #[test]
    fn printed_addresses_are_read_back() {
        let a17 = AgentAddress::Qualified {
            agent: "a17",
            machine: MachineSelector::Name("gpu"),
            literal_name: None,
        };
        assert_eq!(parse_agent_address("a17@gpu"), Ok(a17));
        assert_eq!(parse_agent_address("#a17@gpu"), Ok(a17));
        assert_eq!(
            parse_agent_address("a17@id:3f9a2c1d"),
            Ok(AgentAddress::Qualified {
                agent: "a17",
                machine: MachineSelector::IdPrefix("3f9a2c1d"),
                literal_name: None,
            })
        );
        assert_eq!(
            parse_agent_address("Pixel@gpu"),
            Ok(AgentAddress::Qualified {
                agent: "Pixel",
                machine: MachineSelector::Name("gpu"),
                literal_name: Some("Pixel@gpu"),
            })
        );
        assert_eq!(parse_agent_address("a17"), Ok(AgentAddress::Local("a17")));
        let m42 = MessageAddress {
            message_id: "m42",
            machine: Some(MachineSelector::Name("gpu")),
        };
        assert_eq!(parse_message_address("m42@gpu"), Ok(m42));
        assert_eq!(parse_message_address("#m42@gpu"), Ok(m42));
        assert_eq!(
            parse_message_address("x@gpu"),
            Err(AddressError::InvalidMessage)
        );

        use crate::v3::address as v3;
        assert_eq!(
            v3::parse_agent_address("\u{feff}a17@gpu\u{feff}"),
            Ok(v3::AgentAddress::Qualified {
                agent: v3::AgentKey::Number("a17"),
                machine: v3::parse_machine_selector("gpu").unwrap(),
                literal_name: None,
            })
        );
        assert_eq!(
            v3::parse_agent_address("\u{85}a17\u{85}"),
            Ok(v3::AgentAddress::Local(v3::AgentKey::Name(
                "\u{85}a17\u{85}"
            )))
        );
    }
}
