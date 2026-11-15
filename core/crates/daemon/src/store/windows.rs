//! The `windows` table: each editor window as it last described itself, so that a daemon started
//! anew knows how long each window's agents wait for it and what to call it meanwhile. A window's
//! row is written whenever it describes itself and deleted when the window goes, or with
//! `Store::take_over` when another window takes its agents. The terminal window is never kept: it
//! is always there.

use std::sync::Arc;

use facade_base::daemon::WindowDescription;
use rusqlite::{Connection, params};

use super::{Store, log};

/// Creates the table where it is missing.
pub(super) fn add_table(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS windows (
			window_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			environment TEXT NOT NULL,
			workspace TEXT,
			folders TEXT NOT NULL,
			branch_prefix TEXT
		);",
    )
}

/// The handle of the `windows` table, which the daemon's windows own. Every method blocks.
#[derive(Clone)]
pub(crate) struct WindowTable(Arc<Store>);

impl WindowTable {
    pub(super) fn new(store: Arc<Store>) -> WindowTable {
        WindowTable(store)
    }

    /// Writes `window`'s description in place of the one before.
    pub(crate) fn save_window(&self, window: &WindowDescription) -> anyhow::Result<()> {
        let folders = serde_json::to_string(&window.folders)?;
        self.0.with(
            || format!("save window {}", window.id),
            |connection| {
                connection.execute(
                    "INSERT OR REPLACE INTO windows \
                     (window_id, label, environment, workspace, folders, branch_prefix) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        window.id,
                        window.label,
                        window.environment,
                        window.workspace,
                        folders,
                        window.branch_prefix,
                    ],
                )
            },
        )?;
        Ok(())
    }

    /// Deletes window `id`'s row.
    pub(crate) fn delete_window(&self, id: &str) -> anyhow::Result<()> {
        self.0.with(
            || format!("delete window {id}"),
            |connection| connection.execute("DELETE FROM windows WHERE window_id = ?1", [id]),
        )?;
        Ok(())
    }

    /// The windows as they last described themselves. A row this build cannot read is logged,
    /// skipped and left as it is.
    pub(crate) fn windows(&self) -> anyhow::Result<Vec<WindowDescription>> {
        let rows = self.0.with(
            || "read the windows".to_string(),
            |connection| {
                let mut statement = connection.prepare(
                    "SELECT window_id, label, environment, workspace, folders, branch_prefix \
                     FROM windows",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?;
                Ok(rows.collect::<Vec<_>>())
            },
        )?;
        let mut windows = Vec::new();
        for row in rows {
            let read = row.map_err(anyhow::Error::from).and_then(
                |(id, label, environment, workspace, folders, branch_prefix)| {
                    Ok(WindowDescription {
                        id,
                        label,
                        environment,
                        workspace,
                        folders: serde_json::from_str(&folders)?,
                        branch_prefix,
                    })
                },
            );
            match read {
                Ok(window) => windows.push(window),
                Err(err) => log(
                    "warn",
                    &format!("skipping a window this build cannot read: {err}"),
                ),
            }
        }
        Ok(windows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AgentRecord;
    use crate::store::tests::record;

    fn window(id: &str, workspace: &str) -> WindowDescription {
        WindowDescription {
            id: id.into(),
            label: format!("{id} (Workspace)"),
            environment: "ssh-remote+devbox".into(),
            workspace: Some(workspace.into()),
            folders: vec!["/work/app".into(), "/work/lib".into()],
            branch_prefix: Some("aaron/".into()),
        }
    }

    /// A window's description survives a reopen as it was last written, and goes once deleted.
    #[test]
    fn a_window_is_kept_as_it_last_described_itself_until_it_is_deleted() {
        let core = crate::test_folder::TestFolder::new("windowsreopen");
        let store = Store::open(&core, &[]).unwrap().store;
        store
            .window_table()
            .save_window(&window("win-1", "k1"))
            .unwrap();
        let renamed = WindowDescription {
            label: "renamed".into(),
            folders: vec!["/work/app".into()],
            ..window("win-1", "k1")
        };
        store.window_table().save_window(&renamed).unwrap();
        store
            .window_table()
            .save_window(&window("win-2", "k2"))
            .unwrap();
        store.window_table().delete_window("win-2").unwrap();
        drop(store);
        let store = Store::open(&core, &[]).unwrap().store;
        assert_eq!(store.window_table().windows().unwrap(), [renamed]);
    }

    /// A takeover moves the agents of one window to another, and deletes the first window,
    /// together. Other agents stay.
    #[test]
    fn a_takeover_moves_a_window_s_agents_and_deletes_the_window_together() {
        let store = Store::in_memory();
        store
            .window_table()
            .save_window(&window("win-old", "k"))
            .unwrap();
        store
            .window_table()
            .save_window(&window("win-new", "k"))
            .unwrap();
        for (id, window) in [("a1", "win-old"), ("a2", "win-old"), ("a3", "terminal")] {
            store
                .insert(&AgentRecord {
                    window_id: window.into(),
                    ..record(id)
                })
                .unwrap();
        }
        store.take_over("win-old", "win-new").unwrap();
        let windows: Vec<String> = store
            .windows()
            .unwrap()
            .into_iter()
            .map(|window| window.id)
            .collect();
        assert_eq!(windows, ["win-new"]);
        let connection = store.connection.lock().unwrap();
        let mut placed: Vec<(String, String)> = connection
            .prepare("SELECT agent_id, window_id FROM agents ORDER BY agent_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        placed.sort();
        assert_eq!(
            placed,
            [
                ("a1".into(), "win-new".into()),
                ("a2".into(), "win-new".into()),
                ("a3".into(), "terminal".into())
            ]
        );
    }
}
