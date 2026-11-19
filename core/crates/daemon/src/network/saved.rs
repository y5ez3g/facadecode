//! Supervises the background session for each saved connection.

use std::sync::Arc;
use std::time::SystemTime;

use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{MachineHello, SshInteraction};
use facade_base::time::iso_time;
use facade_base::v3::{MachineConnection, MachineInfo, MachineState};
use tokio::sync::{Notify, oneshot, watch};
use tokio::time::Instant;

use super::ssh::{FailedAttempt, Pipes, RETRY_AFTER};
use super::topology::{Origin, Saved, Topology, ssh_source};
use super::wire::Reader;
use super::{Event, Network, SavedSsh, SessionId, expected, session, wire};
use crate::SavedConnection;

pub(crate) struct SavedStatus {
    pub(crate) connecting: bool,
    pub(crate) last_seen: Option<String>,
    pub(crate) sleeping: bool,
    pub(crate) ssh_error: Option<String>,
}

impl Network {
    pub(crate) fn start_saved_ssh(
        &self,
        ssh: SavedSsh,
    ) -> oneshot::Receiver<Result<MachineHello, ErrorBody>> {
        let config = &ssh.config;
        let (first, receiver) = oneshot::channel();
        let mut state = self.0.state.lock().unwrap();
        if let Some(saved) = state.saved.get_mut(&config.machine_id) {
            if saved.config != *config || saved.argv != ssh.argv {
                let existing = ssh_source(
                    &saved.config.ssh_destination,
                    saved.config.remote_home.as_deref(),
                );
                let _ = first.send(Err(ErrorBody::new(
                    Reason::Refused,
                    format!(
                        "Machine {} already has a saved connection via {existing}.",
                        config.machine_id
                    ),
                )));
                return receiver;
            }
            if let Some(active) = saved.active {
                let _ = first.send(Ok(state.links[&active].remote.clone()));
            } else if let Some(error) = &saved.failure {
                let _ = first.send(Err(error.error.clone()));
            } else {
                saved.waiters.push(first);
            }
            return receiver;
        }
        self.install_saved(&mut state, ssh).waiters.push(first);
        state.publish(&self.0.events, None);
        receiver
    }

    fn install_saved<'a>(&self, state: &'a mut Topology, ssh: SavedSsh) -> &'a mut Saved {
        let generation = state.number();
        let (stop, stopped) = watch::channel(false);
        let changed = Arc::new(Notify::new());
        let machine_id = ssh.config.machine_id.clone();
        let saved = state.saved.entry(machine_id).insert_entry(Saved {
            config: ssh.config.clone(),
            argv: ssh.argv.clone(),
            generation,
            stop,
            changed: changed.clone(),
            waiters: Vec::new(),
            wake_waiters: Vec::new(),
            connecting: true,
            name: None,
            last_seen: None,
            failure: None,
            active: None,
        });
        let network = self.clone();
        tokio::spawn(async move {
            network
                .maintain_saved(ssh, generation, changed, stopped)
                .await;
        });
        saved.into_mut()
    }

    /// Gives the already authenticated foreground link to the saved connection's supervisor.
    pub(super) fn adopt_saved(
        &self,
        state: &mut Topology,
        ssh: SavedSsh,
        id: SessionId,
        remote: &MachineHello,
    ) -> Origin {
        let config = &ssh.config;
        let prior = state.saved.remove(&config.machine_id);
        if let Some(prior) = &prior {
            prior.stop.send_replace(true);
            if let Some(active) = prior.active {
                self.close_link(state, active);
            }
        }
        let source = ssh_source(&config.ssh_destination, config.remote_home.as_deref());
        let saved = self.install_saved(state, ssh);
        if let Some(prior) = prior {
            saved.waiters = prior.waiters;
            saved.wake_waiters = prior.wake_waiters;
        }
        saved.opened(id, remote);
        Origin::Saved {
            machine_id: remote.machine_id.clone(),
            generation: saved.generation,
            source,
        }
    }

    pub(super) async fn ensure_saved_hop(&self, machine_id: &str) -> Result<(), ErrorBody> {
        let ready = {
            let mut state = self.0.state.lock().unwrap();
            if state.direct(machine_id).is_some() {
                return Ok(());
            }
            let identity = state.identity(machine_id);
            let saved = state.saved.get_mut(machine_id).ok_or_else(|| {
                wire::unavailable(
                    identity,
                    facade_base::machine::ExecutionOutcome::NotExecuted,
                    "There is no saved connection to this machine.",
                )
            })?;
            if saved.interaction().is_some()
                && let Some(error) = &saved.failure
            {
                return Err(error.error.clone());
            }
            let (waiter, ready) = oneshot::channel();
            saved.wake_waiters.push(waiter);
            saved.changed.notify_one();
            ready
        };
        ready.await.map_err(ErrorBody::internal)??;
        Ok(())
    }

    pub(crate) fn remove_saved(&self, machine_id: &str) -> bool {
        let mut state = self.0.state.lock().unwrap();
        let Some(saved) = state.saved.remove(machine_id) else {
            return false;
        };
        saved.stop.send_replace(true);
        for waiting in saved.waiters.into_iter().chain(saved.wake_waiters) {
            let _ = waiting.send(Err(ErrorBody::new(
                Reason::Cancelled,
                "The saved connection was removed.",
            )));
        }
        match saved.active {
            Some(id) => self.close_link(&mut state, id),
            None => state.publish(&self.0.events, None),
        }
        true
    }

    async fn maintain_saved(
        &self,
        ssh: SavedSsh,
        generation: u64,
        changed: Arc<Notify>,
        mut stopped: watch::Receiver<bool>,
    ) {
        tokio::select! {
            biased;
            _ = stopped.wait_for(|stopped| *stopped) => {},
            () = async {
                let mut next_probe = Instant::now();
                let config = &ssh.config;
                loop {
                    let (wake, until) = {
                        let mut state = self.0.state.lock().unwrap();
                        let Some(saved) = state.saved.get_mut(&config.machine_id)
                            .filter(|saved| saved.generation == generation) else { return };
                        let plan = if saved.active.is_some() || saved.interaction().is_some() {
                            (None, None)
                        } else if !saved.wake_waiters.is_empty() {
                            (Some(true), None)
                        } else if Instant::now() >= next_probe {
                            (Some(false), None)
                        } else {
                            (None, Some(next_probe))
                        };
                        if plan.0.is_some() && !saved.connecting {
                            saved.connecting = true;
                            state.publish(&self.0.events, None);
                        }
                        plan
                    };
                    if let Some(wake) = wake {
                        if let Err(failure) = self.saved_attempt(&ssh, generation, wake).await {
                            self.saved_failed(config, generation, wake, failure);
                        }
                        next_probe = Instant::now() + RETRY_AFTER;
                    } else {
                        tokio::select! {
                            () = changed.notified() => {},
                            () = session::expires(until) => {},
                        }
                    }
                }
            } => {},
        }
    }

    async fn saved_attempt(
        &self,
        ssh: &SavedSsh,
        generation: u64,
        wake: bool,
    ) -> Result<(), FailedAttempt> {
        let config = &ssh.config;
        let local = self.local_hello();
        let Pipes {
            read,
            mut write,
            process,
        } = Pipes::open(ssh, &local.build, wake, self.0.control_dir.as_deref()).await?;
        let mut read = Reader::new(read);
        let mut opened = false;
        let result = async {
            let remote = wire::introduce(&mut read, &mut write, local).await?;
            expected(&remote, Some(&config.machine_id))?;
            let origin = Origin::Saved {
                machine_id: config.machine_id.clone(),
                generation,
                source: ssh_source(&config.ssh_destination, config.remote_home.as_deref()),
            };
            let (registered, output) = self
                .handshake(&mut read, &mut write, remote, origin)
                .await?;
            registered.activate()?;
            opened = true;
            registered.run(read, write, output).await
        }
        .await;
        let diagnostics = process.finish().await;
        if opened {
            return Ok(());
        }
        let error = result.expect_err("a session must open before it can run");
        let sleeping = !wake && diagnostics.status.and_then(|status| status.code()) == Some(3);
        Err(FailedAttempt::from_ssh(ssh, diagnostics, error, sleeping))
    }

    fn saved_failed(
        &self,
        config: &SavedConnection,
        generation: u64,
        wake: bool,
        failure: FailedAttempt,
    ) {
        let mut state = self.0.state.lock().unwrap();
        let Some(saved) = state
            .saved
            .get_mut(&config.machine_id)
            .filter(|saved| saved.generation == generation)
        else {
            return;
        };
        let error = &failure.error;
        for waiting in saved.waiters.drain(..) {
            let _ = waiting.send(Err(error.clone()));
        }
        if wake || error.data.ssh_interaction.is_some() {
            for waiting in saved.wake_waiters.drain(..) {
                let _ = waiting.send(Err(error.clone()));
            }
        }
        let sleeping = failure.sleeping;
        saved.connecting = false;
        if !sleeping {
            let _ = self.0.events.send(Event::ConnectionFailed {
                config: config.clone(),
                error: error.clone(),
            });
        }
        saved.failure = Some(failure);
        state.publish(&self.0.events, None);
    }
}

impl Saved {
    pub(super) fn interaction(&self) -> Option<&SshInteraction> {
        self.failure.as_ref()?.error.data.ssh_interaction.as_ref()
    }

    pub(super) fn opened(&mut self, id: SessionId, remote: &MachineHello) {
        self.active = Some(id);
        self.connecting = false;
        self.name = Some(remote.name.clone());
        self.failure = None;
        self.last_seen = Some(SystemTime::now());
        for waiting in self.waiters.drain(..).chain(self.wake_waiters.drain(..)) {
            let _ = waiting.send(Ok(remote.clone()));
        }
    }

    fn status(&self) -> SavedStatus {
        let failure = self.failure.as_ref();
        SavedStatus {
            connecting: self.connecting,
            last_seen: self.last_seen.map(iso_time),
            sleeping: failure.is_some_and(|failure| failure.sleeping),
            ssh_error: failure.and_then(|failure| failure.ssh_error.clone()),
        }
    }

    pub(super) fn offline(&self, connection: MachineConnection) -> MachineInfo {
        let status = self.status();
        let selector = facade_base::v3::address::exact_machine_selector(&self.config.machine_id);
        let state = if status.connecting {
            MachineState::Connecting
        } else if self.interaction().is_some() {
            MachineState::SshInteractionRequired
        } else if status.sleeping {
            MachineState::Sleeping
        } else {
            MachineState::Unreachable
        };
        MachineInfo {
            machine_id: self.config.machine_id.clone(),
            boot_id: None,
            name: self.name.clone().unwrap_or_else(|| selector.clone()),
            selector,
            state,
            last_seen: status.last_seen,
            ssh_error: status.ssh_error,
            build: None,
            route: None,
            connections: vec![connection],
        }
    }
}
