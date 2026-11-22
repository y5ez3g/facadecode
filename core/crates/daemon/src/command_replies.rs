//! Replies to a command-line send are owned by the daemon serving that command.

use std::collections::{HashMap, hash_map::Entry};
use std::sync::Mutex;

use facade_base::model::agent::AgentRef;
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::message::MessageRef;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::Cancel;

#[derive(Default)]
pub(super) struct CommandReplies(Mutex<HashMap<String, Waiting>>);

struct Waiting {
    recipient: AgentRef,
    until: Instant,
    cancel: Cancel,
    answer: Option<oneshot::Sender<Answer>>,
}

pub(super) struct Answer {
    pub(super) original: MessageRef,
    pub(super) reference: MessageRef,
    pub(super) text: String,
}

/// Lives on the call that sent the original message and removes its entry when that call ends.
pub(super) struct CommandWait<'a> {
    replies: &'a CommandReplies,
    request_id: String,
    pub(super) reply: oneshot::Receiver<Answer>,
}

impl CommandReplies {
    pub(super) fn begin(
        &self,
        request_id: &str,
        recipient: AgentRef,
        until: Instant,
        cancel: Cancel,
    ) -> Result<CommandWait<'_>, ErrorBody> {
        let mut waiting = self.0.lock().unwrap();
        let Entry::Vacant(entry) = waiting.entry(request_id.to_owned()) else {
            return Err(ErrorBody::invalid_argument(
                "this command-line request ID is already in use",
            ));
        };
        let (answer, reply) = oneshot::channel();
        entry.insert(Waiting {
            recipient,
            until,
            cancel,
            answer: Some(answer),
        });
        Ok(CommandWait {
            replies: self,
            request_id: request_id.to_owned(),
            reply,
        })
    }

    /// Hands off the first reply while the command is waiting. A successful send to the
    /// command's receiver is the acknowledgement returned to the machine that numbered it.
    pub(super) fn accept(
        &self,
        request_id: &str,
        sender: &AgentRef,
        answer: Answer,
    ) -> Result<(), ErrorBody> {
        if answer.original.machine_id != sender.machine_id
            || answer.reference.machine_id != sender.machine_id
            || answer.reference == answer.original
        {
            return Err(ErrorBody::invalid_argument(
                "the original and reply must be distinct messages on the replying agent's machine",
            ));
        }
        let mut waiting = self.0.lock().unwrap();
        let waiter = waiting
            .get_mut(request_id)
            .ok_or_else(|| ended(&answer.original))?;
        if &waiter.recipient != sender {
            return Err(ErrorBody::refused(
                "only the original recipient can answer the command line",
            ));
        }
        if waiter.until <= Instant::now() || waiter.cancel.is_requested() {
            return Err(ended(&answer.original));
        }
        waiter
            .answer
            .take()
            .ok_or_else(|| ended(&answer.original))?
            .send(answer)
            .map_err(|answer| ended(&answer.original))
    }
}

fn ended(original: &MessageRef) -> ErrorBody {
    ErrorBody::new(
        Reason::Ended,
        format!(
            "The command line is no longer waiting for a reply to {}@{}.",
            original.message_id, original.machine_id,
        ),
    )
}

impl Drop for CommandWait<'_> {
    fn drop(&mut self) {
        self.replies.0.lock().unwrap().remove(&self.request_id);
    }
}
