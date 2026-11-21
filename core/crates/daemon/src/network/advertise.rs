//! Encodes machine tables using the negotiated machine protocol.

use facade_base::jsonrpc::{ErrorBody, decode_arguments};
use facade_base::{machine, v3};
use serde_json::Value;

pub(super) fn encode(
    protocol: u32,
    capabilities: &[String],
    mut machines: Vec<v3::MachineInfo>,
) -> Value {
    if protocol >= v3::DAEMON_PROTOCOL_RANGE[0] {
        let supports_disconnected = capabilities
            .iter()
            .any(|cap| cap == v3::CAP_MACHINE_DISCONNECTED);
        for machine in &mut machines {
            if !supports_disconnected && machine.state == v3::MachineState::Disconnected {
                machine.state = v3::MachineState::Unreachable;
            }
            if capabilities.is_empty() {
                machine.capabilities.clear();
            }
        }
        serde_json::to_value(v3::AdvertiseParams { machines })
    } else {
        let machines = machines
            .iter()
            .filter(|machine| machine.route.is_some())
            .map(legacy_row)
            .collect();
        serde_json::to_value(machine::AdvertiseParams { machines })
    }
    .expect("machine tables serialize")
}

pub(super) fn decode(protocol: u32, params: Value) -> Result<v3::AdvertiseParams, ErrorBody> {
    if protocol >= v3::DAEMON_PROTOCOL_RANGE[0] {
        return decode_arguments(params);
    }
    let legacy: machine::AdvertiseParams = decode_arguments(params)?;
    Ok(v3::AdvertiseParams {
        machines: legacy.machines.into_iter().map(current_row).collect(),
    })
}

pub(super) fn legacy_row(row: &v3::MachineInfo) -> machine::MachineInfo {
    machine::MachineInfo {
        machine_id: row.machine_id.clone(),
        boot_id: row.boot_id.clone(),
        name: row.name.clone(),
        build: row.build.clone(),
        route: row.route.clone(),
        connections: row
            .connections
            .iter()
            .map(|connection| machine::MachineConnection {
                machine_id: connection.machine_id.clone(),
                initiator_machine_id: connection.initiator_machine_id.clone(),
                kind: connection.kind,
                ssh_destination: connection.ssh_destination.clone(),
                remote_home: connection.remote_home.clone(),
                state: connection.state,
                ssh_interaction: connection.ssh_interaction.clone(),
            })
            .collect(),
    }
}

fn current_row(row: machine::MachineInfo) -> v3::MachineInfo {
    v3::MachineInfo {
        selector: v3::address::exact_machine_selector(&row.machine_id),
        machine_id: row.machine_id,
        boot_id: row.boot_id,
        name: row.name,
        build: row.build,
        route: row.route,
        state: v3::MachineState::Online,
        last_seen: None,
        ssh_error: None,
        capabilities: Vec::new(),
        connections: row
            .connections
            .into_iter()
            .map(|connection| v3::MachineConnection {
                machine_id: connection.machine_id,
                initiator_machine_id: connection.initiator_machine_id,
                kind: connection.kind,
                ssh_destination: connection.ssh_destination,
                ssh_args: Vec::new(),
                remote_home: connection.remote_home,
                state: connection.state,
                ssh_interaction: connection.ssh_interaction,
            })
            .collect(),
    }
}
