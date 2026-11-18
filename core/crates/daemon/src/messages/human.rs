//! Keeping and settling a message to the person under one number.

use facade_base::daemon::{Message, SendResult, WindowDelivery};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::machine::{ExecutionOutcome, Unavailable};
use tokio::sync::watch;

use super::{Messages, PostedHuman, number};
use crate::blocking_in_place;
use crate::store::Kept;

/// Answers from the saved receipts, including when a delivery may have reached a window.
pub(crate) fn human_result(send: SendResult) -> Result<SendResult, ErrorBody> {
    if send
        .windows
        .as_ref()
        .is_some_and(|windows| !windows.delivered.is_empty())
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
    error.data.window_delivery = send.windows;
    Err(error)
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
        windows: WindowDelivery,
    ) -> Result<SendResult, ErrorBody> {
        let number = number(message);
        let mut open = self.deliveries.lock();
        let result = self
            .save_human_receipt(number, windows)
            .and_then(human_result);
        if let Some(settled) = open.human.remove(&number) {
            let repeated = result.clone().map(|send| SendResult {
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
        windows: WindowDelivery,
    ) -> Result<SendResult, ErrorBody> {
        let table = &self.deliveries.table;
        if windows.delivered.is_empty() && windows.outcome_unknown.is_empty() {
            blocking_in_place(|| table.delete_message(number)).map_err(ErrorBody::internal)?;
            let mut error = ErrorBody::new(
                Reason::Unavailable,
                "no member window could tell the person",
            );
            error.data.windows = Some(windows.not_delivered);
            return Err(error);
        }
        let mut message = blocking_in_place(|| table.settle_human(number, &windows))
            .map_err(ErrorBody::internal)?;
        self.deliveries.identify(&mut message);
        Ok(SendResult {
            message,
            repeated: false,
            withdrawn: false,
            windows: Some(windows),
        })
    }
}
