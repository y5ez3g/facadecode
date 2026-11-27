//! What each CLI is given for a run to have Facade Code Framework's tools: the server, tool approvals and, for
//! CLIs that need it, a hook or extension that gives the model the instructions.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::plugin::{AGY_RUN_TOKEN, ALLOW_TOOLS, plugin_files};
use super::servers::{
    Entry, SERVER, claude_entry, codex_entry, opencode_allow, opencode_entry,
    opencode_native_entry, pi_entry, runs_facade_mcp,
};
use super::{INSTRUCTIONS_FILE, OPENCODE_CONFIG, SKILL_FILE, Server, Wiring};
use crate::RUN_CREDENTIAL_ARG;
use crate::formats::{HookArg, facade_hook, parse_jsonc};
use facade_base::system::env_var;

/// The variable that gives the test CLI the server, which it runs itself.
const FAKE_SERVER: &str = "FAKECLI_MCP";
const MCP_CONFIG: &str = "mcp.json";
/// The extension, in the run's folder, that gives Pi the tools.
const PI_TOOLS: &str = "facade-pi.mjs";

/// `path` as one argument.
fn argument(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Claude Code: a `--mcp-config` file of the run's, which adds the server to the person's own; its
/// tools allowed without asking; and run settings that turn off a project's own `facade` server,
/// which would otherwise ask about itself at the start.
pub(super) fn claude_run(server: &Server, entry: &Entry) -> Wiring {
    let config = mcp_config(claude_entry(entry));
    Wiring {
        args: vec![
            "--mcp-config".into(),
            argument(&server.folder.join(MCP_CONFIG)),
            "--allowedTools".into(),
            "mcp__facade".into(),
        ],
        files: vec![config],
        settings: Some(json!({ "disabledMcpjsonServers": [SERVER] })),
        takes_values_to_next_option: true,
        ..Wiring::default()
    }
}

/// Codex: `-c` overrides with its tools approved in advance and a 10-second server startup grace
/// period for the first model request.
pub(super) fn codex_run(entry: &Entry) -> Result<Wiring, String> {
    let keys = codex_entry(entry)?;
    let overrides = keys
        .into_iter()
        .map(|(key, value)| format!("mcp_servers.{SERVER}.{key}={value}"))
        .chain(["mcp_optional_startup_grace_ms=10000".to_string()]);
    Ok(Wiring {
        args: overrides
            .flat_map(|value| ["-c".to_string(), value])
            .collect(),
        ..Wiring::default()
    })
}

/// OpenCode: its inline configuration, the person's own with the server added, its tools allowed
/// after the person's own rules.
/// The person's is read as OpenCode reads it: comments and trailing commas allowed, and a blank one
/// as none. One that cannot be read stays as it is, without the tools.
pub(super) fn opencode_run(
    entry: &Entry,
    environment: &BTreeMap<String, String>,
) -> Result<Wiring, String> {
    let theirs = environment
        .get(OPENCODE_CONFIG)
        .filter(|text| !text.trim().is_empty());
    let mut config = match theirs.map(|text| parse_jsonc(text)) {
        None => Map::new(),
        Some(Ok(Value::Object(config))) => config,
        Some(_) => {
            return Err(format!(
                "its {OPENCODE_CONFIG} is not a JSON object Facade Code Framework can read"
            ));
        }
    };
    let not = |what: &str| format!("the {what} of its {OPENCODE_CONFIG}");
    let servers = config
        .entry("mcp")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    let servers = servers.ok_or_else(|| not("mcp") + " is not an object")?;
    if let Some(native) = servers
        .get_mut("servers")
        .and_then(Value::as_object_mut)
        .and_then(|servers| servers.get_mut(SERVER))
    {
        *native = opencode_native_entry(entry);
    } else {
        servers.insert(SERVER.into(), opencode_entry(entry));
    }
    let permission = config.entry("permission").or_insert_with(|| json!({}));
    let allowed = opencode_allow(permission.take()).or_else(|| opencode_allow(json!({})));
    *permission = Value::Object(allowed.unwrap_or_default());
    Ok(Wiring {
        env: vec![(OPENCODE_CONFIG.into(), Value::Object(config).to_string())],
        ..Wiring::default()
    })
}

/// Pi: a run extension that registers the server with tools available on demand and puts the
/// instructions in a section of Pi's system prompt.
pub(super) fn pi_run(server: &Server, entry: &Entry, name: &str) -> Wiring {
    let mut instructions = server.instructions.to_owned();
    if name != SERVER {
        instructions.push_str(&format!(
            "\n\nFor this run, call Facade Code Framework's tools through `{name}` using names that begin with `mcp__{name}__`."
        ));
    }
    let extension = format!(
        r#"// Facade Code Framework: this run's tools, registered for its session alone
export default function (pi) {{
	pi.registerMcpServer({name}, {entry});
	pi.on('before_agent_start', (event) => {{
		event.systemPromptOptions.sections.facade = {instructions};
	}});
}}
"#,
        name = json!(name),
        entry = pi_entry(entry),
        instructions = json!(instructions),
    );
    Wiring {
        args: vec!["-e".into(), argument(&server.folder.join(PI_TOOLS))],
        files: vec![(PI_TOOLS.into(), extension)],
        ..Wiring::default()
    }
}

fn muse_entry(entry: &Entry) -> Value {
    let env = entry
        .env
        .iter()
        .map(|(name, _)| (name.clone(), json!(format!("${{{name}}}"))))
        .collect::<Map<_, _>>();
    json!({ "command": entry.program, "args": entry.args, "env": env, "mode": "optional" })
}

/// Muse Code: `-c mcpServers.facade=<entry>` for the run alone, and two hooks: `SessionStart`,
/// which gives the model the instructions, as Muse Code shows it no server's instructions, and
/// `PermissionRequest`, which approves Facade Code Framework's own tools, as Muse Code has no rule for one
/// server's tools. The entry references the CLI's environment and is optional, as Muse Code fails
/// a whole run over a required server that does not start. Each hook receives the run's
/// variables in its command. Where the person's settings hold a Facade Code Framework server, the run
/// uses that entry with these hooks.
pub(super) fn muse_run(server: &Server, entry: Option<&Entry>) -> Wiring {
    let args = entry
        .map(muse_entry)
        .map(|entry| vec!["-c".into(), format!("mcpServers.{SERVER}={entry}")])
        .unwrap_or_default();
    let hook = |event| {
        facade_hook(
            "muse",
            server.facade,
            event,
            &[HookArg::Word("muse")],
            server.hook_variables(),
        )
    };
    Wiring {
        args,
        hooks: vec![
            ("SessionStart".into(), hook("instructions")),
            ("PermissionRequest".into(), hook("approve")),
        ],
        files: vec![(INSTRUCTIONS_FILE.into(), server.instructions.into())],
        ..Wiring::default()
    }
}

/// Antigravity: the plugin in [`super::PLUGIN_FOLDER`] of the folder the run starts in, shared by
/// the runs there, which holds no run's identity: the run's variables reach its server and hook
/// through the CLI's environment. Its tools are allowed for the run by `--settings`, beside the
/// person's own rules.
pub(super) fn agy_managed(server: &Server, credential: Option<&str>) -> Wiring {
    Wiring {
        settings: Some(json!({ "permissions": { "allow": [ALLOW_TOOLS] } })),
        plugin: plugin_files(server.program, server.facade),
        env: credential
            .map(|value| vec![(AGY_RUN_TOKEN.into(), value.into())])
            .unwrap_or_default(),
        files: vec![(INSTRUCTIONS_FILE.into(), server.instructions.into())],
        ..Wiring::default()
    }
}

/// The debug CLI reads the same stdio entry shape as an actual MCP client.
#[cfg(debug_assertions)]
pub(super) fn fake_run(server: &Server, entry: &Entry) -> Wiring {
    let config = mcp_config(super::servers::agy_entry(entry));
    Wiring {
        args: vec![
            "--mcp-config".into(),
            argument(&server.folder.join(MCP_CONFIG)),
        ],
        files: vec![config],
        ..Wiring::default()
    }
}

fn mcp_config(entry: Value) -> (String, String) {
    let config = json!({ "mcpServers": { SERVER: entry } });
    (MCP_CONFIG.into(), format!("{config:#}\n"))
}

/// Takes out of `env`, the environment a run of `cli` started with, what gave it Facade Code Framework's tools:
/// the test CLI's variables, and Facade Code Framework's server and permission in OpenCode's inline configuration.
/// Remove the old OpenCode skill entry when it names a file in a run folder of `FACADE_AGENT`
/// under `FACADE_HOME`.
pub(super) fn unwire(cli: &str, env: &mut BTreeMap<String, String>) {
    match cli {
        "fake" => drop(env.remove(FAKE_SERVER)),
        "agy" => drop(env.remove(AGY_RUN_TOKEN)),
        "opencode" => {
            let config = env
                .get(OPENCODE_CONFIG)
                .and_then(|text| serde_json::from_str(text).ok());
            let Some(Value::Object(mut config)) = config else {
                return;
            };
            let ours = config.get_mut("mcp").and_then(Value::as_object_mut);
            if !ours.is_some_and(remove_opencode_server) {
                return;
            }
            // A one-string permission became `{"*": <it>}`, which means the same, and stays.
            if let Some(Value::Object(rules)) = config.get_mut("permission") {
                rules.shift_remove("facade_*");
            }
            let runs = match (env_var(env, "FACADE_HOME"), env_var(env, "FACADE_AGENT")) {
                (Some(home), Some(agent)) => {
                    Some(Path::new(home).join("framework/runs").join(agent))
                }
                _ => None,
            };
            if let (Some(runs), Some(Value::Array(instructions))) =
                (runs, config.get_mut("instructions"))
            {
                let count = instructions.len();
                let run_skill =
                    |path: &str| Path::new(path).starts_with(&runs) && path.ends_with(SKILL_FILE);
                instructions.retain(|entry| !entry.as_str().is_some_and(run_skill));
                if count > 0 && instructions.is_empty() {
                    config.shift_remove("instructions");
                }
            }
            // What only Facade Code Framework's entries filled goes with them, and so does a configuration that
            // holds nothing else.
            config.retain(|key, value| {
                !(["mcp", "permission"].contains(&key.as_str())
                    && value.as_object().is_some_and(Map::is_empty))
            });
            match config.is_empty() {
                true => drop(env.remove(OPENCODE_CONFIG)),
                false => {
                    drop(env.insert(OPENCODE_CONFIG.into(), Value::Object(config).to_string()))
                }
            }
        }
        _ => {}
    }
}

fn remove_opencode_server(servers: &mut Map<String, Value>) -> bool {
    if let Some(native) = servers.get_mut("servers").and_then(Value::as_object_mut)
        && native.get(SERVER).is_some_and(|entry| {
            runs_facade_mcp(entry)
                && entry["command"].as_array().is_some_and(|argv| {
                    matches!(argv.as_slice(), [_, flag, value]
                        if flag == RUN_CREDENTIAL_ARG && value.as_str().is_some_and(|value| !value.is_empty()))
                })
        })
    {
        native.shift_remove(SERVER);
        if native.is_empty() {
            servers.shift_remove("servers");
        }
        return true;
    }
    servers.shift_remove(SERVER).is_some()
}
