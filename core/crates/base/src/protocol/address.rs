//! Validation and formatting for Shell selectors and public MCP addresses.

pub mod mcp;
pub mod selector;

pub fn is_machine_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(name_letter) && bytes.all(|byte| name_letter(byte) || byte == b'-')
}

fn name_letter(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

fn is_number(input: &str, prefix: char) -> bool {
    input.strip_prefix(prefix).is_some_and(|number| {
        !number.is_empty() && number.bytes().all(|digit| digit.is_ascii_digit())
    })
}

fn compact_id(machine_id: &str) -> String {
    machine_id.replace('-', "").to_ascii_lowercase()
}

/// The first eight hex digits of the full machine ID. It can be shared by several machines.
pub fn short_machine_id(machine_id: &str) -> String {
    compact_id(machine_id).chars().take(8).collect()
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
    use super::{mcp::*, selector};
    use crate::model::machine::MachineIdentity;

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
        assert_eq!(
            selector::display_machine_selector(&machines[0], &machines[..3]),
            Ok(compact.into())
        );
        assert_eq!(
            selector::display_machine_selector(&machines[0], &machines),
            Err(selector::AddressError::NoUniqueMachineSelector)
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

        assert_eq!(
            selector::parse_agent_address("\u{feff}a17@gpu\u{feff}"),
            Ok(selector::AgentAddress::Qualified {
                agent: selector::AgentKey::Number("a17"),
                machine: selector::parse_machine_selector("gpu").unwrap(),
                literal_name: None,
            })
        );
        assert_eq!(
            selector::parse_agent_address("\u{85}a17\u{85}"),
            Ok(selector::AgentAddress::Local(selector::AgentKey::Name(
                "\u{85}a17\u{85}"
            )))
        );
    }
}
