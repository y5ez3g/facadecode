//! Supervises the background session for each saved connection.

use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{MachineHello, SshInteraction};
use facade_base::ssh::{SshMode, machine_ssh_args};
use tokio::process::Command;
use tokio::sync::{oneshot, watch};

use super::ssh::{Diagnostics, Pipes, RETRY_AFTER};
use super::topology::{Origin, Saved, ssh_source};
use super::wire::Reader;
use super::{Event, Network, expected, wire};
use crate::SavedConnection;

impl Network {
    /// Starts a saved connection, or resumes one whose background SSH needed interaction.
    /// The returned receiver reports the first attempt. Once saved, retry stays active until
    /// removal or an SSH diagnostic that requires a foreground repair.
    pub(crate) fn start_saved(
        &self,
        config: SavedConnection,
    ) -> oneshot::Receiver<Result<MachineHello, ErrorBody>> {
        let (first, receiver) = oneshot::channel();
        let (stop, stopped) = watch::channel(false);
        let mut state = self.0.state.lock().unwrap();
        if let Some(saved) = state.saved.get(&config.machine_id) {
            if saved.config != config {
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
            if let Some(link) = saved.active.and_then(|id| state.links.get(&id)) {
                let _ = first.send(Ok(link.remote.clone()));
                return receiver;
            }
        }
        let generation = state.number();
        let mut waiters = if let Some(previous) = state.saved.remove(&config.machine_id) {
            previous.stop.send_replace(true);
            previous.waiters
        } else {
            Vec::new()
        };
        waiters.push(first);
        state.saved.insert(
            config.machine_id.clone(),
            Saved {
                config: config.clone(),
                generation,
                stop,
                waiters,
                interaction: None,
                active: None,
            },
        );
        state.publish(&self.0.events, None);
        let network = self.clone();
        tokio::spawn(async move { network.maintain_saved(config, generation, stopped).await });
        receiver
    }

    pub(crate) fn remove_saved(&self, machine_id: &str) -> bool {
        let mut state = self.0.state.lock().unwrap();
        let Some(saved) = state.saved.remove(machine_id) else {
            return false;
        };
        saved.stop.send_replace(true);
        for waiting in saved.waiters {
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
        config: SavedConnection,
        generation: u64,
        mut stopped: watch::Receiver<bool>,
    ) {
        tokio::select! {
            biased;
            _ = stopped.wait_for(|stopped| *stopped) => {},
            () = async {
                loop {
                    let error = self.saved_attempt(&config, generation).await;
                    if !self.saved_failed(&config, generation, error) {
                        return;
                    }
                    tokio::time::sleep(RETRY_AFTER).await;
                }
            } => {},
        }
    }

    async fn saved_attempt(&self, config: &SavedConnection, generation: u64) -> ErrorBody {
        let args = match machine_ssh_args(
            &config.ssh_destination,
            config.remote_home.as_deref(),
            SshMode::Saved,
            self.0.control_dir.as_deref(),
        ) {
            Ok(args) => args,
            Err(error) => return ErrorBody::invalid_argument(error.to_string()),
        };
        let mut command = Command::from(facade_base::programs::command("ssh"));
        // Keep OpenSSH's diagnostics recognizable while retaining their original text.
        command.args(args).env("LC_ALL", "C");
        let Pipes {
            read,
            mut write,
            process,
        } = match Pipes::spawn(command) {
            Ok(pipes) => pipes,
            Err(error) => {
                let reason = if error.kind() == std::io::ErrorKind::NotFound {
                    Reason::NotFound
                } else {
                    Reason::Unavailable
                };
                return ErrorBody::new(reason, format!("Could not start SSH: {error}"));
            }
        };
        let mut read = Reader::new(read);
        let result = async {
            let remote = wire::introduce(&mut read, &mut write, self.local_hello()).await?;
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
            registered.run(read, write, output).await
        }
        .await;
        let error = result
            .err()
            .unwrap_or_else(|| ErrorBody::new(Reason::Unavailable, "The machine session closed."));
        ssh_error(config, process.finish().await, error)
    }

    fn saved_failed(&self, config: &SavedConnection, generation: u64, error: ErrorBody) -> bool {
        let mut state = self.0.state.lock().unwrap();
        let Some(saved) = state
            .saved
            .get_mut(&config.machine_id)
            .filter(|saved| saved.generation == generation)
        else {
            return false;
        };
        for waiting in saved.waiters.drain(..) {
            let _ = waiting.send(Err(error.clone()));
        }
        saved.interaction = error.data.ssh_interaction.clone();
        let retry = saved.interaction.is_none();
        let _ = self.0.events.send(Event::ConnectionFailed {
            config: config.clone(),
            error,
        });
        state.publish(&self.0.events, None);
        retry
    }
}

fn ssh_error(
    config: &SavedConnection,
    diagnostics: Diagnostics,
    mut error: ErrorBody,
) -> ErrorBody {
    if !matches!(
        error.data.reason,
        Reason::Unavailable | Reason::InvalidArgument
    ) {
        return error;
    }
    if diagnostics.needs_interaction() {
        let mut command = vec![
            "facade".to_owned(),
            "machine".to_owned(),
            "add".to_owned(),
            config.ssh_destination.clone(),
        ];
        if let Some(home) = &config.remote_home {
            command.extend(["--home".to_owned(), home.clone()]);
        }
        let mut error = ErrorBody::new(Reason::SshInteractionRequired, "SSH needs interaction.");
        error.data.ssh_interaction = Some(SshInteraction {
            reason: diagnostics.stderr,
            command,
        });
        return error;
    }
    if diagnostics.missing_facade() {
        return ErrorBody::new(
            Reason::NotFound,
            format!(
                "SSH could not find facade on {}. Install Facade there and add its bin directory to the PATH used by non-interactive SSH sessions.\n{}",
                config.ssh_destination, diagnostics.stderr,
            ),
        );
    }
    if !diagnostics.stderr.trim().is_empty() {
        if error.data.reason == Reason::Unavailable
            && diagnostics.status.is_some_and(|status| !status.success())
        {
            error.message = diagnostics.stderr;
        } else {
            error.message.push('\n');
            error.message.push_str(&diagnostics.stderr);
        }
    }
    error
}
