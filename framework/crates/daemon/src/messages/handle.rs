//! The handle an agent's typist delivers messages through.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use facade_base::model::{agent::ManagedAgent, message::DeliveryFailure};

use super::{Deliveries, Outcome, PromptNotice, PromptWatch, warn};
use crate::store::{DraftDigest, DraftProof};
use crate::{blocking_in_place, pause_for_test};

/// What a typist may ask of the messages: whether a message is still to be typed, leave to paste
/// some, and how their delivery ended.
#[derive(Clone)]
pub(crate) struct DeliveryHandle(Arc<Deliveries>);

impl DeliveryHandle {
    pub(super) fn of(deliveries: Arc<Deliveries>) -> DeliveryHandle {
        DeliveryHandle(deliveries)
    }

    /// Whether message `number` is still to be typed: open, its paste not begun, and not read.
    pub(crate) fn still_to_type(&self, number: u64) -> bool {
        self.0
            .lock()
            .agents
            .get(&number)
            .is_some_and(|delivery| !delivery.pasted)
    }

    /// Writes that a paste of `numbers` begins, in that order and named by the first, and returns
    /// those it may type: the ones still to be typed. Returns None where the table could not write
    /// it: nothing may be typed then, or a restart could type it again.
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

    pub(crate) fn observe_paste(&self, number: u64, draft: &DraftDigest) -> bool {
        blocking_in_place(|| self.0.table.observe_paste(number, draft)).unwrap_or_else(|err| {
            warn(&format!("{err:#}"));
            false
        })
    }

    pub(crate) fn forget_paste_draft(&self, number: u64) -> bool {
        blocking_in_place(|| self.0.table.forget_paste_draft(number))
            .inspect_err(|err| warn(&format!("{err:#}")))
            .is_ok()
    }

    pub(crate) fn record_cleanup(&self, number: u64, proof: DraftProof) -> bool {
        blocking_in_place(|| self.0.table.record_cleanup(number, proof)).unwrap_or_else(|err| {
            warn(&format!("{err:#}"));
            false
        })
    }

    /// Returns a durably reserved paste to the pending messages when no bytes were issued.
    pub(crate) fn release_unissued_paste(&self, numbers: &[u64]) -> bool {
        let mut open = self.0.lock();
        if let Err(err) = blocking_in_place(|| self.0.table.release_unissued_paste(numbers)) {
            warn(&format!("{err:#}; retaining the paste reservation"));
            return false;
        }
        for number in numbers {
            if let Some(delivery) = open.agents.get_mut(number) {
                delivery.pasted = false;
            }
        }
        true
    }

    /// Ends the deliveries among `numbers` still open, as `outcome` says.
    pub(crate) fn settle(&self, numbers: &[u64], outcome: Outcome) -> bool {
        self.0.settle(numbers, outcome)
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
            if delivery.pasted {
                return PromptNotice::InFlight(delivery.settled.subscribe());
            }
            self.0
                .settle_open(&mut open.agents, &[prompt.number], Outcome::untyped(reason));
        }
        if prompt.failed_incident.load(Ordering::Relaxed) == incident {
            PromptNotice::Owned
        } else {
            PromptNotice::Report
        }
    }
}
