use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use facade_base::jsonrpc::ErrorBody;
use serde_json::Value;

use super::indexes::{integer, text};
use super::{
    Folder, SavedSession, entries, saved_file, sqlite, store_error, title, transcript, unix_time,
    uuid,
};

pub(super) fn list(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let mut indexed = HashSet::new();
    let mut sessions = read_threads(&root.join("state_5.sqlite"), scope, &mut indexed)?;
    for year in entries(&root.join("sessions"), |name| digits(name, 4))? {
        for month in entries(&year, |name| digits(name, 2))? {
            for day in entries(&month, |name| digits(name, 2))? {
                for path in entries(&day, |name| {
                    name.starts_with("rollout-") && name.ends_with(".jsonl")
                })? {
                    if transcript::filename_uuid(&path).is_some_and(|id| indexed.contains(&id)) {
                        continue;
                    }
                    sessions.extend(read_rollout(&path, scope, &indexed)?);
                }
            }
        }
    }
    Ok(sessions)
}

fn digits(name: &str, len: usize) -> bool {
    name.len() == len && name.bytes().all(|byte| byte.is_ascii_digit())
}

fn read_threads(
    path: &Path,
    scope: &Folder<'_>,
    indexed: &mut HashSet<String>,
) -> Result<Vec<SavedSession>, ErrorBody> {
    Ok(sqlite::read(path, |db| {
        let error = |error| store_error(path, error);
        let columns = sqlite::columns(db, "threads").map_err(error)?;
        let mut sessions = Vec::new();
        // Installations without the supported index can still have native rollouts.
        if [
            "id",
            "cwd",
            "title",
            "updated_at",
            "rollout_path",
            "archived",
            "source",
        ]
        .iter()
        .any(|name| !columns.contains(*name))
        {
            return Ok(sessions);
        }
        let at = if columns.contains("recency_at_ms") {
            "COALESCE(recency_at_ms, updated_at * 1000)"
        } else {
            "updated_at * 1000"
        };
        let name = if columns.contains("name") {
            "COALESCE(name, title)"
        } else {
            "title"
        };
        let mode = if columns.contains("history_mode") {
            "history_mode"
        } else {
            "'legacy'"
        };
        let query = format!(
            "SELECT id, cwd, {name}, {at}, rollout_path, {mode}, archived, source FROM threads"
        );
        let mut statement = db.prepare(&query).map_err(error)?;
        let mut rows = statement.query([]).map_err(error)?;
        while let Some(row) = rows.next().map_err(error)? {
            let Some(id) = text(row, 0).and_then(uuid) else {
                continue;
            };
            // A known thread, including an archive, takes precedence over its rollout.
            indexed.insert(id.clone());
            let in_scope = text(row, 1).is_some_and(|cwd| scope.matches(Path::new(cwd)));
            let archived = integer(row, 6).unwrap_or_default() != 0;
            let delegated = text(row, 7).is_some_and(|source| source.contains("subagent"));
            if !in_scope || archived || delegated {
                continue;
            }
            if text(row, 5) != Some("paginated") {
                let Some(rollout) = text(row, 4) else {
                    continue;
                };
                if !saved_file(Path::new(rollout))? {
                    continue;
                }
            }
            let at = unix_time(integer(row, 3), Duration::from_millis);
            sessions.push(scope.session(id, title(text(row, 2), None), at));
        }
        Ok(sessions)
    })?
    .unwrap_or_default())
}

fn read_rollout(
    path: &Path,
    scope: &Folder<'_>,
    indexed: &HashSet<String>,
) -> Result<Option<SavedSession>, ErrorBody> {
    let Some(log) = transcript::read(path, false)? else {
        return Ok(None);
    };
    let Some((meta, lines)) = log
        .head
        .split_first()
        .filter(|(meta, _)| meta["type"] == "session_meta")
    else {
        return Ok(None);
    };
    let payload = &meta["payload"];
    let (Some(id), Some(cwd)) = (
        payload["id"].as_str().and_then(uuid),
        payload["cwd"].as_str(),
    ) else {
        return Ok(None);
    };
    let source = &payload["source"];
    if indexed.contains(&id)
        || !scope.matches(Path::new(cwd))
        || source
            .as_str()
            .is_some_and(|source| source.contains("subagent"))
        || source.get("subagent").is_some()
    {
        return Ok(None);
    }
    let prompt = lines
        .iter()
        .filter(|line| line["type"] == "response_item" && line["payload"]["role"] == "user")
        .find_map(|line| first_prompt(&line["payload"]["content"]));
    Ok(Some(scope.session(
        id,
        title(None, prompt),
        log.modified_at,
    )))
}

fn first_prompt(content: &Value) -> Option<&str> {
    content
        .as_array()?
        .iter()
        .find_map(|part| part["text"].as_str())
        .filter(|text| !text.trim().is_empty() && !text.trim_start().starts_with('<'))
}
