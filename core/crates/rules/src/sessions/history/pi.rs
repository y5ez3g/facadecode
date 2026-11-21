use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use facade_base::model::error::ErrorBody;
use facade_base::system::{SYSTEM, System, env_var};
use serde_json::Value;

use super::paths::file_url;
use super::transcript::{json_file, latest, read};
use super::{Folder, SavedSession, entries, title, uuid};
use crate::Rule;

pub(super) fn list(
    rule: &Rule,
    scope: &Folder<'_>,
    home: Option<&Path>,
    env: &BTreeMap<String, String>,
    args: &[String],
) -> Result<Vec<SavedSession>, ErrorBody> {
    let cwd = scope.selected;
    let resolve = |value: &str| resolve_dir(value, cwd, home);
    let value = |name| env_var(env, name).filter(|value| !value.is_empty());
    let agent = value("PI_CODING_AGENT_DIR")
        .and_then(resolve)
        .or_else(|| home.map(|home| home.join(".pi").join("agent")));

    let launch = rule.arguments.found(args, "--session-dir").pop();
    let override_dir = launch
        .as_ref()
        .and_then(|option| option.value.as_deref())
        .filter(|value| !value.is_empty())
        .or_else(|| value("PI_CODING_AGENT_SESSION_DIR"))
        .and_then(resolve);
    let folders = if let Some(dir) = override_dir {
        vec![dir]
    } else if let Some(dir) = setting(&cwd.join(".pi").join("settings.json"))?
        .as_deref()
        .and_then(resolve)
    {
        vec![dir]
    } else if let Some(agent) = agent {
        if let Some(dir) = setting(&agent.join("settings.json"))?
            .as_deref()
            .and_then(resolve)
        {
            vec![dir]
        } else {
            scope.stores_at(&agent.join("sessions"), project_name)?
        }
    } else {
        Vec::new()
    };

    let mut sessions = Vec::new();
    for dir in folders {
        for path in entries(&dir, |name| name.ends_with(".jsonl"))? {
            sessions.extend(conversation(&path, scope)?);
        }
    }
    Ok(sessions)
}

fn setting(path: &Path) -> Result<Option<String>, ErrorBody> {
    Ok(json_file(path)?.and_then(|value| {
        value["sessionDir"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    }))
}

fn resolve_dir(value: &str, cwd: &Path, home: Option<&Path>) -> Option<PathBuf> {
    if value == "~" {
        return home.map(Path::to_path_buf);
    }
    let tilde = if SYSTEM == System::Windows {
        ['/', '\\'].as_slice()
    } else {
        ['/'].as_slice()
    };
    if let Some(rest) = value
        .strip_prefix('~')
        .and_then(|rest| rest.strip_prefix(tilde))
    {
        return Some(home?.join(rest));
    }
    if value.starts_with("file://") {
        return file_url(value);
    }
    Some(cwd.join(value))
}

fn project_name(path: &Path) -> String {
    let path = path.to_string_lossy();
    let path = path.strip_prefix(['/', '\\']).unwrap_or(&path);
    format!("--{}--", path.replace(['/', '\\', ':'], "-"))
}

fn conversation(path: &Path, scope: &Folder<'_>) -> Result<Option<SavedSession>, ErrorBody> {
    let Some(log) = read(path, true)? else {
        return Ok(None);
    };
    let Some(header) = log.head.first().filter(|line| line["type"] == "session") else {
        return Ok(None);
    };
    let (Some(id), Some(cwd)) = (header["id"].as_str().and_then(uuid), header["cwd"].as_str())
    else {
        return Ok(None);
    };
    if !scope.matches(Path::new(cwd)) {
        return Ok(None);
    }
    let name = latest(log.tail(), "session_info", "name")
        .or_else(|| latest(&log.head, "session_info", "name"));
    let prompt = log
        .head
        .iter()
        .filter(|line| line["type"] == "message" && line["message"]["role"] == "user")
        .find_map(|line| user_text(&line["message"]["content"]));
    Ok(Some(scope.session(
        id,
        title(name, prompt),
        log.modified_at,
    )))
}

fn user_text(content: &Value) -> Option<&str> {
    let nonempty = |text: &&str| !text.trim().is_empty();
    content.as_str().filter(nonempty).or_else(|| {
        content
            .as_array()?
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .find(nonempty)
    })
}
