//! Runs demand-driven attempts for saved SSH connections.

use std::time::SystemTime;

use facade_base::api_v1::ErrorBody;
use facade_base::api_v1::daemon::ConnectedMachine;
use facade_base::machine::{ExecutionOutcome, SshInteraction};
use facade_base::time::iso_time;
use facade_base::v3::{self, MachineConnection, MachineInfo, MachineState};
use tokio::sync::{oneshot, watch};

use super::ssh::{FailedAttempt, Pipes};
use super::topology::{Origin, Saved, Topology, ssh_source};
use super::wake::RouteAttempt;
use super::wire::Reader;
use super::{Event, Network, SavedSsh, SessionId, expected, wire};

type Waiter = oneshot::Sender<Result<ConnectedMachine, ErrorBody>>;

impl Network {
    pub(crate) fn restore_saved_ssh(&self, ssh: SavedSsh, name: Option<String>) {
        let mut state = self.0.state.lock().unwrap();
        self.install_saved(&mut state, ssh).name = name;
        state.publish(&self.0.events, None);
    }

    fn install_saved<'a>(&self, state: &'a mut Topology, ssh: SavedSsh) -> &'a mut Saved {
        let generation = state.number();
        let machine_id = ssh.config.machine_id.clone();
        state
            .saved
            .entry(machine_id)
            .insert_entry(Saved {
                config: ssh.config,
                argv: ssh.argv,
                generation,
                stop: watch::channel(false).0,
                passive_waiters: Vec::new(),
                wake_waiters: Vec::new(),
                connecting: false,
                name: None,
                last_seen: None,
                failure: None,
                active: None,
            })
            .into_mut()
    }

    pub(super) fn adopt_saved(
        &self,
        state: &mut Topology,
        ssh: SavedSsh,
        id: SessionId,
        remote: &ConnectedMachine,
    ) -> Origin {
        let config = &ssh.config;
        let prior = state.saved.remove(&config.machine_id);
        if let Some(prior) = &prior {
            prior.stop.send_replace(true);
            if let Some(active) = prior.active {
                self.withdraw_link(state, active, None);
            }
        }
        let source = ssh_source(&config.ssh_destination, config.remote_home.as_deref());
        let saved = self.install_saved(state, ssh);
        if let Some(prior) = prior {
            saved.passive_waiters = prior.passive_waiters;
            saved.wake_waiters = prior.wake_waiters;
        }
        saved.opened(id, remote);
        Origin::Saved {
            machine_id: remote.machine_id.clone(),
            generation: saved.generation,
            source,
        }
    }

    pub(super) async fn open_saved_hop(
        &self,
        machine_id: &str,
        attempt: RouteAttempt,
    ) -> Result<(), ErrorBody> {
        let ready = {
            let mut state = self.0.state.lock().unwrap();
            let (waiter, ready) = oneshot::channel();
            self.queue_saved(&mut state, machine_id, attempt, waiter);
            ready
        };
        ready
            .await
            .map_err(|error| wire::error("internal", error.to_string()))??;
        Ok(())
    }

    fn queue_saved(
        &self,
        state: &mut Topology,
        machine_id: &str,
        attempt: RouteAttempt,
        waiter: Waiter,
    ) {
        if let Some(link) = state.direct_link(machine_id) {
            let _ = waiter.send(Ok(link.remote.clone()));
            return;
        }
        let Some(saved) = state.saved.get_mut(machine_id) else {
            let _ = waiter.send(Err(wire::unavailable(
                state.identity(machine_id),
                ExecutionOutcome::NotExecuted,
                "There is no saved connection to this machine.",
            )));
            return;
        };
        if attempt == RouteAttempt::Wake
            && !saved.connecting
            && let Some(failure) = &saved.failure
            && failure.interaction.is_some()
        {
            let _ = waiter.send(Err(failure.error.clone()));
            return;
        }
        match attempt {
            RouteAttempt::Passive => saved.passive_waiters.push(waiter),
            RouteAttempt::Wake => saved.wake_waiters.push(waiter),
        }
        if !saved.connecting {
            self.start_attempt(saved, attempt);
            state.publish(&self.0.events, None);
        }
    }

    fn start_attempt(&self, saved: &mut Saved, attempt: RouteAttempt) {
        saved.connecting = true;
        let ssh = SavedSsh {
            config: saved.config.clone(),
            argv: saved.argv.clone(),
        };
        let generation = saved.generation;
        let mut stopped = saved.stop.subscribe();
        let network = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = stopped.wait_for(|stopped| *stopped) => {}
                result = network.saved_attempt(&ssh, generation, attempt) => {
                    if let Err(failure) = result {
                        network.saved_failed(&ssh, generation, attempt, failure);
                    }
                }
            }
        });
    }

    pub(crate) fn remove_saved(&self, machine_id: &str) -> bool {
        let mut state = self.0.state.lock().unwrap();
        let Some(saved) = state.saved.remove(machine_id) else {
            return false;
        };
        saved.stop.send_replace(true);
        for waiter in saved.passive_waiters.into_iter().chain(saved.wake_waiters) {
            let _ = waiter.send(Err(wire::error(
                "cancelled",
                "The saved connection was removed.",
            )));
        }
        if let Some(id) = saved.active {
            self.withdraw_link(&mut state, id, None);
        }
        state.publish(&self.0.events, None);
        true
    }

    async fn saved_attempt(
        &self,
        ssh: &SavedSsh,
        generation: u64,
        attempt: RouteAttempt,
    ) -> Result<(), FailedAttempt> {
        let config = &ssh.config;
        let local = self.local_hello();
        let wake = attempt == RouteAttempt::Wake;
        let Pipes {
            read,
            mut write,
            process,
        } = Pipes::open(ssh, &local.build, wake, self.0.control_dir.as_deref()).await?;
        let mut read = Reader::new(read);
        let mut introduced = false;
        let handshaken = async {
            let remote = wire::introduce(&mut read, &mut write, local, false).await?;
            introduced = true;
            expected(&remote.machine, Some(&config.machine_id))?;
            let origin = Origin::Saved {
                machine_id: config.machine_id.clone(),
                generation,
                source: ssh_source(&config.ssh_destination, config.remote_home.as_deref()),
            };
            let (registered, output) = self
                .handshake(&mut read, &mut write, remote, origin)
                .await?;
            registered.activate()?;
            Ok::<_, ErrorBody>((registered, output))
        }
        .await;
        match handshaken {
            Ok((registered, output)) => {
                let result = registered.run(read, write, output).await;
                let diagnostics = process.finish().await;
                let failure = match result {
                    Err(error) => Some(FailedAttempt::from_ssh(ssh, diagnostics, error, false)),
                    Ok(()) if diagnostics.exit_code() == Some(255) => {
                        Some(FailedAttempt::from_ssh(
                            ssh,
                            diagnostics,
                            wire::error("unavailable", "The SSH connection failed."),
                            false,
                        ))
                    }
                    Ok(()) => None,
                };
                registered.finish(failure);
                Ok(())
            }
            Err(error) => {
                drop((read, write));
                let diagnostics = process.finish().await;
                let sleeping = !wake
                    && !introduced
                    && error.data.reason == "unavailable"
                    && diagnostics.exit_code() == Some(3);
                Err(FailedAttempt::from_ssh(ssh, diagnostics, error, sleeping))
            }
        }
    }

    fn saved_failed(
        &self,
        ssh: &SavedSsh,
        generation: u64,
        attempt: RouteAttempt,
        mut failure: FailedAttempt,
    ) {
        let config = &ssh.config;
        let mut state = self.0.state.lock().unwrap();
        let live = state
            .direct_link(&config.machine_id)
            .map(|link| link.remote.clone());
        let Some(saved) = state
            .saved
            .get_mut(&config.machine_id)
            .filter(|saved| saved.generation == generation)
        else {
            return;
        };
        saved.connecting = false;
        if let Some(remote) = live {
            saved.seen(&remote);
            return;
        }
        if failure.sleeping {
            wire::detail(
                &mut failure.error,
                "machines",
                serde_json::json!([saved.sleeping_row(&failure.ssh_error)]),
            );
        }
        if failure.error.data.reason == "unavailable" {
            let identity = facade_base::machine::MachineIdentity {
                machine_id: config.machine_id.clone(),
                name: saved.name.clone().unwrap_or_else(|| saved.selector()),
            };
            wire::detail(
                &mut failure.error,
                "execution",
                serde_json::json!(ExecutionOutcome::NotExecuted),
            );
            wire::detail(&mut failure.error, "machine", serde_json::json!(identity));
        }
        let error = &failure.error;
        for waiter in saved.passive_waiters.drain(..) {
            let _ = waiter.send(Err(error.clone()));
        }
        if attempt == RouteAttempt::Wake || failure.interaction.is_some() {
            for waiter in saved.wake_waiters.drain(..) {
                let _ = waiter.send(Err(error.clone()));
            }
        }
        if !failure.sleeping {
            let _ = self.0.events.send(Event::ConnectionFailed {
                config: config.clone(),
                error: error.clone(),
            });
        }
        saved.failure = Some(failure);
        saved.wake_waiters.retain(|waiter| !waiter.is_closed());
        if !saved.wake_waiters.is_empty() {
            self.start_attempt(saved, RouteAttempt::Wake);
        }
        state.publish(&self.0.events, None);
    }
}

impl Saved {
    pub(super) fn interaction(&self) -> Option<&SshInteraction> {
        self.failure.as_ref()?.interaction.as_ref()
    }

    pub(super) fn seen(&mut self, remote: &ConnectedMachine) {
        self.name = Some(remote.name.clone());
        self.failure = None;
        self.last_seen = Some(SystemTime::now());
        for waiter in self
            .passive_waiters
            .drain(..)
            .chain(self.wake_waiters.drain(..))
        {
            let _ = waiter.send(Ok(remote.clone()));
        }
    }

    pub(super) fn opened(&mut self, id: SessionId, remote: &ConnectedMachine) {
        self.active = Some(id);
        self.connecting = false;
        self.seen(remote);
    }

    fn selector(&self) -> String {
        v3::address::exact_machine_selector(&self.config.machine_id)
    }

    fn sleeping_row(&self, ssh_error: &Option<String>) -> v3::MachineQueryResult {
        v3::MachineQueryResult {
            machine_id: self.config.machine_id.clone(),
            short_id: v3::address::short_machine_id(&self.config.machine_id),
            name: self.name.clone().unwrap_or_else(|| self.selector()),
            selector: self.selector(),
            build: None,
            state: MachineState::Sleeping,
            status: v3::MachineQueryStatus::Unavailable,
            last_seen: self.last_seen.map(iso_time),
            ssh_error: ssh_error.clone(),
            error: None,
        }
    }

    pub(super) fn offline(&self, connection: MachineConnection) -> MachineInfo {
        let state = if self.connecting {
            MachineState::Connecting
        } else if self.interaction().is_some() {
            MachineState::SshInteractionRequired
        } else {
            match &self.failure {
                Some(failure) if failure.sleeping => MachineState::Sleeping,
                Some(_) => MachineState::Unreachable,
                None => MachineState::Disconnected,
            }
        };
        MachineInfo {
            machine_id: self.config.machine_id.clone(),
            boot_id: None,
            name: self.name.clone().unwrap_or_else(|| self.selector()),
            selector: self.selector(),
            state,
            last_seen: self.last_seen.map(iso_time),
            ssh_error: self
                .failure
                .as_ref()
                .and_then(|failure| failure.ssh_error.clone()),
            build: None,
            route: None,
            connections: vec![connection],
            capabilities: Vec::new(),
        }
    }
}
