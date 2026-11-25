//! Cursor Agent stores its CLI conversations in the configured Cursor directory.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use facade_base::model::error::ErrorBody;
use facade_base::system::env_var;
use serde::Deserialize;

use super::{Folder, SavedSession, entries, metadata, read_metadata, title, unix_time, uuid};

pub(super) fn config_root(
    folder: &Path,
    home: Option<&Path>,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let given = |name| env_var(env, name).filter(|value| !value.trim().is_empty());
    given("CURSOR_CONFIG_DIR")
        .map(|path| folder.join(path))
        .or_else(|| given("XDG_CONFIG_HOME").map(|path| folder.join(path).join("cursor")))
        .or_else(|| home.map(|home| home.join(".cursor")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    cwd: PathBuf,
    title: Option<String>,
    created_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
    has_conversation: bool,
    #[serde(default)]
    is_subagent: bool,
}

pub(super) fn list(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let mut result = Vec::new();
    let chats = root.join("chats");
    for bucket in entries(&chats, |name| {
        name.len() == 32 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
    })? {
        for session in entries(&bucket, |name| {
            uuid(name).is_some_and(|id| scope.includes_id(&id))
        })? {
            let Some(id) = session.file_name().and_then(|name| uuid(name.to_str()?)) else {
                continue;
            };
            let Some(meta): Option<Meta> = read_metadata(&session.join("meta.json"))? else {
                continue;
            };
            if !meta.has_conversation || meta.is_subagent || !scope.matches(&meta.cwd) {
                continue;
            }
            let Some(store) = metadata(&session.join("store.db"))?.filter(|store| store.is_file())
            else {
                continue;
            };
            let at = unix_time(meta.updated_at_ms, Duration::from_millis)
                .or_else(|| store.modified().ok())
                .or_else(|| unix_time(meta.created_at_ms, Duration::from_millis));
            result.push(scope.session(id, title(meta.title.as_deref(), None), at));
        }
    }
    Ok(result)
}
