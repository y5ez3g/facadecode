//! The windows of each agent. A relation can remain while its window is disconnected.

use std::sync::Arc;

use facade_base::daemon::WindowRef;
use rusqlite::{Connection, params};

use super::Store;

pub(super) fn add_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE agent_windows (
            agent_id TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            window_id TEXT NOT NULL,
            PRIMARY KEY (agent_id, machine_id, window_id)
        );
        CREATE INDEX agent_windows_by_window ON agent_windows (machine_id, window_id);",
    )
}

pub(super) fn insert(
    connection: &Connection,
    agent_id: &str,
    windows: &[WindowRef],
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare_cached(
        "INSERT INTO agent_windows (agent_id, machine_id, window_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (agent_id, machine_id, window_id) DO NOTHING",
    )?;
    for window in windows {
        statement.execute(params![agent_id, window.machine_id, window.window_id])?;
    }
    Ok(())
}

pub(super) fn read(connection: &Connection, agent_id: &str) -> rusqlite::Result<Vec<WindowRef>> {
    let mut statement = connection.prepare_cached(
        "SELECT machine_id, window_id FROM agent_windows WHERE agent_id = ?1
         ORDER BY machine_id, window_id",
    )?;
    let rows = statement.query_map([agent_id], |row| {
        Ok(WindowRef {
            machine_id: row.get(0)?,
            window_id: row.get(1)?,
        })
    })?;
    rows.collect()
}

/// The handle records uses to join an existing agent to another window.
#[derive(Clone)]
pub(crate) struct MembershipTable(Arc<Store>);

impl MembershipTable {
    pub(super) fn new(store: Arc<Store>) -> Self {
        Self(store)
    }

    /// Keeps the membership and returns the agent's full, sorted set. None if the agent was removed.
    pub(crate) fn add(
        &self,
        agent_id: &str,
        window: &WindowRef,
    ) -> anyhow::Result<Option<Vec<WindowRef>>> {
        self.0.transaction(
            || format!("join {agent_id} to window {}", window.window_id),
            |transaction| {
                let exists = transaction.query_row(
                    "SELECT EXISTS (SELECT 1 FROM agents WHERE agent_id = ?1)",
                    [agent_id],
                    |row| row.get::<_, bool>(0),
                )?;
                if !exists {
                    return Ok(None);
                }
                insert(transaction, agent_id, std::slice::from_ref(window))?;
                read(transaction, agent_id).map(Some)
            },
        )
    }
}

impl Store {
    /// Removes a local window during startup if no stored agent references it.
    pub(crate) fn delete_empty_window(&self, window: &WindowRef) -> anyhow::Result<bool> {
        let deleted = self.transaction(
            || format!("delete empty window {}", window.window_id),
            |transaction| {
                transaction.execute(
                    "DELETE FROM windows WHERE window_id = ?1 AND NOT EXISTS (
                        SELECT 1 FROM agent_windows WHERE machine_id = ?2 AND window_id = ?1
                    ) AND NOT EXISTS (
                        SELECT 1 FROM agents WHERE location_machine_id = ?2 AND location_window_id = ?1
                    )",
                    params![window.window_id, window.machine_id],
                )
            },
        )?;
        Ok(deleted == 1)
    }
}
