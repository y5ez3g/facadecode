//! The handle an agent's typist delivers messages through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use facade_base::model::error::ErrorBody;
use facade_base::model::{agent::ManagedAgent, message::DeliveryFailure};
use facade_base::terminal::WritePermit;
use tokio::time::Instant;

use super::write_queue::Lane;
use super::writer::{self, Prepared};
use super::{
    BeginNext, Deliveries, Messages, Outcome, PromptNotice, PromptWatch, cancelled_delivery, warn,
};
use crate::store::MessageTable;
#[cfg(test)]
use crate::{blocking_in_place, pause_for_test};

/// What a typist may ask of the messages: whether a message is still to be typed, leave to paste
/// some, and how their delivery ended.
#[derive(Clone)]
pub(crate) struct DeliveryHandle(Arc<Deliveries>);

#[derive(Debug, PartialEq, Eq)]
enum PasteState {
    Armed,
    Writing,
    Released,
    Cancelled,
}

/// The authority to use one saved paste marker. A recovered marker has no such authority.
#[derive(Clone, Debug)]
pub(crate) struct PasteGrant {
    pub(crate) number: u64,
    pub(super) deadline: Instant,
    state: Arc<Mutex<PasteState>>,
    paused: Arc<AtomicBool>,
    uncertain: Arc<AtomicBool>,
}

impl PasteGrant {
    pub(crate) fn deadline(&self) -> Instant {
        self.deadline
    }

    pub(super) fn new(number: u64, deadline: Instant, deliveries: &Deliveries) -> Self {
        Self {
            number,
            deadline,
            state: Arc::new(Mutex::new(PasteState::Armed)),
            paused: deliveries.paste_paused.clone(),
            uncertain: deliveries.writer.uncertainty_flag(),
        }
    }

    pub(super) fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    #[cfg(test)]
    pub(crate) fn write(&self) -> bool {
        self.try_issue(&mut || true)
    }

    pub(super) fn request_cancel(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if *state == PasteState::Writing {
            return false;
        }
        *state = PasteState::Cancelled;
        true
    }

    pub(crate) fn release(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if *state == PasteState::Writing {
            return false;
        }
        if *state != PasteState::Cancelled {
            *state = PasteState::Released;
        }
        true
    }

    pub(super) fn cancelled(&self) -> bool {
        *self.state.lock().unwrap() == PasteState::Cancelled
    }
}

impl WritePermit for PasteGrant {
    fn try_issue(&self, issue: &mut dyn FnMut() -> bool) -> bool {
        // Only the nonblocking issue is guarded. A rejected or full pipe never consumes the grant.
        let mut state = self.state.lock().unwrap();
        if *state != PasteState::Armed
            || self.paused.load(Ordering::Acquire)
            || self.uncertain.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
        {
            return false;
        }
        if issue() {
            *state = PasteState::Writing;
        }
        true
    }
}

impl Messages {
    pub(crate) async fn withdraw_queued(&self, number: u64) -> bool {
        let deliveries = &self.deliveries;
        loop {
            let grant = {
                let mut open = deliveries.lock();
                let Some(delivery) = open.agents.get_mut(&number) else {
                    return false;
                };
                if delivery.prompt || delivery.owes.is_some() {
                    return false;
                }
                if !delivery.pasted {
                    delivery.cancelling = true;
                    break;
                }
                delivery.paste_grant.clone()
            };
            let Some(grant) = grant.filter(PasteGrant::request_cancel) else {
                return false;
            };
            let mut open = deliveries.lock();
            let Some(delivery) = open.agents.get_mut(&number) else {
                return false;
            };
            if !delivery.pasted
                || delivery
                    .paste_grant
                    .as_ref()
                    .is_some_and(|active| active.is_same(&grant))
            {
                delivery.cancelling = true;
                break;
            }
        }
        match deliveries.clone().keep_cancel(number).await {
            Ok(withdrew) => withdrew,
            Err(error) => {
                warn(&error.message);
                false
            }
        }
    }
}

impl Deliveries {
    async fn keep_cancel(self: Arc<Self>, number: u64) -> Result<bool, ErrorBody> {
        let deliveries = self.clone();
        let ticket = self
            .writer
            .enqueue_prepared(Lane::Closing, 0, move || {
                let may_remove = {
                    let open = deliveries.lock();
                    open.agents
                        .get(&number)
                        .filter(|delivery| delivery.cancelling)
                        .and_then(|delivery| {
                            if delivery.pasted {
                                delivery
                                    .paste_grant
                                    .as_ref()
                                    .filter(|grant| grant.cancelled())
                                    .map(|_| true)
                            } else {
                                Some(false)
                            }
                        })
                };
                move |batch: &mut crate::store::Batch<'_>| {
                    let Some(unused_grant) = may_remove else {
                        return Ok(Prepared::known(Ok(false)));
                    };
                    let (withdrawn, facts) = match MessageTable::withdraw_in(
                        batch,
                        number,
                        &cancelled_delivery(),
                        unused_grant,
                    )? {
                        Ok(written) => written,
                        Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
                    };
                    Ok(Prepared::changed(
                        move |connection| facts.states(connection),
                        move |committed| {
                            committed.require()?;
                            let mut open = deliveries.lock();
                            Ok(withdrawn && deliveries.withdrawn(&mut open.agents, number))
                        },
                    ))
                }
            })
            .await?;
        writer::answer(ticket).await
    }
}

impl DeliveryHandle {
    pub(super) fn of(deliveries: Arc<Deliveries>) -> DeliveryHandle {
        DeliveryHandle(deliveries)
    }

    pub(crate) fn pastes_paused(&self) -> bool {
        self.0.paste_paused.load(Ordering::Acquire) || self.0.writer.uncertain()
    }

    pub(crate) fn save_paste(
        self,
        previous: Vec<u64>,
        outcome: Outcome,
        next: BeginNext,
    ) -> impl Future<Output = Result<Option<PasteGrant>, ErrorBody>> + Send + 'static {
        self.0.keep_terminal_outcome(previous, outcome, Some(next))
    }

    pub(crate) fn save_outcome(
        self,
        numbers: Vec<u64>,
        outcome: Outcome,
    ) -> impl Future<Output = Result<Option<PasteGrant>, ErrorBody>> + Send + 'static {
        self.0.keep_terminal_outcome(numbers, outcome, None)
    }

    pub(crate) async fn return_grant(
        self,
        grant: PasteGrant,
        expired: bool,
    ) -> Result<Option<PasteGrant>, ErrorBody> {
        self.0.finish_grant(grant, expired).await?;
        Ok(None)
    }

    /// Whether message `number` is still to be typed: open, its paste not begun, and not read.
    pub(crate) fn still_to_type(&self, number: u64) -> bool {
        self.0
            .lock()
            .agents
            .get(&number)
            .is_some_and(|delivery| !delivery.pasted)
    }

    /// Chooses the next still-open message from the actor's ordered candidates in one snapshot.
    pub(crate) fn next_to_type(
        &self,
        candidates: impl Iterator<Item = (u64, Instant, bool)>,
    ) -> Option<(u64, Instant)> {
        let open = self.0.lock();
        candidates
            .filter(|(number, _, _)| {
                open.agents
                    .get(number)
                    .is_some_and(|delivery| !delivery.pasted && !delivery.cancelling)
            })
            .min_by_key(|(number, _, prompt)| (!*prompt, *number))
            .map(|(number, deadline, _)| (number, deadline))
    }

    /// Writes that a paste of `numbers` begins, in that order and named by the first, and returns
    /// those it may type: the ones still to be typed. Returns None where the table could not write
    /// it: nothing may be typed then, or a restart could type it again.
    #[cfg(test)]
    pub(crate) fn begin_paste(&self, numbers: &[u64]) -> Option<Vec<u64>> {
        let mut open = self.0.lock();
        let granted: Vec<u64> = numbers
            .iter()
            .copied()
            .filter(|number| {
                open.agents
                    .get(number)
                    .is_some_and(|delivery| !delivery.pasted)
            })
            .collect();
        if granted.is_empty() {
            return Some(granted);
        }
        if let Err(err) = blocking_in_place(|| self.0.table.begin_paste(&granted)) {
            warn(&format!("{err:#}; it is not typed now"));
            return None;
        }
        pause_for_test("after-paste-commit");
        for number in &granted {
            if let Some(delivery) = open.agents.get_mut(number) {
                delivery.pasted = true;
            }
        }
        Some(granted)
    }

    /// Ends the deliveries among `numbers` still open, as `outcome` says.
    #[cfg(test)]
    pub(crate) fn settle(&self, numbers: &[u64], outcome: Outcome) {
        self.0.settle(numbers, outcome);
    }

    /// Gives a due incident to the startup prompt under the paste fence. A paste already in
    /// flight keeps its real outcome and may leave the watchdog to report after success.
    pub(crate) fn prompt_notice(
        &self,
        prompt: &PromptWatch,
        agent: &ManagedAgent,
        incident: u64,
        reason: DeliveryFailure,
    ) -> PromptNotice {
        let mut open = self.0.lock();
        if let Some(delivery) = open.agents.get_mut(&prompt.number) {
            if let Some(owed) = &mut delivery.owes {
                owed.incident = Some((agent.clone(), incident));
            }
            let settled = delivery.settled.subscribe();
            let unstarted = !delivery.pasted;
            drop(open);
            if unstarted {
                let deliveries = self.0.clone();
                let number = prompt.number;
                tokio::spawn(async move {
                    if let Err(error) = deliveries
                        .finish_queued(vec![number], Outcome::untyped(reason), None, true)
                        .await
                    {
                        warn(&error.message);
                    }
                });
            }
            return PromptNotice::InFlight(settled);
        }
        if prompt.failed_incident.load(Ordering::Relaxed) == incident {
            PromptNotice::Owned
        } else {
            PromptNotice::Report
        }
    }
}
