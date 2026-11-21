//! Snapshots and incremental changes for the current daemon protocol.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use facade_base::api_v1::daemon::{AgentsChange, AgentsSnapshot};
use facade_base::api_v1::{
    Size, Topic,
    daemon::{self as wire, AttachmentInfo, AttachmentKind, Caller},
};
use facade_base::model::agent::AgentRef;
use facade_base::model::agent::AgentsUpdate;
use facade_base::process::{ProcessExit, ProcessState};
use facade_base::{
    jsonrpc::decode_arguments,
    model::error::{AgentRemoval, ErrorBody, Reason},
};
use serde_json::{Value, json};
use tokio::sync::{broadcast::error::RecvError, mpsc, oneshot};

use crate::agent::{AgentCommand, AgentHandle, ViewerChange, viewer_channel};
use crate::api;
use crate::network::WatchRoute;
use crate::records::{OperationTarget, Reach};
use crate::server::{Watch, WatchChange};
use crate::service::{actor_stopped, check_size, terminal_colors, value_of};
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
    Local(AgentHandle),
    Remote {
        reference: AgentRef,
        attach: wire::AttachBinding,
        route: WatchRoute,
        changes: mpsc::Sender<WatchChange>,
    },
}

impl Daemon {
    pub(crate) async fn start_watch(
        self: &Arc<Self>,
        caller: &Caller,
        topic: wire::DaemonWatch,
        viewer: u64,
        forwarded: bool,
    ) -> Result<Watch, ErrorBody> {
        match topic {
            wire::DaemonWatch::Attach(args) => {
                crate::network_operations::require_person(caller)?;
                if args.allow_ended && !matches!(args.target, wire::AgentTarget::Reference(_)) {
                    return Err(ErrorBody::invalid_argument(
                        "an ended screen needs an exact agent reference",
                    ));
                }
                let reference = if forwarded {
                    match &args.target {
                        wire::AgentTarget::Reference(reference)
                            if reference.machine_id == self.machine_id =>
                        {
                            api::agent_ref(reference.clone())
                        }
                        _ => {
                            return Err(ErrorBody::invalid_argument(
                                "a forwarded Attach needs the exact local reference",
                            ));
                        }
                    }
                } else {
                    let operation = OperationTarget::Attach {
                        allow_ended: args.allow_ended,
                    };
                    self.addressed_agent(caller, args.target.clone(), operation)
                        .await?
                };
                if reference.machine_id != self.machine_id {
                    self.watch_remote_screen(reference, caller.clone(), args, viewer)
                        .await
                } else {
                    self.watch_local_screen(caller, &reference, args, viewer)
                        .await
                }
            }
            wire::DaemonWatch::Agents(_)
                if !forwarded || matches!(caller, Caller::Terminal { .. }) =>
            {
                self.watch_agent_records(caller, !forwarded)
            }
            wire::DaemonWatch::Machines(_) if !forwarded => self.watch_machines(matches!(
                caller,
                Caller::Terminal { .. } | Caller::Ide { .. }
            )),
            _ => Err(ErrorBody::refused(
                "this topic has no forwarded subscription",
            )),
        }
    }
    pub(crate) async fn end_viewer(&self, viewer: u64) {
        let ending = self.watch_ends.lock().unwrap().remove(&viewer);
        if let Some(ViewerBinding {
            target: ViewerTarget::Local(agent),
            ..
        }) = ending
        {
            agent.send(AgentCommand::RemoveViewer { viewer }).await;
        }
    }

    pub(crate) fn attach_binding(&self, viewer: u64) -> Option<wire::AttachBinding> {
        let local = self
            .watch_ends
            .lock()
            .unwrap()
            .get(&viewer)
            .is_some_and(|watched| matches!(watched.target, ViewerTarget::Local(_)));
        local.then(|| wire::AttachBinding {
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
        size: Size,
        colors: Option<wire::TerminalColors>,
    ) -> Result<(), ErrorBody> {
        match self.viewer_target(caller, viewer)? {
            ViewerTarget::Local(agent) => {
                self.resize_local_viewer(caller, agent, viewer, size, colors)
                    .await
            }
            ViewerTarget::Remote {
                reference,
                attach,
                route,
                changes,
            } => {
                check_size(size.cols, size.rows)?;
                let result = route
                    .resize(
                        caller,
                        wire::InternalAttachResizeArgs {
                            viewer: attach.viewer,
                            boot_id: attach.boot_id,
                            size,
                            colors,
                        },
                        SCREEN_SNAPSHOT_TIMEOUT,
                    )
                    .await
                    .map_err(|error| {
                        self.remote_screen_error(&reference, api::received_error(error))
                    });
                if let Err(error) = &result
                    && matches!(error.data.reason, Reason::Unavailable | Reason::NotFound)
                {
                    self.end_viewer(viewer).await;
                    let _ = changes
                        .send(WatchChange::Ended(api::project_error(error.clone())))
                        .await;
                }
                result
            }
        }
    }

    pub(crate) async fn resize_forwarded_viewer(
        &self,
        caller: &Caller,
        args: wire::InternalAttachResizeArgs,
    ) -> Result<(), ErrorBody> {
        if args.boot_id != self.network.local_hello().boot_id {
            return Err(viewer_ended());
        }
        let ViewerTarget::Local(agent) = self.viewer_target(caller, args.viewer)? else {
            return Err(viewer_ended());
        };
        self.resize_local_viewer(caller, agent, args.viewer, args.size, args.colors)
            .await
    }
    async fn resize_local_viewer(
        &self,
        caller: &Caller,
        agent: AgentHandle,
        viewer: u64,
        size: Size,
        colors: Option<wire::TerminalColors>,
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

    async fn watch_local_screen(
        self: &Arc<Self>,
        caller: &Caller,
        reference: &AgentRef,
        args: wire::AttachArgs,
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
        self: &Arc<Self>,
        agent: &AgentHandle,
        caller: &Caller,
        args: wire::AttachArgs,
        viewer: u64,
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
        let snapshot = wire::ScreenSnapshot {
            reference: api::wire_ref(&reference),
            address,
            name: Some(drawn.name),
            size: Size {
                cols: drawn.cols,
                rows: drawn.rows,
            },
            redraw: facade_base::base64::encode(&drawn.redraw),
            exit_status: drawn.exit.as_ref().and_then(shell_exit_status),
            exit: drawn.exit,
            resume_hint: drawn.resume_hint,
            process: Some(if ended {
                wire::ProcessState::Ended
            } else {
                drawn.process.into()
            }),
            working: drawn.working,
        };
        let snapshot = value_of(snapshot);
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        if ended {
            return Ok(Watch {
                snapshot,
                changes: sent,
            });
        }
        self.watch_ends.lock().unwrap().insert(
            viewer,
            ViewerBinding {
                caller: caller.clone(),
                target: ViewerTarget::Local(agent.clone()),
            },
        );
        let daemon = self.clone();
        tokio::spawn(async move {
            let forward = async {
                while let Some(change) = feed.recv().await {
                    let update = screen_change(change);
                    let removed = update == wire::ScreenChange::Removed;
                    if !send(&changes, value_of(update)).await || removed {
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
            snapshot,
            changes: sent,
        })
    }

    async fn watch_remote_screen(
        self: &Arc<Self>,
        reference: AgentRef,
        caller: Caller,
        args: wire::AttachArgs,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        self.ensure_machine_route(&reference.machine_id, &caller)
            .await?;
        let address = self.agent_address(&reference)?;
        let request = wire::ForwardParams {
            route: Vec::new(),
            caller: caller.clone(),
            request: wire::ForwardRequest::Watch(wire::WatchParams {
                topic: wire::AttachTopic::NAME.into(),
                args: value_of(wire::AttachArgs {
                    target: wire::AgentTarget::Reference(api::wire_ref(&reference)),
                    size: args.size,
                    viewer: args.viewer,
                    keep_scrollback: args.keep_scrollback,
                    include_scrollback: args.include_scrollback,
                    allow_ended: args.allow_ended,
                    report_activity: args.report_activity,
                }),
            }),
            time_left_ms: None,
            from_name: None,
            start_result: None,
        };
        let mut subscription = self
            .network
            .watch_with_receipt(
                &reference.machine_id,
                request,
                Some(tokio::time::Instant::now() + SCREEN_SNAPSHOT_TIMEOUT),
            )
            .await
            .map_err(|error| {
                self.remote_screen_error(&reference, api::received_error(error.into()))
            })?;
        let mut snapshot: wire::ScreenSnapshot =
            decode_arguments(std::mem::take(&mut subscription.snapshot))?;
        if snapshot.reference.machine_id != reference.machine_id
            || snapshot.reference.agent_id != reference.agent_id
        {
            return Err(ErrorBody::refused(
                "the machine opened a different terminal",
            ));
        }
        snapshot.address = address;
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        if snapshot.process == Some(wire::ProcessState::Ended) || snapshot.exit.is_some() {
            return Ok(Watch {
                snapshot: value_of(snapshot),
                changes: sent,
            });
        }
        let attach = subscription.view.take().ok_or_else(|| {
            ErrorBody::invalid_argument("the machine did not confirm its Attach viewer")
        })?;
        self.watch_ends.lock().unwrap().insert(
            viewer,
            ViewerBinding {
                caller,
                target: ViewerTarget::Remote {
                    reference: reference.clone(),
                    attach,
                    route: subscription.route(),
                    changes: changes.clone(),
                },
            },
        );
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
                        Err(error) => {
                            let error =
                                daemon.remote_screen_error(&reference, api::received_error(error));
                            let _ = changes
                                .send(WatchChange::Ended(api::project_error(error)))
                                .await;
                            return;
                        }
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
            .map(|agent| agent.reference.agent_id.clone())
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
                                listed.insert(agent.reference.agent_id.clone());
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
                        if !send(&changes, value_of(update)).await { return; }
                    }
                    update = remote_update(&mut remote) => {
                        match update {
                            Ok(update) => {
                                if !send(&changes, value_of(update)).await { return; }
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

    fn watch_machines(self: &Arc<Self>, disclose_ssh: bool) -> Result<Watch, ErrorBody> {
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
                            json!({ "kind": "updated", "machine": api::project_machine(machine.clone(), disclose_ssh) }),
                        )
                        .await
                    {
                        return;
                    }
                }
                for id in known.keys().filter(|id| !current.contains_key(*id)) {
                    if !send(&changes, json!({ "kind": "removed", "machine_id": id })).await {
                        return;
                    }
                }
                known = current;
            }
        });
        Ok(Watch {
            snapshot: value_of(
                snapshot
                    .into_iter()
                    .map(|machine| api::project_machine(machine, disclose_ssh))
                    .collect::<Vec<_>>(),
            ),
            changes: sent,
        })
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

async fn send(changes: &mpsc::Sender<WatchChange>, change: Value) -> bool {
    changes.send(WatchChange::Change(change)).await.is_ok()
}

fn screen_change(change: ViewerChange) -> wire::ScreenChange {
    match change {
        ViewerChange::Redraw { bytes, cols, rows } => wire::ScreenChange::Redraw {
            data: facade_base::base64::encode(&bytes),
            size: Size { cols, rows },
        },
        ViewerChange::Output(bytes) => wire::ScreenChange::Output {
            data: facade_base::base64::encode(&bytes),
        },
        ViewerChange::Activity(working) => wire::ScreenChange::Activity { working },
        ViewerChange::Exit(exit, resume_hint) => wire::ScreenChange::Exit {
            exit_status: shell_exit_status(&exit),
            exit,
            resume_hint,
        },
        ViewerChange::Removed => wire::ScreenChange::Removed,
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
