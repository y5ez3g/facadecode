//! Snapshots and incremental changes for the current daemon protocol.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{AgentsUpdate, WatchParams};
use facade_base::jsonrpc::{AgentRemoval, ErrorBody, Reason, decode_arguments};
use facade_base::machine::AgentRef;
use facade_base::operations::{CallParams, Operation, Topic};
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::v3::{
    self, AgentTarget, AgentsChange, AgentsSnapshot, AgentsTopic, AttachBinding, AttachTopic,
    AttachmentInfo, AttachmentKind, Caller, MachinesChange, MachinesTopic, NoArgs, ScreenChange,
    ScreenSize, ScreenSnapshot, ScreenTopic, ScreenWatchArgs, TerminalColors,
};
use serde::Serialize;
use tokio::sync::{broadcast::error::RecvError, mpsc, oneshot};

use crate::agent::{AgentCommand, AgentHandle, ViewerChange, ViewerSizing, viewer_channel};
use crate::network::WatchRoute;
use crate::records::{OperationTarget, Reach};
use crate::server::{Client, Watch, WatchChange};
use crate::service::{
    accepts_disconnected, actor_stopped, check_size, decode_or_default, legacy_machine_error,
    project_legacy_machine_state, terminal_colors, value_of,
};
use crate::store::RemovalCause;
use crate::{Daemon, blocking_in_place};

const SCREEN_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const CHANGES_WAITING: usize = 64;

#[derive(Clone)]
pub(crate) struct ViewerBinding {
    caller: Caller,
    target: ViewerTarget,
}

#[derive(Clone)]
enum ViewerTarget {
    Local {
        agent: AgentHandle,
        sizing: ViewerSizing,
    },
    Remote {
        reference: AgentRef,
        attach: Option<AttachBinding>,
        route: WatchRoute,
        changes: mpsc::Sender<WatchChange>,
        disconnected: bool,
    },
}

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
            ScreenTopic::NAME | AttachTopic::NAME => {
                let sizing = viewer_sizing(topic);
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
                    self.watch_remote_screen(
                        reference,
                        caller,
                        args,
                        viewer,
                        sizing,
                        accepts_disconnected(client),
                    )
                    .await
                } else {
                    self.watch_local_screen(&caller, &reference, args, viewer, sizing)
                        .await
                }
            }
            AgentsTopic::NAME => {
                let NoArgs {} = decode_or_default(args)?;
                self.watch_agent_records(&caller, true)
            }
            MachinesTopic::NAME => {
                let NoArgs {} = decode_or_default(args)?;
                self.watch_machines(accepts_disconnected(client))
            }
            _ => Err(ErrorBody::invalid_argument(format!(
                "unknown topic {topic}"
            ))),
        }
    }

    pub(crate) async fn end_viewer(&self, viewer: u64) {
        let ending = self.watch_ends.lock().unwrap().remove(&viewer);
        if let Some(ViewerBinding {
            target: ViewerTarget::Local { agent, .. },
            ..
        }) = ending
        {
            agent.send(AgentCommand::RemoveViewer { viewer }).await;
        }
    }

    pub(crate) fn attach_binding(&self, viewer: u64) -> Option<AttachBinding> {
        let shared = self
            .watch_ends
            .lock()
            .unwrap()
            .get(&viewer)
            .is_some_and(|watched| {
                matches!(
                    watched.target,
                    ViewerTarget::Local {
                        sizing: ViewerSizing::Shared,
                        ..
                    }
                )
            });
        shared.then(|| AttachBinding {
            viewer,
            boot_id: self.network.local_hello().boot_id,
        })
    }

    fn viewer_target(&self, caller: &Caller, viewer: u64) -> Result<ViewerTarget, ErrorBody> {
        self.watch_ends
            .lock()
            .unwrap()
            .get(&viewer)
            .filter(|watched| &watched.caller == caller)
            .map(|watched| watched.target.clone())
            .ok_or_else(viewer_ended)
    }

    pub(crate) async fn resize_active_viewer(
        &self,
        caller: &Caller,
        viewer: u64,
        size: ScreenSize,
        colors: Option<TerminalColors>,
    ) -> Result<(), ErrorBody> {
        match self.viewer_target(caller, viewer)? {
            ViewerTarget::Local {
                agent,
                sizing: ViewerSizing::Shared,
            } => {
                self.resize_local_viewer(caller, agent, viewer, size, colors)
                    .await
            }
            ViewerTarget::Local { .. } => Err(viewer_ended()),
            ViewerTarget::Remote {
                reference,
                attach,
                route,
                changes,
                disconnected,
            } => {
                check_size(size.cols, size.rows)?;
                let result = if let Some(AttachBinding { viewer, boot_id }) = attach {
                    let params = v3::ForwardAttachResizeArgs {
                        viewer,
                        boot_id,
                        cols: size.cols,
                        rows: size.rows,
                        colors,
                    };
                    route
                        .call(
                            caller.clone(),
                            v3::AttachResize::NAME,
                            value_of(params),
                            SCREEN_SNAPSHOT_TIMEOUT,
                        )
                        .await
                } else {
                    let params = v3::AgentResizeArgs {
                        target: AgentTarget::Reference {
                            reference: reference.clone(),
                        },
                        cols: size.cols,
                        rows: size.rows,
                        colors,
                    };
                    let call = v3::ForwardCall {
                        call: CallParams {
                            op: v3::AgentResize::NAME.to_owned(),
                            args: value_of(params),
                        },
                        by_model: false,
                        from_name: None,
                        recipient: None,
                    };
                    route
                        .call(
                            caller.clone(),
                            "call",
                            value_of(call),
                            SCREEN_SNAPSHOT_TIMEOUT,
                        )
                        .await
                };
                let result = result
                    .map(|_| ())
                    .map_err(|error| self.remote_screen_error(&reference, error));
                if let Err(error) = &result
                    && matches!(error.data.reason, Reason::Unavailable | Reason::NotFound)
                {
                    self.end_viewer(viewer).await;
                    let error = if disconnected {
                        error.clone()
                    } else {
                        legacy_machine_error(error.clone())
                    };
                    let _ = changes.send(WatchChange::Ended(error)).await;
                }
                result
            }
        }
    }

    pub(crate) async fn resize_forwarded_viewer(
        &self,
        caller: &Caller,
        args: v3::ForwardAttachResizeArgs,
    ) -> Result<(), ErrorBody> {
        if args.boot_id != self.network.local_hello().boot_id {
            return Err(viewer_ended());
        }
        let ViewerTarget::Local {
            agent,
            sizing: ViewerSizing::Shared,
        } = self.viewer_target(caller, args.viewer)?
        else {
            return Err(viewer_ended());
        };
        let size = ScreenSize {
            cols: args.cols,
            rows: args.rows,
        };
        self.resize_local_viewer(caller, agent, args.viewer, size, args.colors)
            .await
    }

    async fn resize_local_viewer(
        &self,
        caller: &Caller,
        agent: AgentHandle,
        viewer: u64,
        size: ScreenSize,
        colors: Option<TerminalColors>,
    ) -> Result<(), ErrorBody> {
        self.local_target(caller, &agent.info().reference(), OperationTarget::Type)
            .map_err(|error| match error.data.reason {
                Reason::Ended | Reason::NotFound => viewer_ended(),
                _ => error,
            })?;
        check_size(size.cols, size.rows)?;
        let colors = terminal_colors(caller, colors)?;
        let (reply, received) = oneshot::channel();
        if !agent
            .send(AgentCommand::ResizeViewer {
                viewer,
                size,
                colors,
                reply,
            })
            .await
        {
            return Err(viewer_ended());
        }
        received.await.map_err(|_| viewer_ended())?
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
            ScreenTopic::NAME | AttachTopic::NAME => {
                let sizing = viewer_sizing(&params.topic);
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
                self.watch_local_screen(caller, &reference.clone(), args, viewer, sizing)
                    .await
            }
            _ => Err(ErrorBody::refused(
                "this topic has no forwarded subscription",
            )),
        }
    }

    async fn watch_local_screen(
        self: &Arc<Self>,
        caller: &Caller,
        reference: &AgentRef,
        args: ScreenWatchArgs,
        viewer: u64,
        sizing: ViewerSizing,
    ) -> Result<Watch, ErrorBody> {
        let operation = OperationTarget::Attach {
            allow_ended: args.allow_ended,
        };
        let agent = self.local_target(caller, reference, operation)?;
        self.watch_agent_screen(&agent, caller, args, viewer, sizing)
            .await
            .map_err(|error| self.with_agent_error(&agent, error))
    }

    async fn watch_agent_screen(
        self: &Arc<Self>,
        agent: &AgentHandle,
        caller: &Caller,
        args: ScreenWatchArgs,
        viewer: u64,
        sizing: ViewerSizing,
    ) -> Result<Watch, ErrorBody> {
        if let Some(size) = args.size {
            check_size(size.cols, size.rows)?;
        }
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
            sizing,
            name: args.viewer,
            attachment: kind.map(|kind| AttachmentInfo {
                kind,
                machine_id: caller.machine_id().to_owned(),
            }),
            allow_ended: args.allow_ended,
            report_activity: args.report_activity,
            size: args.size,
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
            exit_status: drawn.exit.as_ref().and_then(shell_exit_status),
            exit: drawn.exit,
            resume_hint: drawn.resume_hint,
            process: Some(if ended {
                ProcessState::Ended
            } else {
                drawn.process
            }),
            working: drawn.working,
        };
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        if ended {
            return Ok(Watch {
                snapshot: value_of(snapshot),
                changes: sent,
            });
        }
        self.watch_ends.lock().unwrap().insert(
            viewer,
            ViewerBinding {
                caller: caller.clone(),
                target: ViewerTarget::Local {
                    agent: agent.clone(),
                    sizing,
                },
            },
        );
        let daemon = self.clone();
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
            daemon.end_viewer(viewer).await;
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
        viewer: u64,
        sizing: ViewerSizing,
        disconnected: bool,
    ) -> Result<Watch, ErrorBody> {
        self.ensure_machine_route(&reference.machine_id).await?;
        let address = self.agent_address(&reference)?;
        args.target = AgentTarget::Reference {
            reference: reference.clone(),
        };
        let shared = sizing == ViewerSizing::Shared
            && self
                .network
                .route_supports(&reference.machine_id, v3::CAP_ATTACH);
        let params = WatchParams {
            topic: if shared {
                AttachTopic::NAME
            } else {
                ScreenTopic::NAME
            }
            .into(),
            args: value_of(args),
        };
        let report_failure = matches!(caller, Caller::Terminal { .. });
        let mut subscription = self
            .network
            .watch(
                &reference.machine_id,
                caller.clone(),
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
        if sizing == ViewerSizing::Shared {
            let attach = if shared {
                Some(subscription.attach.take().ok_or_else(|| {
                    ErrorBody::invalid_argument("the machine did not confirm its Attach viewer")
                })?)
            } else {
                None
            };
            self.watch_ends.lock().unwrap().insert(
                viewer,
                ViewerBinding {
                    caller,
                    target: ViewerTarget::Remote {
                        reference: reference.clone(),
                        attach,
                        route: subscription.route(),
                        changes: changes.clone(),
                        disconnected,
                    },
                },
            );
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
                            let error = if disconnected {
                                error
                            } else {
                                legacy_machine_error(error)
                            };
                            let _ = changes.send(WatchChange::Ended(error)).await;
                            return;
                        }
                        Err(_) => break,
                    }
                }
                let _ = changes.send(WatchChange::Disconnect).await;
            };
            tokio::select! { () = forward => {}, () = changes.closed() => {} }
            daemon.end_viewer(viewer).await;
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

    fn watch_machines(self: &Arc<Self>, disconnected: bool) -> Result<Watch, ErrorBody> {
        let mut following = self.machine_views.subscribe();
        let snapshot = self.watched_machines(disconnected)?;
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
                let Ok(rows) = daemon.watched_machines(disconnected) else {
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

    fn watched_machines(&self, disconnected: bool) -> Result<Vec<v3::MachineInfo>, ErrorBody> {
        let mut rows = self.public_machines()?;
        if !disconnected {
            for machine in &mut rows {
                project_legacy_machine_state(&mut machine.state);
            }
        }
        Ok(rows)
    }
}

fn viewer_sizing(topic: &str) -> ViewerSizing {
    if topic == AttachTopic::NAME {
        ViewerSizing::Shared
    } else {
        ViewerSizing::Legacy
    }
}

fn viewer_ended() -> ErrorBody {
    ErrorBody::new(
        Reason::NotFound,
        "this terminal watch ended; open it again to resize",
    )
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
        ViewerChange::Activity(working) => ScreenChange::Activity { working },
        ViewerChange::Exit(exit, resume_hint) => ScreenChange::Exit {
            exit_status: shell_exit_status(&exit),
            exit,
            resume_hint,
        },
        ViewerChange::Removed => ScreenChange::Removed,
    }
}

fn shell_exit_status(exit: &ProcessExit) -> Option<i32> {
    exit.code.or_else(|| {
        exit.signal
            .as_deref()
            .and_then(facade_base::unix_process::signal_number)
            .map(|number| 128 + number)
    })
}
