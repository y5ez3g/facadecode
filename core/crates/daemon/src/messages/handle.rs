//! The handle an agent's typist delivers messages through.

use std::sync::Arc;

use super::{Deliveries, Outcome, warn};
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
            .filter(|number| open.get(number).is_some_and(|delivery| !delivery.pasted))
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
            if let Some(delivery) = open.get_mut(number) {
                delivery.pasted = true;
            }
        }
        Some(granted)
    }

    /// Ends the deliveries among `numbers` still open, as `outcome` says.
    pub(crate) fn settle(&self, numbers: &[u64], outcome: Outcome) {
        self.0.settle(numbers, outcome);
    }
}
