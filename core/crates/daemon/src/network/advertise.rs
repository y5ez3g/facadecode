//! Projects the machine table onto the topology shared with authenticated neighbours.

use facade_base::api_v1::daemon as api;
use facade_base::v3;

pub(super) fn encode(machines: Vec<v3::MachineInfo>) -> api::AdvertiseParams {
    api::AdvertiseParams {
        machines: machines
            .into_iter()
            .map(|row| api::MachineInfo {
                short_id: v3::address::short_machine_id(&row.machine_id),
                machine_id: row.machine_id,
                boot_id: row.boot_id,
                name: row.name,
                selector: row.selector,
                state: match row.state {
                    v3::MachineState::Online => api::MachineState::Online,
                    v3::MachineState::Connecting => api::MachineState::Connecting,
                    v3::MachineState::Disconnected => api::MachineState::Disconnected,
                    v3::MachineState::Sleeping => api::MachineState::Sleeping,
                    v3::MachineState::Unreachable => api::MachineState::Unreachable,
                    v3::MachineState::SshInteractionRequired => {
                        api::MachineState::SshInteractionRequired
                    }
                },
                last_seen: row.last_seen,
                ssh_error: None,
                build: row.build,
                route: row.route,
                connections: row
                    .connections
                    .into_iter()
                    .map(|connection| api::MachineConnection {
                        machine_id: connection.machine_id,
                        initiator_machine_id: connection.initiator_machine_id,
                        kind: match connection.kind {
                            v3::ConnectionKind::Saved => api::ConnectionKind::Saved,
                            v3::ConnectionKind::Temporary => api::ConnectionKind::Temporary,
                        },
                        state: match connection.state {
                            v3::ConnectionState::Connected => api::ConnectionState::Connected,
                            v3::ConnectionState::Disconnected => api::ConnectionState::Disconnected,
                            v3::ConnectionState::SshInteractionRequired => {
                                api::ConnectionState::SshInteractionRequired
                            }
                        },
                        transport: None,
                        ssh_interaction: None,
                    })
                    .collect(),
            })
            .collect(),
    }
}

pub(super) fn decode(table: api::AdvertiseParams) -> v3::AdvertiseParams {
    v3::AdvertiseParams {
        machines: table
            .machines
            .into_iter()
            .map(|row| v3::MachineInfo {
                selector: v3::address::exact_machine_selector(&row.machine_id),
                machine_id: row.machine_id,
                boot_id: row.boot_id,
                name: row.name,
                state: match row.state {
                    api::MachineState::Online => v3::MachineState::Online,
                    api::MachineState::Connecting => v3::MachineState::Connecting,
                    api::MachineState::Disconnected => v3::MachineState::Disconnected,
                    api::MachineState::Sleeping => v3::MachineState::Sleeping,
                    api::MachineState::Unreachable | api::MachineState::Unknown => {
                        v3::MachineState::Unreachable
                    }
                    api::MachineState::SshInteractionRequired => {
                        v3::MachineState::SshInteractionRequired
                    }
                },
                last_seen: row.last_seen,
                ssh_error: None,
                build: row.build,
                route: row.route,
                capabilities: Vec::new(),
                connections: row
                    .connections
                    .into_iter()
                    .map(|connection| v3::MachineConnection {
                        machine_id: connection.machine_id,
                        initiator_machine_id: connection.initiator_machine_id,
                        kind: match connection.kind {
                            api::ConnectionKind::Saved => v3::ConnectionKind::Saved,
                            api::ConnectionKind::Temporary => v3::ConnectionKind::Temporary,
                        },
                        state: match connection.state {
                            api::ConnectionState::Connected => v3::ConnectionState::Connected,
                            api::ConnectionState::Disconnected | api::ConnectionState::Unknown => {
                                v3::ConnectionState::Disconnected
                            }
                            api::ConnectionState::SshInteractionRequired => {
                                v3::ConnectionState::SshInteractionRequired
                            }
                        },
                        ssh_destination: None,
                        ssh_args: Vec::new(),
                        remote_home: None,
                        ssh_interaction: None,
                    })
                    .collect(),
            })
            .collect(),
    }
}
