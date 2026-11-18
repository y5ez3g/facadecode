//! The `windows` table keeps each logical editor window's last instance and description for
//! recovery and workspace rebinding. The daemon lists the terminal window separately.

use std::sync::Arc;

use facade_base::daemon::WindowDescription;
use rusqlite::{Connection, params};

use super::{Store, WindowRow, log};

/// Creates the table where it is missing.
pub(super) fn add_table(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS windows (
			window_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			environment TEXT NOT NULL,
			workspace TEXT,
			folders TEXT NOT NULL,
			branch_prefix TEXT,
			sequence INTEGER,
			instance TEXT
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
        self.write_description(&window.id, window, None)
    }

    /// Writes the logical window and its binding. Environment variables and colors live in memory.
    pub(crate) fn save_logical_window(&self, row: &WindowRow) -> anyhow::Result<()> {
        self.write_description(&row.window_id, &row.description, Some(row.sequence))
    }

    fn write_description(
        &self,
        window_id: &str,
        window: &WindowDescription,
        sequence: Option<u64>,
    ) -> anyhow::Result<()> {
        let folders = serde_json::to_string(&window.folders)?;
        let sequence = sequence.map(i64::try_from).transpose()?;
        self.0.with(
            || format!("save window {window_id}"),
            |connection| {
                connection.execute(
                    "INSERT OR REPLACE INTO windows \
                     (window_id, label, environment, workspace, folders, branch_prefix, sequence, instance) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        window_id,
                        window.label,
                        window.environment,
                        window.workspace,
                        folders,
                        window.branch_prefix,
                        sequence,
                        sequence.map(|_| &window.id),
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
        Ok(self
            .logical_windows()?
            .into_iter()
            .map(|mut row| {
                row.description.id = row.window_id;
                row.description
            })
            .collect())
    }

    /// Saved logical windows, in allocation order, with the last instance of each binding.
    pub(crate) fn logical_windows(&self) -> anyhow::Result<Vec<WindowRow>> {
        let rows = self.0.with(
            || "read the windows".to_string(),
            |connection| {
                let mut statement = connection.prepare(
                    "SELECT window_id, coalesce(sequence, rowid) AS allocation, \
                     coalesce(instance, window_id), label, environment, workspace, folders, branch_prefix \
                     FROM windows ORDER BY allocation, window_id",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                })?;
                Ok(rows.collect::<Vec<_>>())
            },
        )?;
        let mut windows = Vec::new();
        for row in rows {
            let read = row.map_err(anyhow::Error::from).and_then(
                |(
                    window_id,
                    sequence,
                    id,
                    label,
                    environment,
                    workspace,
                    folders,
                    branch_prefix,
                )| {
                    Ok(WindowRow {
                        window_id,
                        sequence: u64::try_from(sequence)?,
                        description: WindowDescription {
                            id,
                            label,
                            environment,
                            workspace,
                            folders: serde_json::from_str(&folders)?,
                            branch_prefix,
                            colors: None,
                            env: None,
                        },
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
    use facade_base::daemon::WindowRef;

    fn window(id: &str, workspace: &str) -> WindowDescription {
        WindowDescription {
            id: id.into(),
            label: format!("{id} (Workspace)"),
            environment: "ssh-remote+devbox".into(),
            workspace: Some(workspace.into()),
            folders: vec!["/work/app".into(), "/work/lib".into()],
            branch_prefix: Some("aaron/".into()),
            colors: None,
            env: None,
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
            colors: None,
            env: None,
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

    #[test]
    fn an_unreferenced_window_can_be_deleted_after_its_last_agent_is_removed() {
        let store = Store::in_memory();
        let member = WindowRef {
            machine_id: "test-machine".into(),
            window_id: "win-1".into(),
        };
        let row = WindowRow {
            window_id: member.window_id.clone(),
            sequence: 1,
            description: window("instance-1", "workspace"),
        };
        let source = WindowRef {
            window_id: "win-source".into(),
            ..member.clone()
        };
        let windows = store.window_table();
        windows.save_logical_window(&row).unwrap();
        windows
            .save_logical_window(&WindowRow {
                window_id: source.window_id.clone(),
                sequence: 2,
                description: window("source-instance", "workspace"),
            })
            .unwrap();
        store
            .insert(&AgentRecord {
                windows: vec![member.clone()],
                location_source_window: Some(source.clone()),
                ..record("a1")
            })
            .unwrap();
        let members = store.membership_table();
        assert_eq!(
            members.add("a1", &member).unwrap(),
            Some(vec![member.clone()])
        );
        assert!(!store.delete_empty_window(&member).unwrap());
        assert!(!store.delete_empty_window(&source).unwrap());
        assert_eq!(windows.logical_windows().unwrap().len(), 2);

        store.delete("a1").unwrap();
        assert!(store.delete_empty_window(&member).unwrap());
        assert!(store.delete_empty_window(&source).unwrap());
        assert!(windows.logical_windows().unwrap().is_empty());
        assert_eq!(members.add("a1", &member).unwrap(), None);
    }
}
