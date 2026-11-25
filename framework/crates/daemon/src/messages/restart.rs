//! Taking up, after a restart, the messages the daemon before left pending.

use std::time::{Duration, SystemTime};

use facade_base::model::message::{DeliveryFailure, Message, TextWritten};
use tokio::sync::watch;

use super::{Deliveries, Messages, Outcome, OwedResult, Settled};
use crate::store::{KeptMessage, KeptPaste};
use crate::{HUMAN, blocking_in_place, delivery_ceiling, delivery_limit};

impl Messages {
    /// The agent messages the daemon before this one left pending, oldest first, each with the
    /// paste it went in. A pending message to the person still answers its request ID as it stands.
    pub(crate) fn pending(&self) -> anyhow::Result<Vec<KeptMessage>> {
        let mut pending = blocking_in_place(|| self.deliveries.table.pending_messages())?;
        pending.retain(|kept| kept.message.to != HUMAN);
        Ok(pending)
    }

    /// Gives the typists their remaining cleanup work without reopening a receipt.
    pub(crate) fn settled_cleanups(&self) -> anyhow::Result<Vec<(String, u64)>> {
        blocking_in_place(|| self.deliveries.table.settled_cleanups())
    }

    /// Every message in the paste, in order, with the evidence the old daemon left.
    pub(crate) fn paste_messages(&self, paste: u64) -> anyhow::Result<KeptPaste> {
        blocking_in_place(|| self.deliveries.table.paste_messages(paste))
    }

    /// Opens again the delivery of `message`, which the daemon before left pending: its paste begun
    /// where `pasted`, with the startup prompt and its result debt where applicable.
    pub(crate) fn take_up(
        &self,
        mut message: Message,
        pasted: bool,
        prompt: bool,
        owes: Option<OwedResult>,
    ) -> watch::Receiver<Option<Settled>> {
        let mut open = self.deliveries.lock();
        self.deliveries.identify(&mut message);
        Deliveries::open(&mut open.agents, message, pasted, prompt, owes)
    }
}

/// What a restart does with a message the daemon before left pending.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TakeUp {
    /// It ends now.
    Settle(Outcome),
    /// Its recipient's typist delivers it, with this much of its time left.
    Type(Duration),
    /// Its recipient's typist finishes paste `paste`, the one it went in, with `left` of its time.
    FinishPaste { paste: u64, left: Duration },
    /// It waits in its recipient's inbox for a read, prompt or turn-end take, with this much of its
    /// time left.
    Wait(Duration),
}

/// Where the recipient of a pending message is at a restart.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Recipient {
    /// Listed and running.
    Running,
    /// Listed and ended.
    Ended,
    /// Not listed: an agent whose record this build cannot read.
    NotListed,
}

/// What becomes of pending `message`, in `paste` where its paste began before the restart, its
/// recipient as `recipient` says, at `now`.
pub(crate) fn decide(
    message: &Message,
    paste: Option<u64>,
    recipient: Recipient,
    now: SystemTime,
) -> TakeUp {
    if let Recipient::Ended = recipient {
        return TakeUp::Settle(match paste {
            Some(_) => Outcome::Failed {
                reason: DeliveryFailure::Ended,
                text_written: TextWritten::Unknown,
                enter_written: None,
            },
            None => Outcome::untyped(DeliveryFailure::Ended),
        });
    }
    let left = time_left(message, now);
    if let (Recipient::Running, Some(paste)) = (recipient, paste) {
        // Even an expired paste can leave its own draft in this terminal.
        return TakeUp::FinishPaste { paste, left };
    }
    if left.is_zero() {
        return TakeUp::Settle(match paste {
            Some(_) => Outcome::UNCONFIRMED,
            None => Outcome::untyped(DeliveryFailure::Timeout),
        });
    }
    match recipient {
        Recipient::NotListed => TakeUp::Wait(left),
        _ => TakeUp::Type(left),
    }
}

/// What is left at `now` of `message`'s deadline, at most [`delivery_ceiling`]: a restart never
/// lengthens it. A start's prompt kept while its CLI's tools connected has no deadline yet and gets
/// a whole delivery's time; a deadline that cannot be read has passed.
fn time_left(message: &Message, now: SystemTime) -> Duration {
    let Some(deadline) = message.delivery.deadline.as_deref() else {
        return delivery_limit();
    };
    facade_base::time::parse_iso_time(deadline)
        .and_then(|deadline| deadline.duration_since(now).ok())
        .unwrap_or_default()
        .min(delivery_ceiling())
}
