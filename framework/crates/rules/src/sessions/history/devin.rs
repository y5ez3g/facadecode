//! Devin's local file and SQLite session stores.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use facade_base::model::error::ErrorBody;
use facade_base::system::{SYSTEM, System, env_var, home_folder_in};
use facade_base::time::parse_iso_time;

use super::transcript::json_file;
use super::{Folder, SavedSession, entries, metadata, sqlite, store_error, title, unix_time, uuid};
use crate::formats::parse_jsonc;

pub(super) fn list(
    scope: &Folder<'_>,
    environment: &BTreeMap<String, String>,
) -> Result<Vec<SavedSession>, ErrorBody> {
    let var = |key| env_var(environment, key).filter(|value| !value.is_empty());
    let home = home_folder_in(environment);
    let home = home.as_deref();
    let data = match SYSTEM {
        System::Unix => var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| home.map(|home| home.join(".local/share"))),
        System::Windows => var("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| home.map(|home| home.join("AppData/Local"))),
    };
    let root = var("DEVIN_SESSIONS_DIR")
        .map(PathBuf::from)
        .or_else(|| data.map(|data| data.join("devin")));
    let db = var("CHISEL_SESSION_DB")
        .map(|path| scope.selected.join(path))
        .or_else(|| Some(scope.selected.join(root.as_ref()?).join("sessions.db")));
    let configured = crate::devin_config_dir(environment)
        .and_then(|path| {
            std::fs::read_to_string(scope.selected.join(path).join("config.json")).ok()
        })
        .and_then(|text| parse_jsonc(&text).ok());
    let backend =
        var("DEVIN_SESSION_STORE").or_else(|| configured.as_ref()?.get("session_store")?.as_str());
    let mut sessions = BTreeMap::new();
    if backend != Some("files")
        && let Some(db) = db
    {
        for session in database(&db, scope)? {
            sessions.insert(session.id.clone(), session);
        }
    }
    if var("DEVIN_SESSION_STORE") != Some("sqlite")
        && let Some(root) = root
    {
        let root = scope.selected.join(root).join("sessions");
        for folder in entries(&root, |name| {
            uuid(name).is_some_and(|id| id == name && scope.includes_id(&id))
        })? {
            let Some(id) = folder.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let meta = folder.join("meta.json");
            if let Some(session) = file_session(&meta, id, scope)? {
                sessions.insert(session.id.clone(), session);
            }
        }
    }
    Ok(sessions.into_values().collect())
}

fn activity(value: i64) -> Option<SystemTime> {
    // Different store generations serialize timestamps in seconds or milliseconds.
    if value >= 100_000_000_000 {
        unix_time(Some(value), Duration::from_millis)
    } else {
        unix_time(Some(value), Duration::from_secs)
    }
}

fn file_session(
    meta: &Path,
    id: &str,
    scope: &Folder<'_>,
) -> Result<Option<SavedSession>, ErrorBody> {
    let Some(record) = json_file(meta)? else {
        return Ok(None);
    };
    if record["id"] != id
        || record["hidden"] == true
        || !record["working_directory"]
            .as_str()
            .is_some_and(|cwd| scope.matches(Path::new(cwd)))
    {
        return Ok(None);
    }
    let modified = record["last_activity_at"]
        .as_i64()
        .and_then(activity)
        .or_else(|| record["last_activity_at"].as_str().and_then(parse_iso_time))
        .or(metadata(meta)?.and_then(|meta| meta.modified().ok()));
    Ok(Some(scope.session(
        id.to_owned(),
        title(record["title"].as_str(), None),
        modified,
    )))
}

fn database(path: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    Ok(sqlite::read(path, |db| {
        let error = |why| store_error(path, why);
        let columns = sqlite::columns(db, "sessions").map_err(error)?;
        if !["id", "working_directory", "last_activity_at"].iter().all(|name| columns.contains(*name)) {
            return Ok(Vec::new());
        }
        let name = if columns.contains("title") { "title" } else { "NULL" };
        let visible = if columns.contains("hidden") { "hidden = 0" } else { "1" };
        let sql = format!("SELECT id, working_directory, {name}, last_activity_at FROM sessions WHERE {visible} AND (?1 IS NULL OR id = ?1)");
        let mut query = db.prepare(&sql).map_err(error)?;
        let rows = query.query_map([scope.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?))
        }).map_err(error)?;
        let mut found = Vec::new();
        for row in rows {
            let (id, cwd, name, modified) = row.map_err(error)?;
            if uuid(&id).as_deref() == Some(&id) && scope.matches(Path::new(&cwd)) {
                found.push(scope.session(id, title(name.as_deref(), None), activity(modified)));
            }
        }
        Ok(found)
    })?.unwrap_or_default())
}
