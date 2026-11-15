//! Run ownership and the registration boundary. Socket work and exit delivery happen after locks.

use std::collections::{HashMap, HashSet};
use std::os::fd::OwnedFd;
use std::sync::{Arc, Mutex};
use tokio::time::Instant;

use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::{HeldAgent, SyncArgs};
use facade_base::process::{ProcessExit, ProcessIdentity};
use tokio::sync::Notify;

use super::{ExitRecorded, ExitSink, RecordedExit, RunExit};

#[derive(PartialEq, Eq)]
pub(super) enum RunRole {
    Agent,
    Unreadable,
    Cleanup,
}

pub(super) struct Run {
    pub identity: ProcessIdentity,
    pub master: OwnedFd,
    pub exit: Option<ProcessExit>,
    pub stopping: bool,
    pub role: RunRole,
    pub committed: bool,
    pub number: u64,
    pub exits: Option<ExitSink>,
}

struct PendingStart {
    exits: ExitSink,
    number: u64,
    exit: Option<ProcessExit>,
}

#[derive(Default)]
pub(super) struct RunRegistry {
    runs: Mutex<HashMap<String, Run>>,
    pending: Mutex<HashMap<String, PendingStart>>,
    changed: Notify,
}

pub(super) struct Reconciliation {
    pub stops: Vec<String>,
    pub unrecorded: Vec<HeldAgent>,
}

impl RunRegistry {
    pub fn begin(&self, id: &str, number: u64, exits: ExitSink) {
        self.pending.lock().unwrap().insert(
            id.into(),
            PendingStart {
                exits,
                number,
                exit: None,
            },
        );
    }

    pub fn cancel(&self, id: &str) {
        self.pending.lock().unwrap().remove(id);
    }

    pub fn register(&self, id: &str, mut run: Run) {
        {
            let mut runs = self.runs.lock().unwrap();
            if let Some(start) = self.pending.lock().unwrap().remove(id) {
                run.exit = start.exit;
            }
            runs.insert(id.into(), run);
        }
        self.changed.notify_waiters();
    }

    pub fn recovered(&self, id: &str, run: Run) {
        self.runs.lock().unwrap().insert(id.into(), run);
        self.changed.notify_waiters();
    }

    pub fn installed(&self, id: &str) -> Option<ProcessExit> {
        let exit = {
            let mut runs = self.runs.lock().unwrap();
            let run = runs.get_mut(id)?;
            run.committed = true;
            run.exit.clone()
        };
        self.cancel(id);
        self.changed.notify_waiters();
        exit
    }

    pub fn process(&self, id: &str) -> Option<ProcessIdentity> {
        let runs = self.runs.lock().unwrap();
        let run = runs.get(id)?;
        run.exit.is_none().then(|| run.identity.clone())
    }

    pub fn request_stop(&self, id: &str) -> Result<bool, ErrorBody> {
        let running = {
            let mut runs = self.runs.lock().unwrap();
            let run = runs.get_mut(id).ok_or_else(|| {
                ErrorBody::new(
                    Reason::NotFound,
                    format!("agent #{id} has no terminal to stop; nothing was sent"),
                )
            })?;
            let running = run.exit.is_none();
            run.stopping |= running;
            running
        };
        self.changed.notify_waiters();
        Ok(running)
    }

    pub fn exit(&self, id: &str, exit: ProcessExit) -> RecordedExit {
        let (outcome, delivery) = {
            let mut runs = self.runs.lock().unwrap();
            match runs.get_mut(id) {
                Some(run) => {
                    if run.exit.is_some() {
                        return RecordedExit::Repeated;
                    }
                    run.exit = Some(exit.clone());
                    facade_base::service::mark_for_test("recorded-run-exit");
                    let delivery = run.exits.clone().map(|sink| {
                        (
                            sink,
                            RunExit {
                                run: run.number,
                                exit,
                                stopped: run.stopping,
                            },
                        )
                    });
                    let result = if run.role == RunRole::Cleanup {
                        runs.remove(id);
                        RecordedExit::Dropped
                    } else {
                        RecordedExit::Kept(ExitRecorded {
                            known: true,
                            committed: run.committed,
                        })
                    };
                    (result, delivery)
                }
                None => {
                    let mut pending = self.pending.lock().unwrap();
                    let Some(start) = pending.get_mut(id) else {
                        return RecordedExit::Unknown;
                    };
                    if start.exit.is_some() {
                        return RecordedExit::Repeated;
                    }
                    start.exit = Some(exit.clone());
                    facade_base::service::mark_for_test("exit-before-registration");
                    (
                        RecordedExit::Kept(ExitRecorded {
                            known: true,
                            committed: false,
                        }),
                        Some((
                            Arc::clone(&start.exits),
                            RunExit {
                                run: start.number,
                                exit,
                                stopped: false,
                            },
                        )),
                    )
                }
            }
        };
        self.changed.notify_waiters();
        if let Some((sink, event)) = delivery {
            sink(event);
        }
        outcome
    }

    pub fn release(&self, id: &str) -> bool {
        let removed = {
            let mut runs = self.runs.lock().unwrap();
            if runs.get(id).is_some_and(|run| run.exit.is_some()) {
                runs.remove(id);
                true
            } else {
                false
            }
        };
        self.changed.notify_waiters();
        removed
    }

    pub fn abandon(&self, id: &str) -> bool {
        let found = {
            let mut runs = self.runs.lock().unwrap();
            match runs.get_mut(id) {
                Some(run) => {
                    run.role = RunRole::Cleanup;
                    run.exits = None;
                    run.stopping = true;
                    true
                }
                None => false,
            }
        };
        self.cancel(id);
        self.changed.notify_waiters();
        found
    }

    pub fn remove(&self, id: &str) -> bool {
        {
            let mut runs = self.runs.lock().unwrap();
            if let Some(run) = runs.get_mut(id) {
                run.role = RunRole::Cleanup;
            }
        }
        self.release(id)
    }

    pub async fn ended_run_released(&self, id: &str, deadline: Instant) -> bool {
        loop {
            let changed = self.changed.notified();
            {
                let mut runs = self.runs.lock().unwrap();
                match runs.get(id) {
                    None => return true,
                    Some(run) if run.exit.is_some() => {
                        runs.remove(id);
                        drop(runs);
                        self.changed.notify_waiters();
                        return true;
                    }
                    _ => {}
                }
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return false;
            }
        }
    }

    pub fn needs_keeper(&self) -> bool {
        self.runs
            .lock()
            .unwrap()
            .values()
            .any(|run| run.exit.is_none())
    }

    pub fn busy(&self) -> Option<String> {
        let runs = self.runs.lock().unwrap();
        if let Some((id, _)) = runs
            .iter()
            .find(|(_, run)| run.role == RunRole::Unreadable && run.exit.is_some())
        {
            return Some(format!(
                "this build cannot read the record of {id}, so its exit cannot be saved; its \
                 run is kept"
            ));
        }
        if runs.values().any(|run| run.exit.is_none()) {
            return Some("an agent is running".into());
        }
        if runs.values().any(|run| run.exit.is_some()) {
            return Some("an exit is being saved or its terminal output is draining".into());
        }
        None
    }

    pub fn reconcile(
        &self,
        keeper: u32,
        inventory: &[HeldAgent],
    ) -> Result<Reconciliation, ErrorBody> {
        let runs = self.runs.lock().unwrap();
        let mut plan = Reconciliation {
            stops: vec![],
            unrecorded: vec![],
        };
        for held in inventory {
            if let Some(run) = runs.get(&held.id) {
                if run.identity
                    != (ProcessIdentity {
                        pid: held.pid,
                        birth: held.birth.clone(),
                    })
                {
                    return Err(ErrorBody::new(
                        Reason::Internal,
                        format!("keeper {keeper} holds {} for another process", held.id),
                    ));
                }
                if run.stopping && !held.stopping {
                    plan.stops.push(held.id.clone());
                }
            } else {
                plan.unrecorded.push(held.clone());
            }
        }
        Ok(plan)
    }

    pub fn missing(
        &self,
        inventory: &[HeldAgent],
    ) -> Result<Vec<(SyncArgs, OwnedFd, bool)>, ErrorBody> {
        let runs = self.runs.lock().unwrap();
        let mut terminals = Vec::new();
        let present: HashSet<_> = inventory.iter().map(|held| held.id.as_str()).collect();
        for (id, run) in runs.iter() {
            if run.exit.is_some() || present.contains(id.as_str()) {
                continue;
            }
            let fd = run.master.try_clone().map_err(|error| {
                ErrorBody::new(
                    Reason::Unavailable,
                    format!("could not copy the terminal of {id}: {error}"),
                )
            })?;
            terminals.push((
                SyncArgs {
                    agent: id.clone(),
                    pid: run.identity.pid,
                    birth: run.identity.birth.clone(),
                },
                fd,
                run.stopping,
            ));
        }
        Ok(terminals)
    }
}
