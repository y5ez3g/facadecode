//! Capacity and ordering for the message writer's ready operations.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_BATCH_OPERATIONS: usize = 128;
const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum Lane {
    Ordinary = 0,
    Ordered = 1,
    Closing = 2,
}

/// The identity of an operation that can still be removed while queued.
#[derive(Clone, Default)]
pub(super) struct QueueKey(Arc<()>);

struct Capacity {
    operations: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
}

impl Capacity {
    fn new(operations: usize, bytes: usize) -> Self {
        Self {
            operations: Arc::new(Semaphore::new(operations)),
            bytes: Arc::new(Semaphore::new(bytes)),
        }
    }
}

struct Queued<T> {
    value: T,
    key: Option<QueueKey>,
    bytes: usize,
    _operations: OwnedSemaphorePermit,
    _space: OwnedSemaphorePermit,
}

struct QueueState<T> {
    ready: [VecDeque<Queued<T>>; 3],
    closed: bool,
}

struct Shared<T> {
    state: Mutex<QueueState<T>>,
    changed: Condvar,
}

pub(super) struct WriteQueue<T> {
    shared: Arc<Shared<T>>,
    capacity: [Capacity; 3],
}

pub(super) struct ReadyWrites<T> {
    shared: Arc<Shared<T>>,
    next_lane: usize,
}

impl<T> WriteQueue<T> {
    pub(super) fn new() -> (Self, ReadyWrites<T>) {
        let shared = Arc::new(Shared {
            state: Mutex::new(QueueState {
                ready: Default::default(),
                closed: false,
            }),
            changed: Condvar::new(),
        });
        (
            Self {
                shared: shared.clone(),
                capacity: [
                    Capacity::new(64, MAX_BATCH_BYTES / 2),
                    Capacity::new(48, MAX_BATCH_BYTES / 2),
                    Capacity::new(16, 0),
                ],
            },
            ReadyWrites {
                shared,
                next_lane: Lane::Ordinary as usize,
            },
        )
    }

    /// Both permits stay with the request while it waits. Cancelling this future returns the
    /// permits it acquired. Closed means the operation has not entered the writer.
    pub(super) async fn push(
        &self,
        value: T,
        lane: Lane,
        bytes: usize,
        key: Option<QueueKey>,
        traced_request: Option<&str>,
    ) -> Result<(), ()> {
        let budget = if matches!(lane, Lane::Closing) {
            0
        } else {
            MAX_BATCH_BYTES / 2
        };
        assert!(bytes <= budget, "one valid operation must fit its lane");
        let capacity = &self.capacity[lane as usize];
        let operations = capacity
            .operations
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ())?;
        let space = capacity
            .bytes
            .clone()
            .acquire_many_owned(bytes as u32)
            .await
            .map_err(|_| ())?;
        let mut state = self.shared.state.lock().unwrap();
        if state.closed {
            return Err(());
        }
        state.ready[lane as usize].push_back(Queued {
            value,
            key,
            bytes,
            _operations: operations,
            _space: space,
        });
        let queued_at = traced_request.map(|_| facade_base::time::iso_now());
        drop(state);
        self.shared.changed.notify_one();
        if let (Some(id), Some(queued_at)) = (traced_request, queued_at) {
            crate::log(
                "info",
                &format!("message send queued: request={id} queued_at={queued_at}"),
            );
        }
        Ok(())
    }

    pub(super) fn discard(&self, key: &QueueKey) {
        let removed = self
            .shared
            .state
            .lock()
            .unwrap()
            .ready
            .iter_mut()
            .find_map(|queue| {
                let index = queue.iter().position(|entry| {
                    entry
                        .key
                        .as_ref()
                        .is_some_and(|queued| Arc::ptr_eq(&queued.0, &key.0))
                })?;
                queue.remove(index)
            });
        drop(removed);
    }
}

impl<T> Drop for WriteQueue<T> {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().closed = true;
        self.shared.changed.notify_one();
    }
}

impl<T> Drop for ReadyWrites<T> {
    fn drop(&mut self) {
        let ready = {
            let mut state = self.shared.state.lock().unwrap();
            state.closed = true;
            std::mem::take(&mut state.ready)
        };
        drop(ready);
    }
}

impl<T> ReadyWrites<T> {
    /// Waits for one operation, then fixes the batch at the ready boundary. The first operation
    /// never waits for a timer or for additional traffic. A second batch can queue during COMMIT.
    pub(super) fn batch(&mut self) -> Option<Vec<T>> {
        let mut state = self.shared.state.lock().unwrap();
        while state.ready.iter().all(VecDeque::is_empty) {
            if state.closed {
                return None;
            }
            state = self.shared.changed.wait(state).unwrap();
        }

        let ready =
            crate::trace_message_batches().then(|| state.ready.each_ref().map(VecDeque::len));
        let mut values = Vec::new();
        let mut bytes = 0;
        while values.len() < MAX_BATCH_OPERATIONS {
            let [first, second] = [self.next_lane, 1 - self.next_lane];
            let Some(index) = [Lane::Closing as usize, first, second]
                .into_iter()
                .find(|&lane| {
                    state.ready[lane]
                        .front()
                        .is_some_and(|job| bytes + job.bytes <= MAX_BATCH_BYTES)
                })
            else {
                break;
            };
            let job = state.ready[index]
                .pop_front()
                .expect("selected a ready operation");
            if index != Lane::Closing as usize {
                self.next_lane = 1 - index;
            }
            bytes += job.bytes;
            values.push(job.value);
        }
        drop(state);
        if let Some([ordinary, ordered, closing]) = ready {
            crate::log(
                "info",
                &format!(
                    "message batch ready: ordinary={ordinary} ordered={ordered} closing={closing} selected={} bytes={bytes}",
                    values.len(),
                ),
            );
        }
        Some(values)
    }
}
