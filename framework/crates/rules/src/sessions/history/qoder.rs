//! Qoder CLI's project-scoped JSONL transcripts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use facade_base::model::error::ErrorBody;
use facade_base::system::{env_var, home_folder_in};
use facade_base::time::parse_iso_time;
use serde_json::Value;

use super::transcript::{prompt_text, read};
use super::{Folder, SavedSession, entries, title, uuid};
use crate::Rule;

pub(crate) fn config_dir(
    rule: &Rule,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    words: &[String],
) -> Option<PathBuf> {
    rule.arguments
        .found(words, "--config-dir")
        .into_iter()
        .next()
        .and_then(|option| option.value)
        .or_else(|| {
            env_var(environment, "QODER_CONFIG_DIR")
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .map(|path| cwd.join(path))
        .or_else(|| {
            env_var(environment, "QODER_CLI_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| home_folder_in(environment))
                .map(|home| cwd.join(home).join(".qoder"))
        })
}

pub(super) fn list(root: &Path, scope: &Folder<'_>) -> Result<Vec<SavedSession>, ErrorBody> {
    let mut sessions = BTreeMap::new();
    for project in scope.stores_at(&root.join("projects"), project_name)? {
        for path in entries(&project, |name| name.ends_with(".jsonl"))? {
            if let Some(session) = conversation(&path, scope)? {
                let same = sessions
                    .entry(session.id.clone())
                    .or_insert_with(|| session.clone());
                if same.modified_at < session.modified_at {
                    *same = session;
                }
            }
        }
    }
    Ok(sessions.into_values().collect())
}

/// Qoder replaces each UTF-16 unit outside ASCII alphanumerics with a dash. Long names end
/// with the base-36 form of the absolute value of its signed, wrapping path hash.
fn project_name(path: &Path) -> String {
    let path = path.to_string_lossy();
    let name: String = path
        .encode_utf16()
        .map(|unit| {
            u8::try_from(unit)
                .ok()
                .filter(u8::is_ascii_alphanumeric)
                .map_or('-', char::from)
        })
        .collect();
    if name.len() <= 200 {
        return name;
    }
    let hash = path.encode_utf16().fold(5381_i32, |hash, unit| {
        hash.wrapping_mul(33) ^ i32::from(unit)
    });
    let mut digits = Vec::new();
    let mut number = hash.unsigned_abs();
    loop {
        digits.push(char::from_digit(number % 36, 36).expect("base-36 digit"));
        number /= 36;
        if number == 0 {
            break;
        }
    }
    format!(
        "{}-{}",
        &name[..200],
        digits.iter().rev().collect::<String>()
    )
}

pub(super) fn conversation(
    path: &Path,
    scope: &Folder<'_>,
) -> Result<Option<SavedSession>, ErrorBody> {
    let Some(stem) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".jsonl"))
    else {
        return Ok(None);
    };
    let Some(id) = uuid(stem).filter(|id| id == stem && scope.includes_id(id)) else {
        return Ok(None);
    };
    let Some(log) = read(path, true)? else {
        return Ok(None);
    };
    let head = &log.head;
    let tail = log.tail();
    let records = || {
        head.iter()
            .chain(tail)
            .filter(|row| row["isSidechain"] != true)
    };
    let belongs = |row: &Value| row["sessionId"] == id;
    let cwd = tail
        .iter()
        .rev()
        .chain(head.iter().rev())
        .find_map(|row| {
            (row["type"] == "relocated" && belongs(row))
                .then(|| row["relocatedCwd"].as_str())
                .flatten()
        })
        .or_else(|| records().find_map(|row| row["cwd"].as_str()));
    let matching_folder = cwd.is_some_and(|cwd| scope.matches(Path::new(cwd)));
    if !matching_folder || !records().any(belongs) {
        return Ok(None);
    }

    let resumable = records().any(|row| {
        row["type"] == "assistant"
            || row["isCompactSummary"] == true
            || user_prompt(row).is_some()
            || (row["type"] == "user"
                && row["origin"]["kind"] == "human"
                && row.get("message").is_some())
            || (row["type"] == "active-leaf"
                && belongs(row)
                && row["explicit"] == true
                && row.get("leafUuid").is_some_and(Value::is_null))
    });
    if !resumable {
        return Ok(None);
    }
    let native = |kind, field| {
        tail.iter()
            .rev()
            .chain(head.iter().rev())
            .filter(|row| row["type"] == kind && belongs(row))
            .find_map(|row| row[field].as_str())
    };
    let named = native("custom-title", "customTitle").or_else(|| native("ai-title", "aiTitle"));
    let prompt = native("last-prompt", "lastPrompt").or_else(|| records().find_map(user_prompt));
    let activity = tail
        .iter()
        .rev()
        .filter(|row| row["isSidechain"] != true)
        .find_map(|row| parse_iso_time(row["timestamp"].as_str()?));
    Ok(Some(scope.session(
        id,
        title(named, prompt),
        activity.or(log.modified_at),
    )))
}

fn user_prompt(row: &Value) -> Option<&str> {
    if row["type"] != "user" || row["isMeta"] == true || row["isVisibleInTranscriptOnly"] == true {
        return None;
    }
    prompt_text(&row["message"]["content"])
}
