//! What Facade adds to a CLI's own settings for a run, merged with the person's: Antigravity's
//! `--settings` and Muse Code's `-c hooks=`, which each replace what the person's settings hold.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::config_files::{agy_settings_file, muse_settings_file};
use super::integration::is_facade_group;
use super::{MergedSettings, Wiring};
use crate::args::{ArgsGrammar, Found};
use crate::formats::{merge_settings, parse_jsonc, shell_word};

/// The values of the options `found` gives, all of them, or None where one has no value.
pub(super) fn values(found: &[Found]) -> Option<Vec<&str>> {
    found.iter().map(|found| found.value.as_deref()).collect()
}

/// `words` without the arguments `taken` gives, each its index and the number of words it spans.
pub(super) fn without(
    words: &[String],
    taken: impl Iterator<Item = (usize, usize)> + Clone,
) -> Vec<String> {
    let is_taken = |at: usize| {
        taken
            .clone()
            .any(|(index, span)| (index..index + span).contains(&at))
    };
    let kept = words.iter().enumerate().filter(|(at, _)| !is_taken(*at));
    kept.map(|(_, word)| word.clone()).collect()
}

/// The spans of the options `found` gives, for [`without`].
pub(super) fn spans(found: &[Found]) -> impl Iterator<Item = (usize, usize)> + Clone + '_ {
    found.iter().map(|found| (found.index, found.span))
}

/// The file, in the run's folder, of Antigravity's `--settings`.
const AGY_SETTINGS_FILE: &str = "settings.json";

/// Antigravity's `--settings` with what `wiring` adds merged into the person's own, and the
/// person's words without their `--settings`. The merged settings go in [`AGY_SETTINGS_FILE`] of
/// the run's `folder`, and the argument names that file, so that the person's settings, which may
/// hold keys, never show on the command line. Each key of `--settings` replaces the person's
/// settings file's for the session, so: their `--settings` arguments, each JSON or a file relative
/// to `cwd`, merged in order; their permission rules, from those or else from their settings file,
/// with Facade's after them; any other setting `wiring` adds, as YOLO's trusted folders, merged the
/// same way into theirs; and their title settings, from both, with the title command of the run's
/// session report, which runs their own title command after it with the same input. None where
/// something of theirs cannot be read.
pub(super) fn agy_settings(
    grammar: &ArgsGrammar,
    wiring: &Wiring,
    words: &[String],
    cwd: &Path,
    folder: &Path,
    environment: &BTreeMap<String, String>,
) -> Option<MergedSettings> {
    // Read as Antigravity reads them: `-settings` too, and never another option's value.
    let given = grammar.found(words, "--settings");
    let mut overlay = Map::new();
    for value in values(&given)? {
        let text = match value.trim_start().starts_with('{') {
            true => value.to_string(),
            false => std::fs::read_to_string(cwd.join(value)).ok()?,
        };
        overlay.extend(parse_jsonc(&text).ok()?.as_object()?.clone());
    }
    let file = agy_settings_file(environment)
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| parse_jsonc(&text).ok());
    let saved = |key: &str| {
        file.as_ref()
            .and_then(|settings| settings.get(key))
            .cloned()
    };
    let saved_object = |key: &str| match saved(key) {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    };
    let ours = wiring.settings.as_ref().and_then(Value::as_object);
    for (key, value) in ours.into_iter().flatten() {
        let merged = match key.as_str() {
            "permissions" => {
                let mut permissions = match overlay.remove(key) {
                    Some(Value::Object(permissions)) => permissions,
                    _ => saved_object(key),
                };
                let mut allow = match permissions.remove("allow") {
                    Some(Value::Array(allow)) => Value::Array(allow),
                    _ => json!([]),
                };
                merge_settings(&mut allow, &value["allow"]);
                permissions.insert("allow".into(), allow);
                Value::Object(permissions)
            }
            _ => {
                let mut theirs = overlay
                    .remove(key)
                    .or_else(|| saved(key))
                    .unwrap_or_else(|| value.clone());
                merge_settings(&mut theirs, value);
                theirs
            }
        };
        overlay.insert(key.clone(), merged);
    }
    if let Some(hook) = wiring.title.as_deref() {
        let mut title = saved_object("title");
        if let Some(Value::Object(given)) = overlay.remove("title") {
            title.extend(given);
        }
        let enabled = title.get("enabled") != Some(&json!(false));
        let theirs = title
            .get("command")
            .and_then(Value::as_str)
            .filter(|_| enabled);
        let command = match theirs {
            Some(theirs) => format!("{hook} {}", shell_word(theirs)),
            None => hook.to_string(),
        };
        title.insert("type".into(), json!("command"));
        title.insert("enabled".into(), json!(true));
        title.insert("command".into(), json!(command));
        overlay.insert("title".into(), Value::Object(title));
    }
    let file = folder.join(AGY_SETTINGS_FILE);
    Some(MergedSettings {
        args: vec!["--settings".into(), file.to_string_lossy().into_owned()],
        files: vec![(
            AGY_SETTINGS_FILE.into(),
            format!("{:#}\n", Value::Object(overlay)),
        )],
        rest: without(words, spans(&given)),
    })
}

/// Muse Code's `-c hooks=` with Facade's hooks `ours`, each an event and its command, after the
/// person's own: those of their own `-c hooks=` argument, or else their settings file's. Facade's
/// guest hooks among them are left out: Muse Code would run them in the run without its
/// `FACADE_AGENT`, and they would take the run's session for a guest's. None where the person's
/// hooks cannot be read.
pub(super) fn muse_hooks(
    grammar: &ArgsGrammar,
    ours: &[(String, String)],
    words: &[String],
    environment: &BTreeMap<String, String>,
) -> Option<MergedSettings> {
    // Read as Muse Code reads them: `-chooks=` and `--config=hooks=` too, and never another
    // option's value.
    let given: Vec<_> = grammar
        .overrides(words)?
        .into_iter()
        .filter(|given| given.key == "hooks")
        .collect();
    let mut hooks = match given.as_slice() {
        [] => match muse_settings_file(environment).map(std::fs::read_to_string) {
            Some(Ok(text)) => parse_jsonc(&text)
                .ok()?
                .get("hooks")
                .cloned()
                .unwrap_or(json!({})),
            Some(Err(err)) if err.kind() != ErrorKind::NotFound => return None,
            _ => json!({}),
        },
        [given] => serde_json::from_str(given.value.as_deref()?).ok()?,
        _ => return None,
    };
    let events = hooks.as_object_mut()?;
    events.retain(|_, groups| {
        let Some(list) = groups.as_array_mut().filter(|list| !list.is_empty()) else {
            return true;
        };
        list.retain(|group| !is_facade_group(group, "muse"));
        !list.is_empty()
    });
    for (event, command) in ours {
        let group = json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] });
        let groups = events.entry(event.as_str()).or_insert_with(|| json!([]));
        groups.as_array_mut()?.push(group);
    }
    let rest = without(words, given.iter().map(|given| (given.index, given.span)));
    Some(MergedSettings {
        args: vec!["-c".into(), format!("hooks={hooks}")],
        files: Vec::new(),
        rest,
    })
}
