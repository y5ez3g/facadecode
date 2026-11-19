//! Copyable MCP addresses from the machine information a tool already has.

use facade_base::address::{display_machine_selector, exact_machine_selector};
use facade_base::daemon::WindowRef;
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::MachineIdentity;
use facade_base::v3::address;

#[derive(Default)]
pub(super) struct Addresses<'a> {
    pub(super) here: &'a str,
    pub(super) machines: &'a [MachineIdentity],
}

impl Addresses<'_> {
    /// An object's address is qualified even when its own ID is local.
    pub(super) fn qualified(&self, id: &str, machine_id: &str) -> String {
        let selector = self
            .machines
            .iter()
            .find(|machine| machine.machine_id == machine_id)
            .map_or_else(
                || exact_machine_selector(machine_id),
                |machine| display_machine_selector(machine, self.machines),
            );
        format!("{id}@{selector}")
    }

    /// A reference in a role may use its bare ID on the caller's machine.
    pub(super) fn role(&self, id: &str, machine_id: &str) -> String {
        if machine_id == self.here {
            id.to_string()
        } else {
            self.qualified(id, machine_id)
        }
    }

    pub(super) fn window(&self, window: &WindowRef) -> String {
        self.role(&window.window_id, &window.machine_id)
    }
}

/// A v3 address for a role in the caller's inbox. Local IDs carry no machine suffix.
pub(super) fn inbox_role(
    id: &str,
    machine_id: &str,
    here: &str,
    machines: &[MachineIdentity],
) -> Result<String, ErrorBody> {
    if machine_id == here {
        return Ok(id.to_string());
    }
    qualified(id, machine_id, machines)
}

/// A v3 address that can be copied into a tool even when bare numbers match other machines.
pub(super) fn qualified(
    id: &str,
    machine_id: &str,
    machines: &[MachineIdentity],
) -> Result<String, ErrorBody> {
    let unnamed = MachineIdentity {
        machine_id: machine_id.to_string(),
        name: String::new(),
    };
    let machine = machines
        .iter()
        .find(|machine| machine.machine_id == machine_id)
        .unwrap_or(&unnamed);
    let selector = address::display_machine_selector(machine, machines).map_err(|error| {
        ErrorBody::new(
            Reason::AmbiguousReference,
            format!("{error}; use machine rename to give it a unique name"),
        )
    })?;
    Ok(format!("{id}@{selector}"))
}
