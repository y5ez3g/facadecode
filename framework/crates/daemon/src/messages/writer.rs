//! Runs and publishes message operations in durable batch order.

use std::future::{Future, pending};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use facade_base::model::error::{ErrorBody, Reason};
use rusqlite::Connection;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::time::Instant;

use super::write_queue::{BatchBudget, Lane, QueueKey, ReadyBatch, ReadyWrites, WriteQueue};
use crate::Cancel;
use crate::store::{Batch, BatchResult, CommitUnknown, MessageTable};

#[derive(Clone)]
pub(super) enum Committed {
    Yes,
    No(ErrorBody),
    Unknown(ErrorBody),
}

impl Committed {
    pub(super) fn require(self) -> Result<(), ErrorBody> {
        match self {
            Self::Yes => Ok(()),
            Self::No(error) | Self::Unknown(error) => Err(error),
        }
    }
}

pub(super) enum CommitEvidence {
    Before,
    After,
    Same,
    Unrecognized,
}

pub(super) type Witness = Box<dyn FnOnce(&Connection) -> rusqlite::Result<CommitEvidence> + Send>;

pub(super) struct Prepared<T> {
    pub(super) witness: Option<Witness>,
    pub(super) finish: Box<dyn FnOnce(Committed) -> Result<T, ErrorBody> + Send>,
}

impl<T: Send + 'static> Prepared<T> {
    pub(super) fn known(result: Result<T, ErrorBody>) -> Self {
        Self {
            witness: None,
            finish: Box::new(move |_| result),
        }
    }

    pub(super) fn changed(
        states: impl FnOnce(&Connection) -> rusqlite::Result<(bool, bool)> + Send + 'static,
        finish: impl FnOnce(Committed) -> Result<T, ErrorBody> + Send + 'static,
    ) -> Self {
        Self {
            witness: Some(Box::new(move |connection| {
                Ok(match states(connection)? {
                    (true, true) => CommitEvidence::Same,
                    (true, false) => CommitEvidence::Before,
                    (false, true) => CommitEvidence::After,
                    (false, false) => CommitEvidence::Unrecognized,
                })
            })),
            finish: Box::new(finish),
        }
    }
}

trait BatchJob: Send {
    fn stage(&mut self, batch: &mut Batch<'_>) -> rusqlite::Result<()>;
    fn witness(&mut self) -> Option<Witness>;
    fn finish(self: Box<Self>, committed: Committed);
}

struct Operation<T, S> {
    stage: Option<S>,
    prepared: Option<Prepared<T>>,
    answer: oneshot::Sender<Result<T, ErrorBody>>,
}

impl<T, S> BatchJob for Operation<T, S>
where
    T: Send,
    S: FnOnce(&mut Batch<'_>) -> rusqlite::Result<Prepared<T>> + Send,
{
    fn stage(&mut self, batch: &mut Batch<'_>) -> rusqlite::Result<()> {
        let stage = self.stage.take().expect("each batch operation stages once");
        self.prepared = Some(stage(batch)?);
        Ok(())
    }

    fn witness(&mut self) -> Option<Witness> {
        self.prepared.as_mut()?.witness.take()
    }

    fn finish(self: Box<Self>, committed: Committed) {
        let result = match self.prepared {
            Some(prepared) => (prepared.finish)(committed),
            // Opening or staging the transaction can fail before this operation prepares.
            None => committed.require().and_then(|()| Err(ended())),
        };
        let _ = self.answer.send(result);
    }
}

type Start = Box<dyn FnOnce() -> Box<dyn BatchJob> + Send>;

enum BatchWork {
    Ready(Box<dyn BatchJob>),
    Prepare(Start),
}

impl BatchWork {
    fn start(self) -> Box<dyn BatchJob> {
        match self {
            Self::Ready(job) => job,
            Self::Prepare(start) => start(),
        }
    }
}

enum Work {
    Batch(BatchWork),
    Ordered(Box<dyn FnOnce() + Send>),
}
pub(super) type Ticket<T> = oneshot::Receiver<Result<T, ErrorBody>>;

pub(super) enum EffectStop {
    Cancelled,
    Expired,
    Frozen,
}

pub(super) enum Effect<T, P> {
    Answered(T),
    Stopped(P, EffectStop),
}

pub(super) type PendingEffect<P> = Arc<Mutex<Option<P>>>;

struct BeforeEffect<'writer, P> {
    writer: &'writer Writer,
    key: QueueKey,
    plan: PendingEffect<P>,
}

impl<P> BeforeEffect<'_, P> {
    fn withdraw(&self) -> Option<P> {
        let plan = self.plan.lock().unwrap().take();
        if plan.is_some() {
            self.writer.writes.discard(&self.key);
        }
        plan
    }
}

impl<P> Drop for BeforeEffect<'_, P> {
    fn drop(&mut self) {
        self.withdraw();
    }
}

pub(super) struct Writer {
    writes: WriteQueue<Work>,
    uncertain: Arc<AtomicBool>,
}

impl Writer {
    pub(super) fn new(table: MessageTable) -> std::io::Result<Self> {
        let (writes, mut reader) = WriteQueue::<Work>::new();
        let uncertain = Arc::new(AtomicBool::new(false));
        let worker_uncertain = uncertain.clone();
        std::thread::Builder::new()
            .name("facade-message-writer".into())
            .spawn(move || {
                while let Some(ReadyBatch { jobs, mut budget }) = reader.batch() {
                    if worker_uncertain.load(Ordering::Acquire) {
                        continue;
                    }
                    let mut batch = Vec::new();
                    for job in jobs {
                        match job {
                            Work::Batch(start) => batch.push(start),
                            Work::Ordered(run) => {
                                publish_batch(
                                    &table,
                                    std::mem::take(&mut batch),
                                    &worker_uncertain,
                                    None,
                                );
                                if !worker_uncertain.load(Ordering::Acquire) {
                                    run();
                                }
                            }
                        }
                    }
                    publish_batch(
                        &table,
                        batch,
                        &worker_uncertain,
                        Some((&mut reader, &mut budget)),
                    );
                }
            })?;
        Ok(Self { writes, uncertain })
    }

    pub(super) fn uncertain(&self) -> bool {
        self.uncertain.load(Ordering::Acquire)
    }

    pub(super) fn uncertainty_flag(&self) -> Arc<AtomicBool> {
        self.uncertain.clone()
    }

    /// Before this returns a ticket the operation can be dropped without taking effect. The
    /// ticket belongs to the writer after that, even if the caller can no longer hear its result.
    pub(super) async fn enqueue<T: Send + 'static>(
        &self,
        lane: Lane,
        bytes: usize,
        stage: impl FnOnce(&mut Batch<'_>) -> rusqlite::Result<Prepared<T>> + Send + 'static,
    ) -> Result<Ticket<T>, ErrorBody> {
        self.enqueue_prepared(lane, bytes, move || stage).await
    }

    /// Makes a plan from published in-memory facts before the batch acquires SQLite.
    pub(super) async fn enqueue_prepared<T, S>(
        &self,
        lane: Lane,
        bytes: usize,
        prepare: impl FnOnce() -> S + Send + 'static,
    ) -> Result<Ticket<T>, ErrorBody>
    where
        T: Send + 'static,
        S: FnOnce(&mut Batch<'_>) -> rusqlite::Result<Prepared<T>> + Send + 'static,
    {
        if self.uncertain() {
            return Err(unknown());
        }
        let (answer, ticket) = oneshot::channel();
        let start: Start = Box::new(move || {
            Box::new(Operation {
                stage: Some(prepare()),
                prepared: None,
                answer,
            })
        });
        self.writes
            .push(
                Work::Batch(BatchWork::Prepare(start)),
                lane,
                bytes,
                None,
                None,
            )
            .await
            .map_err(|()| ended())?;
        Ok(ticket)
    }

    /// A still-unclaimed plan can leave the queue, dropping its payload and capacity immediately.
    /// The writer takes the plan at its actual effect boundary. A read-only query can precede
    /// that boundary when the effect is publication itself.
    pub(super) async fn before_effect<T: Send + 'static, P: Send + 'static>(
        &self,
        lane: Lane,
        bytes: usize,
        plan: P,
        stop: impl Future<Output = EffectStop> + Send,
        traced_request: Option<&str>,
        stage: impl FnOnce(&mut Batch<'_>, PendingEffect<P>) -> rusqlite::Result<Prepared<T>>
        + Send
        + 'static,
    ) -> Result<Effect<T, P>, ErrorBody> {
        let guard = BeforeEffect {
            writer: self,
            key: QueueKey::default(),
            plan: Arc::new(Mutex::new(Some(plan))),
        };
        let candidate = guard.plan.clone();
        let waiting = async {
            if self.uncertain() {
                return Err(unknown());
            }
            let (reply, ticket) = oneshot::channel();
            let operation = Operation {
                stage: Some(move |batch: &mut Batch<'_>| stage(batch, candidate)),
                prepared: None,
                answer: reply,
            };
            self.writes
                .push(
                    Work::Batch(BatchWork::Ready(Box::new(operation))),
                    lane,
                    bytes,
                    Some(guard.key.clone()),
                    traced_request,
                )
                .await
                .map_err(|()| ended())?;
            answer(ticket).await
        };
        tokio::pin!(waiting);
        tokio::select! {
            biased;
            reason = stop => {
                if let Some(plan) = guard.withdraw() {
                    Ok(Effect::Stopped(plan, reason))
                } else {
                    waiting.await.map(Effect::Answered)
                }
            }
            answered = &mut waiting => answered.map(Effect::Answered),
        }
    }

    /// Applies an existing cross-table transaction and its publication between adjacent batches.
    pub(super) async fn ordered<T: Send + 'static>(
        &self,
        bytes: usize,
        apply: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
    ) -> Result<T, ErrorBody> {
        if self.uncertain() {
            return Err(unknown());
        }
        let (send, ticket) = oneshot::channel();
        let commit_uncertain = self.uncertain.clone();
        let job = Work::Ordered(Box::new(move || {
            let result = apply().map_err(|error| {
                if error.is::<CommitUnknown>() {
                    super::warn(&format!("{error:#}"));
                    commit_uncertain.store(true, Ordering::Release);
                    unknown()
                } else {
                    ErrorBody::internal(error)
                }
            });
            let _ = send.send(result);
        }));
        self.writes
            .push(job, Lane::Ordered, bytes, None, None)
            .await
            .map_err(|()| ended())?;
        answer(ticket).await
    }
}

pub(super) async fn stop_before_effect(
    until: Option<Instant>,
    mut cancel: Cancel,
    mut closing: Option<watch::Receiver<Option<Arc<str>>>>,
) -> EffectStop {
    tokio::select! {
        biased;
        () = cancel.requested() => EffectStop::Cancelled,
        () = async {
            if let Some(until) = until { tokio::time::sleep_until(until).await } else { pending().await }
        } => EffectStop::Expired,
        () = async {
            if let Some(closing) = closing.as_mut() {
                let _ = closing.wait_for(Option::is_some).await;
            } else {
                pending().await
            }
        } => EffectStop::Frozen,
    }
}

fn publish_batch(
    table: &MessageTable,
    jobs: Vec<BatchWork>,
    uncertain: &AtomicBool,
    more: Option<(&mut ReadyWrites<Work>, &mut BatchBudget)>,
) {
    if jobs.is_empty() || uncertain.load(Ordering::Acquire) {
        return;
    }
    let mut jobs = jobs.into_iter().map(BatchWork::start).collect::<Vec<_>>();
    let committed = table.write_batch(|batch| {
        for job in &mut jobs {
            job.stage(batch)?;
        }
        if let Some((reader, budget)) = more {
            let initial = jobs.len();
            let ready = reader.take_ready_ordinary(budget, |work| {
                matches!(work, Work::Batch(BatchWork::Ready(_)))
            });
            jobs.extend(ready.into_iter().map(|work| match work {
                Work::Batch(BatchWork::Ready(job)) => job,
                _ => unreachable!("only prepared ordinary work can join after staging"),
            }));
            for job in &mut jobs[initial..] {
                job.stage(batch)?;
            }
        }
        Ok(())
    });
    let committed = match committed {
        BatchResult::Committed => Committed::Yes,
        BatchResult::Aborted(error) => Committed::No(ErrorBody::internal(error)),
        BatchResult::Uncertain(error) => {
            super::warn(&format!("{error:#}"));
            verify(table, &mut jobs)
        }
        BatchResult::Unverified(error) => {
            super::warn(&format!("{error:#}"));
            Committed::Unknown(unknown())
        }
    };
    if matches!(committed, Committed::Unknown(_)) {
        uncertain.store(true, Ordering::Release);
    }
    crate::gate_for_test("before-message-batch-publication");
    let publishing = crate::trace_message_batches().then(std::time::Instant::now);
    let count = jobs.len();
    for operation in jobs {
        operation.finish(committed.clone());
    }
    if let Some(publishing) = publishing {
        crate::log(
            "info",
            &format!(
                "message batch published: operations={count} publication_us={}",
                publishing.elapsed().as_micros(),
            ),
        );
    }
}

pub(super) async fn answer<T>(ticket: Ticket<T>) -> Result<T, ErrorBody> {
    ticket.await.map_err(|_| ended())?
}

fn ended() -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        "the message writer could not confirm this operation",
    )
}

fn unknown() -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        "the durable result of the message operation is unknown",
    )
}

fn verify(table: &MessageTable, jobs: &mut [Box<dyn BatchJob>]) -> Committed {
    let checked = table.verify_write(|connection| {
        let mut before = true;
        let mut after = true;
        for witness in jobs.iter_mut().filter_map(|operation| operation.witness()) {
            match witness(connection)? {
                CommitEvidence::Before => after = false,
                CommitEvidence::After => before = false,
                CommitEvidence::Same => {}
                CommitEvidence::Unrecognized => return Ok(Committed::Unknown(unknown())),
            }
        }
        Ok(match (before, after) {
            (_, true) => Committed::Yes,
            (true, false) => {
                Committed::No(ErrorBody::internal("the message transaction rolled back"))
            }
            (false, false) => Committed::Unknown(unknown()),
        })
    });
    checked.unwrap_or_else(|error| {
        super::warn(&format!("{error:#}"));
        Committed::Unknown(unknown())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::poll_fn;
    use std::sync::mpsc;
    use std::task::Poll;
    use std::time::Duration;

    fn record_order(batch: &mut Batch<'_>, label: &str) -> rusqlite::Result<Prepared<i64>> {
        let number = batch.operation(|connection| {
            connection.execute("INSERT INTO batch_order (name) VALUES (?)", [label])?;
            Ok(connection.last_insert_rowid())
        })??;
        Ok(Prepared {
            witness: None,
            finish: Box::new(move |committed| committed.require().map(|()| number)),
        })
    }

    #[tokio::test]
    async fn an_ordinary_save_ready_during_staging_uses_the_same_commit() {
        let store = crate::store::Store::in_memory();
        let writer = Writer::new(store.message_table()).unwrap();
        let before = store.commits();
        let (staged, staging) = oneshot::channel();
        let (release, held) = mpsc::channel();
        let first = writer
            .enqueue(Lane::Ordered, 0, move |batch| {
                batch.operation(|connection| {
                    connection.execute_batch("CREATE TABLE batch_order (name TEXT)")
                })??;
                let prepared = record_order(batch, "first")?;
                staged.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(10)).unwrap();
                Ok(prepared)
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), staging)
            .await
            .unwrap()
            .unwrap();

        let mut second = std::pin::pin!(writer.before_effect(
            Lane::Ordinary,
            0,
            (),
            pending(),
            None,
            |batch, plan| {
                plan.lock().unwrap().take().unwrap();
                record_order(batch, "second")
            },
        ));
        poll_fn(|cx| {
            assert!(second.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        release.send(()).unwrap();

        let (first, second) = tokio::time::timeout(Duration::from_secs(10), async {
            (answer(first).await.unwrap(), second.await.unwrap())
        })
        .await
        .unwrap();
        assert_eq!(first, 1);
        assert!(matches!(second, Effect::Answered(2)));
        assert_eq!(store.commits() - before, 1);
    }
}
