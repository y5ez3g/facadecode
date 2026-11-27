//! Oh My Pi loads the run's own plugin and a settings overlay. The plugin supplies the managed
//! server, and the extension reports session changes and turn state.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::config_files::{MCP_FILE, read_config};
use super::servers::{CALL_SECONDS, Entry, claude_entry, is_server_program};
use super::{Hooked, MergedSettings, Server, SessionReport, Wiring};
use crate::Rule;
use crate::formats::merge_settings;

const PLUGIN: &str = "omp-facade";
const PLUGIN_NAME: &str = "facade-managed";
const SERVER_NAME: &str = "facade";
const TOOL_PREFIX: &str = "mcp__facade_managed_facade_";
const SETTINGS: &str = "omp-settings.yaml";
const EXTENSION: &str = "facade-omp.mjs";

/// The diagnostic for a linked reply through Oh My Pi's separate project server.
pub fn project_guest_reply(cwd: &Path, home: &Path) -> Option<String> {
    let (file, server) = [".cursor/mcp.json", "mcp.json", MCP_FILE]
        .into_iter()
        .find_map(|name| {
            let file = cwd.join(name);
            let config = read_config(&file)?;
            Some((file, config["mcpServers"].get(SERVER_NAME)?.clone()))
        })?;
    (server["enabled"] != false
        && is_server_program(server["command"].as_str())
        && server["env"]["FACADE_HOME"]
            .as_str()
            .is_some_and(|value| Path::new(value) == home))
    .then(|| {
        format!(
            "{} names a facade server. Oh My Pi's project relay replies as a Guest. Use {TOOL_PREFIX}send_message for the managed inbox",
            file.display()
        )
    })
}

pub(super) fn tools(server: &Server<'_>, entry: &Entry<'_>) -> Wiring {
    let manifest = json!({
        "name": PLUGIN_NAME,
        "description": "Facade Code's managed tools for this run"
    });
    let mut mcp = claude_entry(entry);
    mcp["timeout"] = json!(CALL_SECONDS * 1000);
    let mcp = json!({ "mcpServers": { SERVER_NAME: mcp } });
    let definitions: Vec<Value> =
        serde_json::from_str(facade_base::tools::DEFINITIONS).expect("Facade's tools are JSON");
    let approval: Map<String, Value> = definitions
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .map(|tool| (format!("{TOOL_PREFIX}{tool}"), json!("allow")))
        .collect();
    Wiring {
        args: vec![
            "--plugin-dir".into(),
            server.folder.join(PLUGIN).to_string_lossy().into_owned(),
        ],
        files: vec![
            (
                format!("{PLUGIN}/.claude-plugin/plugin.json"),
                manifest.to_string(),
            ),
            (format!("{PLUGIN}/.mcp.json"), mcp.to_string()),
        ],
        // Without its notice about the server's tools, the conversation opens as it does without
        // Facade.
        settings: Some(json!({ "tools": { "approval": approval, "commandNotices": false } })),
        ..Wiring::default()
    }
}

pub(super) fn settings(
    rule: &Rule,
    wiring: &Wiring,
    words: &[String],
    folder: &Path,
) -> MergedSettings {
    // Retain the person's overlays in order and append the overlay for managed tool approvals.
    let mut settings = json!({});
    if let Some(additions) = &wiring.settings {
        merge_settings(&mut settings, additions);
    }
    let mut args = Vec::new();
    let mut rest = Vec::new();
    let mut at = 0;
    for option in rule.arguments.found(words, "--config") {
        let end = option.index + option.span;
        rest.extend_from_slice(&words[at..option.index]);
        args.extend_from_slice(&words[option.index..end]);
        at = end;
    }
    rest.extend_from_slice(&words[at..]);
    args.extend([
        "--config".into(),
        folder.join(SETTINGS).to_string_lossy().into_owned(),
    ]);
    MergedSettings {
        args,
        files: vec![(SETTINGS.into(), format!("{settings:#}\n"))],
        rest,
    }
}

pub(super) fn hook(words: &[String], session: &SessionReport<'_>) -> Hooked {
    let file = json!(session.file.to_string_lossy());
    let server = json!(format!("{PLUGIN_NAME}:{SERVER_NAME}"));
    let source = format!(
        "const reportFile = {file};\nconst server = {server};\n{}",
        include_str!("omp.mjs")
    );
    Hooked {
        args: vec![
            "--extension".into(),
            session
                .folder()
                .join(EXTENSION)
                .to_string_lossy()
                .into_owned(),
        ],
        env: Vec::new(),
        files: vec![(EXTENSION.into(), source)],
        rest: words.to_vec(),
    }
}
