//! Run ownership and the registration boundary. Socket work and exit delivery happen after locks.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::api_v1::keeper::{HeldAgent, SyncArgs};
use facade_base::model::agent::AgentRef;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::process::{ProcessExit, ProcessIdentity};
use facade_base::terminal::PtyMaster;
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::runs::credential_digest;

use super::{
    ExitRecorded, ExitSink, RecordedExit, RunCredentialRecord, RunExit, RunIdentity, StopAccepted,
};

#[derive(PartialEq, Eq)]
pub(super) enum RunRole {
    Agent,
    Unreadable,
    Cleanup,
}

pub(super) enum StopState {
    None,
    Requested,
    Confirmed(Option<AgentRef>),
}

impl StopState {
    pub fn from_holder(stopping: bool) -> Self {
        if stopping {
            Self::Confirmed(None)
        } else {
            Self::None
        }
    }
}

pub(super) struct Run {
    pub identity: ProcessIdentity,
    pub master: PtyMaster,
    pub exit: Option<ProcessExit>,
    pub stop: StopState,
    pub role: RunRole,
    pub committed: bool,
    /// The daemon has committed the record and installed the agent's terminal.
    pub installed: bool,
    pub number: u64,
    pub exits: Option<ExitSink>,
    pub credential_digest: Option<[u8; 32]>,
}

struct PendingStart {
    exits: ExitSink,
    number: u64,
    exit: Option<ProcessExit>,
    credential_digest: Option<[u8; 32]>,
}

enum CredentialState {
    Pending,
    Installed(RunIdentity),
    Ended,
}

#[derive(Default)]
pub(super) struct RunRegistry {
    runs: Mutex<HashMap<String, Run>>,
    pending: Mutex<HashMap<String, PendingStart>>,
    changed: Notify,
}

pub(super) struct Reconciliation {
    pub stops: Vec<StopAccepted>,
    pub unrecorded: Vec<HeldAgent>,
}

impl RunRegistry {
    pub fn begin(
        &self,
        id: &str,
        number: u64,
        exits: ExitSink,
        credential_digest: Option<[u8; 32]>,
    ) {
        self.pending.lock().unwrap().insert(
            id.into(),
            PendingStart {
                exits,
                number,
                exit: None,
                credential_digest,
            },
        );
    }

    pub fn cancel(&self, id: &str) {
        if self.pending.lock().unwrap().remove(id).is_some() {
            self.changed.notify_waiters();
        }
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

    pub fn installed(&self, id: &str, number: Option<u64>) -> Option<ProcessExit> {
        let exit = {
            let mut runs = self.runs.lock().unwrap();
            let run = runs.get_mut(id)?;
            if number.is_some_and(|number| run.number != number) {
                return None;
            }
            run.committed = true;
            run.installed = true;
            run.exit.clone()
        };
        self.cancel(id);
        self.changed.notify_waiters();
        exit
    }

    pub async fn verify_credential(
        &self,
        credential: &str,
        timeout: Duration,
    ) -> Result<Option<RunIdentity>, ErrorBody> {
        let digest = credential_digest(credential);
        let deadline = Instant::now() + timeout;
        let mut waited_for_run = false;
        loop {
            let changed = self.changed.notified();
            match self.credential_state(&digest) {
                Some(CredentialState::Installed(identity)) => return Ok(Some(identity)),
                Some(CredentialState::Pending) => waited_for_run = true,
                None if !waited_for_run => return Ok(None),
                None | Some(CredentialState::Ended) => {
                    return Err(ErrorBody::new(
                        Reason::Unavailable,
                        "the run for this relay credential is no longer available",
                    ));
                }
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return Err(ErrorBody::new(
                    Reason::Unavailable,
                    "the run for this relay credential is still starting; try again",
                ));
            }
        }
    }

    fn credential_state(&self, digest: &[u8; 32]) -> Option<CredentialState> {
        let runs = self.runs.lock().unwrap();
        if let Some((id, run)) = runs
            .iter()
            .find(|(_, run)| run.credential_digest.as_ref() == Some(digest))
        {
            let state = if run.exit.is_some() || run.role != RunRole::Agent {
                CredentialState::Ended
            } else if run.installed {
                CredentialState::Installed(RunIdentity {
                    agent_id: id.clone(),
                    pid: run.identity.pid,
                    run: run.number,
                })
            } else {
                CredentialState::Pending
            };
            return Some(state);
        }
        let pending = self.pending.lock().unwrap();
        pending
            .values()
            .find(|start| start.credential_digest.as_ref() == Some(digest))
            .map(|start| {
                if start.exit.is_some() {
                    CredentialState::Ended
                } else {
                    CredentialState::Pending
                }
            })
    }

    pub fn restore_credential(
        &self,
        held: &HeldAgent,
        number: u64,
        credential: RunCredentialRecord,
    ) -> bool {
        if credential.process.pid != held.pid || credential.process.birth != held.birth {
            return false;
        }
        let mut runs = self.runs.lock().unwrap();
        let Some(run) = runs.get_mut(&held.agent_id).filter(|run| {
            run.role == RunRole::Agent
                && run.installed
                && run.exit.is_none()
                && run.identity == credential.process
                && run.number == number
        }) else {
            return false;
        };
        run.credential_digest = Some(credential.digest);
        true
    }

    pub fn process(&self, id: &str) -> Option<ProcessIdentity> {
        let runs = self.runs.lock().unwrap();
        let run = runs.get(id)?;
        run.exit.is_none().then(|| run.identity.clone())
    }

    pub fn request_stop(&self, id: &str, number: u64) -> Result<Option<bool>, ErrorBody> {
        let was_stopping = {
            let mut runs = self.runs.lock().unwrap();
            let run = runs.get_mut(id).ok_or_else(|| {
                ErrorBody::new(
                    Reason::NotFound,
                    format!("agent #{id} has no terminal to stop; nothing was sent"),
                )
            })?;
            if run.exit.is_some() || run.number != number {
                return Ok(None);
            }
            run.master.let_go_before_stop();
            let was_stopping = !matches!(run.stop, StopState::None);
            if !was_stopping {
                run.stop = StopState::Requested;
            }
            was_stopping
        };
        self.changed.notify_waiters();
        Ok(Some(was_stopping))
    }

    pub fn stop_refused(&self, id: &str, number: u64) {
        if let Some(run) = self.runs.lock().unwrap().get_mut(id)
            && run.number == number
            && matches!(run.stop, StopState::Requested)
        {
            run.stop = StopState::None;
        }
    }

    pub fn confirm_stop(&self, stop: StopAccepted) {
        if let Some(run) = self.runs.lock().unwrap().get_mut(&stop.id)
            && run.number == stop.run
            && run.exit.is_none()
            && !matches!(run.stop, StopState::Confirmed(_))
        {
            run.stop = StopState::Confirmed(stop.caller);
        }
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
                        let (stopped, stopped_by) = match &mut run.stop {
                            StopState::Confirmed(caller) => (true, caller.take()),
                            _ => (false, None),
                        };
                        (
                            sink,
                            RunExit {
                                run: run.number,
                                exit,
                                stopped,
                                stopped_by,
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
                                stopped_by: None,
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
                    run.stop = StopState::Requested;
                    run.master.let_go_before_stop();
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
        let mut runs = self.runs.lock().unwrap();
        let mut plan = Reconciliation {
            stops: vec![],
            unrecorded: vec![],
        };
        for held in inventory {
            if let Some(run) = runs.get_mut(&held.agent_id) {
                if run.identity
                    != (ProcessIdentity {
                        pid: held.pid,
                        birth: held.birth.clone(),
                    })
                {
                    return Err(ErrorBody::new(
                        Reason::Internal,
                        format!(
                            "keeper {keeper} holds {} for another process",
                            held.agent_id
                        ),
                    ));
                }
                if held.stopping {
                    if !matches!(run.stop, StopState::Confirmed(_)) {
                        run.stop = StopState::Confirmed(None);
                    }
                } else if !matches!(run.stop, StopState::None) {
                    plan.stops.push(StopAccepted {
                        id: held.agent_id.clone(),
                        run: run.number,
                        caller: None,
                    });
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
    ) -> Result<Vec<(SyncArgs, PtyMaster, Option<StopAccepted>)>, ErrorBody> {
        let runs = self.runs.lock().unwrap();
        let mut terminals = Vec::new();
        let present: HashSet<_> = inventory
            .iter()
            .map(|held| held.agent_id.as_str())
            .collect();
        for (id, run) in runs.iter() {
            if run.exit.is_some() || present.contains(id.as_str()) {
                continue;
            }
            let master = run.master.try_clone().map_err(|error| {
                ErrorBody::new(
                    Reason::Unavailable,
                    format!("could not copy the terminal of {id}: {error}"),
                )
            })?;
            terminals.push((
                SyncArgs {
                    agent_id: id.clone(),
                    pid: run.identity.pid,
                    birth: run.identity.birth.clone(),
                },
                master,
                (!matches!(run.stop, StopState::None)).then(|| StopAccepted {
                    id: id.clone(),
                    run: run.number,
                    caller: None,
                }),
            ));
        }
        Ok(terminals)
    }
}
