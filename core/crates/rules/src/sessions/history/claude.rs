use std::path::Path;

use facade_base::model::error::ErrorBody;
use facade_base::time::parse_iso_time;
use serde_json::Value;

use super::transcript::{json_file, latest, prompt_text, read};
use super::{Folder, SavedSession, entries, title, uuid};

pub(super) fn list(config: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let mut sessions = Vec::new();
    for project in scope.stores_at(&config.join("projects"), project_name)? {
        for path in entries(&project, |name| {
            name.strip_suffix(".jsonl").and_then(uuid).is_some()
        })? {
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let Some(id) = uuid(stem) else {
                continue;
            };
            sessions.extend(conversation(&path, &project, stem, id, scope)?);
        }
    }
    Ok(sessions)
}

fn project_name(path: &Path) -> String {
    path.to_string_lossy()
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => char::from(byte),
            _ => '-',
        })
        .collect()
}

fn conversation(
    path: &Path,
    project: &Path,
    stem: &str,
    id: String,
    scope: &Folder<'_>,
) -> Result<Option<SavedSession>, ErrorBody> {
    let Some(log) = read(path, true)? else {
        return Ok(None);
    };
    let head = &log.head;
    let tail = log.tail();
    let cwd = latest(tail, "relocated", "relocatedCwd")
        .or_else(|| head.iter().find_map(|line| line["cwd"].as_str()));
    let owns_id = head.iter().chain(tail).any(|line| {
        line["sessionId"]
            .as_str()
            .is_some_and(|recorded| recorded.eq_ignore_ascii_case(&id))
    });
    if !cwd.is_some_and(|cwd| scope.matches(Path::new(cwd)))
        || !owns_id
        || head.iter().any(is_child)
    {
        return Ok(None);
    }

    // A continuation can supersede the old session once it has saved conversation records.
    if let Some(next) = continuation(tail).filter(|next| !next.eq_ignore_ascii_case(&id)) {
        let successor = project.join(format!("{next}.jsonl"));
        if read(&successor, true)?.is_some_and(|log| {
            log.head
                .iter()
                .chain(log.tail())
                .any(|line| line.get("parentUuid").is_some())
        }) {
            return Ok(None);
        }
    }

    let sidecar;
    let custom = match latest(tail, "custom-title", "customTitle") {
        Some(custom) => Some(custom),
        None => {
            sidecar = json_file(&project.join(stem).join("custom-title.json"))?;
            sidecar
                .as_ref()
                .and_then(|value| value["customTitle"].as_str())
                .filter(|text| !text.trim().is_empty())
                .or_else(|| latest(head, "custom-title", "customTitle"))
        }
    };
    let ai = latest(tail, "ai-title", "aiTitle").or_else(|| latest(head, "ai-title", "aiTitle"));
    let summary = latest(tail, "summary", "summary").or_else(|| latest(head, "summary", "summary"));
    let native = [custom, ai, summary]
        .into_iter()
        .flatten()
        .find(|text| !text.trim().is_empty());
    let prompt = latest(tail, "last-prompt", "lastPrompt")
        .filter(|text| !text.is_empty())
        .or_else(|| head.iter().chain(tail).find_map(first_prompt));
    let activity = tail
        .iter()
        .rev()
        .filter(|line| line["type"] == "user" || line["type"] == "assistant")
        .find_map(|line| parse_iso_time(line["timestamp"].as_str()?));
    let at = match (activity, log.modified_at) {
        (Some(activity), Some(mtime)) => Some(activity.min(mtime)),
        (activity, mtime) => activity.or(mtime),
    };
    Ok(Some(scope.session(id, title(native, prompt), at)))
}

fn is_child(line: &Value) -> bool {
    line["isSidechain"] == true
        || line["teamName"]
            .as_str()
            .is_some_and(|team| !team.is_empty())
        || matches!(
            line["sessionKind"].as_str(),
            Some("daemon" | "daemon-worker")
        )
}

fn first_prompt(line: &Value) -> Option<&str> {
    if line["type"] != "user" || line["isMeta"] == true || line["isCompactSummary"] == true {
        return None;
    }
    let content = &line["message"]["content"];
    if content
        .as_array()
        .is_some_and(|parts| parts.iter().any(|part| part["type"] == "tool_result"))
    {
        return None;
    }
    prompt_text(content)
}

fn continuation(lines: &[Value]) -> Option<&str> {
    for line in lines.iter().rev() {
        if line["type"] == "continued-in"
            && let Some(next) = line["continuedInSessionId"].as_str()
            && uuid(next).is_some()
        {
            return Some(next);
        }
        if first_prompt(line).is_some()
            || (line["type"] == "assistant"
                && line["isApiErrorMessage"] != true
                && line["message"]["stop_reason"].is_string())
        {
            return None;
        }
    }
    None
}
