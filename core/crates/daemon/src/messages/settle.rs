//! Ending deliveries: by their typist, by their deadline, and the results start prompts owe.

use facade_base::daemon::{
    Delivery, DeliveryFailure, DeliveryStatus, FACADE, Message, PromptOutcome, StartOutcome,
    TextWritten, start_result_text,
};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{
    Deliveries, Due, Messages, OpenMap, Outcome, OwedResult, PostedResult, RESPONSE_GRACE, Settled,
    number, warn,
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
        let ending: Vec<u64> = numbers
            .iter()
            .copied()
            .filter(|number| open.contains_key(number))
            .collect();
        if ending.is_empty() {
            return;
        }
        let at = facade_base::time::iso_now();
        let delivery = outcome.delivery(&at);
        let writes: Vec<(u64, &Delivery)> =
            ending.iter().map(|number| (*number, &delivery)).collect();
        let due = Due::now();
        let results = owed_results(open, &writes, &at, &due);
        let written = blocking_in_place(|| self.table.settle_messages(&writes, &results))
            .unwrap_or_else(|err| {
                // The sends still learn what happened. After a restart the table shows what it
                // last wrote, and the prompts among them still owe their results.
                warn(&format!("{err:#}"));
                Settlement {
                    settled: ending.clone(),
                    results: Vec::new(),
                }
            });
        for number in ending {
            let Some(ended) = open.remove(&number) else {
                continue;
            };
            if !written.settled.contains(&number) {
                continue;
            }
            let withdraw = outcome.withdraws() && ended.may_withdraw();
            let message = Message {
                delivery: delivery.clone(),
                ..ended.message
            };
            if withdraw && self.delete(number) {
                ended
                    .settled
                    .send_replace(Some(Settled::Withdrawn(Box::new(message.clone()))));
                self.removed(message.message_id, message.from, message.to);
            } else {
                ended
                    .settled
                    .send_replace(Some(Settled::Kept(Box::new(message.clone()))));
                self.updated(&message);
            }
        }
        self.hand_on(open, results, &written.results, &due);
    }

    /// Opens the delivery of each result in `results` the table wrote, `written`, and hands it to
    /// the daemon to deliver by `due`.
    pub(super) fn hand_on(
        &self,
        open: &mut OpenMap,
        results: Vec<(u64, Message)>,
        written: &[u64],
        due: &Due,
    ) {
        for (_, result) in results {
            if !written.contains(&number(&result)) {
                continue;
            }
            let settled = Deliveries::open(open, result.clone(), false, false, None);
            self.updated(&result);
            let _ = self.results.send(PostedResult {
                message: result,
                deadline: due.instant,
                settled,
            });
        }
    }
}

/// The results that the prompts among `ending`, each ending as its delivery says at `at`, owe their
/// senders, each paired with its prompt's number.
pub(super) fn owed_results(
    open: &OpenMap,
    ending: &[(u64, &Delivery)],
    at: &str,
    due: &Due,
) -> Vec<(u64, Message)> {
    ending
        .iter()
        .filter_map(|&(number, delivery)| {
            let prompt = open.get(&number)?;
            let owed = prompt.owes.as_ref()?;
            Some((
                number,
                result_message(&prompt.message, delivery, owed, at, due),
            ))
        })
        .collect()
}

/// The result `prompt`, ending as `delivery` at `at`, owes its sender: from Facade, under the
/// number the prompt keeps, on the sender's call, pending until `due`.
fn result_message(
    prompt: &Message,
    delivery: &Delivery,
    owed: &OwedResult,
    at: &str,
    due: &Due,
) -> Message {
    let outcome = StartOutcome {
        agent: (owed.agent)(),
        prompt: PromptOutcome {
            message_id: prompt.message_id.clone(),
            delivery: delivery.clone(),
        },
    };
    Message {
        message_id: format!("m{}", owed.number),
        from: FACADE.to_string(),
        from_name: None,
        to: prompt.from.clone(),
        text: start_result_text(&outcome),
        reply_to: None,
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
