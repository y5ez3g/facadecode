//! The `windows` table keeps each logical editor window's last instance and description for
//! recovery and workspace rebinding. The daemon lists the terminal window separately.

use std::sync::Arc;

use facade_base::daemon::WindowDescription;
use rusqlite::{Connection, params};

use super::{Store, WindowRow, log};

pub(super) fn add_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE windows (
			window_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			environment TEXT NOT NULL,
			workspace TEXT,
			folders TEXT NOT NULL,
			branch_prefix TEXT,
			sequence INTEGER NOT NULL,
			instance TEXT NOT NULL
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

    /// Writes the logical window and its binding. Environment variables and colors live in memory.
    pub(crate) fn save_logical_window(&self, row: &WindowRow) -> anyhow::Result<()> {
        let window = &row.description;
        let folders = serde_json::to_string(&window.folders)?;
        let sequence = i64::try_from(row.sequence)?;
        self.0.with(
            || format!("save window {}", row.window_id),
            |connection| {
                connection.execute(
                    "INSERT OR REPLACE INTO windows \
                     (window_id, label, environment, workspace, folders, branch_prefix, sequence, instance) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        row.window_id,
                        window.label,
                        window.environment,
                        window.workspace,
                        folders,
                        window.branch_prefix,
                        sequence,
                        window.id,
                    ],
                )
            },
        )?;
        Ok(())
    }

    /// Saved logical windows, in allocation order, with the last instance of each binding.
    pub(crate) fn logical_windows(&self) -> anyhow::Result<Vec<WindowRow>> {
        let rows = self.0.with(
            || "read the windows".to_string(),
            |connection| {
                let mut statement = connection.prepare(
                    "SELECT window_id, sequence, instance, label, environment, workspace, folders, \
                     branch_prefix FROM windows ORDER BY sequence, window_id",
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

    /// A logical window keeps its allocation order and description across reopening.
    #[test]
    fn a_window_keeps_its_logical_id_and_latest_instance() {
        let core = crate::test_folder::TestFolder::new("windowsreopen");
        let store = Store::open(&core, &[]).unwrap().store;
        let mut kept = WindowRow {
            window_id: "win-1".into(),
            sequence: 1,
            description: window("first-instance", "workspace"),
        };
        let windows = store.window_table();
        windows.save_logical_window(&kept).unwrap();
        kept.description = WindowDescription {
            id: "later-instance".into(),
            label: "renamed".into(),
            folders: vec!["/work/app".into()],
            env: Some(std::collections::BTreeMap::from([(
                "PATH".into(),
                "/custom".into(),
            )])),
            ..kept.description
        };
        windows.save_logical_window(&kept).unwrap();
        drop(windows);
        drop(store);

        let store = Store::open(&core, &[]).unwrap().store;
        let rows = store.window_table().logical_windows().unwrap();
        let [row] = rows.as_slice() else {
            panic!("expected one logical window");
        };
        assert_eq!(row.window_id, kept.window_id);
        assert_eq!(row.sequence, kept.sequence);
        kept.description.env = None;
        assert_eq!(row.description, kept.description);
    }
}
