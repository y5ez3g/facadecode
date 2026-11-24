use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;

use facade_base::files::immutable_uri;
use facade_base::model::error::ErrorBody;
use rusqlite::{Connection, OpenFlags};

use super::{metadata, store_error};

/// A quiet index is immutable so SQLite creates no journal or shared-memory files. When a WAL
/// holds changes, read the live index with its WAL so committed sessions are visible.
pub(super) fn read<T>(
    path: &Path,
    query: impl FnOnce(&Connection) -> Result<T, ErrorBody>,
) -> Result<Option<T>, ErrorBody> {
    if metadata(path)?.is_none() {
        return Ok(None);
    }
    let mut wal = OsString::from(path.as_os_str());
    wal.push("-wal");
    let has_wal = metadata(Path::new(&wal))?.is_some_and(|meta| meta.len() > 0);
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = if has_wal {
        Connection::open_with_flags(path, flags)
    } else {
        let uri = immutable_uri(path).ok_or_else(|| store_error(path, "the path is not UTF-8"))?;
        Connection::open_with_flags(uri, flags | OpenFlags::SQLITE_OPEN_URI)
    }
    .map_err(|error| store_error(path, error))?;
    query(&connection).map(Some)
}

/// A vendor's versioned schema. Callers supply table names fixed by the vendor format.
pub(super) fn columns(db: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    statement.query_map([], |row| row.get(1))?.collect()
}
