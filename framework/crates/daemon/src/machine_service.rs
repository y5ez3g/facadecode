//! Authorizes machine streams and applies local machine operations.

use std::sync::Arc;

use facade_base::address::{
    is_machine_name,
    selector::{self as addresses, MachineSelector},
};
use facade_base::api_v1::{self, ApiVersion, daemon as wire};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::machine::MachineQueryResult;
use facade_base::sockets::{ServerReader, ServerWriter};
use facade_base::ssh::parse_ssh_destination;
use facade_base::{
    model::agent::AgentRef,
    model::machine::{MachineIdentity, MachineQueryStatus},
};
use tokio::io::BufReader;
use tokio::sync::mpsc;

use crate::api;
use crate::lifecycle::{Work, WorkGuard};
use crate::network::{Event, FrontConnection, MachineGreeting, is_uuid_v4};
use crate::network_operations::{machine_query_failure, machine_query_result, machine_selector};
use crate::records::root_of;
use crate::server::Client;
use crate::{Daemon, SavedConnection, SavedSsh, blocking_in_place};

pub(crate) enum MachineStream {
    Incoming(MachineGreeting, WorkGuard),
    Foreground(FrontConnection, WorkGuard),
}

pub(crate) async fn follow_network(
    daemon: Arc<Daemon>,
    mut events: mpsc::UnboundedReceiver<Event>,
) {
    while let Some(event) = events.recv().await {
        match event {
            Event::RoutesChanged { machines } => {
                for row in machines
                    .iter()
                    .filter(|row| row.machine_id != daemon.machine_id && row.route.is_some())
                {
                    if let Err(error) = blocking_in_place(|| {
                        daemon.store.remember_machine(&row.machine_id, &row.name)?;
                        if let Some(route) = daemon.network.remembered_route(&row.machine_id) {
                            daemon.store.remember_route(&row.machine_id, &route)?;
                        }
                        Ok::<_, anyhow::Error>(())
                    }) {
                        crate::log("warn", &format!("could not save a machine name: {error:#}"));
                    }
                }
                daemon.follow_remote_agents(&machines);
                daemon.publish_machine_table();
            }
            Event::ConnectionFailed { config, error } => {
                crate::log(
                    "warn",
                    &format!("saved machine {}: {}", config.machine_id, error.message),
                );
                daemon.publish_machine_table();
            }
            Event::SessionOpened { session, machine } => crate::log(
                "info",
                &format!("machine {} opened session {session:?}", machine.machine_id),
            ),
            Event::SessionClosed {
                session,
                machine_id,
            } => crate::log(
                "info",
                &format!("machine {machine_id} closed session {session:?}"),
            ),
        }
    }
}

impl Daemon {
    pub(crate) fn machine_hello_plan(
        &self,
        hello: wire::HelloParams,
        api_version: ApiVersion,
    ) -> Result<(wire::HelloResult, MachineStream), api_v1::ErrorBody> {
        let remote = hello.machine.ok_or_else(|| {
            api_v1::ErrorBody::invalid_argument("a machine hello requires an introduction")
        })?;
        let greeting = MachineGreeting {
            machine: wire::ConnectedMachine {
                machine_id: remote.machine_id,
                boot_id: remote.boot_id,
                name: remote.name,
                build: hello.build,
                ssh_cleans_processes: remote.ssh_cleans_processes,
            },
            api_version,
            foreground: hello.foreground,
        };
        self.network.check_peer(&greeting)?;
        let local = self.network.local_hello();
        Ok((
            wire::HelloResult {
                api_version,
                build: local.build,
                machine_id: local.machine_id,
                machine: Some(wire::MachineHelloResult {
                    boot_id: local.boot_id,
                    name: local.name,
                    ssh_cleans_processes: local.ssh_cleans_processes,
                }),
                pid: std::process::id(),
                agent_count: self.active_count() as u64,
                keeper: None,
                topics: wire::topic_names(wire::ClientKind::Machine),
                ops: wire::operation_names(wire::ClientKind::Machine),
            },
            MachineStream::Incoming(greeting, self.hold_machine_handoff()?),
        ))
    }

    pub(crate) fn machine_connect_plan(
        &self,
        client: &Client,
        args: wire::MachineConnectArgs,
    ) -> Result<(wire::MachineConnectResult, MachineStream), api_v1::ErrorBody> {
        if client.verified_actor.is_some() || client.kind != wire::ClientKind::Terminal {
            return Err(api::error(
                "refused",
                "only a terminal client can open an SSH connection",
            ));
        }
        let wire::MachineConnectArgs {
            transport,
            kind,
            expected_machine_id,
        } = args;
        let saved = kind == wire::ConnectionKind::Saved;
        if expected_machine_id
            .as_ref()
            .is_some_and(|id| !saved || !is_uuid_v4(id))
        {
            return Err(api_v1::ErrorBody::invalid_argument(
                "expected_machine_id must be a full machine ID for a saved connection",
            ));
        }
        let (transport, expected_machine_id) = match transport {
            wire::MachineTransportInput::Ssh {
                ssh_destination,
                ssh_args,
                remote_home,
            } => {
                let argv = checked_ssh_args(&ssh_destination, ssh_args.unwrap_or_default())
                    .map_err(api::project_error)?;
                let expected = if saved {
                    let known = self
                        .saved_ssh()
                        .map_err(api::project_error)?
                        .into_iter()
                        .find(|saved| saved.argv == argv && saved.config.remote_home == remote_home)
                        .map(|saved| saved.config.machine_id);
                    if let (Some(known), Some(given)) = (&known, &expected_machine_id)
                        && known != given
                    {
                        let mut error = api::error(
                            "machine_id_mismatch",
                            format!(
                                "the saved SSH destination expects machine ID {known}, got {given}"
                            ),
                        );
                        error.data.details = Some(serde_json::Map::from_iter([
                            (
                                "expected_machine_id".into(),
                                serde_json::Value::String(known.clone()),
                            ),
                            (
                                "machine_id".into(),
                                serde_json::Value::String(given.clone()),
                            ),
                        ]));
                        return Err(error);
                    }
                    expected_machine_id.or(known)
                } else {
                    None
                };
                (
                    wire::MachineTransport::Ssh(wire::SshTransport {
                        ssh_destination,
                        ssh_args: argv,
                        remote_home,
                    }),
                    expected,
                )
            }
            wire::MachineTransportInput::Bridge if !saved => (wire::MachineTransport::Bridge, None),
            _ => {
                return Err(api_v1::ErrorBody::invalid_argument(
                    "a bridged machine session is temporary",
                ));
            }
        };
        let result = wire::MachineConnectResult {
            transport: transport.clone(),
            expected_machine_id: expected_machine_id.clone(),
        };
        let session = FrontConnection {
            transport,
            kind,
            expected_machine_id,
        };
        Ok((
            result,
            MachineStream::Foreground(session, self.hold_machine_handoff()?),
        ))
    }

    fn hold_machine_handoff(&self) -> Result<WorkGuard, api_v1::ErrorBody> {
        self.lifecycle
            .begin(Work::Call)
            .ok_or_else(|| api::error("unavailable", "Facade Code Framework is exiting"))
    }

    pub(crate) async fn serve_machine_stream(
        &self,
        stream: MachineStream,
        read: BufReader<ServerReader>,
        write: ServerWriter,
    ) -> anyhow::Result<()> {
        match stream {
            MachineStream::Incoming(remote, initial_work) => {
                self.network
                    .accept_with_work(remote, read, write, Some(Box::new(initial_work)))
                    .await
            }
            MachineStream::Foreground(session, initial_work) => {
                let transport = session.transport.clone();
                let save = session.kind == wire::ConnectionKind::Saved;
                self.network
                    .connect_with_saved(
                        session,
                        read,
                        write,
                        Some(Box::new(initial_work)),
                        |remote: wire::ConnectedMachine| async move {
                            let changing = self.machine_changes.lock().await;
                            let (first, saved) = match &transport {
                                wire::MachineTransport::Ssh(ssh) if save => {
                                    let saved = SavedSsh {
                                        config: SavedConnection {
                                            machine_id: remote.machine_id.clone(),
                                            ssh_destination: ssh.ssh_destination.clone(),
                                            remote_home: ssh.remote_home.clone(),
                                        },
                                        argv: ssh.ssh_args.clone(),
                                    };
                                    let (first, saved) = self
                                        .keep_ssh(saved, &remote.name, Some(&remote.machine_id))
                                        .map_err(api::project_error)?;
                                    (first, Some(saved))
                                }
                                _ => {
                                    let first = blocking_in_place(|| {
                                        self.store
                                            .remember_machine(&remote.machine_id, &remote.name)
                                    })
                                    .map_err(|error| {
                                        api::project_error(ErrorBody::internal(error))
                                    })?;
                                    (first, None)
                                }
                            };
                            Ok((first, saved, changing))
                        },
                    )
                    .await
            }
        }
        .map_err(|error| anyhow::anyhow!("{}", error.message))
    }

    /// Derives the caller from the local connection's accepted identity.
    pub(crate) fn local_caller(&self, client: &Client) -> Result<wire::Caller, ErrorBody> {
        use wire::Caller;
        if let Some(actor) = client.verified_actor.as_ref() {
            let agent = &actor.reference;
            let info = self
                .get_agent(&agent.agent_id)
                .filter(|_| self.machine_id == agent.machine_id)
                .map(|agent| agent.info())
                .filter(|info| info.process == facade_base::process::ProcessState::Running)
                .ok_or_else(|| {
                    ErrorBody::new(Reason::CallerUnavailable, "this agent's run has ended")
                })?;
            return Ok(Caller::Agent {
                agent: agent.clone(),
                root: api::wire_ref(&root_of(&info)),
                yolo: info.yolo,
            });
        }
        let machine_id = self.machine_id.clone();
        match client.kind {
            wire::ClientKind::Terminal => Ok(Caller::Terminal { machine_id }),
            wire::ClientKind::Ide => Ok(Caller::Ide { machine_id }),
            _ => Err(ErrorBody::refused("this connection has no verified caller")),
        }
    }

    fn saved_ssh(&self) -> Result<Vec<SavedSsh>, ErrorBody> {
        blocking_in_place(|| self.store.saved_ssh()).map_err(ErrorBody::internal)
    }

    pub(crate) fn restore_machine_connections(&self) -> anyhow::Result<()> {
        let names = blocking_in_place(|| self.store.known_machine_names())?;
        for saved in blocking_in_place(|| self.store.saved_ssh())? {
            let name = names.get(&saved.config.machine_id).cloned();
            self.network.restore_saved_ssh(saved, name);
        }
        for (id, route) in blocking_in_place(|| self.store.remembered_routes())? {
            self.network.remember_route(id, route);
        }
        Ok(())
    }

    fn keep_ssh(
        &self,
        saved: SavedSsh,
        name: &str,
        expected_machine_id: Option<&str>,
    ) -> Result<(bool, SavedSsh), ErrorBody> {
        let (kept, first) = blocking_in_place(|| {
            self.store
                .save_verified_ssh(&saved, name, expected_machine_id)
        })
        .map_err(ErrorBody::internal)?;
        if kept.config != saved.config || kept.argv != saved.argv {
            return Err(ErrorBody::refused(format!(
                "this machine already has a saved SSH connection through {}",
                kept.config.ssh_destination
            )));
        }
        Ok((first, kept))
    }

    fn publish_machine_table(&self) {
        let _ = self.machine_views.send(());
    }

    pub(crate) fn public_machines(&self) -> Result<Vec<wire::MachineInfo>, ErrorBody> {
        let last_contact =
            blocking_in_place(|| self.store.machine_last_seen()).map_err(ErrorBody::internal)?;
        let mut rows = self.network.machines();
        let visible = identities(&rows);
        for row in &mut rows {
            row.selector = machine_address_part(&row.machine_id, &visible)?;
            if row.last_seen.is_none() {
                row.last_seen = last_contact.get(&row.machine_id).cloned();
            }
        }
        Ok(rows)
    }

    pub(crate) fn machine_identities(&self) -> Result<Vec<MachineIdentity>, ErrorBody> {
        Ok(identities(&self.network.machines()))
    }

    pub(crate) fn machine_address_part(&self, machine_id: &str) -> Result<String, ErrorBody> {
        let visible = self.machine_identities()?;
        machine_address_part(machine_id, &visible)
    }

    pub(crate) fn agent_address(&self, reference: &AgentRef) -> Result<String, ErrorBody> {
        let machine = self.machine_address_part(&reference.machine_id)?;
        Ok(addresses::format_agent_address(
            &reference.agent_id,
            &machine,
        ))
    }

    pub(crate) fn select_machine(
        &self,
        selector: MachineSelector<'_>,
    ) -> Result<wire::MachineInfo, ErrorBody> {
        let machines = self.network.machines();
        let mut visible = identities(&machines);
        let mut found: Vec<_> = machines
            .into_iter()
            .filter(|machine| {
                selector.matches(&MachineIdentity {
                    machine_id: machine.machine_id.clone(),
                    name: machine.name.clone(),
                })
            })
            .collect();
        if found.is_empty() {
            let known = blocking_in_place(|| self.store.known_machine_names())
                .map_err(ErrorBody::internal)?;
            found.extend(known.into_iter().filter_map(|(machine_id, name)| {
                let identity = MachineIdentity { machine_id, name };
                if !visible
                    .iter()
                    .any(|machine| machine.machine_id == identity.machine_id)
                {
                    visible.push(identity.clone());
                }
                selector
                    .matches(&identity)
                    .then(|| offline_machine(identity))
            }));
        }
        match found.len() {
            0 => Err(ErrorBody::new(
                Reason::NotFound,
                "no machine matches that address",
            )),
            1 => Ok(found.remove(0)),
            _ => {
                let mut error = ErrorBody::new(
                    Reason::AmbiguousReference,
                    "several machines match that address",
                );
                for machine in found {
                    if let Ok(selector) = machine_address_part(&machine.machine_id, &visible) {
                        error.data.candidates.push(selector);
                    }
                    let mut row = machine_query_result(machine, MachineQueryStatus::Unavailable);
                    project_machine_query(&mut row, &visible);
                    error.data.machines.push(row);
                }
                Err(error)
            }
        }
    }

    pub(crate) async fn ensure_machine_route(
        &self,
        machine_id: &str,
        caller: &wire::Caller,
    ) -> Result<(), ErrorBody> {
        self.network
            .ensure_route(machine_id, caller)
            .await
            .map_err(|error| self.machine_failure(machine_id, api::received_error(error)))
    }

    pub(crate) fn machine_failure(&self, machine_id: &str, mut error: ErrorBody) -> ErrorBody {
        if error.data.machines.is_empty() {
            let machines = self.network.machines();
            let visible = identities(&machines);
            let machine = machines
                .into_iter()
                .find(|machine| machine.machine_id == machine_id)
                .unwrap_or_else(|| {
                    let identity = error
                        .data
                        .unavailable
                        .as_ref()
                        .and_then(|failure| failure.machine.as_ref())
                        .filter(|machine| machine.machine_id == machine_id)
                        .cloned()
                        .unwrap_or_else(|| MachineIdentity {
                            machine_id: machine_id.to_owned(),
                            name: machine_id.to_owned(),
                        });
                    offline_machine(identity)
                });
            let mut row = machine_query_result(machine, machine_query_failure(&error));
            project_machine_query(&mut row, &visible);
            row.error = Some(error.message.clone());
            error.data.machines.push(row);
        }
        error
    }

    pub(crate) async fn remove_machine(
        &self,
        args: wire::MachineRemoveArgs,
    ) -> Result<wire::MachineRemoveResult, ErrorBody> {
        let _changing = self.machine_changes.lock().await;
        let (id, name) = if let Some(id) = args.expected_machine_id {
            if !is_uuid_v4(&id) {
                return Err(ErrorBody::invalid_argument(
                    "expected_machine_id must be a full machine ID",
                ));
            }
            (id.clone(), id)
        } else {
            let target = self.select_machine(machine_selector(&args.machine)?)?;
            (target.machine_id, target.name)
        };
        let machine_id = &id;
        if *machine_id == self.machine_id {
            return Err(self.machine_failure(
                machine_id,
                ErrorBody::invalid_argument("cannot remove the local machine"),
            ));
        }
        let name = self
            .network
            .machines()
            .into_iter()
            .find(|machine| machine.machine_id == *machine_id)
            .map_or(name, |machine| machine.name);
        let saved = blocking_in_place(|| self.store.delete_connection(machine_id))
            .map_err(ErrorBody::internal)?
            .ok_or_else(|| {
                self.machine_failure(
                    machine_id,
                    ErrorBody::new(
                        Reason::NotFound,
                        "this machine has no saved connection to remove",
                    ),
                )
            })?;
        self.network.remove_saved(machine_id);
        let route = self
            .network
            .machines()
            .into_iter()
            .find(|machine| machine.machine_id == *machine_id)
            .and_then(|machine| machine.route);
        let reachable = route.is_some();
        let via = route
            .filter(|route| route.len() > 1)
            .and_then(|route| self.machine_address_part(&route[0]).ok());
        self.publish_machine_table();
        Ok(wire::MachineRemoveResult {
            machine_id: saved.config.machine_id,
            name: Some(name),
            transport: Some(wire::SshTransport {
                ssh_destination: saved.config.ssh_destination,
                ssh_args: saved.argv,
                remote_home: saved.config.remote_home,
            }),
            reachable,
            via,
        })
    }

    pub(crate) async fn rename_local_machine(
        &self,
        name: String,
    ) -> Result<wire::MachineRenameResult, ErrorBody> {
        if !is_machine_name(&name) {
            return Err(ErrorBody::invalid_argument(
                "a machine name begins with a lowercase letter or digit and uses lowercase letters, digits and hyphens",
            ));
        }
        let _changing = self.machine_changes.lock().await;
        let previous_name = self
            .network
            .machines()
            .into_iter()
            .find(|machine| machine.machine_id == self.machine_id)
            .map(|machine| machine.name);
        blocking_in_place(|| self.store.rename_machine(&name)).map_err(ErrorBody::internal)?;
        self.network.rename_local(name.clone());
        Ok(wire::MachineRenameResult {
            machine_id: self.machine_id.clone(),
            name,
            previous_name,
        })
    }
}

pub(crate) fn project_machine_query(row: &mut MachineQueryResult, visible: &[MachineIdentity]) {
    row.selector = machine_address_part(&row.machine_id, visible)
        .unwrap_or_else(|_| addresses::exact_machine_selector(&row.machine_id));
    row.short_id =
        addresses::display_machine_id(&row.machine_id, visible).unwrap_or_else(|_| "-".into());
}

fn checked_ssh_args(destination: &str, argv: Vec<String>) -> Result<Vec<String>, ErrorBody> {
    let argv = if argv.is_empty() {
        vec![destination.to_owned()]
    } else {
        argv
    };
    let parsed = parse_ssh_destination(&argv)
        .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
    if parsed != destination {
        return Err(ErrorBody::invalid_argument(
            "SSH arguments name a different destination",
        ));
    }
    Ok(argv)
}

pub(crate) fn machine_address_part(
    machine_id: &str,
    visible: &[MachineIdentity],
) -> Result<String, ErrorBody> {
    let unnamed = MachineIdentity {
        machine_id: machine_id.to_owned(),
        name: String::new(),
    };
    let target = visible
        .iter()
        .find(|entry| entry.machine_id == machine_id)
        .unwrap_or(&unnamed);
    addresses::display_machine_selector(target, visible).map_err(|error| {
        ErrorBody::new(
            Reason::AmbiguousReference,
            format!("{error}; use machine rename to give it a unique name"),
        )
    })
}

fn identities(rows: &[wire::MachineInfo]) -> Vec<MachineIdentity> {
    rows.iter()
        .map(|row| MachineIdentity {
            machine_id: row.machine_id.clone(),
            name: row.name.clone(),
        })
        .collect()
}

pub(crate) fn offline_machine(identity: MachineIdentity) -> wire::MachineInfo {
    wire::MachineInfo {
        short_id: facade_base::address::short_machine_id(&identity.machine_id),
        selector: addresses::exact_machine_selector(&identity.machine_id),
        state: wire::MachineState::Unreachable,
        last_seen: None,
        ssh_error: None,
        machine_id: identity.machine_id,
        name: identity.name,
        boot_id: None,
        build: None,
        route: None,
        connections: Vec::new(),
    }
}
