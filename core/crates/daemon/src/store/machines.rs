//! Durable facts about this home's machine connections and the names it has seen.

use std::collections::HashMap;

use facade_base::machine::MachineIdentity;
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

/// Captures machines that may hold old workspace members before v3 discovers any new peers.
pub(super) fn snapshot_legacy_machines(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE legacy_machines (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL);
         INSERT INTO legacy_machines (machine_id, name) SELECT machine_id, name FROM known_machines;",
    )
}

fn read_connection(row: &Row<'_>) -> rusqlite::Result<SavedConnection> {
    Ok(SavedConnection {
        machine_id: row.get(0)?,
        ssh_destination: row.get(1)?,
        remote_home: row.get(2)?,
    })
}

pub(super) fn migrate_routes(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "ALTER TABLE saved_connections ADD COLUMN ssh_args TEXT;
         ALTER TABLE known_machines ADD COLUMN last_seen TEXT;
         CREATE TABLE remembered_routes (machine_id TEXT PRIMARY KEY, route TEXT NOT NULL);",
    )
}

fn read_saved_ssh(row: &Row<'_>) -> rusqlite::Result<crate::network::SavedSsh> {
    let config = read_connection(row)?;
    let args: Option<String> = row.get(3)?;
    let argv = match args {
        Some(args) => serde_json::from_str(&args).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        None => vec![config.ssh_destination.clone()],
    };
    Ok(crate::network::SavedSsh { config, argv })
}

impl Store {
    pub(crate) fn saved_ssh(&self) -> anyhow::Result<Vec<crate::network::SavedSsh>> {
        self.with(
            || "read saved SSH connections".into(),
            |connection| {
                connection
                    .prepare(
                        "SELECT machine_id, ssh_destination, remote_home, ssh_args
                FROM saved_connections ORDER BY machine_id",
                    )?
                    .query_map([], read_saved_ssh)?
                    .collect()
            },
        )
    }

    pub(crate) fn save_verified_ssh(
        &self,
        saved: &crate::network::SavedSsh,
        name: &str,
        expected_machine_id: Option<&str>,
    ) -> anyhow::Result<(crate::network::SavedSsh, bool)> {
        let args = serde_json::to_string(&saved.argv)?;
        let config = &saved.config;
        let replace = expected_machine_id == Some(config.machine_id.as_str());
        self.transaction(
            || format!("save the SSH connection to {}", config.machine_id),
            |connection| {
                connection.execute(
                    "INSERT INTO saved_connections (machine_id, ssh_destination, remote_home, ssh_args)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(machine_id) DO UPDATE SET
                         ssh_destination = excluded.ssh_destination,
                         remote_home = excluded.remote_home,
                         ssh_args = excluded.ssh_args
                     WHERE ?5",
                    params![
                        config.machine_id,
                        config.ssh_destination,
                        config.remote_home,
                        args,
                        replace
                    ],
                )?;
                let kept = connection.query_row(
                    "SELECT machine_id, ssh_destination, remote_home, ssh_args
                     FROM saved_connections WHERE machine_id = ?1",
                    [&config.machine_id],
                    read_saved_ssh,
                )?;
                let first = kept.config == *config
                    && kept.argv == saved.argv
                    && remember_machine(connection, &config.machine_id, name)?;
                Ok((kept, first))
            },
        )
    }

    pub(crate) fn remember_route(&self, id: &str, route: &[String]) -> anyhow::Result<()> {
        let route = serde_json::to_string(route)?;
        self.with(|| "remember a saved route".into(), |connection| connection.execute(
            "INSERT INTO remembered_routes(machine_id, route) VALUES (?1, ?2)
             ON CONFLICT(machine_id) DO UPDATE SET route = excluded.route WHERE route <> excluded.route",
            params![id, route],
        ))?;
        Ok(())
    }

    pub(crate) fn remembered_routes(&self) -> anyhow::Result<Vec<(String, Vec<String>)>> {
        self.with(
            || "read saved routes".into(),
            |connection| {
                connection
                    .prepare("SELECT machine_id, route FROM remembered_routes")?
                    .query_map([], |row| {
                        let route: String = row.get(1)?;
                        let route = serde_json::from_str(&route).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?;
                        Ok((row.get(0)?, route))
                    })?
                    .collect()
            },
        )
    }

    pub(crate) fn machine_last_seen(&self) -> anyhow::Result<HashMap<String, String>> {
        self.with(|| "read machine contact times".into(), |connection| {
            connection.prepare("SELECT machine_id, last_seen FROM known_machines WHERE last_seen IS NOT NULL")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect()
        })
    }

    pub(crate) fn legacy_machines(&self) -> anyhow::Result<Vec<MachineIdentity>> {
        self.with(
            || "read the legacy workspace source machines".to_owned(),
            |connection| {
                connection
                    .prepare("SELECT machine_id, name FROM legacy_machines ORDER BY machine_id")?
                    .query_map([], |row| {
                        Ok(MachineIdentity {
                            machine_id: row.get(0)?,
                            name: row.get(1)?,
                        })
                    })?
                    .collect()
            },
        )
    }

    pub(crate) fn rename_machine(&self, name: &str) -> anyhow::Result<()> {
        self.with(
            || "save this machine's name".to_string(),
            |connection| {
                connection.execute("UPDATE machine SET name = ?1 WHERE singleton = 1", [name])
            },
        )?;
        Ok(())
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
            |transaction| remember_machine(transaction, machine_id, name),
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

fn remember_machine(
    connection: &Connection,
    machine_id: &str,
    name: &str,
) -> rusqlite::Result<bool> {
    let last_seen = facade_base::time::iso_now();
    let inserted = connection.execute(
        "INSERT INTO known_machines (machine_id, name, last_seen) VALUES (?1, ?2, ?3)
         ON CONFLICT(machine_id) DO NOTHING",
        params![machine_id, name, last_seen],
    )?;
    if inserted == 0 {
        connection.execute(
            "UPDATE known_machines SET name = ?2, last_seen = ?3 WHERE machine_id = ?1",
            params![machine_id, name, last_seen],
        )?;
    }
    Ok(inserted == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::SavedSsh;
    use crate::test_folder::TestFolder;

    #[test]
    fn a_saved_connection_changes_only_with_the_expected_machine_id() {
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
            let ssh = SavedSsh {
                config: connection.clone(),
                argv: vec![connection.ssh_destination.clone()],
            };
            let (kept, first) = store
                .save_verified_ssh(&ssh, &connection.ssh_destination, None)
                .unwrap();
            assert_eq!(kept.config, *connection);
            assert_eq!(kept.argv, ssh.argv);
            assert!(first);
        }
        let replacement = SavedSsh {
            config: SavedConnection {
                ssh_destination: "another-desk".into(),
                remote_home: Some("/tmp/other-facade".into()),
                ..saved[0].clone()
            },
            argv: vec!["-p".into(), "2222".into(), "another-desk".into()],
        };
        let (kept, _) = store
            .save_verified_ssh(&replacement, "new-desk", None)
            .unwrap();
        assert_eq!(kept.config, saved[0]);
        let (_, first) = store
            .save_verified_ssh(&replacement, "new-desk", Some(&saved[0].machine_id))
            .unwrap();
        assert!(!first);

        drop(store);
        let store = Store::open(&core, &[]).unwrap().store;
        let restored = store.saved_ssh().unwrap();
        assert_eq!(restored[0].config, replacement.config);
        assert_eq!(restored[0].argv, replacement.argv);
        assert_eq!(restored[1].config, saved[1]);
        assert_eq!(
            store.known_machine_names().unwrap()[&saved[0].machine_id],
            "new-desk"
        );
        for connection in restored {
            let id = &connection.config.machine_id;
            assert_eq!(
                store.delete_connection(id).unwrap().as_ref(),
                Some(&connection.config)
            );
            assert_eq!(store.delete_connection(id).unwrap(), None);
        }
        assert!(store.saved_ssh().unwrap().is_empty());
    }
}
