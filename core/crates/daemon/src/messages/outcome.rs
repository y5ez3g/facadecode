//! How a delivery ends, and by when it must.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use facade_base::daemon::{DeliveredVia, Delivery, DeliveryFailure, DeliveryStatus, TextWritten};
use tokio::time::Instant;

use super::DELIVERY_TIME;

/// How a delivery ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Typed and submitted.
    Typed,
    /// Not delivered. `text_written` says how much of it reached the terminal; `enter_written` is
    /// None where nobody knows whether its Enter did.
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

    /// Whether this failure takes a sent message back out of its inbox: its recipient's CLI could
    /// not take it in time and none of it was typed, so its sender can simply send it again.
    pub(super) fn withdraws(self) -> bool {
        matches!(
            self,
            Outcome::Failed {
                reason: DeliveryFailure::Timeout
                    | DeliveryFailure::InputDraft
                    | DeliveryFailure::InputInteraction
                    | DeliveryFailure::InputUnknown,
                text_written: TextWritten::None,
                ..
            }
        )
    }

    /// The delivery this outcome records, ending at `at`.
    pub(super) fn delivery(self, at: &str) -> Delivery {
        let (status, reason, text_written, enter_written, delivered_via, delivered_at) = match self
        {
            Outcome::Typed => (
                DeliveryStatus::Success,
                None,
                TextWritten::Full,
                Some(true),
                Some(DeliveredVia::Terminal),
                Some(at.to_string()),
            ),
            Outcome::Failed {
                reason,
                text_written,
                enter_written,
            } => (
                DeliveryStatus::Failure,
                Some(reason),
                text_written,
                enter_written,
                None,
                None,
            ),
        };
        Delivery {
            status,
            reason,
            text_written,
            enter_written,
            deadline: None,
            delivered_via,
            delivered_at,
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
        delivered_via: Some(DeliveredVia::Read),
        delivered_at: Some(at.to_string()),
    }
}

/// When a delivery beginning now must end: on the daemon's clock, and as the store writes it.
pub(crate) struct Due {
    pub(crate) instant: Instant,
    pub(crate) at: String,
}

impl Due {
    /// A whole delivery's time from now.
    pub(crate) fn now() -> Due {
        Due::within(None)
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

/// The longest a message may take from its call reaching the daemon to its delivery. A debug build
/// reads a longer one from `FACADE_TEST_DELIVERY_MS`, once.
pub(crate) fn delivery_limit() -> Duration {
    static LIMIT: OnceLock<Duration> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        #[cfg(debug_assertions)]
        if let Some(ms) = std::env::var("FACADE_TEST_DELIVERY_MS")
            .ok()
            .and_then(|ms| ms.parse::<u64>().ok())
        {
            return Duration::from_millis(ms);
        }
        DELIVERY_TIME
    })
}
