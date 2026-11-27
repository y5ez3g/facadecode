//! The message tools a relay read and has not answered, keyed by JSON-RPC ID.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tokio::sync::watch;

use crate::Cancel;

#[derive(Default)]
pub(super) struct Sends(Mutex<HashMap<String, watch::Sender<bool>>>);

impl Sends {
    fn table(&self) -> MutexGuard<'_, HashMap<String, watch::Sender<bool>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn note(&self, key: String, cancelled: bool) {
        self.table().insert(key, watch::Sender::new(cancelled));
    }

    pub(super) fn read_cancel(&self, key: &str) -> Cancel {
        self.table()
            .get(key)
            .map_or_else(Cancel::default, |signal| Cancel::of(signal.subscribe()))
    }

    /// The reader wakes the named call before taking another MCP line.
    pub(super) fn cancel(&self, key: &str) {
        if let Some(signal) = self.table().get(key) {
            signal.send_replace(true);
        }
    }

    #[cfg(test)]
    pub(super) fn cancelled(&self, key: &str) -> bool {
        self.read_cancel(key).is_requested()
    }

    pub(super) fn finish(&self, key: &str) {
        self.table().remove(key);
    }

    /// No more lines arrive before the cut. Each cancellation's original call owns its
    /// settlement, even if it is waiting for its turn to inspect a saved receipt.
    pub(super) async fn settle_cancelled(&self) {
        let cancelled: Vec<_> = self
            .table()
            .values()
            .filter(|signal| *signal.borrow())
            .map(watch::Sender::subscribe)
            .collect();
        for mut done in cancelled {
            let _ = done.wait_for(|_| false).await;
        }
    }
}
