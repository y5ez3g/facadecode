//! Qoder's session-only MCP file and settings, leaving its user and project files in place.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};

use super::config_files::{MCP_FILE, project_files};
use super::servers::{CALL_SECONDS, Entry, SERVER, claude_entry, runs_facade_mcp};
use super::session_report::{Hooked, SessionReport};
use super::settings::{spans, values, without};
use super::{Server, Wiring};
use crate::Rule;
use crate::formats::{merge_settings, parse_json_with_comments, parse_jsonc};

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
    let files = crate::qoder_config_dir(rule, server.cwd, environment, words)
        .map(|root| root.join("settings.json"))
        .into_iter()
        .chain(project_files(
            server.cwd,
            &[
                ".qoder/settings.json",
                MCP_FILE,
                ".qoder/settings.local.json",
            ],
        ));
    let project_mcp = server.cwd.join(MCP_FILE);
    let mut configured_files = 0;
    let mut tools_config = None;
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(settings) = parse_jsonc(&text) else {
            continue;
        };
        let Some(server) = settings["mcpServers"].get(SERVER) else {
            continue;
        };
        if !runs_facade_mcp(server) {
            return Err(format!(
                "{} names a {SERVER} server that is not Facade's",
                file.display()
            ));
        }
        configured_files += 1;
        // The native project approval names this entry. Keep its path for the connection deadline.
        if file == project_mcp
            && server["command"].is_string()
            && server.get("type").is_none_or(|kind| kind == "stdio")
            && parse_json_with_comments(&text).is_ok()
        {
            tools_config = Some(file);
        }
    }
    let mut settings =
        flag_settings(rule, words, server.cwd).ok_or("Facade could not read Qoder's --settings")?;
    let settings_server = settings["mcpServers"].get(SERVER);
    if settings_server.is_some_and(|entry| !runs_facade_mcp(entry)) {
        return Err(format!(
            "its --settings names a {SERVER} server that is not Facade's"
        ));
    }
    let tools_config = tools_config.filter(|_| configured_files == 1 && settings_server.is_none());
    event_hooks(&mut settings, "SessionStart")
        .ok_or("Qoder's --settings has invalid SessionStart hooks")?;

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
        tools_config,
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
    if wiring.unattended {
        merge_settings(
            &mut settings,
            &json!({"general": {"enableAutoUpdate": false}}),
        );
    }
    event_hooks(&mut settings, "SessionStart")?.push(json!({
        "hooks": [{
            "type": "command",
            "command": session.facade,
            "args": ["hook", "session-start", session.file.to_string_lossy()],
            "timeout": 10
        }]
    }));
    // Qoder fires the startup hook before the person trusts a new folder. The first
    // submitted prompt can report the same session after the person has trusted it.
    if let Some(prompts) = event_hooks(&mut settings, "UserPromptSubmit") {
        prompts.push(json!({
            "hooks": [{
                "type": "command",
                "command": session.facade,
                "args": ["hook", "session-prompt", session.file.to_string_lossy(), "qoder"],
                "timeout": 10
            }]
        }));
    }
    let found = rule.arguments.found(words, "--settings");
    let file = session.folder().join("settings.json");
    Some(Hooked {
        args: vec!["--settings".into(), file.to_string_lossy().into_owned()],
        env: Vec::new(),
        files: vec![("settings.json".into(), format!("{settings:#}\n"))],
        rest: without(words, spans(&found)),
    })
}

fn event_hooks<'a>(settings: &'a mut Value, event: &str) -> Option<&'a mut Vec<Value>> {
    settings
        .as_object_mut()?
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?
        .entry(event)
        .or_insert_with(|| json!([]))
        .as_array_mut()
}
