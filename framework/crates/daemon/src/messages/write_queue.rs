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

pub(super) struct ReadyBatch<T> {
    pub(super) jobs: Vec<T>,
    pub(super) budget: BatchBudget,
}

#[derive(Default)]
pub(super) struct BatchBudget {
    operations: usize,
    bytes: usize,
}

impl BatchBudget {
    fn take<T>(
        &mut self,
        state: &mut QueueState<T>,
        turn: &mut usize,
        eligible: impl FnOnce(usize, &T) -> bool,
    ) -> Option<T> {
        if self.operations == MAX_BATCH_OPERATIONS {
            return None;
        }
        let closing = Lane::Closing as usize;
        let index = [closing, *turn, 1 - *turn].into_iter().find(|&lane| {
            state.ready[lane]
                .front()
                .is_some_and(|job| self.bytes + job.bytes <= MAX_BATCH_BYTES)
        })?;
        let queue = &mut state.ready[index];
        if !eligible(index, &queue.front()?.value) {
            return None;
        }
        let job = queue.pop_front().expect("selected a ready operation");
        if index != closing {
            *turn = 1 - index;
        }
        self.operations += 1;
        self.bytes += job.bytes;
        Some(job.value)
    }
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
    /// Takes the initial ready work immediately when the first operation arrives.
    pub(super) fn batch(&mut self) -> Option<ReadyBatch<T>> {
        let mut state = self.shared.state.lock().unwrap();
        while state.ready.iter().all(VecDeque::is_empty) {
            if state.closed {
                return None;
            }
            state = self.shared.changed.wait(state).unwrap();
        }

        let ready =
            crate::trace_message_batches().then(|| state.ready.each_ref().map(VecDeque::len));
        let mut jobs = Vec::new();
        let mut budget = BatchBudget::default();
        while let Some(job) = budget.take(&mut state, &mut self.next_lane, |_, _| true) {
            jobs.push(job);
        }
        drop(state);
        if let Some([ordinary, ordered, closing]) = ready {
            crate::log(
                "info",
                &format!(
                    "message batch ready: ordinary={ordinary} ordered={ordered} closing={closing} selected={} bytes={}",
                    jobs.len(),
                    budget.bytes,
                ),
            );
        }
        Some(ReadyBatch { jobs, budget })
    }

    /// After staging, adds only prepared ordinary work that would go next. The writer holds the
    /// database connection here, so use one try-lock and the initial selection's remaining budget.
    pub(super) fn take_ready_ordinary(
        &mut self,
        budget: &mut BatchBudget,
        prepared: impl Fn(&T) -> bool,
    ) -> Vec<T> {
        let Ok(mut state) = self.shared.state.try_lock() else {
            return Vec::new();
        };
        let mut jobs = Vec::new();
        while let Some(job) = budget.take(&mut state, &mut self.next_lane, |lane, job| {
            lane == Lane::Ordinary as usize && prepared(job)
        }) {
            jobs.push(job);
        }
        jobs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn staging_leaves_the_next_ordered_or_closing_job_in_front() {
        let (queue, mut ready) = WriteQueue::new();
        queue.push(1, Lane::Ordinary, 1, None, None).await.unwrap();
        let mut batch = ready.batch().unwrap();
        queue.push(2, Lane::Ordinary, 1, None, None).await.unwrap();
        queue.push(3, Lane::Ordered, 1, None, None).await.unwrap();
        assert!(
            ready
                .take_ready_ordinary(&mut batch.budget, |_| true)
                .is_empty()
        );
        queue.push(4, Lane::Closing, 0, None, None).await.unwrap();
        assert!(
            ready
                .take_ready_ordinary(&mut batch.budget, |_| true)
                .is_empty()
        );
        assert_eq!(ready.batch().unwrap().jobs, [4, 3, 2]);
    }

    #[tokio::test]
    async fn staging_spends_only_the_batch_budget_that_remains() {
        let (queue, mut ready) = WriteQueue::new();
        queue.push(1, Lane::Ordinary, 2, None, None).await.unwrap();
        queue.push(2, Lane::Ordinary, 1, None, None).await.unwrap();
        let mut budget = BatchBudget {
            operations: MAX_BATCH_OPERATIONS - 1,
            bytes: MAX_BATCH_BYTES - 1,
        };
        assert!(ready.take_ready_ordinary(&mut budget, |_| true).is_empty());
        budget.bytes -= 2;
        assert_eq!(ready.take_ready_ordinary(&mut budget, |_| true), [1]);
        assert_eq!(ready.batch().unwrap().jobs, [2]);
    }
}
