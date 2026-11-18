//! Live links, full table replacement, and the table advertised to every neighbour.

use std::collections::BTreeMap;
use std::sync::Arc;

use facade_base::address::is_machine_name;
use facade_base::daemon::methods;
use facade_base::jsonrpc::{ErrorBody, Notification, Reason};
use facade_base::machine::{
    AdvertiseParams, ConnectionKind, ConnectionState, MachineConnection, MachineHello,
    MachineIdConflict, MachineIdentity, MachineInfo, MachineTransport, SshInteraction,
};
use tokio::sync::{mpsc, oneshot, watch};

use super::routes::{self, Conflict, LiveIdentities, is_uuid_v4};
use super::session::Peer;
use super::{Event, FrontConnection, SessionId, wire};
use crate::SavedConnection;

pub(super) struct Topology {
    pub(super) local: MachineHello,
    pub(super) links: BTreeMap<SessionId, Link>,
    /// The identities already accepted during a handshake, held until it succeeds or closes.
    pub(super) pending_links: BTreeMap<SessionId, Link>,
    pub(super) saved: BTreeMap<String, Saved>,
    next: u64,
    selected: BTreeMap<String, Selected>,
}

pub(super) struct Saved {
    pub(super) config: SavedConnection,
    pub(super) generation: u64,
    pub(super) stop: watch::Sender<bool>,
    pub(super) waiters: Vec<oneshot::Sender<Result<MachineHello, ErrorBody>>>,
    pub(super) interaction: Option<SshInteraction>,
    pub(super) active: Option<SessionId>,
}

pub(super) struct Link {
    pub(super) remote: MachineHello,
    pub(super) origin: Origin,
    pub(super) peer: Arc<Peer>,
    pub(super) table: BTreeMap<String, MachineInfo>,
}

pub(super) enum Origin {
    Incoming,
    Front(FrontConnection),
    Saved {
        machine_id: String,
        generation: u64,
        source: String,
    },
}

impl Origin {
    fn describe(&self, remote: &MachineHello) -> String {
        match self {
            Self::Incoming => format!(
                "Incoming session from {} ({})",
                remote.name, remote.machine_id
            ),
            Self::Front(front) => match &front.transport {
                MachineTransport::Bridge => {
                    format!("Bridge to {} ({})", remote.name, remote.machine_id)
                }
                MachineTransport::Ssh {
                    ssh_destination,
                    remote_home,
                } => ssh_source(ssh_destination, remote_home.as_deref()),
            },
            Self::Saved { source, .. } => source.clone(),
        }
    }
}

pub(super) fn ssh_source(destination: &str, home: Option<&str>) -> String {
    match home {
        Some(home) => format!("SSH {destination} --home {home:?}"),
        None => format!("SSH {destination}"),
    }
}

struct Selected {
    row: MachineInfo,
    via: Option<SessionId>,
}

impl Topology {
    pub(super) fn new(local: MachineHello) -> Self {
        let mut state = Self {
            local,
            links: BTreeMap::new(),
            pending_links: BTreeMap::new(),
            saved: BTreeMap::new(),
            next: 1,
            selected: BTreeMap::new(),
        };
        state.selected = state.select();
        state
    }

    pub(super) fn number(&mut self) -> u64 {
        let next = self.next;
        self.next += 1;
        next
    }

    pub(super) fn machines(&self) -> Vec<MachineInfo> {
        self.selected.values().map(|row| row.row.clone()).collect()
    }

    pub(super) fn route(&self, machine: &str) -> Option<(&Arc<Peer>, &MachineInfo)> {
        let selected = self.selected.get(machine)?;
        let link = self.links.get(&selected.via?)?;
        Some((&link.peer, &selected.row))
    }

    pub(super) fn direct(&self, machine: &str) -> Option<&Arc<Peer>> {
        let (peer, row) = self.route(machine)?;
        (row.route.as_ref()?.len() == 1).then_some(peer)
    }

    pub(super) fn identity(&self, machine_id: &str) -> MachineIdentity {
        let name = self
            .selected
            .get(machine_id)
            .map_or(machine_id, |selected| selected.row.name.as_str());
        MachineIdentity {
            machine_id: machine_id.to_owned(),
            name: name.to_owned(),
        }
    }

    pub(super) fn check_peer(
        &self,
        remote: &MachineHello,
        origin: &Origin,
    ) -> Result<(), ErrorBody> {
        wire::protocol(&self.local, remote)?;
        if !is_uuid_v4(&remote.machine_id)
            || !is_uuid_v4(&remote.boot_id)
            || !is_machine_name(&remote.name)
        {
            return Err(ErrorBody::invalid_argument(
                "A machine introduction requires a valid name and lowercase UUID v4 machine and boot IDs.",
            ));
        }
        self.identities(None)?
            .observe(&remote.machine_id, &remote.boot_id, || {
                format!("{} (boot {})", origin.describe(remote), remote.boot_id)
            })
            .map_err(conflicted)?;
        if remote.machine_id == self.local.machine_id {
            return Err(ErrorBody::new(
                Reason::Refused,
                "This connection leads back to this Facade home.",
            ));
        }
        Ok(())
    }

    /// The previous table of this same link is replaced, so it cannot conflict with the new one.
    pub(super) fn validate_table(
        &self,
        session: Option<SessionId>,
        remote: &MachineHello,
        origin: &Origin,
        table: AdvertiseParams,
    ) -> Result<BTreeMap<String, MachineInfo>, ErrorBody> {
        let source = origin.describe(remote);
        let mut identities = self.identities(session)?;
        identities
            .observe(&remote.machine_id, &remote.boot_id, || {
                format!("{source} (boot {})", remote.boot_id)
            })
            .map_err(conflicted)?;
        let mut rows = BTreeMap::new();
        for mut row in table.machines {
            let (Some(boot), Some(path), Some(_)) = (&row.boot_id, row.route.take(), &row.build)
            else {
                return Err(ErrorBody::invalid_argument(
                    "The machine table has an incomplete row.",
                ));
            };
            if !is_uuid_v4(&row.machine_id)
                || !is_uuid_v4(boot)
                || !is_machine_name(&row.name)
                || path.iter().any(|hop| !is_uuid_v4(hop))
                || row.connections.iter().any(|connection| {
                    !is_uuid_v4(&connection.machine_id)
                        || !is_uuid_v4(&connection.initiator_machine_id)
                })
            {
                return Err(ErrorBody::invalid_argument(
                    "The machine table has an invalid identity.",
                ));
            }
            if row.machine_id == self.local.machine_id {
                identities
                    .observe(&row.machine_id, boot, || {
                        describe_path(&source, &path, boot)
                    })
                    .map_err(conflicted)?;
                continue;
            }
            let Some(path) = routes::through(
                &self.local.machine_id,
                &remote.machine_id,
                &row.machine_id,
                path,
            )
            .map_err(ErrorBody::invalid_argument)?
            else {
                continue;
            };
            identities
                .observe(&row.machine_id, boot, || {
                    describe_path(&source, &path, boot)
                })
                .map_err(conflicted)?;
            row.route = Some(path);
            if rows.insert(row.machine_id.clone(), row).is_some() {
                return Err(ErrorBody::invalid_argument(
                    "The machine table repeats a machine.",
                ));
            }
        }
        if !rows.contains_key(&remote.machine_id) {
            return Err(ErrorBody::invalid_argument(
                "The peer is missing from its machine table.",
            ));
        }
        Ok(rows)
    }

    fn identities(&self, except: Option<SessionId>) -> Result<LiveIdentities, ErrorBody> {
        let mut identities = LiveIdentities::default();
        identities
            .observe(&self.local.machine_id, &self.local.boot_id, || {
                format!(
                    "This Facade home ({}, boot {})",
                    self.local.machine_id, self.local.boot_id
                )
            })
            .map_err(conflicted)?;
        for (&id, link) in self.links.iter().chain(&self.pending_links) {
            if Some(id) == except {
                continue;
            }
            let source = link.origin.describe(&link.remote);
            for row in link.table.values() {
                let boot = row.boot_id.as_deref().expect("validated boot ID");
                let path = row.route.as_deref().expect("validated route");
                identities
                    .observe(&row.machine_id, boot, || describe_path(&source, path, boot))
                    .map_err(conflicted)?;
            }
        }
        Ok(identities)
    }

    pub(super) fn publish(
        &mut self,
        events: &mpsc::UnboundedSender<Event>,
        joined: Option<SessionId>,
    ) {
        let selected = self.select();
        let changed = selected
            .values()
            .map(|entry| &entry.row)
            .ne(self.selected.values().map(|entry| &entry.row));
        let switched = selected.iter().any(|(key, current)| {
            self.selected
                .get(key)
                .is_some_and(|old| old.via != current.via)
        });
        self.selected = selected;
        if !changed && !switched && joined.is_none() {
            return;
        }
        let machines = self.machines();
        if changed || joined.is_some() {
            let table = Notification::new(
                methods::ADVERTISE,
                AdvertiseParams {
                    machines: machines.clone(),
                },
            );
            for (&id, link) in &self.links {
                if changed || Some(id) == joined {
                    link.peer.notify(table.clone());
                }
            }
        }
        if changed || switched {
            let _ = events.send(Event::RoutesChanged { machines });
        }
    }

    fn select(&self) -> BTreeMap<String, Selected> {
        let own = MachineInfo {
            machine_id: self.local.machine_id.clone(),
            boot_id: Some(self.local.boot_id.clone()),
            name: self.local.name.clone(),
            build: Some(self.local.build.clone()),
            route: Some(Vec::new()),
            connections: self.connections(),
        };
        let mut selected = BTreeMap::from([(
            own.machine_id.clone(),
            Selected {
                row: own,
                via: None,
            },
        )]);
        for (&via, link) in &self.links {
            for row in link.table.values() {
                let better = selected.get(&row.machine_id).is_none_or(|current| {
                    routes::preferred(
                        row.route.as_deref().expect("validated route"),
                        current.row.route.as_deref().expect("selected route"),
                    )
                });
                if better {
                    selected.insert(
                        row.machine_id.clone(),
                        Selected {
                            row: row.clone(),
                            via: Some(via),
                        },
                    );
                }
            }
        }
        selected
    }

    fn connections(&self) -> Vec<MachineConnection> {
        let local = &self.local.machine_id;
        let mut connections: Vec<_> = self
            .saved
            .values()
            .map(|saved| MachineConnection {
                machine_id: saved.config.machine_id.clone(),
                initiator_machine_id: local.clone(),
                kind: ConnectionKind::Saved,
                ssh_destination: Some(saved.config.ssh_destination.clone()),
                remote_home: saved.config.remote_home.clone(),
                state: match (&saved.interaction, saved.active) {
                    (_, Some(_)) => ConnectionState::Connected,
                    (Some(_), None) => ConnectionState::SshInteractionRequired,
                    (None, None) => ConnectionState::Unavailable,
                },
                ssh_interaction: saved.interaction.clone(),
            })
            .collect();
        for link in self.links.values() {
            match &link.origin {
                Origin::Front(front) => {
                    let (ssh_destination, remote_home) = match &front.transport {
                        MachineTransport::Ssh {
                            ssh_destination,
                            remote_home,
                        } => (Some(ssh_destination.clone()), remote_home.clone()),
                        MachineTransport::Bridge => (None, None),
                    };
                    merge_connection(
                        &mut connections,
                        MachineConnection {
                            machine_id: link.remote.machine_id.clone(),
                            initiator_machine_id: local.clone(),
                            kind: front.kind,
                            ssh_destination,
                            remote_home,
                            state: ConnectionState::Connected,
                            ssh_interaction: None,
                        },
                    );
                }
                Origin::Incoming => {
                    let remote = &link.remote.machine_id;
                    for connection in &link.table[remote].connections {
                        if connection.machine_id != *local
                            || connection.initiator_machine_id != *remote
                            || connection.state != ConnectionState::Connected
                        {
                            continue;
                        }
                        let mut connection = connection.clone();
                        connection.machine_id = remote.clone();
                        merge_connection(&mut connections, connection);
                    }
                }
                Origin::Saved { .. } => {}
            }
        }
        connections.sort_by(|a, b| connection_key(a).cmp(&connection_key(b)));
        connections
    }
}

fn connection_key(connection: &MachineConnection) -> (&str, &str, u8, Option<&str>, Option<&str>) {
    (
        &connection.machine_id,
        &connection.initiator_machine_id,
        connection.kind as u8,
        connection.ssh_destination.as_deref(),
        connection.remote_home.as_deref(),
    )
}

fn merge_connection(connections: &mut Vec<MachineConnection>, connected: MachineConnection) {
    if let Some(previous) = connections
        .iter_mut()
        .find(|row| connection_key(row) == connection_key(&connected))
    {
        *previous = connected;
    } else {
        connections.push(connected);
    }
}

fn describe_path(source: &str, route: &[String], boot: &str) -> String {
    format!("{source} via {} (boot {boot})", route.join(" -> "))
}

fn conflicted(Conflict { machine_id, paths }: Conflict) -> ErrorBody {
    let mut error = ErrorBody::new(
        Reason::MachineIdConflict,
        format!(
            "Machine ID {machine_id} is in use by two running daemons. Paths: {} and {}. Use a new empty Facade home on the copied machine.",
            paths[0], paths[1],
        ),
    );
    error.data.machine_id_conflict = Some(MachineIdConflict { machine_id, paths });
    error
}
