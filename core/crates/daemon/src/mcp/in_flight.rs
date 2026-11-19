//! The `send_message` calls of one relay that were read and not yet answered, by their JSON-RPC ID
//! as JSON text, which the client's `notifications/cancelled` names.
//!
//! A cancellation withdraws a call's message where its paste has not begun. Before the call is
//! written to the daemon, nothing is written. After that, the call's own daemon connection carries a
//! `cancel` naming it, behind the call. The reader of the client's lines cancels at once: the table
//! is locked only to note or find a call, never while anything is written to a daemon, so a
//! cancellation never waits behind the calls under way.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Mutex, MutexGuard, PoisonError};

use facade_base::daemon_client::{DaemonClient, cancel_line};
use facade_base::paths::ClientSocket;
use tokio::sync::watch;

use crate::Cancel;

/// A call under way.
#[derive(Default)]
struct Pending {
    cancelled: bool,
    /// The daemon connection its call went out on, and the call's request ID there.
    written: Option<(ClientSocket, u64)>,
    read: Option<watch::Sender<bool>>,
}

#[derive(Default)]
pub(super) struct Sends(Mutex<HashMap<String, Pending>>);

impl Sends {
    fn table(&self) -> MutexGuard<'_, HashMap<String, Pending>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Notes call `key` as its line is read, until [`Sends::finish`].
    pub(super) fn note(&self, key: String) {
        self.table().insert(key, Pending::default());
    }

    pub(super) fn note_read(&self, key: String) {
        self.table().insert(
            key,
            Pending {
                read: Some(watch::Sender::new(false)),
                ..Pending::default()
            },
        );
    }

    pub(super) fn read_cancel(&self, key: &str) -> Cancel {
        self.table()
            .get(key)
            .and_then(|pending| pending.read.as_ref())
            .map_or_else(Cancel::default, |read| Cancel::of(read.subscribe()))
    }

    /// Cancels call `key` for its client. A call already written gets a `cancel` on its connection;
    /// one being written is cancelled by its own thread once it is. A call already answered stays.
    pub(super) fn cancel(&self, key: &str) {
        let written = {
            let mut table = self.table();
            let Some(pending) = table.get_mut(key) else {
                return;
            };
            pending.cancelled = true;
            if let Some(read) = &pending.read {
                read.send_replace(true);
            }
            match &pending.written {
                Some((connection, id)) => connection.try_clone().ok().map(|copy| (copy, *id)),
                None => None,
            }
        };
        if let Some((mut connection, id)) = written {
            // A connection that ended has no call left to withdraw.
            let _ = connection.write_all(&cancel_line(id));
        }
    }

    /// Writes call `key` to the daemon with `write`, which answers the call's request ID on
    /// `client`; nothing where the client cancelled it first. A call never noted, as in tests, is
    /// written.
    pub(super) fn write(
        &self,
        key: &str,
        client: &mut DaemonClient,
        write: impl FnOnce(&mut DaemonClient) -> anyhow::Result<u64>,
    ) -> Option<anyhow::Result<u64>> {
        let cancelled = self.table().get(key).map(|pending| pending.cancelled);
        match cancelled {
            None => return Some(write(client)),
            Some(true) => return None,
            Some(false) => {}
        }
        // Tests hold a call here, as a daemon slow to read its line would.
        facade_base::service::gate_for_test("mcp-writing-send");
        let written = write(client);
        let Ok(id) = written else {
            return Some(written);
        };
        // Noted under the lock: a cancellation that came while the call was written is sent here,
        // after the call, and a later one by `cancel`. Either way it follows the call.
        let copy = client.writer.try_clone().ok();
        let cancelled_meanwhile = match self.table().get_mut(key) {
            Some(pending) => {
                pending.written = copy.map(|copy| (copy, id));
                pending.cancelled
            }
            None => false,
        };
        if cancelled_meanwhile {
            let _ = client.writer.write_all(&cancel_line(id));
        }
        Some(Ok(id))
    }

    /// Whether the client cancelled call `key`.
    pub(super) fn cancelled(&self, key: &str) -> bool {
        self.table()
            .get(key)
            .is_some_and(|pending| pending.cancelled)
    }

    /// Ends call `key`, answered or withdrawn.
    pub(super) fn finish(&self, key: &str) {
        self.table().remove(key);
    }
}
