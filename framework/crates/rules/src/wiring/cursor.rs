//! Cursor Agent takes Facade Code Framework's MCP server, rules and hooks in a per-run local plugin.

use std::path::Path;

use serde_json::json;

use super::servers::{Entry, SERVER, claude_entry};
use super::{Server, SessionReport, Wiring};

const PLUGIN: &str = "cursor-plugin";

pub(super) fn tools(server: &Server, entry: &Entry) -> Wiring {
    let mcp = json!({ "mcpServers": { SERVER: claude_entry(entry) } });
    // A local plugin bypasses the workspace mcp.json connection gate. The CLI still enforces
    // its existing tool call permissions, including team and project denies.
    Wiring {
        args: arguments(server.folder),
        files: vec![
            manifest(),
            (format!("{PLUGIN}/.mcp.json"), format!("{mcp:#}\n")),
            (
                format!("{PLUGIN}/rules/facade.mdc"),
                format!("---\nalwaysApply: true\n---\n\n{}", server.instructions),
            ),
        ],
        ..Wiring::default()
    }
}

pub(super) fn report(wiring: &mut Wiring, session: &SessionReport, server: Option<&Server>) {
    if wiring.args.is_empty() {
        wiring.args = arguments(session.folder());
        wiring.files.push(manifest());
    }
    let env = server.into_iter().flat_map(Server::hook_variables);
    let command = session.hook("agent", env);
    let hooks = json!({
        "version": 1,
        "hooks": {
            "sessionStart": [{ "command": command }],
        },
    });
    wiring
        .files
        .push((format!("{PLUGIN}/hooks/hooks.json"), format!("{hooks:#}\n")));
    wiring.captures = true;
}

fn manifest() -> (String, String) {
    let manifest = json!({
        "name": "facade-code",
        "description": "Facade Code Framework’s managed tools for this run",
        "version": facade_base::version(),
        "mcpServers": "./.mcp.json",
    });
    (
        format!("{PLUGIN}/.cursor-plugin/plugin.json"),
        format!("{manifest:#}\n"),
    )
}

fn arguments(folder: &Path) -> Vec<String> {
    vec![
        "--plugin-dir".into(),
        folder.join(PLUGIN).to_string_lossy().into_owned(),
    ]
}
