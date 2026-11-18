//! Keeping and settling a message to the person under one number.

use facade_base::daemon::{Message, SendResult, WindowDelivery};
use facade_base::jsonrpc::{ErrorBody, Reason};
use tokio::sync::watch;

use super::{Messages, PostedHuman, earlier, number};
use crate::blocking_in_place;
use crate::store::Kept;

impl Messages {
    /// Keeps a pending message for the person and lets repeats join its settlement. The caller
    /// delivers it to the subscribed windows once it has its number.
    pub(crate) fn begin_human(
        &self,
        message: Message,
        request_id: Option<&str>,
    ) -> Result<PostedHuman, ErrorBody> {
        let mut open = self.deliveries.lock();
        Ok(match self.deliveries.keep(&message, request_id)? {
            Kept::New(message) => {
                open.human.insert(number(&message), watch::channel(None).0);
                PostedHuman::New(message)
            }
            Kept::Earlier(kept) => PostedHuman::Earlier(earlier(&open, kept)),
        })
    }

    /// Records which windows took the message, or withdraws it if none did. Repeats are answered
    /// after the table write, with the same outcome.
    pub(crate) fn finish_human(
        &self,
        message: &Message,
        windows: WindowDelivery,
    ) -> Result<SendResult, ErrorBody> {
        let number = number(message);
        let mut open = self.deliveries.lock();
        let table = &self.deliveries.table;
        let result = blocking_in_place(|| {
            if windows.delivered.is_empty() {
                table.delete_message(number).map_err(ErrorBody::internal)?;
                let mut error = ErrorBody::new(
                    Reason::Unavailable,
                    "no member window could tell the person",
                );
                error.data.windows = Some(windows.not_delivered);
                return Err(error);
            }
            let message = table
                .settle_human(number, &windows)
                .map_err(ErrorBody::internal)?;
            Ok(SendResult {
                message,
                repeated: false,
                withdrawn: false,
                windows: Some(windows),
            })
        });
        if let Some(settled) = open.human.remove(&number) {
            let repeated = result.clone().map(|send| SendResult {
                repeated: true,
                ..send
            });
            settled.send_replace(Some(repeated));
        }
        result
    }
}
