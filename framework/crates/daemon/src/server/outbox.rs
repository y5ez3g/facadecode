//! What a connection sends: its lines in order, at most [`MAX_OUTBOX_BYTES`] of them waiting.

use std::io;
use std::sync::Arc;

use facade_base::api_v1::daemon::{ChangedParams, methods};
use facade_base::api_v1::{ErrorBody, Notification, Response, encode_line};
use facade_base::sockets::ServerWriter;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;

/// The most bytes waiting to be written on one connection. A sender waits for room; a longer line
/// waits until it is alone.
const MAX_OUTBOX_BYTES: usize = 8 * 1024 * 1024;

/// The room a line takes while it waits.
fn weight(line: &[u8]) -> u32 {
    line.len().clamp(1, MAX_OUTBOX_BYTES) as u32
}

/// The sending side of a connection. Clones send into the same order.
#[derive(Clone)]
pub(super) struct Outbox {
    lines: mpsc::UnboundedSender<Vec<u8>>,
    room: Arc<Semaphore>,
}

impl Outbox {
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
                freed.add_permits(weight(&line) as usize);
            }
            freed.close();
            Ok(write)
        });
        (Outbox { lines, room }, writer)
    }

    /// Sends `line` once there is room. False once the connection closed.
    pub(super) async fn send(&self, line: Vec<u8>) -> bool {
        let Ok(taken) = self.room.acquire_many(weight(&line)).await else {
            return false;
        };
        taken.forget();
        self.lines.send(line).is_ok()
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
