//! Ending deliveries: by their typist, by their deadline, and the results start prompts owe.

use std::sync::atomic::Ordering;

use facade_base::model::message::{
    Delivery, DeliveryFailure, DeliveryStatus, FACADE, Message, PromptOutcome, StartOutcome,
    TextWritten, start_result_text,
};
use facade_base::{
    model::agent::{AgentRef, ManagedAgent},
    model::message::AgentDeliverStartResultArgs,
};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{
    Deliveries, Due, Messages, OpenMap, Outcome, OwedResult, PostedResult, RESPONSE_GRACE, Settled,
    warn,
};
use crate::blocking_in_place;
use crate::store::Settlement;

impl Messages {
    /// Ends the deliveries among `numbers` still open, as `outcome` says.
    pub(crate) fn settle(&self, numbers: &[u64], outcome: Outcome) {
        self.deliveries.settle(numbers, outcome);
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
        {
            let mut open = self.deliveries.lock();
            if !open
                .agents
                .get(&number)
                .is_some_and(|delivery| delivery.pasted)
            {
                let timeout = Outcome::untyped(DeliveryFailure::Timeout);
                return self
                    .deliveries
                    .settle_open(&mut open.agents, &[number], timeout);
            }
        }
        if !ended_by(settled, Instant::now() + RESPONSE_GRACE).await {
            self.settle(&[number], Outcome::UNCONFIRMED);
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
    pub(super) fn settle_open(&self, open: &mut OpenMap, numbers: &[u64], outcome: Outcome) {
        let cleaned_paste = matches!(outcome, Outcome::Withdrawn { .. });
        let ending: Vec<u64> = numbers
            .iter()
            .copied()
            .filter(|number| {
                open.get(number)
                    .is_some_and(|delivery| !cleaned_paste || delivery.pasted)
            })
            .collect();
        if ending.is_empty() {
            return;
        }
        let at = facade_base::time::iso_now();
        let delivery = outcome.delivery(&at);
        let writes: Vec<(u64, &Delivery)> =
            ending.iter().map(|number| (*number, &delivery)).collect();
        let mut withdrawals: Vec<u64> = ending
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
        let recorded = blocking_in_place(|| {
            if cleaned_paste {
                self.table.settle_cleaned_paste(&writes, &results)
            } else if withdrawals.is_empty() {
                self.table.settle_messages(&writes, &results)
            } else {
                self.table
                    .settle_with_withdrawals(&writes, &results, &withdrawals)
            }
        });
        if let Ok(written) = &recorded {
            for (number, incident) in failures {
                if written.settled.contains(&number) {
                    let owed = open[&number]
                        .owes
                        .as_ref()
                        .expect("a prompt that owes a result");
                    owed.prompt
                        .failed_incident
                        .store(incident, Ordering::Relaxed);
                }
            }
        }
        let written = match recorded {
            Ok(written) => written,
            Err(err) => {
                warn(&format!("{err:#}"));
                if cleaned_paste {
                    return;
                }
                // The sends still learn what happened. After a restart the table shows what it
                // last wrote, and the prompts among them still owe their results.
                withdrawals.clear();
                Settlement {
                    settled: ending.clone(),
                    results: Vec::new(),
                }
            }
        };
        for number in ending {
            let Some(ended) = open.remove(&number) else {
                continue;
            };
            if !written.settled.contains(&number) {
                continue;
            }
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
