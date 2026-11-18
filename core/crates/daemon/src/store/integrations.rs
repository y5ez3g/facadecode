//! The `integration_files` table: each file Facade wrote for a CLI's integration, with what it held
//! before Facade's entries and what Facade last wrote, so that taking the integration out can put
//! the file back as it was, or take out only Facade's entries where the person changed it since.

use std::sync::Arc;

use rusqlite::{Connection, params};

use super::Store;

/// A file Facade wrote for a CLI's integration, as the store keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IntegrationFile {
    pub(crate) file: String,
    /// What it held before Facade's entries: none where there was no file.
    pub(crate) before: Option<Vec<u8>>,
    /// What Facade last wrote.
    pub(crate) written: Vec<u8>,
    /// When Facade first wrote it.
    pub(crate) added_at: String,
}

pub(super) fn add_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE integration_files (
			cli TEXT NOT NULL,
			file TEXT NOT NULL,
			before BLOB,
			written BLOB NOT NULL,
			added_at TEXT NOT NULL,
			PRIMARY KEY (cli, file)
		);",
    )
}

/// The handle of the `integration_files` table, which the daemon's guests own with the
/// integrations. Every method blocks.
#[derive(Clone)]
pub(crate) struct IntegrationTable(Arc<Store>);

impl IntegrationTable {
    pub(super) fn new(store: Arc<Store>) -> IntegrationTable {
        IntegrationTable(store)
    }

    /// Commits a file of `cli`'s integration: what it held before, `before` None where there was
    /// no file, and what Facade wrote now at `at`. A file kept already keeps when Facade first
    /// wrote it.
    pub(crate) fn keep_integration_file(
        &self,
        cli: &str,
        file: &str,
        before: Option<&[u8]>,
        written: &[u8],
        at: &str,
    ) -> anyhow::Result<()> {
        self.0.with(
            || format!("keep the integration of {cli}"),
            |connection| {
                connection.execute(
                    "INSERT INTO integration_files (cli, file, before, written, added_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (cli, file) \
                     DO UPDATE SET before = excluded.before, written = excluded.written",
                    params![cli, file, before, written, at],
                )
            },
        )?;
        Ok(())
    }

    /// The files of `cli`'s integration that Facade wrote, by name.
    pub(crate) fn integration_files(&self, cli: &str) -> anyhow::Result<Vec<IntegrationFile>> {
        self.0.with(
            || format!("read the integration of {cli}"),
            |connection| {
                let mut statement = connection.prepare(
                    "SELECT file, before, written, added_at FROM integration_files \
                     WHERE cli = ?1 ORDER BY file",
                )?;
                let rows = statement.query_map([cli], |row| {
                    Ok(IntegrationFile {
                        file: row.get(0)?,
                        before: row.get(1)?,
                        written: row.get(2)?,
                        added_at: row.get(3)?,
                    })
                })?;
                rows.collect()
            },
        )
    }

    /// Commits that Facade's entries are out of `file`, for `cli`'s integration.
    pub(crate) fn forget_integration_file(&self, cli: &str, file: &str) -> anyhow::Result<()> {
        self.0.with(
            || format!("forget the integration of {cli}"),
            |connection| {
                connection.execute(
                    "DELETE FROM integration_files WHERE cli = ?1 AND file = ?2",
                    [cli, file],
                )
            },
        )?;
        Ok(())
    }
}
