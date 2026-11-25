//! Runs independently fallible message operations in one durable SQLite transaction.

use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};

use super::Store;

/// The durable result of one batch. An uncertain result needs a fresh database read before
/// its effects can be published.
pub(crate) enum BatchResult {
    Committed,
    Aborted(anyhow::Error),
    Uncertain(anyhow::Error),
    Unverified(anyhow::Error),
}

/// A standalone transaction did not establish its durable result.
#[derive(Debug)]
pub(crate) struct CommitUnknown(pub(super) anyhow::Error);

impl std::fmt::Display for CommitUnknown {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(output, "the durable result is unknown: {:#}", self.0)
    }
}

impl std::error::Error for CommitUnknown {}

pub(crate) struct Batch<'store> {
    transaction: Transaction<'store>,
}

impl Batch<'_> {
    /// Runs an operation without exposing its result outside the batch. On an ordinary statement
    /// error, rolls back just this operation. Failure to roll back dooms the surrounding batch.
    pub(crate) fn operation<T>(
        &mut self,
        write: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<rusqlite::Result<T>> {
        let mut savepoint = self.transaction.savepoint()?;
        let result = write(&savepoint);
        if result.is_err() {
            savepoint.rollback()?;
        }
        savepoint.commit()?;
        Ok(result)
    }
}

impl Store {
    /// Runs a bounded group using the store's one write connection. Holds only that connection
    /// through the SQLite commit.
    pub(crate) fn write_batch(
        &self,
        work: impl FnOnce(&mut Batch<'_>) -> rusqlite::Result<()>,
    ) -> BatchResult {
        let started = crate::trace_message_batches().then(std::time::Instant::now);
        let mut connection = self.connection.lock().unwrap();
        let locked = started.map(|_| std::time::Instant::now());
        let (result, writing) = {
            let mut batch =
                match connection.transaction_with_behavior(TransactionBehavior::Immediate) {
                    Ok(transaction) => Batch { transaction },
                    Err(error) => return BatchResult::Aborted(error.into()),
                };
            if let Err(error) = work(&mut batch) {
                if batch.transaction.is_autocommit() {
                    return BatchResult::Aborted(error.into());
                }
                return match batch.transaction.rollback() {
                    Ok(()) => BatchResult::Aborted(error.into()),
                    Err(rollback) => {
                        BatchResult::Unverified(anyhow::Error::from(error).context(rollback))
                    }
                };
            }
            #[cfg(test)]
            if self
                .abort_next_batch
                .swap(false, std::sync::atomic::Ordering::Relaxed)
            {
                batch
                    .transaction
                    .rollback()
                    .expect("test message transaction rolls back");
                return BatchResult::Aborted(anyhow::anyhow!(
                    "test message transaction rolled back"
                ));
            }
            crate::gate_for_test("before-message-batch-commit");
            let writing = started.map(|_| std::time::Instant::now());
            (self.commit(batch.transaction), writing)
        };
        drop(connection);
        if let (Some(started), Some(locked), Some(writing)) = (started, locked, writing) {
            crate::log(
                "info",
                &format!(
                    "message batch storage: lock_us={} statements_us={} commit_us={} committed={}",
                    (locked - started).as_micros(),
                    (writing - locked).as_micros(),
                    writing.elapsed().as_micros(),
                    matches!(result, BatchResult::Committed),
                ),
            );
        }
        result
    }

    pub(super) fn commit(&self, transaction: Transaction<'_>) -> BatchResult {
        match transaction.execute_batch("COMMIT") {
            Ok(()) => {
                #[cfg(test)]
                self.note_commit();
                BatchResult::Committed
            }
            Err(error) => {
                let error = anyhow::Error::from(error).context("could not commit the transaction");
                if transaction.is_autocommit() {
                    return BatchResult::Uncertain(error);
                }
                match transaction.rollback() {
                    Ok(()) => BatchResult::Aborted(error),
                    Err(rollback) => BatchResult::Unverified(error.context(rollback)),
                }
            }
        }
    }

    /// Reads the committed state without disturbing the connection that reported the error.
    pub(crate) fn verify_write<T>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> anyhow::Result<T> {
        let Some(path) = self.path.as_ref() else {
            return self.with(|| "verify a message transaction".into(), read);
        };
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let mut connection = Connection::open_with_flags(path, flags)?;
        let snapshot = connection.transaction()?;
        Ok(read(&snapshot)?)
    }
}
