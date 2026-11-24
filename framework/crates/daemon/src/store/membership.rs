//! The windows of each agent. A relation can remain while its window is disconnected.

use facade_base::model::machine::WindowRef;
use rusqlite::{Connection, params};

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
