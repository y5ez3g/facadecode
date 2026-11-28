//! Each open relay request has one registration until its response task ends.

use std::collections::{HashMap, hash_map::Entry};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::watch;

use crate::Cancel;

type Table = HashMap<String, Arc<Request>>;

#[derive(Clone, Default)]
pub(super) struct Requests(Arc<Mutex<Table>>);

struct Request {
    cancel: Option<watch::Sender<bool>>,
}

pub(super) struct Registration {
    requests: Requests,
    key: String,
    request: Arc<Request>,
}

impl Requests {
    fn table(&self) -> MutexGuard<'_, Table> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn register(&self, key: String, cancelled: Option<bool>) -> Option<Registration> {
        let mut table = self.table();
        let Entry::Vacant(entry) = table.entry(key.clone()) else {
            return None;
        };
        let request = Arc::new(Request {
            cancel: cancelled.map(watch::Sender::new),
        });
        entry.insert(request.clone());
        Some(Registration {
            requests: self.clone(),
            key,
            request,
        })
    }

    /// The reader wakes the named message call before taking another line.
    pub(super) fn cancel(&self, key: &str) {
        if let Some(signal) = self
            .table()
            .get(key)
            .and_then(|request| request.cancel.as_ref())
        {
            signal.send_replace(true);
        }
    }

    #[cfg(test)]
    pub(super) fn cancelled(&self, key: &str) -> bool {
        self.table()
            .get(key)
            .and_then(|request| request.cancel.as_ref())
            .is_some_and(|signal| *signal.borrow())
    }

    /// A cancellation's original call owns its settlement.
    pub(super) async fn settle_cancelled(&self) {
        let cancelled: Vec<_> = self
            .table()
            .values()
            .filter_map(|request| request.cancel.as_ref())
            .filter(|signal| *signal.borrow())
            .map(watch::Sender::subscribe)
            .collect();
        for mut done in cancelled {
            let _ = done.wait_for(|_| false).await;
        }
    }
}

impl Registration {
    pub(super) fn cancellation(&self) -> Cancel {
        self.request
            .cancel
            .as_ref()
            .map_or_else(Cancel::default, |signal| Cancel::of(signal.subscribe()))
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut table = self.requests.table();
        if table
            .get(&self.key)
            .is_some_and(|request| Arc::ptr_eq(request, &self.request))
        {
            table.remove(&self.key);
        }
    }
}
