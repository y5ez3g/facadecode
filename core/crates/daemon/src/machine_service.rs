//! Authorizes machine streams and applies local machine operations.

use std::sync::Arc;

use facade_base::daemon::{ClientKind, HelloParams, HelloResult};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{
    AgentRef, ConnectionKind, MachineAddResult, MachineHello, MachineIdentity, MachineRemoveResult,
    MachineRenameResult, MachineTransport,
};
use facade_base::sockets::{ServerReader, ServerWriter};
use facade_base::ssh::parse_ssh_destination;
use facade_base::v3;
use facade_base::v3::address::{self as addresses, MachineSelector, is_machine_name};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::mpsc;

use crate::lifecycle::Work;
use crate::network::{Event, FrontConnection, SavedSsh, TargetReply};
use crate::records::root_of;
use crate::server::Client;
use crate::service::value_of;
use crate::{Daemon, SavedConnection, blocking_in_place};

pub(crate) enum MachineStream {
    Incoming(MachineHello),
    Foreground {
        session: FrontConnection,
        argv: Vec<String>,
    },
}

pub(crate) async fn follow_network(
    daemon: Arc<Daemon>,
    mut events: mpsc::UnboundedReceiver<Event>,
) {
    while let Some(event) = events.recv().await {
        match event {
            Event::Target(request) => {
                let error = ErrorBody::new(
                    Reason::IncompatibleProtocol,
                    "normal machine calls use protocol 3",
                );
                let _ = request.reply.send(TargetReply::Call(Err(error)));
            }
            Event::RoutesChanged { machines } => {
                for row in machines
                    .iter()
                    .filter(|row| row.machine_id != daemon.machine_id && !row.is_unreachable())
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
        if client.verified_actor.is_some() || client.identity.kind != ClientKind::Terminal {
            return Err(ErrorBody::refused(
                "only a terminal client can open an SSH connection",
            ));
        }
        let v3::MachineConnectArgs { transport, kind } = decode_arguments(args)?;
        let (transport, argv, expected_machine_id) = match transport {
            v3::MachineTransport::Ssh {
                ssh_destination,
                ssh_args,
                remote_home,
            } => {
                let argv = checked_ssh_args(&ssh_destination, ssh_args)?;
                let expected = if kind == ConnectionKind::Saved {
                    self.saved_ssh()?
                        .into_iter()
                        .find(|saved| saved.argv == argv && saved.config.remote_home == remote_home)
                        .map(|saved| saved.config.machine_id)
                } else {
                    None
                };
                (
                    MachineTransport::Ssh {
                        ssh_destination,
                        remote_home,
                    },
                    argv,
                    expected,
                )
            }
            v3::MachineTransport::Bridge if kind == ConnectionKind::Temporary => {
                (MachineTransport::Bridge, Vec::new(), None)
            }
            _ => {
                return Err(ErrorBody::invalid_argument(
                    "a bridged machine session is temporary",
                ));
            }
        };
        let (ssh_destination, remote_home) = match &transport {
            MachineTransport::Ssh {
                ssh_destination,
                remote_home,
            } => (Some(ssh_destination.clone()), remote_home.clone()),
            MachineTransport::Bridge => (None, None),
        };
        let result = v3::MachineConnectResult {
            ssh_destination,
            ssh_args: argv.clone(),
            remote_home,
            expected_machine_id: expected_machine_id.clone(),
        };
        let session = FrontConnection {
            transport,
            kind,
            expected_machine_id,
        };
        Ok((
            value_of(result),
            MachineStream::Foreground { session, argv },
        ))
    }

    pub(crate) async fn serve_machine_stream(
        &self,
        stream: MachineStream,
        read: BufReader<ServerReader>,
        write: ServerWriter,
    ) -> anyhow::Result<()> {
        let Some(initial_work) = self.lifecycle.begin(Work::Call) else {
            return Ok(());
        };
        match stream {
            MachineStream::Incoming(remote) => {
                self.network
                    .accept_with_work(remote, read, write, Some(initial_work))
                    .await
            }
            MachineStream::Foreground { session, argv } => {
                let transport = session.transport.clone();
                let kind = session.kind;
                self.network
                    .connect_with_saved(
                        session,
                        read,
                        write,
                        Some(initial_work),
                        |remote: &MachineHello| {
                            let saved = match &transport {
                                MachineTransport::Ssh {
                                    ssh_destination,
                                    remote_home,
                                } if kind == ConnectionKind::Saved => {
                                    let saved = SavedSsh {
                                        config: SavedConnection {
                                            machine_id: remote.machine_id.clone(),
                                            ssh_destination: ssh_destination.clone(),
                                            remote_home: remote_home.clone(),
                                        },
                                        argv,
                                    };
                                    Some(self.keep_ssh(saved)?)
                                }
                                _ => None,
                            };
                            let first = blocking_in_place(|| {
                                self.store
                                    .remember_machine(&remote.machine_id, &remote.name)
                            })
                            .map_err(ErrorBody::internal)?;
                            Ok((first, saved))
                        },
                    )
                    .await
            }
        }
        .map_err(|error| anyhow::anyhow!("{}", error.message))
    }

    /// Derives the caller from the local connection's accepted identity.
    pub(crate) fn local_caller(
        &self,
        client: &Client,
    ) -> Result<facade_base::v3::Caller, ErrorBody> {
        use facade_base::v3::Caller;
        if let Some(agent) = client.verified_actor.as_ref() {
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
                root: root_of(&info),
                yolo: info.yolo,
            });
        }
        let machine_id = self.machine_id.clone();
        match client.identity.kind {
            ClientKind::Terminal => Ok(Caller::Terminal { machine_id }),
            ClientKind::Ide => Ok(Caller::Ide { machine_id }),
            _ => Err(ErrorBody::refused("this connection has no verified caller")),
        }
    }

    fn saved_ssh(&self) -> Result<Vec<SavedSsh>, ErrorBody> {
        blocking_in_place(|| self.store.saved_ssh()).map_err(ErrorBody::internal)
    }

    pub(crate) fn restore_machine_connections(&self) -> anyhow::Result<()> {
        for saved in blocking_in_place(|| self.store.saved_ssh())? {
            drop(self.network.start_saved_ssh(saved));
        }
        for (id, route) in blocking_in_place(|| self.store.remembered_routes())? {
            self.network.remember_route(id, route);
        }
        Ok(())
    }

    fn keep_ssh(&self, saved: SavedSsh) -> Result<SavedSsh, ErrorBody> {
        let kept = blocking_in_place(|| self.store.save_verified_ssh(&saved))
            .map_err(ErrorBody::internal)?;
        if kept.config != saved.config || kept.argv != saved.argv {
            return Err(ErrorBody::refused(format!(
                "this machine already has a saved SSH connection through {}",
                kept.config.ssh_destination
            )));
        }
        Ok(kept)
    }

    fn publish_machine_table(&self) {
        let _ = self.machine_views.send(());
    }

    pub(crate) fn public_machines(&self) -> Result<Vec<v3::MachineInfo>, ErrorBody> {
        let last_contact =
            blocking_in_place(|| self.store.machine_last_seen()).map_err(ErrorBody::internal)?;
        let mut rows = self.network.machines_v3();
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

    pub(crate) fn select_machine(
        &self,
        selector: MachineSelector<'_>,
    ) -> Result<v3::MachineInfo, ErrorBody> {
        let mut found: Vec<_> = self
            .network
            .machines_v3()
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
                let visible = self.machine_identities()?;
                error.data.candidates = found
                    .into_iter()
                    .filter_map(|machine| machine_address_part(&machine.machine_id, &visible).ok())
                    .collect();
                Err(error)
            }
        }
    }

    pub(crate) async fn add_machine_v3(
        &self,
        args: v3::MachineAddArgs,
    ) -> Result<MachineAddResult, ErrorBody> {
        let _changing = self.machine_changes.lock().await;
        let argv = checked_ssh_args(&args.ssh_destination, args.ssh_args)?;
        let saved = self
            .saved_ssh()?
            .into_iter()
            .find(|saved| saved.config.machine_id == args.machine_id)
            .ok_or_else(|| {
                ErrorBody::invalid_argument(
                    "open the authenticated foreground SSH connection first",
                )
            })?;
        if saved.argv != argv || saved.config.remote_home != args.remote_home {
            return Err(ErrorBody::invalid_argument(
                "the saved SSH connection does not match these arguments",
            ));
        }
        let machine = self
            .network
            .start_saved_ssh(saved)
            .await
            .map_err(ErrorBody::internal)??;
        Ok(MachineAddResult {
            machine,
            first_connection: false,
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

fn identities(rows: &[v3::MachineInfo]) -> Vec<MachineIdentity> {
    rows.iter()
        .map(|row| MachineIdentity {
            machine_id: row.machine_id.clone(),
            name: row.name.clone(),
        })
        .collect()
}

fn offline_machine(identity: MachineIdentity) -> v3::MachineInfo {
    v3::MachineInfo {
        selector: addresses::exact_machine_selector(&identity.machine_id),
        state: v3::MachineState::Unreachable,
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
