//! GitHub Copilot CLI's configuration directory and persisted workspace metadata.

use std::collections::BTreeMap;
use std::fs::{File, Metadata};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use facade_base::model::error::ErrorBody;
use facade_base::system::{env_var, home_folder_in};
use facade_base::time::parse_iso_time;
use serde::Deserialize;
use serde_json::Value;
use serde_saphyr::{DuplicateKeyPolicy, MergeKeyPolicy, budget, from_slice_with_options, options};

use super::{
    Folder, SavedSession, entries, if_present, metadata, read_metadata_bytes, store_error, title,
    uuid,
};
use crate::Rule;

pub(crate) fn config_dir(
    rule: &Rule,
    launch_cwd: &Path,
    environment: &BTreeMap<String, String>,
    words: &[String],
) -> Option<PathBuf> {
    let home = || home_folder_in(environment).map(|path| launch_cwd.join(path));
    if let Some(value) = rule
        .arguments
        .found(words, "--config-dir")
        .into_iter()
        .next()
        .and_then(|option| option.value)
    {
        let path = Path::new(&value);
        if let Ok(relative) = path.strip_prefix("~") {
            return home().map(|home| home.join(relative));
        }
        return Some(launch_cwd.join(path));
    }
    env_var(environment, "COPILOT_HOME")
        .filter(|path| !path.is_empty())
        .map(|path| launch_cwd.join(path))
        .or_else(|| home().map(|home| home.join(".copilot")))
}

pub(super) fn list(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let store = root.join("session-state");
    if let Some(id) = scope.id {
        return Ok(conversation(&store.join(id), scope)?.into_iter().collect());
    }
    let mut sessions = Vec::new();
    for directory in entries(&store, |name| uuid(name).as_deref() == Some(name))? {
        sessions.extend(conversation(&directory, scope)?);
    }
    Ok(sessions)
}

fn conversation(directory: &Path, scope: &Folder<'_>) -> Result<Option<SavedSession>, ErrorBody> {
    let Some(workspace) = read_workspace(directory, scope)? else {
        return Ok(None);
    };
    let Some(log) = user_message_log(directory)? else {
        return Ok(None);
    };
    let modified_at = workspace
        .updated_at
        .or(workspace.created_at)
        .or_else(|| log.modified().ok());
    Ok(Some(scope.session(
        workspace.id,
        workspace.title,
        modified_at,
    )))
}

#[derive(Deserialize)]
struct Workspace {
    id: String,
    cwd: PathBuf,
    name: Option<String>,
    updated_at: Option<String>,
    created_at: Option<String>,
}

struct WorkspaceMetadata {
    id: String,
    title: Option<String>,
    updated_at: Option<SystemTime>,
    created_at: Option<SystemTime>,
}

fn read_workspace(
    directory: &Path,
    scope: &Folder<'_>,
) -> Result<Option<WorkspaceMetadata>, ErrorBody> {
    const LIMIT: u64 = 64 * 1024;

    let Some(id) = directory.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    if uuid(id).as_deref() != Some(id) || !scope.includes_id(id) {
        return Ok(None);
    }
    let Some(bytes) = read_metadata_bytes(&directory.join("workspace.yaml"), LIMIT)? else {
        return Ok(None);
    };
    let options = options! {
        budget: budget! {
            max_depth: 16,
            max_documents: 1,
            max_events: 4096,
            max_nodes: 4096,
            max_total_scalar_bytes: LIMIT as usize,
            max_aliases: 0,
            max_anchors: 0,
            max_merge_keys: 0,
        },
        duplicate_keys: DuplicateKeyPolicy::Error,
        merge_keys: MergeKeyPolicy::Error,
        with_snippet: false,
    };
    Ok(from_slice_with_options::<Workspace>(&bytes, options)
        .ok()
        .filter(|workspace| {
            workspace.id == id && scope.matches(&workspace.cwd) && workspace.cwd.is_dir()
        })
        .map(|workspace| WorkspaceMetadata {
            id: workspace.id,
            title: title(workspace.name.as_deref(), None),
            updated_at: workspace.updated_at.as_deref().and_then(parse_iso_time),
            created_at: workspace.created_at.as_deref().and_then(parse_iso_time),
        }))
}

/// The native journal's metadata once a visible, primary user message with text is found.
fn user_message_log(directory: &Path) -> Result<Option<Metadata>, ErrorBody> {
    let path = directory.join("events.jsonl");
    let Some(meta) = metadata(&path)?.filter(|meta| meta.is_file()) else {
        return Ok(None);
    };
    let Some(file) = if_present(&path, File::open(&path))? else {
        return Ok(None);
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let nonempty_string = |value: &Value| value.as_str().is_some_and(|text| !text.is_empty());
    loop {
        line.clear();
        reader
            .read_until(b'\n', &mut line)
            .map_err(|error| store_error(&path, error))?;
        if !line.ends_with(b"\n") {
            return Ok(None);
        }
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if event["type"] != "user.message"
            || !nonempty_string(&event["id"])
            || !nonempty_string(&event["timestamp"])
            || !event
                .get("parentId")
                .is_some_and(|id| id.is_null() || id.is_string())
            || !matches!(event.get("ephemeral"), None | Some(Value::Bool(false)))
        {
            continue;
        }
        let data = &event["data"];
        let visible_origin = match data.get("source") {
            None => true,
            Some(Value::String(source)) => {
                source.is_empty()
                    || source == "user"
                    || ["command-", "schedule-", "autopilot-"]
                        .iter()
                        .any(|prefix| source.starts_with(prefix))
            }
            _ => false,
        };
        if visible_origin
            && !nonempty_string(&event["agentId"])
            && !nonempty_string(&data["agentId"])
            && !nonempty_string(&data["parentToolCallId"])
            && data["content"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
        {
            return Ok(Some(meta));
        }
    }
}
