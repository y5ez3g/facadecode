//! Qoder's session-only MCP file and settings, leaving its user and project files in place.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};

use super::config_files::{project_files, read_config};
use super::servers::{CALL_SECONDS, Entry, SERVER, claude_entry, runs_facade_mcp};
use super::session_report::{Hooked, SessionReport};
use super::settings::{spans, values, without};
use super::{Server, Wiring};
use crate::Rule;
use crate::formats::{merge_settings, parse_jsonc};

fn flag_settings(rule: &Rule, words: &[String], cwd: &Path) -> Option<Value> {
    match values(&rule.arguments.found(words, "--settings"))?.as_slice() {
        [] => Some(json!({})),
        [value] if value.starts_with('{') => serde_json::from_str(value).ok(),
        [file] => parse_jsonc(&std::fs::read_to_string(cwd.join(file)).ok()?).ok(),
        _ => None,
    }
}

pub(super) fn tools(
    rule: &Rule,
    words: &[String],
    server: &Server<'_>,
    entry: &Entry<'_>,
    environment: &BTreeMap<String, String>,
) -> Result<Wiring, String> {
    let configured = |settings: &Value| {
        settings["mcpServers"]
            .get(SERVER)
            .is_some_and(|entry| !runs_facade_mcp(entry))
    };
    let files = crate::qoder_config_dir(rule, server.cwd, environment, words)
        .map(|root| root.join("settings.json"))
        .into_iter()
        .chain(project_files(
            server.cwd,
            &[
                ".qoder/settings.json",
                ".mcp.json",
                ".qoder/settings.local.json",
            ],
        ));
    for file in files {
        if read_config(&file).is_some_and(|settings| configured(&settings)) {
            return Err(format!(
                "{} names a {SERVER} server that is not Facade's",
                file.display()
            ));
        }
    }
    let mut settings =
        flag_settings(rule, words, server.cwd).ok_or("Facade could not read Qoder's --settings")?;
    if configured(&settings) {
        return Err(format!(
            "its --settings names a {SERVER} server that is not Facade's"
        ));
    }
    session_starts(&mut settings).ok_or("Qoder's --settings has invalid SessionStart hooks")?;

    let mut entry = claude_entry(entry);
    entry["trust"] = json!(true);
    entry["timeout"] = json!(CALL_SECONDS * 1000);
    let config = json!({ "mcpServers": { SERVER: entry } });
    Ok(Wiring {
        args: vec![
            "--mcp-config".into(),
            server
                .folder
                .join("mcp.json")
                .to_string_lossy()
                .into_owned(),
        ],
        files: vec![("mcp.json".into(), format!("{config:#}\n"))],
        settings: Some(settings),
        ..Wiring::default()
    })
}

pub(super) fn hook(
    rule: &Rule,
    words: &[String],
    session: &SessionReport<'_>,
    wiring: &Wiring,
) -> Option<Hooked> {
    let mut settings = flag_settings(rule, words, session.cwd)?;
    if let Some(additions) = &wiring.settings {
        merge_settings(&mut settings, additions);
    }
    let starts = session_starts(&mut settings)?;
    starts.push(json!({
        "hooks": [{
            "type": "command",
            "command": session.facade,
            "args": ["hook", "session-start", session.file.to_string_lossy()],
            "timeout": 10
        }]
    }));
    let found = rule.arguments.found(words, "--settings");
    let file = session.folder().join("settings.json");
    Some(Hooked {
        args: vec!["--settings".into(), file.to_string_lossy().into_owned()],
        env: Vec::new(),
        files: vec![("settings.json".into(), format!("{settings:#}\n"))],
        rest: without(words, spans(&found)),
    })
}

fn session_starts(settings: &mut Value) -> Option<&mut Vec<Value>> {
    settings
        .as_object_mut()?
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?
        .entry("SessionStart")
        .or_insert_with(|| json!([]))
        .as_array_mut()
}
