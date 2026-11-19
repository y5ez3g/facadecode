//! The answer to a repeated send of a message to the person, from its saved window receipts.

use facade_base::daemon::{SendOutcome, WindowDeliveryOutcome};
use facade_base::jsonrpc::{ErrorBody, Reason, SendFailure};
use facade_base::machine::{ExecutionOutcome, Unavailable};

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
