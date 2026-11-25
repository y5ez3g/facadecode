//! What a connection sends: its lines in order, at most [`MAX_OUTBOX_BYTES`] of them waiting.

use std::io;
use std::sync::Arc;

use facade_base::api_v1::daemon::{ChangedParams, methods};
use facade_base::api_v1::{ErrorBody, Notification, Response, encode_line};
use facade_base::sockets::ServerWriter;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinHandle;

/// The most bytes waiting to be written on one connection. A sender waits for room; a longer line
/// waits until it is alone.
pub(crate) const MAX_OUTBOX_BYTES: usize = 8 * 1024 * 1024;

/// The room a line takes while it waits.
fn weight(bytes: usize) -> u32 {
    bytes.clamp(1, MAX_OUTBOX_BYTES) as u32
}

/// The sending side of a connection. Clones send into the same order.
#[derive(Clone)]
pub(crate) struct Outbox {
    lines: mpsc::UnboundedSender<Vec<u8>>,
    room: Arc<Semaphore>,
}

/// Room held for one complete response, until it is enqueued or the effect is abandoned.
pub(crate) struct OutboxRoom {
    lines: mpsc::UnboundedSender<Vec<u8>>,
    permit: OwnedSemaphorePermit,
}

impl OutboxRoom {
    pub(crate) fn fits(&self, bytes: usize) -> bool {
        self.permit.num_permits() >= weight(bytes) as usize
    }

    pub(crate) fn send(mut self, line: Vec<u8>) -> bool {
        let used = self
            .permit
            .split(weight(line.len()) as usize)
            .expect("reply room reserved");
        if self.lines.send(line).is_err() {
            return false;
        }
        used.forget();
        true
    }
}

impl Outbox {
    #[cfg(test)]
    pub(crate) fn for_test() -> (Outbox, impl FnMut() -> Vec<u8>) {
        let (lines, mut waiting) = mpsc::unbounded_channel::<Vec<u8>>();
        let room = Arc::new(Semaphore::new(MAX_OUTBOX_BYTES));
        let outbox = Outbox {
            lines,
            room: room.clone(),
        };
        let drain = move || {
            let line = waiting.try_recv().expect("a queued response");
            room.add_permits(weight(line.len()) as usize);
            line
        };
        (outbox, drain)
    }

    /// Starts writing to `write`. After all queued lines are sent, the task gives back the
    /// writer. If the client stops reading, senders waiting for room learn the outbox closed.
    pub(super) fn open(mut write: ServerWriter) -> (Outbox, JoinHandle<io::Result<ServerWriter>>) {
        let (lines, mut waiting) = mpsc::unbounded_channel::<Vec<u8>>();
        let room = Arc::new(Semaphore::new(MAX_OUTBOX_BYTES));
        let freed = room.clone();
        let writer = tokio::spawn(async move {
            while let Some(line) = waiting.recv().await {
                if let Err(error) = write.write_all(&line).await {
                    freed.close();
                    return Err(error);
                }
                freed.add_permits(weight(line.len()) as usize);
            }
            freed.close();
            Ok(write)
        });
        (Outbox { lines, room }, writer)
    }

    /// Sends `line` once there is room. False once the connection closed.
    pub(super) async fn send(&self, line: Vec<u8>) -> bool {
        self.reserve(line.len())
            .await
            .is_ok_and(|room| room.send(line))
    }

    pub(crate) fn try_reserve(
        &self,
        bytes: usize,
    ) -> Result<OutboxRoom, tokio::sync::TryAcquireError> {
        let permit = self.room.clone().try_acquire_many_owned(weight(bytes))?;
        Ok(OutboxRoom {
            lines: self.lines.clone(),
            permit,
        })
    }

    pub(crate) async fn reserve(
        &self,
        bytes: usize,
    ) -> Result<OutboxRoom, tokio::sync::AcquireError> {
        let permit = self.room.clone().acquire_many_owned(weight(bytes)).await?;
        Ok(OutboxRoom {
            lines: self.lines.clone(),
            permit,
        })
    }

    /// Wakes blocked senders without retaining a sender or keeping the writer alive.
    pub(super) fn close_handle(&self) -> impl FnOnce() + Send + 'static {
        let room = self.room.clone();
        move || room.close()
    }

    /// Answers request `id`. A notification gets no answer.
    pub(super) async fn answer(&self, id: Option<u64>, result: Result<Value, ErrorBody>) {
        let Some(id) = id else { return };
        let response = match result {
            Ok(result) => Response::ok(id, result),
            Err(error) => Response::failed(Some(id), error),
        };
        self.send(encode_line(&response)).await;
    }

    /// Answers a malformed frame, echoing its ID if the decoder could identify it.
    pub(super) async fn fail(&self, id: Option<u64>, error: ErrorBody) {
        self.send(encode_line(&Response::failed(id, error))).await;
    }

    /// Sends a change of watch `watch`. False once the connection closed.
    pub(super) async fn change(&self, watch: u64, change: Value) -> bool {
        let params = ChangedParams { watch, change };
        self.send(encode_line(&Notification::new(methods::CHANGED, params)))
            .await
    }
}
