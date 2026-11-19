//! Authorizes machine streams and applies local machine operations.

use std::sync::Arc;

use facade_base::address::{MachineSelector, is_machine_name};
use facade_base::daemon::{ClientKind, HelloParams, HelloResult};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{
    AgentRef, Caller, ConnectionKind, ConnectionState, MachineAddArgs, MachineAddResult,
    MachineConnectArgs, MachineConnectResult, MachineConnection, MachineHello, MachineIdentity,
    MachineInfo, MachineRemoveResult, MachineRenameResult, MachineTransport,
};
use facade_base::sockets::{ServerReader, ServerWriter};
use facade_base::ssh::{SshMode, machine_ssh_args};
use facade_base::v3;
use facade_base::v3::address as addresses;
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::mpsc;

use crate::lifecycle::Work;
use crate::network::{Event, FrontConnection};
use crate::records::root_of;
use crate::server::Client;
use crate::service::value_of;
use crate::{Daemon, SavedConnection, blocking_in_place};

pub(crate) enum MachineStream {
    Incoming(MachineHello),
    Foreground(FrontConnection),
}

pub(crate) async fn follow_network(
    daemon: Arc<Daemon>,
    mut events: mpsc::UnboundedReceiver<Event>,
) {
    while let Some(event) = events.recv().await {
        match event {
            Event::Target(request) => {
                let daemon = daemon.clone();
                tokio::spawn(async move { daemon.serve_target(request).await });
            }
            Event::RoutesChanged { machines } => {
                for row in machines
                    .iter()
                    .filter(|row| row.machine_id != daemon.machine_id && !row.is_unreachable())
                {
                    if let Err(error) = blocking_in_place(|| {
                        daemon.store.remember_machine(&row.machine_id, &row.name)
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
    pub(crate) fn machine_identities(&self) -> Result<Vec<MachineIdentity>, ErrorBody> {
        Ok(identities(&self.network.machines_v3()))
    }

    pub(crate) fn machine_address_part(&self, machine_id: &str) -> Result<String, ErrorBody> {
        let visible = self.machine_identities()?;
        machine_address_part(machine_id, &visible)
    }

    pub(crate) fn agent_address(&self, reference: &AgentRef) -> Result<String, ErrorBody> {
        let machine = self.machine_address_part(&reference.machine_id)?;
        Ok(addresses::format_agent_address(reference, &machine))
    }

    pub(crate) fn machine_hello_plan(
        &self,
        hello: HelloParams,
    ) -> Result<(HelloResult, MachineStream), ErrorBody> {
        let remote = hello.machine.ok_or_else(|| {
            ErrorBody::invalid_argument("a machine hello requires an introduction")
        })?;
        if remote.build != hello.build || remote.protocol_range != hello.protocol_range {
            return Err(ErrorBody::invalid_argument(
                "the machine introduction and hello give different versions",
            ));
        }
        self.network.check_peer(&remote)?;
        let local = self.network.local_hello();
        Ok((
            HelloResult {
                protocol: local.protocol_range[1],
                build: local.build.clone(),
                machine_id: local.machine_id.clone(),
                machine: Some(local),
                window: None,
                pid: std::process::id(),
                agent: None,
                agent_count: self.agents().len(),
                keeper: self.runs.keeper_info(),
                topics: Vec::new(),
                ops: Vec::new(),
            },
            MachineStream::Incoming(remote),
        ))
    }

    pub(crate) fn machine_connect_plan(
        &self,
        client: &Client,
        args: Value,
    ) -> Result<(Value, MachineStream), ErrorBody> {
        if client.agent.is_some() || client.identity.kind != ClientKind::Terminal {
            return Err(ErrorBody::refused(
                "only a person connected as a terminal can open a machine session",
            ));
        }
        let MachineConnectArgs { transport, kind } = decode_arguments(args)?;
        let (ssh_destination, remote_home, expected_machine_id) = match &transport {
            MachineTransport::Ssh {
                ssh_destination,
                remote_home,
            } => {
                let mode = if kind == ConnectionKind::Saved {
                    SshMode::Add
                } else {
                    SshMode::Connect
                };
                machine_ssh_args(ssh_destination, remote_home.as_deref(), mode, None)
                    .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
                let saved = if kind == ConnectionKind::Saved {
                    self.saved_connections()?.into_iter().find(|saved| {
                        &saved.ssh_destination == ssh_destination
                            && &saved.remote_home == remote_home
                    })
                } else {
                    None
                };
                (
                    Some(ssh_destination.clone()),
                    remote_home.clone(),
                    saved.map(|saved| saved.machine_id),
                )
            }
            MachineTransport::Bridge if kind == ConnectionKind::Temporary => (None, None, None),
            MachineTransport::Bridge => {
                return Err(ErrorBody::invalid_argument(
                    "a bridged machine session is temporary",
                ));
            }
        };
        let result = MachineConnectResult {
            ssh_destination,
            remote_home,
            expected_machine_id: expected_machine_id.clone(),
        };
        let front = FrontConnection {
            transport,
            kind,
            expected_machine_id,
        };
        Ok((value_of(result), MachineStream::Foreground(front)))
    }

    pub(crate) async fn serve_machine_stream(
        &self,
        stream: MachineStream,
        read: BufReader<ServerReader>,
        write: ServerWriter,
    ) -> anyhow::Result<()> {
        let Some(_active) = self.lifecycle.begin(Work::Connection) else {
            return Ok(());
        };
        match stream {
            MachineStream::Incoming(remote) => self.network.accept(remote, read, write).await,
            MachineStream::Foreground(front) => {
                let transport = front.transport.clone();
                let kind = front.kind;
                self.network
                    .connect(front, read, write, |remote| {
                        if kind == ConnectionKind::Saved
                            && let MachineTransport::Ssh {
                                ssh_destination,
                                remote_home,
                            } = &transport
                        {
                            self.check_saved_destination(
                                &remote.machine_id,
                                ssh_destination,
                                remote_home.as_deref(),
                            )?;
                        }
                        blocking_in_place(|| {
                            self.store
                                .remember_machine(&remote.machine_id, &remote.name)
                        })
                        .map_err(ErrorBody::internal)
                    })
                    .await
            }
        }
        .map_err(|error| anyhow::anyhow!("{}", error.message))
    }

    /// Derives the caller from the local connection's accepted identity.
    pub(crate) fn local_caller(&self, client: &Client) -> Result<Caller, ErrorBody> {
        if let Some(id) = &client.agent {
            let agent = AgentRef {
                machine_id: self.machine_id.clone(),
                agent_id: id.clone(),
            };
            let info = self.get_agent(id).map(|handle| handle.info());
            let root = info.as_ref().map(root_of).unwrap_or_else(|| agent.clone());
            let yolo = info.is_some_and(|info| info.yolo);
            return Ok(Caller::Agent { agent, root, yolo });
        }
        if let Some(binding) = &client.window {
            if !self.windows.is_current(binding) {
                return Err(ErrorBody::refused("this editor window is no longer bound"));
            }
            return Ok(Caller::Ide {
                window: binding.window.clone(),
            });
        }
        if client.identity.kind == ClientKind::Terminal {
            Ok(Caller::Terminal {
                machine_id: self.machine_id.clone(),
            })
        } else {
            Err(ErrorBody::refused(
                "this connection cannot act for the person",
            ))
        }
    }

    fn saved_connections(&self) -> Result<Vec<SavedConnection>, ErrorBody> {
        blocking_in_place(|| self.store.saved_connections()).map_err(ErrorBody::internal)
    }

    pub(crate) fn restore_machine_connections(&self) -> anyhow::Result<()> {
        for saved in blocking_in_place(|| self.store.saved_connections())? {
            drop(self.network.start_saved(saved));
        }
        Ok(())
    }

    fn check_saved_destination(
        &self,
        machine_id: &str,
        ssh_destination: &str,
        remote_home: Option<&str>,
    ) -> Result<Option<SavedConnection>, ErrorBody> {
        let saved = self
            .saved_connections()?
            .into_iter()
            .find(|saved| saved.machine_id == machine_id);
        if let Some(saved) = &saved
            && (saved.ssh_destination != ssh_destination
                || saved.remote_home.as_deref() != remote_home)
        {
            return Err(ErrorBody::invalid_argument(format!(
                "this machine is already saved through {}",
                saved.ssh_destination
            )));
        }
        Ok(saved)
    }

    pub(crate) fn machine_table(&self) -> Result<Vec<MachineInfo>, ErrorBody> {
        let mut machines = self.network.machines();
        let known =
            blocking_in_place(|| self.store.known_machine_names()).map_err(ErrorBody::internal)?;
        let local_connections = machines
            .iter()
            .find(|row| row.machine_id == self.machine_id)
            .map(|row| row.connections.clone())
            .unwrap_or_default();
        for saved in self.saved_connections()? {
            if machines
                .iter()
                .any(|row| row.machine_id == saved.machine_id)
            {
                continue;
            }
            let state = local_connections.iter().find(|c| {
                c.machine_id == saved.machine_id
                    && c.kind == ConnectionKind::Saved
                    && c.initiator_machine_id == self.machine_id
            });
            machines.push(MachineInfo {
                name: known
                    .get(&saved.machine_id)
                    .cloned()
                    .unwrap_or_else(|| saved.ssh_destination.clone()),
                machine_id: saved.machine_id,
                boot_id: None,
                build: None,
                route: None,
                connections: vec![MachineConnection {
                    machine_id: self.machine_id.clone(),
                    initiator_machine_id: self.machine_id.clone(),
                    kind: ConnectionKind::Saved,
                    ssh_destination: Some(saved.ssh_destination),
                    remote_home: saved.remote_home,
                    state: state.map_or(ConnectionState::Disconnected, |c| c.state),
                    ssh_interaction: state.and_then(|c| c.ssh_interaction.clone()),
                }],
            });
        }
        machines.sort_by(|left, right| left.machine_id.cmp(&right.machine_id));
        Ok(machines)
    }

    fn publish_machine_table(&self) {
        match self.machine_table() {
            Ok(machines) => {
                let _ = self.machine_views.send(machines);
            }
            Err(error) => crate::log("warn", &error.message),
        }
    }

    pub(crate) fn select_machine(
        &self,
        selector: MachineSelector<'_>,
    ) -> Result<MachineInfo, ErrorBody> {
        let mut found: Vec<_> = self
            .machine_table()?
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
                selector
                    .matches(&identity)
                    .then(|| offline_machine(identity))
            }));
            if found.is_empty()
                && let MachineSelector::IdPrefix(id) = selector
                && id.len() == 32
            {
                let id = id.to_ascii_lowercase();
                let machine_id = format!(
                    "{}-{}-{}-{}-{}",
                    &id[..8],
                    &id[8..12],
                    &id[12..16],
                    &id[16..20],
                    &id[20..]
                );
                found.push(offline_machine(MachineIdentity {
                    name: facade_base::address::exact_machine_selector(&machine_id),
                    machine_id,
                }));
            }
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
                error.data.candidates = found.into_iter().map(|row| row.machine_id).collect();
                Err(error)
            }
        }
    }

    pub(crate) async fn add_machine(
        &self,
        args: MachineAddArgs,
    ) -> Result<MachineAddResult, ErrorBody> {
        let _changing = self.machine_changes.lock().await;
        let old = self.check_saved_destination(
            &args.machine_id,
            &args.ssh_destination,
            args.remote_home.as_deref(),
        )?;
        let saved = SavedConnection {
            machine_id: args.machine_id,
            ssh_destination: args.ssh_destination,
            remote_home: args.remote_home,
        };
        let connected = self.network.start_saved(saved.clone()).await;
        let machine = match connected
            .map_err(ErrorBody::internal)
            .and_then(|machine| machine)
        {
            Ok(machine) => machine,
            Err(error) => {
                if old.is_none() {
                    self.network.remove_saved(&saved.machine_id);
                }
                return Err(error);
            }
        };
        let kept = blocking_in_place(|| self.store.save_connection(&saved));
        if let Err(error) = kept {
            if old.is_none() {
                self.network.remove_saved(&saved.machine_id);
            }
            return Err(ErrorBody::internal(error));
        }
        let first_connection = blocking_in_place(|| {
            self.store
                .remember_machine(&machine.machine_id, &machine.name)
        })
        .map_err(ErrorBody::internal)?;
        self.publish_machine_table();
        Ok(MachineAddResult {
            machine,
            first_connection,
        })
    }

    pub(crate) async fn remove_machine(
        &self,
        machine_id: &str,
    ) -> Result<MachineRemoveResult, ErrorBody> {
        let _changing = self.machine_changes.lock().await;
        let saved = blocking_in_place(|| self.store.delete_connection(machine_id))
            .map_err(ErrorBody::internal)?
            .ok_or_else(|| {
                ErrorBody::new(
                    Reason::NotFound,
                    "this machine has no saved connection to remove",
                )
            })?;
        self.network.remove_saved(machine_id);
        let reachable = self
            .network
            .machines()
            .iter()
            .any(|row| row.machine_id == machine_id && !row.is_unreachable());
        self.publish_machine_table();
        Ok(MachineRemoveResult {
            machine_id: saved.machine_id,
            ssh_destination: saved.ssh_destination,
            remote_home: saved.remote_home,
            reachable,
        })
    }

    pub(crate) async fn rename_local_machine(
        &self,
        name: String,
    ) -> Result<MachineRenameResult, ErrorBody> {
        if !is_machine_name(&name) {
            return Err(ErrorBody::invalid_argument(
                "a machine name begins with a lowercase letter or digit and uses lowercase letters, digits and hyphens",
            ));
        }
        let _changing = self.machine_changes.lock().await;
        blocking_in_place(|| self.store.rename_machine(&name)).map_err(ErrorBody::internal)?;
        self.network.rename_local(name.clone());
        Ok(MachineRenameResult {
            machine_id: self.machine_id.clone(),
            name,
        })
    }
}

fn offline_machine(identity: MachineIdentity) -> MachineInfo {
    MachineInfo {
        machine_id: identity.machine_id,
        name: identity.name,
        boot_id: None,
        build: None,
        route: None,
        connections: Vec::new(),
    }
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

fn identities(rows: &[v3::MachineInfo]) -> Vec<MachineIdentity> {
    rows.iter()
        .map(|row| MachineIdentity {
            machine_id: row.machine_id.clone(),
            name: row.name.clone(),
        })
        .collect()
}
