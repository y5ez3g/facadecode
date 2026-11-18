//! Durable facts about this home's machine connections and the names it has seen.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::Store;
use crate::SavedConnection;

pub(super) fn add_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE saved_connections (
            machine_id TEXT PRIMARY KEY,
            ssh_destination TEXT NOT NULL,
            remote_home TEXT
        );
        CREATE TABLE known_machines (
            machine_id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );",
    )
}

fn read_connection(row: &Row<'_>) -> rusqlite::Result<SavedConnection> {
    Ok(SavedConnection {
        machine_id: row.get(0)?,
        ssh_destination: row.get(1)?,
        remote_home: row.get(2)?,
    })
}

impl Store {
    pub(crate) fn rename_machine(&self, name: &str) -> anyhow::Result<()> {
        self.with(
            || "save this machine's name".to_string(),
            |connection| {
                connection.execute("UPDATE machine SET name = ?1 WHERE singleton = 1", [name])
            },
        )?;
        Ok(())
    }

    pub(crate) fn saved_connections(&self) -> anyhow::Result<Vec<SavedConnection>> {
        self.with(
            || "read the saved machine connections".to_string(),
            |connection| {
                connection
                    .prepare(
                        "SELECT machine_id, ssh_destination, remote_home FROM saved_connections
                         ORDER BY machine_id",
                    )?
                    .query_map([], read_connection)?
                    .collect()
            },
        )
    }

    /// Saves a connection after its handshake. An existing SSH destination is kept for this ID.
    pub(crate) fn save_connection(
        &self,
        saved: &SavedConnection,
    ) -> anyhow::Result<SavedConnection> {
        self.transaction(
            || format!("save the connection to {}", saved.machine_id),
            |transaction| {
                transaction.execute(
                    "INSERT INTO saved_connections (machine_id, ssh_destination, remote_home)
                     VALUES (?1, ?2, ?3) ON CONFLICT(machine_id) DO NOTHING",
                    params![saved.machine_id, saved.ssh_destination, saved.remote_home],
                )?;
                transaction.query_row(
                    "SELECT machine_id, ssh_destination, remote_home FROM saved_connections
                     WHERE machine_id = ?1",
                    [&saved.machine_id],
                    read_connection,
                )
            },
        )
    }

    pub(crate) fn delete_connection(
        &self,
        machine_id: &str,
    ) -> anyhow::Result<Option<SavedConnection>> {
        self.with(
            || format!("delete the saved connection to {machine_id}"),
            |connection| {
                connection
                    .query_row(
                        "DELETE FROM saved_connections WHERE machine_id = ?1
                         RETURNING machine_id, ssh_destination, remote_home",
                        [machine_id],
                        read_connection,
                    )
                    .optional()
            },
        )
    }

    /// Remembers the name now advertised for a machine. Returns true on first sighting.
    pub(crate) fn remember_machine(&self, machine_id: &str, name: &str) -> anyhow::Result<bool> {
        self.transaction(
            || format!("remember the name of machine {machine_id}"),
            |transaction| {
                let inserted = transaction.execute(
                    "INSERT INTO known_machines (machine_id, name) VALUES (?1, ?2)
                     ON CONFLICT(machine_id) DO NOTHING",
                    params![machine_id, name],
                )?;
                if inserted == 0 {
                    transaction.execute(
                        "UPDATE known_machines SET name = ?2 WHERE machine_id = ?1 AND name <> ?2",
                        params![machine_id, name],
                    )?;
                }
                Ok(inserted == 1)
            },
        )
    }

    pub(crate) fn known_machine_names(&self) -> anyhow::Result<HashMap<String, String>> {
        self.with(
            || "read the known machine names".to_string(),
            |connection| {
                connection
                    .prepare("SELECT machine_id, name FROM known_machines")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect()
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_folder::TestFolder;

    #[test]
    fn saved_connections_keep_the_first_destination_and_home_after_reopening() {
        let core = TestFolder::new("saved-connections");
        let store = Store::open(&core, &[]).unwrap().store;
        let saved = [
            SavedConnection {
                machine_id: "20992f22-a645-4b31-acbe-3bdaa29dead0".into(),
                ssh_destination: "desk".into(),
                remote_home: None,
            },
            SavedConnection {
                machine_id: "7164b21c-c4d6-4406-817b-e4860fb1eb63".into(),
                ssh_destination: "user@gpu".into(),
                remote_home: Some("/var/lib/facade".into()),
            },
        ];
        for connection in &saved {
            assert_eq!(store.save_connection(connection).unwrap(), *connection);
        }
        let replacement = SavedConnection {
            ssh_destination: "another-desk".into(),
            remote_home: Some("/tmp/other-facade".into()),
            ..saved[0].clone()
        };
        assert_eq!(store.save_connection(&replacement).unwrap(), saved[0]);

        drop(store);
        let store = Store::open(&core, &[]).unwrap().store;
        assert_eq!(store.saved_connections().unwrap(), saved);
        for connection in &saved {
            let id = &connection.machine_id;
            assert_eq!(
                store.delete_connection(id).unwrap().as_ref(),
                Some(connection)
            );
            assert_eq!(store.delete_connection(id).unwrap(), None);
        }
        assert!(store.saved_connections().unwrap().is_empty());
    }
}
