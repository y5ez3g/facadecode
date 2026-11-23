//! How a delivery ends, and by when it must.

use std::time::{Duration, SystemTime};

use facade_base::model::message::{
    DeliveredVia, Delivery, DeliveryFailure, DeliveryStatus, TextWritten,
};
use tokio::time::Instant;

use super::RESPONSE_GRACE;
use crate::{DELIVERY_TIME, delivery_limit};

/// How a delivery ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Typed and submitted.
    Typed,
    /// The terminal cleared this message's own paste before submitting it.
    Withdrawn {
        reason: DeliveryFailure,
        text_written: TextWritten,
    },
    /// Not delivered. `text_written` tracks the text that reached the terminal.
    /// `enter_written` tracks the submission key and is None when the write outcome is unknown.
    Failed {
        reason: DeliveryFailure,
        text_written: TextWritten,
        enter_written: Option<bool>,
    },
}

impl Outcome {
    /// Typing began and nobody can say how it ended.
    pub(crate) const UNCONFIRMED: Outcome = Outcome::Failed {
        reason: DeliveryFailure::SubmissionUnconfirmed,
        text_written: TextWritten::Unknown,
        enter_written: None,
    };

    /// Not delivered, for `reason`, and none of it typed.
    pub(crate) fn untyped(reason: DeliveryFailure) -> Outcome {
        Outcome::Failed {
            reason,
            text_written: TextWritten::None,
            enter_written: Some(false),
        }
    }

    /// Takes a message out of its inbox when it expired before pasting or the terminal confirmed
    /// clearing its paste before submission.
    pub(super) fn withdraws(self, pasted: bool) -> bool {
        match self {
            Outcome::Withdrawn { .. } => pasted,
            Outcome::Failed {
                reason:
                    DeliveryFailure::Timeout
                    | DeliveryFailure::InputDraft
                    | DeliveryFailure::InputInteraction
                    | DeliveryFailure::InputUnknown,
                text_written: TextWritten::None,
                ..
            } => !pasted,
            _ => false,
        }
    }

    /// The delivery this outcome records, ending at `at`.
    pub(super) fn delivery(self, at: &str) -> Delivery {
        let (reason, text_written, enter_written) = match self {
            Outcome::Typed => {
                return Delivery {
                    status: DeliveryStatus::Success,
                    reason: None,
                    text_written: TextWritten::Full,
                    enter_written: Some(true),
                    deadline: None,
                    delivered_via: Some(DeliveredVia::TypedIntoInput),
                    delivered_at: Some(at.to_string()),
                };
            }
            Outcome::Withdrawn {
                reason,
                text_written,
            } => (reason, text_written, Some(false)),
            Outcome::Failed {
                reason,
                text_written,
                enter_written,
            } => (reason, text_written, enter_written),
        };
        Delivery {
            status: DeliveryStatus::Failure,
            reason: Some(reason),
            text_written,
            enter_written,
            deadline: None,
            delivered_via: None,
            delivered_at: None,
        }
    }
}

/// The delivery a read gives a message at `at`. Where its typist had begun pasting it, nobody knows
/// how much of it reached the terminal.
pub(super) fn read_delivery(before: &Delivery, typing: bool, at: &str) -> Delivery {
    let (text_written, enter_written) = if typing {
        (TextWritten::Unknown, None)
    } else {
        (before.text_written, before.enter_written)
    };
    Delivery {
        status: DeliveryStatus::Success,
        reason: None,
        text_written,
        enter_written,
        deadline: None,
        delivered_via: Some(DeliveredVia::ReadByRecipient),
        delivered_at: Some(at.to_string()),
    }
}

/// When a delivery beginning now must end: on the daemon's clock, and as the store writes it.
pub(crate) struct Due {
    pub(crate) instant: Instant,
    pub(crate) at: String,
}

impl Due {
    /// Caps an inbox wait at the same whole call budget as a send, including its answer grace.
    pub(super) fn inbox_wait(until: Instant) -> Instant {
        until.min(Instant::now() + DELIVERY_TIME + RESPONSE_GRACE * 2)
    }

    /// A whole delivery's time from now.
    pub(crate) fn now() -> Due {
        Due::within(None)
    }

    /// Projects the caller's bounded deadline to the time kept in the store.
    pub(crate) fn until(deadline: Instant) -> Due {
        let left = deadline.saturating_duration_since(Instant::now());
        Due {
            instant: deadline,
            at: facade_base::time::iso_time(SystemTime::now() + left),
        }
    }

    /// What is left of a send's 30 seconds, `time_left_ms` as the call reached the daemon, and never
    /// more than [`delivery_limit`]: the rest went on the way (RULES-1.2).
    pub(crate) fn within(time_left_ms: Option<u64>) -> Due {
        let limit = delivery_limit();
        let left = time_left_ms.map_or(limit, |ms| limit.min(Duration::from_millis(ms)));
        Due {
            instant: Instant::now() + left,
            at: facade_base::time::iso_time(SystemTime::now() + left),
        }
    }
}
