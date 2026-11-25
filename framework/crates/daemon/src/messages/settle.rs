//! Ending deliveries: by their typist, by their deadline, and the results start prompts owe.

use std::sync::atomic::Ordering;
use std::sync::{Arc, atomic::AtomicBool};

use facade_base::model::message::{
    Delivery, DeliveryFailure, DeliveryStatus, FACADE, Message, PromptOutcome, StartOutcome,
    TextWritten, start_result_text,
};
use facade_base::{
    model::agent::{AgentRef, ManagedAgent},
    model::error::ErrorBody,
    model::message::AgentDeliverStartResultArgs,
};
use tokio::sync::watch;
use tokio::time::Instant;

use super::write_queue::Lane;
use super::writer::{self, Prepared};
use super::{
    Deliveries, Due, Messages, OpenMap, Outcome, OwedResult, PasteGrant, PostedResult,
    RESPONSE_GRACE, Settled, cancelled_delivery, warn,
};
#[cfg(test)]
use crate::blocking_in_place;
use crate::store::{MessageTable, Settlement};

#[derive(Clone)]
pub(crate) struct BeginNext {
    pub(crate) number: u64,
    pub(crate) deadline: Instant,
    pub(crate) paused: Arc<AtomicBool>,
}

struct Finishing {
    ending: Vec<u64>,
    delivery: Delivery,
    withdrawals: Vec<u64>,
    due: Due,
    failures: Vec<(u64, u64)>,
    results: Vec<(u64, Message)>,
    cleaned_paste: bool,
}

enum ReleasedPaste {
    Returned,
    Cancelled,
    Expired(Box<Finishing>, Settlement),
}

impl Finishing {
    fn writes(&self) -> Vec<(u64, &Delivery)> {
        self.ending
            .iter()
            .map(|&number| (number, &self.delivery))
            .collect()
    }
}

impl Messages {
    /// Waits for previous writes to publish, then reclaims each grant which can still write
    /// zero bytes. Active pastes settle in the terminal drain.
    pub(crate) async fn clear_unused_pastes(&self) -> Result<(), ErrorBody> {
        let deliveries = self.deliveries.clone();
        let unused = self
            .ordered(0, move || {
                if !deliveries.paste_paused.load(Ordering::Acquire) {
                    return Ok(Vec::new());
                }
                let grants = deliveries
                    .lock()
                    .agents
                    .values()
                    .filter_map(|delivery| delivery.paste_grant.clone())
                    .collect::<Vec<_>>();
                Ok(grants
                    .into_iter()
                    .filter(PasteGrant::release)
                    .collect::<Vec<_>>())
            })
            .await?;
        let mut returning = tokio::task::JoinSet::new();
        for grant in unused {
            let deliveries = self.deliveries.clone();
            returning.spawn(async move {
                let expired = grant.deadline <= Instant::now();
                deliveries.finish_grant(grant, expired).await
            });
        }
        while let Some(returned) = returning.join_next().await {
            returned.map_err(ErrorBody::internal)??;
        }
        Ok(())
    }

    /// Ends the deliveries among `numbers` still open, as `outcome` says.
    #[cfg(test)]
    pub(crate) fn settle(&self, numbers: &[u64], outcome: Outcome) {
        self.deliveries.settle(numbers, outcome);
    }

    pub(crate) async fn settle_written(&self, numbers: &[u64], outcome: Outcome) {
        if let Err(error) = self
            .deliveries
            .clone()
            .finish_queued(numbers.to_vec(), outcome, None, false)
            .await
        {
            warn(&error.message);
        }
    }

    /// Ends delivery `number` where nobody else has by `deadline` and a grace: as `timeout` where
    /// its paste had not begun, and otherwise, one more grace on, as unconfirmed. Returns once it
    /// ended or its inbox went.
    pub(crate) async fn settle_by_deadline(
        &self,
        number: u64,
        settled: &mut watch::Receiver<Option<Settled>>,
        deadline: Instant,
    ) {
        if ended_by(settled, deadline + RESPONSE_GRACE).await {
            return;
        }
        let unused_grant = {
            let open = self.deliveries.lock();
            open.agents
                .get(&number)
                .and_then(|delivery| delivery.paste_grant.clone())
        };
        if let Some(unused_grant) = unused_grant.filter(PasteGrant::release) {
            if let Err(error) = self
                .deliveries
                .clone()
                .finish_grant(unused_grant, true)
                .await
            {
                warn(&error.message);
                return;
            }
            if settled.borrow().is_some() {
                return;
            }
        }
        let unstarted = {
            let open = self.deliveries.lock();
            !open
                .agents
                .get(&number)
                .is_some_and(|delivery| delivery.pasted)
        };
        if unstarted {
            let timeout = Outcome::untyped(DeliveryFailure::Timeout);
            if let Err(error) = self
                .deliveries
                .clone()
                .finish_queued(vec![number], timeout, None, true)
                .await
            {
                warn(&error.message);
            }
            if settled.borrow().is_some() {
                return;
            }
        }
        if !ended_by(settled, Instant::now() + RESPONSE_GRACE).await {
            self.settle_written(&[number], Outcome::UNCONFIRMED).await;
        }
    }
}

/// Waits until `settled` is told how its delivery ended, its inbox went, or `until`. Returns false
/// only where `until` came first.
async fn ended_by(settled: &mut watch::Receiver<Option<Settled>>, until: Instant) -> bool {
    tokio::select! {
        _ = settled.wait_for(Option::is_some) => true,
        () = tokio::time::sleep_until(until) => false,
    }
}

impl Deliveries {
    /// Records the proof immediately. The returned future writes the result and may await
    /// earlier operations, so a timeout must see the proof even before it is polled.
    pub(super) fn keep_terminal_outcome(
        self: Arc<Self>,
        numbers: Vec<u64>,
        outcome: Outcome,
        next: Option<BeginNext>,
    ) -> impl Future<Output = Result<Option<PasteGrant>, ErrorBody>> + Send + 'static {
        let proven =
            !numbers.is_empty() && matches!(outcome, Outcome::Typed | Outcome::Withdrawn { .. });
        if proven {
            let mut open = self.lock();
            for number in &numbers {
                if let Some(delivery) = open.agents.get_mut(number) {
                    delivery.terminal_proof = true;
                }
            }
        }
        async move {
            if !proven {
                return self.finish_queued(numbers, outcome, next, false).await;
            }
            let mut warned = false;
            loop {
                match self
                    .clone()
                    .finish_queued(numbers.clone(), outcome, next.clone(), false)
                    .await
                {
                    Err(error)
                        if error.data.reason == facade_base::model::error::Reason::Internal =>
                    {
                        if !warned {
                            warn(&format!(
                                "{}; retaining the terminal outcome for another write",
                                error.message
                            ));
                            warned = true;
                        }
                        tokio::time::sleep(RESPONSE_GRACE).await;
                    }
                    result => return result,
                }
            }
        }
    }

    pub(super) async fn finish_grant(
        self: Arc<Self>,
        grant: PasteGrant,
        expired: bool,
    ) -> Result<(), ErrorBody> {
        let number = grant.number;
        let deliveries = self.clone();
        let ticket = self
            .writer
            .enqueue_prepared(Lane::Ordered, 0, move || {
                let open = deliveries.lock();
                let owned = open
                    .agents
                    .get(&number)
                    .and_then(|entry| entry.paste_grant.as_ref())
                    .is_some_and(|current| current.is_same(&grant))
                    && grant.release();
                let expiry = (owned && expired).then(|| {
                    deliveries.finishing(
                        &open.agents,
                        &[number],
                        Outcome::Withdrawn {
                            reason: DeliveryFailure::Timeout,
                            text_written: TextWritten::None,
                        },
                        false,
                    )
                });
                drop(open);
                move |batch: &mut crate::store::Batch<'_>| {
                    if !owned {
                        return Ok(Prepared::known(Ok(())));
                    }
                    let written = if grant.cancelled() {
                        MessageTable::withdraw_in(batch, number, &cancelled_delivery(), true)?
                            .map(|(changed, facts)| (changed, facts, ReleasedPaste::Cancelled))
                    } else if let Some(expiry) = expiry {
                        MessageTable::write_paste_in(
                            batch,
                            &expiry.writes(),
                            &expiry.results,
                            &expiry.withdrawals,
                            true,
                            None,
                        )?
                        .map(|written| {
                            (
                                written.settlement.settled.contains(&number),
                                written.facts,
                                ReleasedPaste::Expired(Box::new(expiry), written.settlement),
                            )
                        })
                    } else {
                        MessageTable::release_paste_in(batch, number)?
                            .map(|(changed, facts)| (changed, facts, ReleasedPaste::Returned))
                    };
                    let (changed, facts, released) = match written {
                        Ok(value) => value,
                        Err(error) => return Ok(Prepared::known(Err(ErrorBody::internal(error)))),
                    };
                    Ok(Prepared::changed(
                        move |connection| facts.states(connection),
                        move |committed| {
                            committed.require()?;
                            if changed {
                                let mut open = deliveries.lock();
                                match released {
                                    ReleasedPaste::Returned => {
                                        if let Some(entry) = open.agents.get_mut(&number)
                                            && entry
                                                .paste_grant
                                                .as_ref()
                                                .is_some_and(|current| current.is_same(&grant))
                                        {
                                            entry.pasted = false;
                                            entry.paste_grant = None;
                                        }
                                    }
                                    ReleasedPaste::Cancelled => {
                                        deliveries.withdrawn(&mut open.agents, number);
                                    }
                                    ReleasedPaste::Expired(plan, settlement) => {
                                        deliveries.record_failures(
                                            &open.agents,
                                            &plan,
                                            &settlement,
                                        );
                                        deliveries.publish_finishing(
                                            &mut open.agents,
                                            *plan,
                                            settlement,
                                        );
                                    }
                                }
                            }
                            Ok(())
                        },
                    ))
                }
            })
            .await?;
        writer::answer(ticket).await
    }

    pub(super) async fn finish_queued(
        self: Arc<Self>,
        numbers: Vec<u64>,
        outcome: Outcome,
        next: Option<BeginNext>,
        unstarted: bool,
    ) -> Result<Option<PasteGrant>, facade_base::model::error::ErrorBody> {
        let deliveries = self.clone();
        let ticket = self
            .writer
            .enqueue(Lane::Ordered, 0, move |batch| {
                let plan = {
                    let open = deliveries.lock();
                    deliveries.finishing(&open.agents, &numbers, outcome, unstarted)
                };
                let mut began = next.filter(|request| {
                    request.deadline > Instant::now()
                        && !request.paused.load(Ordering::Acquire)
                        && !deliveries.paste_paused.load(Ordering::Acquire)
                });
                if plan.ending.is_empty() && began.is_none() {
                    return Ok(Prepared::known(Ok(None)));
                }
                let writes = plan.writes();
                let written = match MessageTable::write_paste_in(
                    batch,
                    &writes,
                    &plan.results,
                    &plan.withdrawals,
                    plan.cleaned_paste,
                    began.as_ref().map(|request| request.number),
                )? {
                    Ok(written) => written,
                    Err(error) if began.is_some() && !plan.ending.is_empty() => {
                        warn(&format!("{error:#}; settling the previous paste alone"));
                        began = None;
                        match MessageTable::write_paste_in(
                            batch,
                            &writes,
                            &plan.results,
                            &plan.withdrawals,
                            plan.cleaned_paste,
                            None,
                        )? {
                            Ok(written) => written,
                            Err(error) => {
                                return Ok(Prepared::known(Err(
                                    facade_base::model::error::ErrorBody::internal(error),
                                )));
                            }
                        }
                    }
                    Err(error) => {
                        return Ok(Prepared::known(Err(
                            facade_base::model::error::ErrorBody::internal(error),
                        )));
                    }
                };
                let crate::store::PasteWrite {
                    settlement,
                    facts,
                    began: marked,
                } = written;
                if crate::trace_message_batches() && (marked || !settlement.settled.is_empty()) {
                    let previous = settlement.settled.first().copied().unwrap_or(0);
                    let next = began
                        .as_ref()
                        .filter(|_| marked)
                        .map_or(0, |next| next.number);
                    crate::log(
                        "info",
                        &format!("message paste staged: previous={previous} next={next}"),
                    );
                }
                Ok(Prepared::changed(
                    move |connection| facts.states(connection),
                    move |committed| {
                        committed.require()?;
                        if marked {
                            crate::gate_for_test("before-paste-grant-publication");
                        }
                        let mut open = deliveries.lock();
                        deliveries.record_failures(&open.agents, &plan, &settlement);
                        deliveries.publish_finishing(&mut open.agents, plan, settlement);
                        Ok(began.filter(|_| marked).and_then(|began| {
                            let message = open.agents.get_mut(&began.number)?;
                            let grant = PasteGrant::new(began.number, began.deadline, &deliveries);
                            if message.cancelling {
                                grant.request_cancel();
                            }
                            message.pasted = true;
                            message.paste_grant = Some(grant.clone());
                            Some(grant)
                        }))
                    },
                ))
            })
            .await?;
        writer::answer(ticket).await
    }

    #[cfg(test)]
    pub(super) fn settle(&self, numbers: &[u64], outcome: Outcome) {
        if numbers.is_empty() {
            return;
        }
        let mut open = self.lock();
        self.settle_open(&mut open.agents, numbers, outcome);
    }

    /// Ends the open deliveries among `numbers` as `outcome` says, `open` held: writes them and the
    /// results they owe in one transaction, tells their sends, and withdraws those the outcome
    /// takes back. One whose inbox went is told nothing: dropping it closes its send's channel.
    #[cfg(test)]
    pub(super) fn settle_open(&self, open: &mut OpenMap, numbers: &[u64], outcome: Outcome) {
        let mut plan = self.finishing(open, numbers, outcome, false);
        if plan.ending.is_empty() {
            return;
        }
        let writes = plan.writes();
        let recorded = blocking_in_place(|| {
            if plan.cleaned_paste {
                self.table.settle_cleaned_paste(&writes, &plan.results)
            } else {
                self.table
                    .settle_with_withdrawals(&writes, &plan.results, &plan.withdrawals)
            }
        });
        let written = match recorded {
            Ok(written) => {
                self.record_failures(open, &plan, &written);
                written
            }
            Err(err) => {
                warn(&format!("{err:#}"));
                if plan.cleaned_paste {
                    return;
                }
                plan.withdrawals.clear();
                Settlement {
                    settled: plan.ending.clone(),
                    results: Vec::new(),
                }
            }
        };
        self.publish_finishing(open, plan, written);
    }

    fn finishing(
        &self,
        open: &OpenMap,
        numbers: &[u64],
        outcome: Outcome,
        unstarted: bool,
    ) -> Finishing {
        let cleaned_paste = matches!(outcome, Outcome::Withdrawn { .. });
        let ending: Vec<u64> = numbers
            .iter()
            .copied()
            .filter(|number| {
                open.get(number).is_some_and(|delivery| {
                    (!unstarted || !delivery.pasted)
                        && (!cleaned_paste || delivery.pasted)
                        && (outcome != Outcome::UNCONFIRMED || !delivery.terminal_proof)
                })
            })
            .collect();
        let at = facade_base::time::iso_now();
        let delivery = outcome.delivery(&at);
        let withdrawals: Vec<u64> = ending
            .iter()
            .copied()
            .filter(|number| outcome.withdraws(open[number].pasted))
            .collect();
        let due = Due::now();
        let mut failures = Vec::new();
        let mut results = Vec::new();
        if delivery.status == DeliveryStatus::Failure {
            for &number in &ending {
                let prompt = &open[&number];
                if let Some(owed) = &prompt.owes {
                    let (agent, incident) = owed.incident.clone().unwrap_or_else(|| (owed.agent)());
                    results.push((
                        number,
                        result_message(&prompt.message, &delivery, owed, agent, &at, &due),
                    ));
                    failures.push((number, incident));
                }
            }
        }
        Finishing {
            ending,
            delivery,
            withdrawals,
            due,
            failures,
            results,
            cleaned_paste,
        }
    }

    fn record_failures(&self, open: &OpenMap, plan: &Finishing, written: &Settlement) {
        for &(number, incident) in &plan.failures {
            if written.settled.contains(&number)
                && let Some(owed) = open.get(&number).and_then(|prompt| prompt.owes.as_ref())
            {
                owed.prompt
                    .failed_incident
                    .store(incident, Ordering::Relaxed);
            }
        }
    }

    fn publish_finishing(&self, open: &mut OpenMap, plan: Finishing, written: Settlement) {
        let Finishing {
            ending,
            delivery,
            withdrawals,
            due,
            results,
            ..
        } = plan;
        for number in ending {
            if !written.settled.contains(&number) {
                continue;
            }
            let Some(ended) = open.remove(&number) else {
                continue;
            };
            let message = Message {
                delivery: delivery.clone(),
                ..ended.message
            };
            if withdrawals.contains(&number) {
                let settled = match (delivery.reason, ended.expected_reply_to) {
                    (Some(DeliveryFailure::Timeout), Some(expected_reply_to)) => {
                        Settled::WithdrawnWhileWaiting {
                            message: Box::new(message.clone()),
                            expected_reply_to,
                        }
                    }
                    _ => Settled::Withdrawn(Box::new(message.clone())),
                };
                ended.settled.send_replace(Some(settled));
                self.removed(message.to);
            } else {
                ended
                    .settled
                    .send_replace(Some(Settled::Kept(Box::new(message.clone()))));
                self.updated(&message);
            }
        }
        self.hand_on(open, results, &written.results, &due);
    }

    /// Hands results for the prompts the table settled to the daemon. Local results are already
    /// kept and open for delivery, and a remote result carries the creator's reserved number.
    pub(super) fn hand_on(
        &self,
        open: &mut OpenMap,
        results: Vec<(u64, Message)>,
        written: &[u64],
        due: &Due,
    ) {
        for (prompt, mut result) in results {
            if !written.contains(&prompt) {
                continue;
            }
            let reference = result
                .message_ref
                .as_ref()
                .expect("a result's reserved reference");
            if reference.machine_id != self.machine_id {
                let recipient = AgentRef {
                    machine_id: reference.machine_id.clone(),
                    agent_id: result.to.clone(),
                };
                let _ = self.results.send(PostedResult::Remote {
                    args: AgentDeliverStartResultArgs {
                        recipient,
                        message: result,
                    },
                    deadline: due.instant,
                });
                continue;
            }
            result.message_ref = None;
            let settled = Deliveries::open(open, result.clone(), false, false, None);
            self.updated(&result);
            let _ = self.results.send(PostedResult::Local {
                message: result,
                deadline: due.instant,
                settled,
            });
        }
    }
}

/// The result `prompt`, ending as `delivery` at `at`, owes its sender: from Facade, under the
/// number the prompt keeps, on the sender's call, pending until `due`.
fn result_message(
    prompt: &Message,
    delivery: &Delivery,
    owed: &OwedResult,
    agent: ManagedAgent,
    at: &str,
    due: &Due,
) -> Message {
    let outcome = StartOutcome {
        agent,
        prompt: PromptOutcome {
            message_id: prompt.message_id.clone(),
            delivery: delivery.clone(),
        },
    };
    Message {
        message_ref: Some(owed.reference.clone()),
        from_machine_id: (outcome.agent.machine_id != owed.reference.machine_id)
            .then(|| outcome.agent.machine_id.clone()),
        reply_to_machine_id: None,
        message_id: owed.reference.message_id.clone(),
        from: FACADE.to_string(),
        from_name: None,
        to: prompt.from.clone(),
        text: start_result_text(&outcome),
        reply_to: None,
        command_line_reply: false,
        from_window: None,
        call_id: prompt.call_id.clone(),
        result: Some(outcome),
        at: at.to_string(),
        delivery: Delivery {
            status: DeliveryStatus::Pending,
            reason: None,
            text_written: TextWritten::None,
            enter_written: Some(false),
            deadline: Some(due.at.clone()),
            delivered_via: None,
            delivered_at: None,
        },
    }
}
