//! Oh My Pi's JSONL sessions can begin with an editable title slot before their session header.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use facade_base::files::{folder_key, real_path};
use facade_base::model::error::ErrorBody;
use facade_base::system::{SYSTEM, System, env_var};
use sha2::{Digest, Sha256};

use super::transcript::{latest, read};
use super::{Folder, SavedSession, entries, pi, title, uuid};
use crate::Rule;

pub(super) fn list(
    rule: &Rule,
    scope: &Folder<'_>,
    home: Option<&Path>,
    env: &BTreeMap<String, String>,
    args: &[String],
) -> Result<Vec<SavedSession>, ErrorBody> {
    let value = |name| env_var(env, name).filter(|value| !value.is_empty());
    let resolve = |value| pi::resolve_dir(value, scope.selected, home);
    let option = |name| {
        rule.arguments
            .found(args, name)
            .pop()
            .and_then(|found| found.value)
    };
    let overridden = option("--session-dir");
    let folders = match overridden
        .as_deref()
        .or_else(|| value("PI_CODING_AGENT_SESSION_DIR"))
        .and_then(resolve)
    {
        Some(folder) => vec![folder],
        None => {
            let Some(home) = home else {
                return Ok(Vec::new());
            };
            let profile_option = option("--profile");
            let profile = profile_option
                .as_deref()
                .or_else(|| env_var(env, "OMP_PROFILE"))
                .or_else(|| env_var(env, "PI_PROFILE"))
                .unwrap_or_default()
                .trim();
            let profile = match profile {
                "" | "default" => None,
                name if valid_profile(name) => Some(name),
                _ => return Ok(Vec::new()),
            };
            let config = home.join(value("PI_CONFIG_DIR").unwrap_or(".omp"));
            let default = profile.map_or_else(
                || config.join("agent"),
                |name| config.join("profiles").join(name).join("agent"),
            );
            let agent = if profile.is_none() {
                value("PI_CODING_AGENT_DIR")
                    .and_then(resolve)
                    .unwrap_or_else(|| default.clone())
            } else {
                default.clone()
            };
            let sessions = if SYSTEM == System::Unix && agent == default {
                value("XDG_DATA_HOME")
                    .and_then(resolve)
                    .map(|root| root.join("omp"))
                    .map(|root| {
                        profile.map_or(root.clone(), |name| root.join("profiles").join(name))
                    })
                    .filter(|root| root.is_dir())
                    .unwrap_or(agent)
            } else {
                agent
            }
            .join("sessions");
            let tmp = if SYSTEM == System::Windows {
                value("TEMP").or_else(|| value("TMP")).and_then(resolve)
            } else {
                value("TMPDIR")
                    .or_else(|| value("TMP"))
                    .or_else(|| value("TEMP"))
                    .and_then(resolve)
                    .or_else(|| Some(PathBuf::from("/tmp")))
            };
            let names = project_names(scope, home, tmp.as_deref());
            entries(&sessions, |name| {
                names.contains(&folder_key(Path::new(name)))
            })?
        }
    };
    let mut sessions = Vec::new();
    for folder in folders {
        for file in entries(&folder, |name| name.ends_with(".jsonl"))? {
            sessions.extend(conversation(&file, scope)?);
        }
    }
    Ok(sessions)
}

pub(super) fn conversation(
    path: &Path,
    scope: &Folder<'_>,
) -> Result<Option<SavedSession>, ErrorBody> {
    if path
        .extension()
        .is_none_or(|extension| extension != "jsonl")
    {
        return Ok(None);
    }
    let Some(log) = read(path, true)? else {
        return Ok(None);
    };
    let mut records = log.head.iter();
    let Some(first) = records.next() else {
        return Ok(None);
    };
    let (slot, header) = if first["type"] == "title" {
        (first["title"].as_str(), records.next())
    } else {
        (None, Some(first))
    };
    let Some(header) = header.filter(|record| record["type"] == "session") else {
        return Ok(None);
    };
    let (Some(id), Some(cwd)) = (header["id"].as_str().and_then(uuid), header["cwd"].as_str())
    else {
        return Ok(None);
    };
    if !scope.includes_id(&id) || !scope.matches(Path::new(cwd)) {
        return Ok(None);
    }

    let middle;
    let name = if slot.is_some() {
        slot
    } else if let Some(name) = latest(log.tail(), "title_change", "title") {
        Some(name)
    } else {
        middle = log.latest_middle(path, "title_change", "title")?;
        middle
            .as_deref()
            .or_else(|| latest(&log.head, "title_change", "title"))
            .or_else(|| header["title"].as_str())
            .or_else(|| latest(log.tail(), "session_info", "name"))
            .or_else(|| latest(&log.head, "session_info", "name"))
    };
    Ok(Some(scope.session(
        id,
        title(name, pi::first_prompt(&log.head)),
        log.modified_at,
    )))
}

fn valid_profile(name: &str) -> bool {
    let good_first = name
        .as_bytes()
        .first()
        .is_some_and(|char| char.is_ascii_lowercase() || char.is_ascii_digit());
    good_first
        && name.len() <= 64
        && !name.ends_with('.')
        && name.bytes().all(|char| {
            char.is_ascii_lowercase() || char.is_ascii_digit() || b"._-".contains(&char)
        })
}

fn project_names(scope: &Folder<'_>, home: &Path, tmp: Option<&Path>) -> BTreeSet<String> {
    let home_key = real_path(home).ok();
    let tmp_key = tmp.and_then(|path| real_path(path).ok());
    let mut names = BTreeSet::new();
    let mut add = |name: String| {
        names.insert(folder_key(Path::new(&name)));
    };
    for folder in scope.forms() {
        add(pi::project_name(folder));
        let mut relative = false;
        for (kind, prefix, bases) in [
            ("home", "-", [Some(home), home_key.as_deref()]),
            ("tmp", "-tmp", [tmp, tmp_key.as_deref()]),
        ] {
            for base in bases.into_iter().flatten() {
                if let Ok(rest) = folder.strip_prefix(base) {
                    let rest = rest.to_string_lossy().replace(['/', '\\', ':'], "-");
                    let gap = if prefix.ends_with('-') || rest.is_empty() {
                        ""
                    } else {
                        "-"
                    };
                    add(format!("{prefix}{gap}{rest}"));
                    add(hashed_name(kind, folder));
                    relative = true;
                }
            }
        }
        if !relative {
            add(hashed_name("abs", folder));
        }
    }
    names
}

/// The short-lived hashed directory spelling that newer Oh My Pi migrates on launch.
fn hashed_name(kind: &str, folder: &Path) -> String {
    let name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let mut readable = String::new();
    for char in name.chars() {
        if char.is_ascii_alphanumeric() || ".-_".contains(char) {
            readable.push(char);
        } else if !readable.ends_with('-') {
            readable.push('-');
        }
    }
    let readable = readable.trim_matches('-');
    let readable = if readable.is_empty() {
        "project"
    } else {
        readable
    };
    let digest = Sha256::digest(folder.to_string_lossy().replace('\\', "/").as_bytes());
    format!(
        "{kind}-{}-{digest:x}",
        &readable[readable.len().saturating_sub(80)..]
    )
}
