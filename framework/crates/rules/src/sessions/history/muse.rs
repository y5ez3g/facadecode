use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    for path in session_transcripts(root, id) {
        if let Some(session) = conversation(&path, scope, id)? {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

/// The native runtime records who opened the session before the first prompt or hook report.
pub(super) fn live_session_matches(
    root: &Path,
    scope: &Folder<'_>,
    id: &str,
    pid: u32,
    started_at: SystemTime,
) -> Result<bool, ErrorBody> {
    let lifetime = started_at..=SystemTime::now();
    for path in session_transcripts(root, id) {
        let Some(log) = transcript::read(&path, false)? else {
            continue;
        };
        if log.head.iter().any(|event| {
            let route = &event["payload"]["record"];
            event["payload_type"] == "runtime.session.route_facts"
                && event["stream"]["id"] == id
                && route["pid"] == pid
                && route["cwd"]
                    .as_str()
                    .is_some_and(|cwd| scope.matches(Path::new(cwd)))
                // Muse records event time as Unix microseconds.
                && event["recorded_at"]
                    .as_u64()
                    .and_then(|micros| UNIX_EPOCH.checked_add(Duration::from_micros(micros)))
                    .is_some_and(|at| lifetime.contains(&at))
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn session_transcripts(root: &Path, id: &str) -> Vec<PathBuf> {
    if id.as_bytes().get(14) != Some(&b'7') {
        return Vec::new();
    }
    // The canonical UUIDv7 starts with the 48-bit creation timestamp in milliseconds.
    let Ok(millis) = u64::from_str_radix(&id[..13].replace('-', ""), 16) else {
        return Vec::new();
    };
    let created = Duration::from_millis(millis);
    let day = Duration::from_secs(86_400);
    // Muse uses the local date. The UTC date and its neighbors cover that folder.
    [Some(created), created.checked_sub(day), Some(created + day)]
        .into_iter()
        .flatten()
        .map(|since_epoch| {
            let date = iso_time(UNIX_EPOCH + since_epoch);
            date.split(['-', 'T'])
                .take(3)
                .fold(root.join("sessions"), |folder, part| folder.join(part))
                .join(id)
                .join("session.jsonl")
        })
        .collect()
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
