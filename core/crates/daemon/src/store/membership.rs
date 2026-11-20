//! The windows of each agent. A relation can remain while its window is disconnected.

use std::collections::BTreeSet;
use std::sync::Arc;

use facade_base::daemon::WindowRef;
use facade_base::machine::AgentRef;
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

/// Reads memberships of legacy logical windows for workspace import.
#[derive(Clone)]
pub(crate) struct MembershipTable(Arc<Store>);

impl MembershipTable {
    pub(super) fn new(store: Arc<Store>) -> Self {
        Self(store)
    }

    /// Records held by this machine that belonged to one of the old logical windows.
    pub(crate) fn legacy_agents(&self, windows: &[WindowRef]) -> anyhow::Result<Vec<AgentRef>> {
        self.0.with(
            || "read the legacy workspace members".to_owned(),
            |connection| {
                let mut statement = connection.prepare(
                    "SELECT aw.agent_id, (SELECT machine_id FROM machine WHERE singleton = 1) \
                     FROM agent_windows aw JOIN agents a ON a.agent_id = aw.agent_id \
                     WHERE aw.machine_id = ?1 AND aw.window_id = ?2",
                )?;
                let mut agents = BTreeSet::new();
                for window in windows {
                    let rows = statement.query_map(
                        params![window.machine_id, window.window_id],
                        |row| {
                            Ok(AgentRef {
                                agent_id: row.get(0)?,
                                machine_id: row.get(1)?,
                            })
                        },
                    )?;
                    for row in rows {
                        agents.insert(row?);
                    }
                }
                Ok(agents.into_iter().collect())
            },
        )
    }
}
