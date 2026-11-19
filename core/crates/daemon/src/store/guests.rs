//! The `guests` table: each guest's record, so that a daemon started anew lists it again with its
//! number and its inbox, and its session's next hook finds it. A guest's row is written as it
//! joins and its `heard_at` as Facade hears from it again; the row goes with its inbox when the
//! guest ends (`Store::delete_guest`). Its environment and the process it ends with stay in memory.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};

use super::Store;

/// A guest's record as the store keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GuestRecord {
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) cli: String,
    /// The session by which its hooks, tool calls and commands find it.
    pub(crate) session: String,
    pub(crate) cwd: String,
    pub(crate) created_at: String,
    /// When Facade last heard from it, its join or a hook that began a turn, in UTC ISO 8601 with
    /// milliseconds.
    pub(crate) heard_at: String,
}

pub(super) fn add_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE guests (
			agent_id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			cli TEXT NOT NULL,
			session TEXT NOT NULL,
			cwd TEXT NOT NULL,
			created_at TEXT NOT NULL,
			heard_at TEXT NOT NULL
		);",
    )
}

/// The handle of the `guests` table, which the daemon's guests own. Every method blocks.
#[derive(Clone)]
pub(crate) struct GuestTable(Arc<Store>);

impl GuestTable {
    pub(super) fn new(store: Arc<Store>) -> GuestTable {
        GuestTable(store)
    }

    /// Commits a guest's record as it joins.
    #[cfg(test)]
    pub(crate) fn keep_guest(&self, guest: &GuestRecord) -> anyhow::Result<()> {
        self.keep_snapshot(guest, None)
    }

    /// Commits a guest and its YOLO together. A guest's existing snapshot takes precedence.
    pub(crate) fn keep_snapshot(
        &self,
        guest: &GuestRecord,
        yolo: Option<bool>,
    ) -> anyhow::Result<()> {
        self.0.with(
            || format!("keep the record of guest {}", guest.agent_id),
            |connection| {
                connection.execute(
                    "INSERT INTO guests (agent_id, name, cli, session, cwd, created_at, heard_at, yolo) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                     ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name, cli = excluded.cli, \
                     session = excluded.session, cwd = excluded.cwd, created_at = excluded.created_at, \
                     heard_at = excluded.heard_at, yolo = COALESCE(guests.yolo, excluded.yolo)",
                    params![
                        guest.agent_id,
                        guest.name,
                        guest.cli,
                        guest.session,
                        guest.cwd,
                        guest.created_at,
                        guest.heard_at,
                        yolo,
                    ],
                )
            },
        )?;
        Ok(())
    }

    /// Returns the saved YOLO snapshot if the record was created by a daemon that saved one.
    pub(crate) fn snapshot_yolo(&self, agent_id: &str) -> anyhow::Result<Option<bool>> {
        self.0.with(
            || format!("read the YOLO snapshot of guest {agent_id}"),
            |connection| {
                let yolo = connection
                    .query_row(
                        "SELECT yolo FROM guests WHERE agent_id = ?1",
                        [agent_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                Ok(yolo.flatten())
            },
        )
    }

    /// Changes only the name of a guest that is still present.
    pub(crate) fn rename_guest(&self, agent_id: &str, name: &str) -> anyhow::Result<bool> {
        self.0.with(
            || format!("save the name of guest {agent_id}"),
            |connection| {
                connection
                    .execute(
                        "UPDATE guests SET name = ?2 WHERE agent_id = ?1",
                        [agent_id, name],
                    )
                    .map(|count| count == 1)
            },
        )
    }

    /// Commits that Facade heard from guest `agent_id` at `at`.
    #[cfg(test)]
    pub(crate) fn heard_from_guest(&self, agent_id: &str, at: &str) -> anyhow::Result<()> {
        self.0.with(
            || format!("note that guest {agent_id} was heard from"),
            |connection| {
                connection.execute(
                    "UPDATE guests SET heard_at = ?2 WHERE agent_id = ?1",
                    params![agent_id, at],
                )
            },
        )?;
        Ok(())
    }

    /// Every guest's record, by number.
    pub(crate) fn guests(&self) -> anyhow::Result<Vec<GuestRecord>> {
        self.select("1", [])
    }

    /// The guests Facade last heard from before `before`, an ISO 8601 time, by number.
    pub(crate) fn guests_heard_before(&self, before: &str) -> anyhow::Result<Vec<GuestRecord>> {
        self.select("heard_at < ?1", [before])
    }

    fn select(
        &self,
        filter: &str,
        values: impl rusqlite::Params,
    ) -> anyhow::Result<Vec<GuestRecord>> {
        self.0.with(
            || "read the guests".to_string(),
            |connection| {
                let mut statement = connection.prepare(&format!(
                    "SELECT agent_id, name, cli, session, cwd, created_at, heard_at FROM guests \
                     WHERE {filter} ORDER BY CAST(substr(agent_id, 2) AS INTEGER)"
                ))?;
                let rows = statement.query_map(values, |row| {
                    Ok(GuestRecord {
                        agent_id: row.get(0)?,
                        name: row.get(1)?,
                        cli: row.get(2)?,
                        session: row.get(3)?,
                        cwd: row.get(4)?,
                        created_at: row.get(5)?,
                        heard_at: row.get(6)?,
                    })
                })?;
                rows.collect()
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guest(number: u64, heard_at: &str) -> GuestRecord {
        GuestRecord {
            agent_id: format!("a{number}"),
            name: format!("Guest {number}"),
            cli: "claude".into(),
            session: format!("s{number}"),
            cwd: "/w".into(),
            created_at: "2026-11-01T00:00:00.000Z".into(),
            heard_at: heard_at.into(),
        }
    }

    /// A guest's record is kept as it joined, its time heard from moves on, and its deletion takes
    /// its inbox with it.
    #[test]
    fn a_guest_s_record_is_kept_heard_from_and_deleted_with_its_inbox() {
        let store = Store::in_memory();
        store
            .keep_guest(&guest(10, "2026-11-01T00:00:00.000Z"))
            .unwrap();
        store
            .keep_guest(&guest(9, "2026-11-01T00:00:00.000Z"))
            .unwrap();
        assert_eq!(
            store
                .guests()
                .unwrap()
                .iter()
                .map(|guest| guest.agent_id.as_str())
                .collect::<Vec<_>>(),
            ["a9", "a10"],
            "by number"
        );
        store
            .heard_from_guest("a10", "2026-11-12T00:00:00.000Z")
            .unwrap();
        let heard: Vec<String> = store
            .guests_heard_before("2026-11-05T00:00:00.000Z")
            .unwrap()
            .into_iter()
            .map(|guest| guest.agent_id)
            .collect();
        assert_eq!(heard, ["a9"], "only the one not heard from since");
        store
            .insert_message(&crate::messages::tests::message(0, "a9"), None)
            .unwrap();
        store.delete_guest("a9").unwrap();
        assert_eq!(store.guest_table().guests().unwrap().len(), 1);
        assert!(
            store.message_table().inbox("a9").unwrap().is_empty(),
            "its inbox went with it"
        );
    }
}
