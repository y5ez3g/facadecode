use std::path::Path;
use std::time::Duration;

use facade_base::model::error::ErrorBody;
use rusqlite::{Connection, Row};
use serde_json::Value;

use super::{
    Folder, SavedSession, parse_session_id, paths::file_url, saved_file, sqlite, store_error,
    title, unix_time, uuid,
};

pub(super) fn antigravity(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let path = root.join("conversation_summaries.db");
    let query = "SELECT conversation_id, title, preview,
                        CAST(ROUND(unixepoch(last_modified_time, 'subsec') * 1000) AS INTEGER),
                        workspace_uris
                 FROM conversation_summaries WHERE parent_conversation_id = ''";
    read_index(
        &path,
        |_| Ok(Some(query.to_owned())),
        |row| {
            let Some(native_id) = text(row, 0) else {
                return Ok(None);
            };
            let Some(id) = uuid(native_id) else {
                return Ok(None);
            };
            if !scope.includes_id(&id)
                || !text(row, 4).is_some_and(|uris| contains_folder(uris, scope))
            {
                return Ok(None);
            }
            // The index retains rows even after Antigravity has dropped their conversation files.
            if !saved_file(&root.join("conversations").join(format!("{native_id}.db")))? {
                return Ok(None);
            }
            let at = unix_time(integer(row, 3), Duration::from_millis);
            Ok(Some(scope.session(
                id,
                title(text(row, 1), text(row, 2)),
                at,
            )))
        },
    )
}

/// Antigravity also records directories given with --add-dir, without identifying the original
/// cwd. A directory explicitly selected by the caller can match one of those workspace URIs.
fn contains_folder(uris: &str, scope: &Folder<'_>) -> bool {
    serde_json::from_str::<Vec<Value>>(uris).is_ok_and(|uris| {
        uris.iter()
            .filter_map(|uri| file_url(uri.as_str()?))
            .any(|path| scope.matches(&path))
    })
}

pub(super) fn muse(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let path = root.join("session-index.db");
    read_index(
        &path,
        |db| {
            let columns = sqlite::columns(db, "sessions")?;
            let at = if columns.contains("msp_last_activity_at_us") {
                "COALESCE(msp_last_activity_at_us, updated_at_us)"
            } else {
                "updated_at_us"
            };
            let name = if columns.contains("session_name") {
                "session_name"
            } else {
                "NULL"
            };
            let root = if columns.contains("msp_kind") {
                "AND (msp_kind IS NULL OR msp_kind = 'root')"
            } else {
                ""
            };
            Ok(Some(format!(
            "SELECT session_id, workspace_root, first_user_prompt, {name}, {at}, session_log_path
             FROM sessions WHERE status = 'valid' AND prompt_count > 0 {root}"
        )))
        },
        |row| {
            let (Some(id), Some(cwd), Some(log)) =
                (text(row, 0).and_then(uuid), text(row, 1), text(row, 5))
            else {
                return Ok(None);
            };
            if !scope.includes_id(&id)
                || !scope.matches(Path::new(cwd))
                || !saved_file(Path::new(log))?
            {
                return Ok(None);
            }
            let at = unix_time(integer(row, 4), Duration::from_micros);
            Ok(Some(scope.session(
                id,
                title(text(row, 3), text(row, 2)),
                at,
            )))
        },
    )
}

pub(super) fn opencode(path: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    read_index(
        path,
        |db| {
            let table = |name| -> rusqlite::Result<bool> {
                db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
                    [name],
                    |row| row.get(0),
                )
            };
            let table = if table("session_v2")? {
                "session_v2"
            } else if table("session")? {
                "session"
            } else {
                return Ok(None);
            };
            let columns = sqlite::columns(db, table)?;
            let archive = if columns.contains("time_archived") {
                "AND time_archived IS NULL"
            } else {
                ""
            };
            Ok(Some(format!(
                "SELECT id, directory, title, time_updated FROM {table} WHERE parent_id IS NULL {archive}"
            )))
        },
        |row| {
            let (Some(id), Some(cwd)) = (text(row, 0), text(row, 1)) else {
                return Ok(None);
            };
            let Some(id) = parse_session_id(id).filter(|id| id.starts_with("ses_")) else {
                return Ok(None);
            };
            if !scope.includes_id(&id) || !scope.matches(Path::new(cwd)) {
                return Ok(None);
            }
            let at = unix_time(integer(row, 3), Duration::from_millis);
            Ok(Some(scope.session(id, title(text(row, 2), None), at)))
        },
    )
}

fn read_index(
    path: &Path,
    query: impl FnOnce(&Connection) -> rusqlite::Result<Option<String>>,
    mut session: impl FnMut(&Row<'_>) -> Result<Option<SavedSession>, ErrorBody>,
) -> Result<Vec<SavedSession>, ErrorBody> {
    Ok(sqlite::read(path, |db| {
        let error = |error| store_error(path, error);
        let mut result = Vec::new();
        if let Some(query) = query(db).map_err(error)? {
            let mut statement = db.prepare(&query).map_err(error)?;
            let mut rows = statement.query([]).map_err(error)?;
            while let Some(row) = rows.next().map_err(error)? {
                result.extend(session(row)?);
            }
        }
        Ok(result)
    })?
    .unwrap_or_default())
}

pub(super) fn text<'a>(row: &'a Row<'_>, index: usize) -> Option<&'a str> {
    row.get_ref(index).ok()?.as_str().ok()
}

pub(super) fn integer(row: &Row<'_>, index: usize) -> Option<i64> {
    row.get(index).ok()
}
