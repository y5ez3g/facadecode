//! Projects the machine table onto the topology shared with authenticated neighbours.

use facade_base::address::selector::exact_machine_selector;
use facade_base::address::short_machine_id;
use facade_base::api_v1::daemon::{AdvertiseParams, ConnectionState, MachineInfo, MachineState};

pub(super) fn encode(mut machines: Vec<MachineInfo>) -> AdvertiseParams {
    for row in &mut machines {
        strip_ssh(row);
    }
    AdvertiseParams { machines }
}

pub(super) fn normalize_incoming(row: &mut MachineInfo) {
    strip_ssh(row);
    row.short_id = short_machine_id(&row.machine_id);
    row.selector = exact_machine_selector(&row.machine_id);
    if row.state == MachineState::Unknown {
        row.state = MachineState::Unreachable;
    }
    for connection in &mut row.connections {
        if connection.state == ConnectionState::Unknown {
            connection.state = ConnectionState::Disconnected;
        }
    }
}

fn strip_ssh(row: &mut MachineInfo) {
    row.ssh_error = None;
    for connection in &mut row.connections {
        connection.transport = None;
        connection.ssh_interaction = None;
    }
}
