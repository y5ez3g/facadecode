use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use facade_base::model::error::ErrorBody;
use facade_base::time::iso_time;

use super::{Folder, SavedSession, indexes, title, transcript};

pub(super) fn sessions(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let indexed = indexes::muse(root, scope)?;
    if let Some(id) = scope.id
        && !indexed.iter().any(|session| session.title.is_some())
        && let Some(session) = recorded_session(root, scope, id)?
    {
        return Ok(vec![session]);
    }
    Ok(indexed)
}

fn recorded_session(
    root: &Path,
    scope: &Folder<'_>,
    id: &str,
) -> Result<Option<SavedSession>, ErrorBody> {
    if id.as_bytes().get(14) != Some(&b'7') {
        return Ok(None);
    }
    // The canonical UUIDv7 starts with the 48-bit creation timestamp in milliseconds.
    let Ok(millis) = u64::from_str_radix(&id[..13].replace('-', ""), 16) else {
        return Ok(None);
    };
    let created = Duration::from_millis(millis);
    let day = Duration::from_secs(86_400);
    // Muse uses the local date. The UTC date and its neighbors cover that folder.
    for since_epoch in [Some(created), created.checked_sub(day), Some(created + day)]
        .into_iter()
        .flatten()
    {
        let date = iso_time(UNIX_EPOCH + since_epoch);
        let folder = date
            .split(['-', 'T'])
            .take(3)
            .fold(root.join("sessions"), |folder, part| folder.join(part));
        let path = folder.join(id).join("session.jsonl");
        if let Some(session) = conversation(&path, scope, id)? {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

fn conversation(
    path: &Path,
    scope: &Folder<'_>,
    id: &str,
) -> Result<Option<SavedSession>, ErrorBody> {
    let Some(log) = transcript::read(path, false)? else {
        return Ok(None);
    };
    let workspace = log
        .head
        .iter()
        .find(|record| record["payload_type"] == "runtime.session.metadata")
        .and_then(|record| record["payload"]["record"]["workspace_root"].as_str());
    if !workspace.is_some_and(|workspace| scope.matches(Path::new(workspace))) {
        return Ok(None);
    }
    let name = log
        .head
        .iter()
        .find(|record| record["payload_type"] == "runtime.user_intent.accepted")
        .and_then(|record| record["payload"]["refill_blocks"].as_array())
        .and_then(|blocks| {
            blocks
                .iter()
                .find_map(|block| title(None, block["text"].as_str()))
        });
    Ok(name.map(|name| scope.session(id.to_owned(), Some(name), log.modified_at)))
}
