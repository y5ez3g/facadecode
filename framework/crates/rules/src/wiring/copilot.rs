//! Copilot's private MCP override and the local plugin that reports its session.

use std::path::Path;

use serde_json::json;

use super::servers::{Entry, SERVER, claude_entry};
use super::{MergedSettings, SessionReport, Wiring};
use crate::Rule;
use crate::formats::{powershell_word, shell_word};

const MCP_CONFIG: &str = "copilot-mcp.json";
const PLUGIN: &str = "copilot-session";

/// Copilot's highest-priority MCP override names Facade Code Framework's server for the run, so it wins over a
/// `facade` server in any other source.
pub(super) fn tools(entry: &Entry<'_>) -> Wiring {
    let mut entry = claude_entry(entry);
    entry["type"] = json!("local");
    entry["tools"] = json!(["*"]);
    let config = json!({ "mcpServers": { SERVER: entry } });
    Wiring {
        args: vec![format!("--allow-tool={SERVER}")],
        files: vec![(MCP_CONFIG.into(), format!("{config:#}\n"))],
        ..Wiring::default()
    }
}

pub(super) fn report(wiring: &mut Wiring, session: &SessionReport<'_>) {
    let plugin = session.folder().join(PLUGIN);
    let manifest = json!({ "name": "facade-code-session", "version": "1.0.0" });
    let file = session.file.to_string_lossy();
    let bash = format!(
        "exec {} hook session-start {}",
        shell_word(session.facade),
        shell_word(&file),
    );
    let powershell = format!(
        "& {} 'hook' 'session-start' {}; exit $LASTEXITCODE",
        powershell_word(session.facade),
        powershell_word(&file),
    );
    let hooks = json!({
        "version": 1,
        "hooks": {
            "SessionStart": [{
                "type": "command",
                "bash": bash,
                "powershell": powershell,
                "timeoutSec": 10
            }]
        }
    });
    wiring
        .args
        .push(format!("--plugin-dir={}", plugin.display()));
    wiring.files.extend([
        (
            format!("{PLUGIN}/.plugin/plugin.json"),
            format!("{manifest:#}\n"),
        ),
        (format!("{PLUGIN}/hooks/hooks.json"), format!("{hooks:#}\n")),
    ]);
    wiring.captures = true;
}

pub(super) fn settings(
    rule: &Rule,
    wiring: &Wiring,
    mut words: Vec<String>,
    folder: &Path,
) -> MergedSettings {
    if wiring.files.iter().any(|(name, _)| name == MCP_CONFIG) {
        let end = rule.arguments.end_of_options(&words);
        let file = folder.join(MCP_CONFIG);
        words.insert(end, format!("--additional-mcp-config=@{}", file.display()));
    }
    MergedSettings {
        args: Vec::new(),
        files: Vec::new(),
        rest: words,
    }
}
