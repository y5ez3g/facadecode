//! Kiro V3's local KAS conversation metadata and transcript markers.

use std::path::{Path, PathBuf};

use facade_base::model::error::ErrorBody;
use facade_base::time::parse_iso_time;
use serde::Deserialize;

use super::{Folder, SavedSession, entries, metadata, parse_session_id, read_metadata, title};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    id: String,
    title: Option<String>,
    agent_mode: Option<String>,
    workspace_paths: Vec<PathBuf>,
    parent_execution_id: Option<String>,
    last_modified_at: Option<String>,
    created_at: Option<String>,
}

pub(super) fn profile(root: &Path, scope: &Folder<'_>) -> Result<Option<String>, ErrorBody> {
    for (_, meta) in metadata_in(root, scope)? {
        if let Some(mode) = meta.agent_mode {
            return Ok(Some(mode));
        }
    }
    Ok(None)
}

pub(super) fn list(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let mut result = Vec::new();
    for (session, meta) in metadata_in(root, scope)? {
        let Some(log) =
            metadata(&session.join("messages.jsonl"))?.filter(|log| log.is_file() && log.len() > 0)
        else {
            continue;
        };
        let at = meta
            .last_modified_at
            .as_deref()
            .and_then(parse_iso_time)
            .or_else(|| log.modified().ok())
            .or_else(|| meta.created_at.as_deref().and_then(parse_iso_time));
        result.push(scope.session(meta.id, title(meta.title.as_deref(), None), at));
    }
    Ok(result)
}

fn metadata_in(root: &Path, scope: &Folder<'_>) -> Result<Vec<(PathBuf, Meta)>, ErrorBody> {
    let mut result = Vec::new();
    let sessions = root.join("sessions");
    for bucket in entries(&sessions, |name| {
        name.len() == 16 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
    })? {
        for session in entries(&bucket, |name| {
            name.starts_with("sess_")
                && parse_session_id(name).as_deref() == Some(name)
                && scope.includes_id(name)
        })? {
            let Some(meta): Option<Meta> = read_metadata(&session.join("session.json"))? else {
                continue;
            };
            if session.file_name().and_then(|name| name.to_str()) == Some(meta.id.as_str())
                && meta.parent_execution_id.is_none()
                && meta.workspace_paths.iter().any(|path| scope.matches(path))
            {
                result.push((session, meta));
            }
        }
    }
    Ok(result)
}
