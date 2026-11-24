//! Facade's MCP server as each CLI's configuration writes it. A run's entry and a guest's are built
//! the same way, from one [`Entry`].

use std::path::Path;

use facade_base::programs::program_name;
use serde_json::{Map, Value, json};

use crate::formats::{inline_toml, toml_string};

/// The server's name in each CLI's configuration.
pub(super) const SERVER: &str = "facade";
/// The program of Facade's server. A `facade` server that runs it is Facade's own, a guest's or
/// another Facade home's; any other `facade` server is the person's own.
const SERVER_PROGRAM: &str = "facade-mcp";
/// How long a CLI gives one of Facade's tool calls, in seconds: more than any call takes, with its
/// response's way back.
pub(super) const CALL_SECONDS: u64 = 3660;
/// What the model reads of the server, for a CLI that lists its servers.
const DESCRIPTION: &str = "Facade Code: start, stop and list agents, send and read messages, and \
                           read or type into agent terminals.";

/// Facade's MCP server as an entry of a CLI's configuration: a run's, with the run's variables, or
/// a guest's, `--guest <cli>` with `FACADE_HOME` where it is not the default. The server finds the
/// daemon's socket from its Facade home itself.
pub(super) struct Entry<'a> {
    /// The `facade-mcp` program.
    pub(super) program: &'a str,
    pub(super) args: Vec<String>,
    pub(super) env: &'a [(String, String)],
}

/// The entry's variables as a JSON object.
fn env_object(entry: &Entry) -> Value {
    let env: Map<String, Value> = entry
        .env
        .iter()
        .map(|(name, value)| (name.clone(), json!(value)))
        .collect();
    Value::Object(env)
}

/// Claude Code's entry.
pub(super) fn claude_entry(entry: &Entry) -> Value {
    json!({
        "type": "stdio", "command": entry.program, "args": entry.args, "env": env_object(entry),
    })
}

/// Codex's keys of the server's table, each with its value in TOML: its tools approved in advance,
/// and calls given as long as they take.
pub(super) fn codex_entry(entry: &Entry) -> Result<Vec<(&'static str, String)>, String> {
    let strings = |items: Vec<(String, String)>| {
        toml::Value::Table(
            items
                .into_iter()
                .map(|(k, v)| (k, toml::Value::String(v)))
                .collect(),
        )
    };
    let env = inline_toml(&strings(entry.env.to_vec()))
        .ok_or("the server's variables cannot be written as TOML")?;
    let args = entry
        .args
        .iter()
        .map(|arg| toml::Value::String(arg.clone()))
        .collect();
    let args = inline_toml(&toml::Value::Array(args))
        .ok_or("the server's arguments cannot be written as TOML")?;
    Ok(vec![
        ("command", toml_string(entry.program)),
        ("args", args),
        ("env", env),
        ("startup_timeout_sec", "30".into()),
        ("tool_timeout_sec", CALL_SECONDS.to_string()),
        ("default_tools_approval_mode", "\"approve\"".into()),
    ])
}

/// OpenCode's entry: its command a list, the program first.
pub(super) fn opencode_entry(entry: &Entry) -> Value {
    opencode_entry_with_status(entry, "enabled", true)
}

pub(super) fn opencode_native_entry(entry: &Entry) -> Value {
    opencode_entry_with_status(entry, "disabled", false)
}

fn opencode_entry_with_status(entry: &Entry, key: &str, status: bool) -> Value {
    let mut command = vec![entry.program];
    command.extend(entry.args.iter().map(String::as_str));
    json!({
        "type": "local", "command": command, "environment": env_object(entry), key: status,
        "timeout": CALL_SECONDS * 1000,
    })
}

/// OpenCode's `permission` with Facade's tools allowed after the person's own rules, as OpenCode
/// takes a later rule over an earlier one. A permission given as one string is one rule for every
/// tool. None for a permission that is neither.
pub(super) fn opencode_allow(permission: Value) -> Option<Map<String, Value>> {
    let mut rules = match permission {
        Value::Object(rules) => rules,
        Value::String(every) => Map::from_iter([("*".to_string(), Value::String(every))]),
        _ => return None,
    };
    // Removed first, so that it goes last.
    rules.shift_remove("facade_*");
    rules.insert("facade_*".into(), json!("allow"));
    Some(rules)
}

/// Muse Code's entry of a guest's server, in its settings. Muse Code passes a user server none of
/// its variables, so the entry names them by references to its own environment, which it expands:
/// empty outside Facade, and in a Facade run the run's agent and Facade home, so that the entry
/// serves the run (see [`super::guest_entry_serves_run`]). `entry`'s Facade home stands where the
/// environment names none. Optional, as Muse Code fails a whole session over a required server
/// that does not start.
pub(super) fn muse_guest_entry(entry: &Entry) -> Value {
    let home = entry
        .env
        .iter()
        .find_map(|(name, home)| (name == "FACADE_HOME").then_some(home.as_str()))
        .unwrap_or_default();
    let env = json!({
        "FACADE_AGENT": "${FACADE_AGENT:-}", "FACADE_HOME": format!("${{FACADE_HOME:-{home}}}"),
    });
    json!({ "command": entry.program, "args": entry.args, "env": env, "mode": "optional" })
}

/// Antigravity's entry: a plugin's, or a guest's in its own MCP configuration.
pub(super) fn agy_entry(entry: &Entry) -> Value {
    json!({ "command": entry.program, "args": entry.args, "env": env_object(entry) })
}

/// Pi's Facade entry, with tools available on demand.
pub(super) fn pi_entry(entry: &Entry) -> Value {
    json!({
        "command": entry.program, "args": entry.args, "env": env_object(entry),
        "exposure": "deferred", "timeout": CALL_SECONDS, "description": DESCRIPTION,
    })
}

/// Whether a server `entry` runs `facade-mcp`: its `command`, or the first word of a `command`
/// list, as OpenCode gives one.
pub(super) fn runs_facade_mcp(entry: &Value) -> bool {
    let program = match &entry["command"] {
        Value::Array(words) => words.first().and_then(Value::as_str),
        command => command.as_str(),
    };
    is_server_program(program)
}

/// Whether `program` is a path of `facade-mcp`, by its name as this system runs it:
/// `facade-mcp.exe` on Windows.
pub(super) fn is_server_program(program: Option<&str>) -> bool {
    program.is_some_and(|program| program_name(Path::new(program)) == SERVER_PROGRAM)
}
