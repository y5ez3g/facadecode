//! Copyable MCP addresses from the machine information a tool already has.

use facade_base::address::{display_machine_selector, exact_machine_selector};
use facade_base::daemon::WindowRef;
use facade_base::machine::MachineIdentity;

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
