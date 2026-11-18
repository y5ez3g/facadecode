//! Keeping and settling a message to the person under one number.

use facade_base::daemon::{Message, SendOutcome, WindowDeliveryOutcome};
use facade_base::jsonrpc::{ErrorBody, Reason, SendFailure};
use facade_base::machine::{ExecutionOutcome, Unavailable};
use tokio::sync::watch;

use super::{Messages, PostedHuman, number};
use crate::blocking_in_place;
use crate::store::Kept;

/// Answers from the saved receipts, including when a delivery may have reached a window.
pub(crate) fn human_result(send: SendOutcome) -> Result<SendOutcome, SendFailure> {
    if send
        .window_delivery
        .as_ref()
        .is_some_and(|outcomes| outcomes.iter().any(WindowDeliveryOutcome::is_delivered))
    {
        return Ok(send);
    }
    let mut error = ErrorBody::new(
        Reason::Unavailable,
        "the message was kept and its window delivery outcome is unknown",
    );
    error.data.unavailable = Some(Unavailable {
        execution: ExecutionOutcome::OutcomeUnknown,
        machine: None,
        window: None,
        matches: Vec::new(),
        unanswered: Vec::new(),
    });
    error.data.message_ref = send.message.message_ref;
    Err(SendFailure {
        error,
        window_delivery: send.window_delivery,
    })
}

pub(crate) fn no_window_delivery(outcomes: Vec<WindowDeliveryOutcome>) -> SendFailure {
    SendFailure {
        error: ErrorBody::new(
            Reason::Unavailable,
            "no member window could tell the person",
        ),
        window_delivery: Some(outcomes),
    }
}

impl Messages {
    /// Keeps a pending message for the person and lets repeats join its settlement. The caller
    /// delivers it to the subscribed windows once it has its number.
    pub(crate) fn begin_human(
        &self,
        message: Message,
        request_id: Option<&str>,
    ) -> Result<PostedHuman, ErrorBody> {
        let mut open = self.deliveries.lock();
        Ok(match self.deliveries.keep(&message, request_id, None)? {
            Kept::New(mut message) => {
                self.deliveries.identify(&mut message);
                open.human.insert(number(&message), watch::channel(None).0);
                PostedHuman::New(message)
            }
            Kept::Earlier(kept) => PostedHuman::Earlier(self.deliveries.earlier(&open, kept)),
        })
    }

    /// Commits the window receipts before answering. A repeat gets the kept message, including
    /// its pending status and receipts when delivery could not be confirmed.
    pub(crate) fn finish_human(
        &self,
        message: &Message,
        outcomes: Vec<WindowDeliveryOutcome>,
    ) -> Result<SendOutcome, SendFailure> {
        let number = number(message);
        let mut open = self.deliveries.lock();
        let result = self
            .save_human_receipt(number, outcomes)
            .and_then(human_result);
        if let Some(settled) = open.human.remove(&number) {
            let repeated = result.clone().map(|send| SendOutcome {
                repeated: true,
                ..send
            });
            settled.send_replace(Some(repeated));
        }
        result
    }

    fn save_human_receipt(
        &self,
        number: u64,
        outcomes: Vec<WindowDeliveryOutcome>,
    ) -> Result<SendOutcome, SendFailure> {
        let table = &self.deliveries.table;
        if outcomes
            .iter()
            .all(|outcome| matches!(outcome, WindowDeliveryOutcome::NotDelivered { .. }))
        {
            blocking_in_place(|| table.delete_message(number)).map_err(ErrorBody::internal)?;
            return Err(no_window_delivery(outcomes));
        }
        let mut message = blocking_in_place(|| table.settle_human(number, &outcomes))
            .map_err(ErrorBody::internal)?;
        self.deliveries.identify(&mut message);
        Ok(SendOutcome {
            message,
            repeated: false,
            withdrawn: false,
            window_delivery: Some(outcomes),
        })
    }
}
