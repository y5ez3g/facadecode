//! The `integration_files` table, in which earlier versions kept each file Facade Code Framework wrote for a CLI's
//! integration. The schema keeps it.

use rusqlite::Connection;

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
