//! Kiro V3 selects a native agent from its workspace. The agent's MCP command refers to a
//! private run file so the workspace configuration never contains the relay credential.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use facade_base::system::{SYSTEM, System, env_var, home_folder_in};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::Rule;
use crate::formats::{encoded_powershell, parse_jsonc, powershell_word, shell_word};
use crate::sessions::{kiro_config_root, kiro_profile};

use super::servers::{Entry, claude_entry};
use super::{Server, SessionReport, Wiring};

/// The native profile governs the conversation. Preserve a profile selected by the person
/// or recorded by Kiro rather than replacing it just to insert the relay.
pub(super) fn selected_profile(
    rule: &Rule,
    words: &[String],
    folder: &Path,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    resume: Option<&str>,
) -> Result<String, String> {
    if rule.arguments.holds(
        words,
        &["--agent".into(), "--profile".into(), "--mode".into()],
        None,
    ) {
        return Err("Kiro is using the agent or mode selected in its launch options".into());
    }
    if let Some(id) = resume {
        return kiro_profile(cwd, environment, id)
            .filter(|name| managed_profile(name))
            .ok_or_else(|| "Kiro resumes with its saved agent profile".into());
    }
    if env_var(environment, "KIRO_MODE").is_some_and(|mode| !mode.is_empty()) {
        return Err("Kiro is using the agent selected by KIRO_MODE".into());
    }
    let home = home_folder_in(environment).map(|home| cwd.join(home));
    let workspace = cwd.join(".kiro/settings/cli.json");
    let user =
        kiro_config_root(home.as_deref(), environment).map(|root| root.join("settings/cli.json"));
    for file in std::iter::once(workspace).chain(user) {
        if let Some(agent) = configured_agent(&file)? {
            if agent.as_str().is_some_and(|name| !name.is_empty()) {
                return Err("Kiro is using its configured default agent".into());
            }
            // An explicit empty setting overrides the less specific setting.
            break;
        }
    }
    Ok(agent_name(folder))
}

fn configured_agent(file: &Path) -> Result<Option<Value>, String> {
    let unreadable = || {
        format!(
            "Kiro's CLI settings could not be read at {}",
            file.display()
        )
    };
    match std::fs::read_to_string(file) {
        Ok(text) if text.trim().is_empty() => Ok(None),
        Ok(text) => parse_jsonc(&text)
            .map(|mut config| {
                config
                    .as_object_mut()
                    .and_then(|settings| settings.remove("chat.defaultAgent"))
            })
            .map_err(|_| unreadable()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(unreadable()),
    }
}

pub(super) fn tools(name: &str, server: &Server, entry: &Entry) -> Wiring {
    let mut relay = claude_entry(entry);
    let (command, args, script) = launcher(server.folder, entry);
    relay["command"] = json!(command);
    relay["args"] = json!(args);
    Wiring {
        files: vec![script],
        settings: Some(json!({
            "prompt": server.instructions,
            "mcpServers": { name: relay },
            "permissions": { "rules": [
                { "capability": "mcp", "match": [format!("{name}/*")], "effect": "allow" },
            ] },
        })),
        ..Wiring::default()
    }
}

pub(super) fn profile(
    wiring: &mut Wiring,
    folder: &Path,
    name: String,
    session: Option<&SessionReport<'_>>,
    server: Option<&Server>,
) {
    let mut config = wiring.settings.take().unwrap_or_else(|| {
        json!({
            "permissions": { "rules": [] },
        })
    });
    config["name"] = json!(name);
    config["description"] = json!("Facade Code");
    config["tools"] = json!(["@builtin", "@mcp"]);
    config["includeMcpJson"] = json!(true);
    config["includePowers"] = json!(true);
    if let Some(session) = session {
        let env = server.into_iter().flat_map(Server::hook_variables);
        let command = session.hook("kiro-cli", env);
        config["hooks"] = json!([{
            "name": "facade-session",
            "trigger": "SessionStart",
            "action": { "type": "command", "command": command },
        }]);
        wiring.captures = true;
    }
    wiring.args.extend(["--agent".into(), name.clone()]);
    // The profile ID survives an exact resume. The projected pathname belongs to this run alone.
    let run = folder
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("run");
    let relative = PathBuf::from(".kiro")
        .join("agents")
        .join(format!("{name}-{run}.json"));
    wiring.workspace_file = Some((relative, format!("{config:#}\n")));
}

/// Keep the same profile name when a run is replaced for an exact resume.
fn agent_name(folder: &Path) -> String {
    let agent_folder = folder.parent().unwrap_or(folder);
    let hash = Sha256::digest(agent_folder.to_string_lossy().as_bytes());
    let prefix: String = hash[..8].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("facade-{prefix}")
}

/// A managed profile can be re-created when the same conversation acquires a new Facade ID.
fn managed_profile(name: &str) -> bool {
    name.strip_prefix("facade-").is_some_and(|hash| {
        hash.len() == 16
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn launcher(folder: &Path, relay: &Entry) -> (String, Vec<String>, (String, String)) {
    let words = std::iter::once(relay.program).chain(relay.args.iter().map(String::as_str));
    match SYSTEM {
        System::Unix => {
            let file = "kiro-relay.sh";
            let words = words.map(shell_word).collect::<Vec<_>>().join(" ");
            (
                "/bin/sh".into(),
                vec![folder.join(file).to_string_lossy().into_owned()],
                (file.into(), format!("exec {words}\n")),
            )
        }
        System::Windows => {
            let file = "kiro-relay.ps1";
            let words = words.map(powershell_word).collect::<Vec<_>>().join(" ");
            let path = powershell_word(&folder.join(file).to_string_lossy());
            let command = encoded_powershell(&format!(
                "& ([scriptblock]::Create([IO.File]::ReadAllText({path}))); exit $LASTEXITCODE"
            ));
            let mut args = command.split_ascii_whitespace().map(str::to_owned);
            let program = args.next().expect("encoded PowerShell names its program");
            (
                program,
                args.collect(),
                (file.into(), format!("& {words}\nexit $LASTEXITCODE\n")),
            )
        }
    }
}
