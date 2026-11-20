//! Snapshots and incremental changes for the current daemon protocol.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{AgentsUpdate, WatchParams};
use facade_base::jsonrpc::{AgentRemoval, ErrorBody, Reason, decode_arguments};
use facade_base::machine::AgentRef;
use facade_base::operations::Topic;
use facade_base::process::ProcessState;
use facade_base::v3::{
    AgentTarget, AgentsChange, AgentsSnapshot, AgentsTopic, AttachmentInfo, AttachmentKind, Caller,
    MachinesChange, MachinesTopic, NoArgs, ScreenChange, ScreenSnapshot, ScreenTopic,
    ScreenWatchArgs,
};
use serde::Serialize;
use tokio::sync::{broadcast::error::RecvError, mpsc, oneshot};

use crate::agent::{AgentCommand, AgentHandle, ViewerChange, viewer_channel};
use crate::records::{OperationTarget, Reach};
use crate::server::{Client, Watch, WatchChange};
use crate::service::{actor_stopped, decode_or_default, value_of};
use crate::store::RemovalCause;
use crate::{Daemon, blocking_in_place};

const SCREEN_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const CHANGES_WAITING: usize = 64;

impl Daemon {
    pub(crate) async fn start_watch(
        self: &Arc<Self>,
        client: &Client,
        topic: &str,
        args: serde_json::Value,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        let caller = self.local_caller(client)?;
        match topic {
            ScreenTopic::NAME => {
                let args: ScreenWatchArgs = decode_arguments(args)?;
                if args.allow_ended && !matches!(args.target, AgentTarget::Reference { .. }) {
                    return Err(ErrorBody::invalid_argument(
                        "an ended screen needs an exact agent reference",
                    ));
                }
                let operation = OperationTarget::Attach {
                    allow_ended: args.allow_ended,
                };
                let reference = self
                    .addressed_agent(&caller, args.target.clone(), operation)
                    .await?;
                if reference.machine_id != self.machine_id {
                    self.watch_remote_screen(reference, caller, args).await
                } else {
                    self.watch_local_screen(&caller, &reference, args, viewer)
                        .await
                }
            }
            AgentsTopic::NAME => {
                let NoArgs {} = decode_or_default(args)?;
                self.watch_agent_records(&caller, true)
            }
            MachinesTopic::NAME => {
                let NoArgs {} = decode_or_default(args)?;
                self.watch_machines()
            }
            _ => Err(ErrorBody::invalid_argument(format!(
                "unknown topic {topic}"
            ))),
        }
    }

    pub(crate) async fn end_viewer(&self, viewer: u64) {
        let ending = self.watch_ends.lock().unwrap().remove(&viewer);
        if let Some(agent) = ending {
            agent.send(AgentCommand::RemoveViewer { viewer }).await;
        }
    }

    pub(crate) async fn start_forwarded_watch(
        self: &Arc<Self>,
        caller: &Caller,
        params: WatchParams,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        match params.topic.as_str() {
            AgentsTopic::NAME if matches!(caller, Caller::Terminal { .. }) => {
                let NoArgs {} = decode_or_default(params.args)?;
                self.watch_agent_records(caller, false)
            }
            ScreenTopic::NAME => {
                let args: ScreenWatchArgs = decode_arguments(params.args)?;
                let AgentTarget::Reference { reference } = &args.target else {
                    return Err(ErrorBody::invalid_argument(
                        "an attached machine needs an exact agent reference",
                    ));
                };
                if reference.machine_id != self.machine_id {
                    return Err(ErrorBody::invalid_argument(
                        "the terminal belongs to another machine",
                    ));
                }
                self.watch_local_screen(caller, &reference.clone(), args, viewer)
                    .await
            }
            _ => Err(ErrorBody::refused(
                "this topic has no forwarded subscription",
            )),
        }
    }

    async fn watch_local_screen(
        &self,
        caller: &Caller,
        reference: &AgentRef,
        args: ScreenWatchArgs,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        let operation = OperationTarget::Attach {
            allow_ended: args.allow_ended,
        };
        let agent = self.local_target(caller, reference, operation)?;
        self.watch_agent_screen(&agent, caller, args, viewer)
            .await
            .map_err(|error| self.with_agent_error(&agent, error))
    }

    async fn watch_agent_screen(
        &self,
        agent: &AgentHandle,
        caller: &Caller,
        args: ScreenWatchArgs,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        let reference = agent.info().reference();
        let address = self.agent_address(&reference)?;
        let (tx, mut feed) = viewer_channel();
        let stalled = feed.stalled();
        let (reply, drawn) = oneshot::channel();
        let kind = match caller {
            Caller::Terminal { .. } => Some(AttachmentKind::Shell),
            Caller::Ide { .. } => Some(AttachmentKind::VsCode),
            Caller::Agent { .. } => None,
        };
        let added = AgentCommand::AttachViewer {
            viewer,
            name: args.viewer,
            attachment: kind.map(|kind| AttachmentInfo {
                kind,
                machine_id: caller.machine_id().to_owned(),
            }),
            tx,
            keep_scrollback: args.keep_scrollback,
            include_scrollback: args.include_scrollback,
            reply,
        };
        if !agent.send(added).await {
            return Err(actor_stopped(agent));
        }
        let drawn = match tokio::time::timeout(SCREEN_SNAPSHOT_TIMEOUT, drawn).await {
            Ok(Ok(drawn)) => drawn,
            other => {
                agent.send(AgentCommand::RemoveViewer { viewer }).await;
                return Err(match other {
                    Ok(Err(_)) => actor_stopped(agent),
                    _ => ErrorBody::new(
                        Reason::Unavailable,
                        format!("{address} did not draw its screen"),
                    ),
                });
            }
        };
        let ended = drawn.process == ProcessState::Ended || drawn.exit.is_some();
        if ended && !args.allow_ended {
            return Err(ErrorBody::new(
                Reason::Ended,
                format!("{address} has already stopped"),
            ));
        }
        let snapshot = ScreenSnapshot {
            agent_id: reference.agent_id,
            machine_id: reference.machine_id,
            address,
            name: Some(drawn.name),
            cols: drawn.cols,
            rows: drawn.rows,
            redraw: facade_base::base64::encode(&drawn.redraw),
            exit: drawn.exit,
            process: Some(if ended {
                ProcessState::Ended
            } else {
                drawn.process
            }),
        };
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        if ended {
            return Ok(Watch {
                snapshot: value_of(snapshot),
                changes: sent,
            });
        }
        self.watch_ends
            .lock()
            .unwrap()
            .insert(viewer, agent.clone());
        let agent = agent.clone();
        tokio::spawn(async move {
            let forward = async {
                while let Some(change) = feed.recv().await {
                    let update = screen_change(change);
                    let removed = update == ScreenChange::Removed;
                    if !send(&changes, &update).await || removed {
                        return;
                    }
                }
            };
            tokio::select! {
                () = forward => {}
                () = changes.closed() => {}
                _ = stalled => { let _ = changes.send(WatchChange::Disconnect).await; }
            }
            agent.send(AgentCommand::RemoveViewer { viewer }).await;
        });
        Ok(Watch {
            snapshot: value_of(snapshot),
            changes: sent,
        })
    }

    async fn watch_remote_screen(
        self: &Arc<Self>,
        reference: AgentRef,
        caller: Caller,
        mut args: ScreenWatchArgs,
    ) -> Result<Watch, ErrorBody> {
        self.ensure_machine_route(&reference.machine_id).await?;
        let address = self.agent_address(&reference)?;
        args.target = AgentTarget::Reference {
            reference: reference.clone(),
        };
        let params = WatchParams {
            topic: ScreenTopic::NAME.into(),
            args: value_of(args),
        };
        let report_failure = matches!(caller, Caller::Terminal { .. });
        let mut subscription = self
            .network
            .watch(
                &reference.machine_id,
                caller,
                params,
                Some(SCREEN_SNAPSHOT_TIMEOUT),
            )
            .await
            .map_err(|error| self.remote_screen_error(&reference, error))?;
        let mut snapshot: ScreenSnapshot =
            decode_arguments(std::mem::take(&mut subscription.snapshot))?;
        if snapshot.reference() != reference {
            return Err(ErrorBody::refused(
                "the machine opened a different terminal",
            ));
        }
        snapshot.address = address;
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        if snapshot.process == Some(ProcessState::Ended) || snapshot.exit.is_some() {
            return Ok(Watch {
                snapshot: value_of(snapshot),
                changes: sent,
            });
        }
        let daemon = self.clone();
        tokio::spawn(async move {
            let forward = async {
                while let Some(change) = subscription.next().await {
                    match change {
                        Ok(value) => {
                            if changes.send(WatchChange::Change(value)).await.is_err() {
                                return;
                            }
                        }
                        Err(error) if report_failure => {
                            let error = daemon.remote_screen_error(&reference, error);
                            let _ = changes.send(WatchChange::Ended(error)).await;
                            return;
                        }
                        Err(_) => break,
                    }
                }
                let _ = changes.send(WatchChange::Disconnect).await;
            };
            tokio::select! { () = forward => {}, () = changes.closed() => {} }
        });
        Ok(Watch {
            snapshot: value_of(snapshot),
            changes: sent,
        })
    }

    fn remote_screen_error(&self, reference: &AgentRef, error: ErrorBody) -> ErrorBody {
        let error = self.project_remote_error(error);
        if error.data.unavailable.is_some() || error.data.ssh_interaction.is_some() {
            self.machine_failure(&reference.machine_id, error)
        } else {
            error
        }
    }

    fn watch_agent_records(
        self: &Arc<Self>,
        caller: &Caller,
        include_remote: bool,
    ) -> Result<Watch, ErrorBody> {
        let mut local = self.changes.subscribe();
        let mut remote = (include_remote && !matches!(caller, Caller::Agent { yolo: false, .. }))
            .then(|| self.remote_changes.subscribe());
        let reach = Reach::from(caller);
        let agents = self
            .agent_infos()
            .into_iter()
            .filter(|agent| reach.reaches(agent))
            .map(|agent| self.public_agent(agent))
            .collect::<Result<Vec<_>, _>>()?;
        let mut listed = agents
            .iter()
            .map(|agent| agent.agent_id.clone())
            .collect::<HashSet<_>>();
        let machines = if remote.is_some() {
            self.remote_agent_states()
        } else {
            Vec::new()
        };
        let snapshot = AgentsSnapshot { agents, machines };
        let daemon = self.clone();
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    update = local.recv() => {
                        let update = match update {
                            Ok(AgentsUpdate::Updated { agent }) if reach.reaches(&agent) => {
                                let Ok(agent) = daemon.public_agent(*agent) else {
                                    let _ = changes.send(WatchChange::Disconnect).await;
                                    return;
                                };
                                listed.insert(agent.agent_id.clone());
                                AgentsChange::Updated { agent: Box::new(agent) }
                            }
                            Ok(AgentsUpdate::Removed { machine_id, agent_id }) if listed.remove(&agent_id) => {
                                let cause = blocking_in_place(|| daemon.store.removal_cause(&agent_id));
                                let cause = match cause {
                                    Ok(Some(RemovalCause::Expired)) => AgentRemoval::Expired,
                                    Ok(Some(RemovalCause::Removed)) | Ok(None) => AgentRemoval::Removed,
                                    Err(_) => {
                                        let _ = changes.send(WatchChange::Disconnect).await;
                                        return;
                                    }
                                };
                                AgentsChange::Removed { machine_id, agent_id, cause }
                            }
                            Ok(_) => continue,
                            Err(RecvError::Lagged(_)) => {
                                let _ = changes.send(WatchChange::Disconnect).await;
                                return;
                            }
                            Err(RecvError::Closed) => return,
                        };
                        if !send(&changes, &update).await { return; }
                    }
                    update = remote_update(&mut remote) => {
                        match update {
                            Ok(update) => {
                                if !send(&changes, &update).await { return; }
                            }
                            Err(_) => {
                                let _ = changes.send(WatchChange::Disconnect).await;
                                return;
                            }
                        }
                    }
                    () = changes.closed() => return,
                }
            }
        });
        Ok(Watch {
            snapshot: value_of(snapshot),
            changes: sent,
        })
    }

    fn watch_machines(self: &Arc<Self>) -> Result<Watch, ErrorBody> {
        let mut following = self.machine_views.subscribe();
        let snapshot = self.public_machines()?;
        let mut known: BTreeMap<_, _> = snapshot
            .iter()
            .map(|row| (row.machine_id.clone(), row.clone()))
            .collect();
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        let daemon = self.clone();
        tokio::spawn(async move {
            loop {
                let next = tokio::select! {
                    next = following.recv() => next,
                    () = changes.closed() => return,
                };
                if matches!(next, Err(RecvError::Closed)) {
                    return;
                }
                let Ok(rows) = daemon.public_machines() else {
                    let _ = changes.send(WatchChange::Disconnect).await;
                    return;
                };
                let current: BTreeMap<_, _> = rows
                    .into_iter()
                    .map(|row| (row.machine_id.clone(), row))
                    .collect();
                for (id, machine) in &current {
                    if known.get(id) != Some(machine)
                        && !send(
                            &changes,
                            &MachinesChange::Updated {
                                machine: machine.clone(),
                            },
                        )
                        .await
                    {
                        return;
                    }
                }
                for id in known.keys().filter(|id| !current.contains_key(*id)) {
                    if !send(
                        &changes,
                        &MachinesChange::Removed {
                            machine_id: id.clone(),
                        },
                    )
                    .await
                    {
                        return;
                    }
                }
                known = current;
            }
        });
        Ok(Watch {
            snapshot: value_of(snapshot),
            changes: sent,
        })
    }
}

async fn remote_update(
    remote: &mut Option<tokio::sync::broadcast::Receiver<AgentsChange>>,
) -> Result<AgentsChange, RecvError> {
    match remote {
        Some(remote) => remote.recv().await,
        None => std::future::pending().await,
    }
}

async fn send(changes: &mpsc::Sender<WatchChange>, change: &impl Serialize) -> bool {
    changes
        .send(WatchChange::Change(value_of(change)))
        .await
        .is_ok()
}

fn screen_change(change: ViewerChange) -> ScreenChange {
    match change {
        ViewerChange::Redraw { bytes, cols, rows } => ScreenChange::Redraw {
            data: facade_base::base64::encode(&bytes),
            cols,
            rows,
        },
        ViewerChange::Output(bytes) => ScreenChange::Output {
            data: facade_base::base64::encode(&bytes),
        },
        ViewerChange::Exit(exit) => ScreenChange::Exit { exit },
        ViewerChange::Removed => ScreenChange::Removed,
    }
}
