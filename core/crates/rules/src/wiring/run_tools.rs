//! What each CLI is given for a run to have Facade's tools: the server, its tools approved, the
//! skill, and for a CLI that shows its model no server's instructions, a hook that gives them.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::config_files::{muse_settings_file, read_config};
use super::conflicts::muse_refusal;
use super::plugin::{ALLOW_TOOLS, plugin_description, plugin_files};
use super::servers::{
    Entry, SERVER, claude_entry, codex_entry, is_muse_guest_entry, opencode_allow, opencode_entry,
    pi_entry,
};
use super::{INSTRUCTIONS_FILE, OPENCODE_CONFIG, SKILL_FILE, Server, Wiring};
use crate::formats::{parse_jsonc, shell_word};

/// The variable that gives the test CLI the server, which it runs itself.
const FAKE_SERVER: &str = "FAKECLI_MCP";
/// The plugin Claude Code loads for the run alone by `--plugin-dir`, in the run's folder: its
/// manifest and the skill.
const CLAUDE_PLUGIN: &str = "plugin";
/// The extension, in the run's folder, that gives Pi the tools.
const PI_TOOLS: &str = "facade-pi.mjs";

/// The run's server as an entry with the run's variables.
fn run_entry<'a>(server: &Server<'a>) -> Entry<'a> {
    Entry {
        program: server.program,
        args: Vec::new(),
        env: server.env,
    }
}

/// The skill, a file of the run's.
fn skill_file() -> (String, String) {
    (SKILL_FILE.into(), facade_base::skill::text())
}

/// `path` as one argument.
fn argument(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Claude Code: a `--mcp-config` file of the run's, which adds the server to the person's own; its
/// tools allowed without asking; the skill in a plugin of the run's, which `--plugin-dir` loads for
/// the run alone; and run settings that turn off a project's own `facade` server, which would
/// otherwise ask about itself at the start.
pub(super) fn claude(server: &Server) -> Wiring {
    let config = json!({ "mcpServers": { SERVER: claude_entry(&run_entry(server)) } });
    let manifest =
        json!({ "name": SERVER, "description": plugin_description(&facade_base::version()) });
    let (skill, text) = skill_file();
    Wiring {
        args: vec![
            "--plugin-dir".into(),
            argument(&server.folder.join(CLAUDE_PLUGIN)),
            "--mcp-config".into(),
            argument(&server.folder.join("mcp.json")),
            "--allowedTools".into(),
            "mcp__facade".into(),
        ],
        files: vec![
            ("mcp.json".into(), format!("{config:#}\n")),
            (
                format!("{CLAUDE_PLUGIN}/.claude-plugin/plugin.json"),
                format!("{manifest:#}\n"),
            ),
            (format!("{CLAUDE_PLUGIN}/{skill}"), text),
        ],
        settings: Some(json!({ "disabledMcpjsonServers": [SERVER] })),
        takes_values_to_next_option: true,
        ..Wiring::default()
    }
}

/// Codex: `-c` overrides, its tools approved in advance, and the skill, which its session-start
/// hook gives as context. Its first model request waits up to 10 seconds for a server that starts
/// slowly, not its own 1 second.
pub(super) fn codex(server: &Server) -> Result<Wiring, String> {
    let keys = codex_entry(&run_entry(server))?;
    let overrides = keys
        .into_iter()
        .map(|(key, value)| format!("mcp_servers.{SERVER}.{key}={value}"))
        .chain(["mcp_optional_startup_grace_ms=10000".to_string()]);
    Ok(Wiring {
        args: overrides
            .flat_map(|value| ["-c".to_string(), value])
            .collect(),
        files: vec![skill_file()],
        session_skill: true,
        ..Wiring::default()
    })
}

/// OpenCode: its inline configuration, the person's own with the server added, its tools allowed
/// after the person's own rules, and the skill, a file of the run's, last in its `instructions`.
/// The person's is read as OpenCode reads it: comments and trailing commas allowed, and a blank one
/// as none. One that cannot be read stays as it is, without the tools.
pub(super) fn opencode(
    server: &Server,
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
                "its {OPENCODE_CONFIG} is not a JSON object Facade can read"
            ));
        }
    };
    let not = |what: &str| format!("the {what} of its {OPENCODE_CONFIG}");
    let servers = config
        .entry("mcp")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    let servers = servers.ok_or_else(|| not("mcp") + " is not an object")?;
    servers.insert(SERVER.into(), opencode_entry(&run_entry(server)));
    let permission = config.entry("permission").or_insert_with(|| json!({}));
    let allowed = opencode_allow(permission.take()).or_else(|| opencode_allow(json!({})));
    *permission = Value::Object(allowed.unwrap_or_default());
    let skill = argument(&server.folder.join(SKILL_FILE));
    let instructions = config
        .entry("instructions")
        .or_insert_with(|| json!([]))
        .as_array_mut();
    instructions
        .ok_or_else(|| not("instructions") + " are not a list")?
        .push(json!(skill));
    Ok(Wiring {
        env: vec![(OPENCODE_CONFIG.into(), Value::Object(config).to_string())],
        files: vec![skill_file()],
        ..Wiring::default()
    })
}

/// Pi: an extension of the run's, given with `-e`, that registers the server for its session alone,
/// its tools given to the model directly; puts the instructions in Pi's own section of its system
/// prompt; and gives Pi the skill, a file of the run's, unless a `facade` skill Pi loaded already
/// is the same text.
pub(super) fn pi(server: &Server) -> Wiring {
    let extension = format!(
        r#"// Facade Code: this run's tools, registered for its session alone
import fs from 'node:fs';
import {{ fileURLToPath }} from 'node:url';
export default function (pi) {{
	pi.registerMcpServer("facade", {entry});
	pi.on('before_agent_start', (event) => {{
		event.systemPromptOptions.sections.facade = {instructions};
	}});
	pi.on('resources_discover', () => {{
		const own = new URL({skill}, import.meta.url);
		const content = fs.readFileSync(own, 'utf8');
		for (const command of pi.getCommands()) {{
			if (command.source !== 'skill' || command.name !== 'skill:facade') continue;
			try {{
				if (fs.readFileSync(command.sourceInfo.path, 'utf8') === content) return;
			}} catch {{ /* A source that cannot be read does not stand for this run's skill. */ }}
		}}
		return {{ skillPaths: [fileURLToPath(own)] }};
	}});
}}
"#,
        entry = pi_entry(&run_entry(server)),
        instructions = json!(server.instructions),
        skill = json!(format!("./{SKILL_FILE}")),
    );
    Wiring {
        args: vec!["-e".into(), argument(&server.folder.join(PI_TOOLS))],
        files: vec![(PI_TOOLS.into(), extension), skill_file()],
        ..Wiring::default()
    }
}

/// `facade hook <hook> <cli>`, `facade` this program.
pub(super) fn facade_hook(facade: &str, hook: &str, cli: &str) -> String {
    format!("{} hook {hook} {cli}", shell_word(facade))
}

/// Muse Code: `-c mcpServers.facade=<entry>` for the run alone, and two hooks: `SessionStart`,
/// which gives the model the instructions, as Muse Code shows it no server's instructions, and
/// `PermissionRequest`, which approves Facade's own tools, as Muse Code has no rule for one
/// server's tools. Muse Code takes no variables in a run's entry, so the entry names the run's by
/// references to the CLI's environment, which carries them; and it passes its hooks none, so the
/// instructions hook names them in its command. The entry is optional, as Muse Code fails a whole
/// run over a required server that does not start. Where the person's settings hold Facade's
/// guest entry, which Muse Code would refuse the run's own server beside, that entry serves the
/// run, which adds none. A run Muse Code would refuse beside the person's own configuration is not
/// given the tools, and Facade writes nothing.
pub(super) fn muse(
    server: &Server,
    environment: &BTreeMap<String, String>,
) -> Result<Wiring, String> {
    if let Some(why) = muse_refusal(server.cwd, environment) {
        return Err(why);
    }
    let settings = muse_settings_file(environment).and_then(|file| read_config(&file));
    let guest_serves =
        settings.is_some_and(|settings| is_muse_guest_entry(&settings["mcpServers"][SERVER]));
    let mut args = Vec::new();
    if !guest_serves {
        let references: Map<String, Value> = server
            .env
            .iter()
            .map(|(name, _)| (name.clone(), json!(format!("${{{name}}}"))))
            .collect();
        let entry =
            json!({ "command": server.program, "args": [], "env": references, "mode": "optional" });
        args = vec!["-c".into(), format!("mcpServers.{SERVER}={entry}")];
    }
    let variables: String = server
        .env
        .iter()
        .map(|(name, value)| format!("{name}={} ", shell_word(value)))
        .collect();
    let instructions = facade_hook(server.facade, "instructions", "muse");
    Ok(Wiring {
        args,
        hooks: vec![
            ("SessionStart".into(), variables + &instructions),
            (
                "PermissionRequest".into(),
                facade_hook(server.facade, "approve", "muse"),
            ),
        ],
        files: vec![
            (INSTRUCTIONS_FILE.into(), server.instructions.into()),
            skill_file(),
        ],
        ..Wiring::default()
    })
}

/// Antigravity: the plugin in [`super::PLUGIN_FOLDER`] of the folder the run starts in, shared by
/// the runs there, which holds no run's identity: the run's variables reach its server and hook
/// through the CLI's environment. Its tools are allowed for the run by `--settings`, beside the
/// person's own rules.
pub(super) fn agy(server: &Server) -> Wiring {
    Wiring {
        settings: Some(json!({ "permissions": { "allow": [ALLOW_TOOLS] } })),
        plugin: plugin_files(server.program, server.facade),
        files: vec![(INSTRUCTIONS_FILE.into(), server.instructions.into())],
        ..Wiring::default()
    }
}

/// The test CLI runs the server itself, with the variables its own environment has.
pub(super) fn fake(server: &Server) -> Wiring {
    Wiring {
        env: vec![(FAKE_SERVER.into(), server.program.into())],
        ..Wiring::default()
    }
}

/// Takes out of `env`, the environment a run of `cli` started with, what gave it Facade's tools:
/// the test CLI's variables, and Facade's server, permission and skill in OpenCode's inline
/// configuration, with what they alone filled. The skill is the one in a folder of the run's
/// agent, `FACADE_AGENT` in `FACADE_HOME`.
pub(super) fn unwire(cli: &str, env: &mut BTreeMap<String, String>) {
    match cli {
        "fake" => drop(env.remove(FAKE_SERVER)),
        "opencode" => {
            let config = env
                .get(OPENCODE_CONFIG)
                .and_then(|text| serde_json::from_str(text).ok());
            let Some(Value::Object(mut config)) = config else {
                return;
            };
            let ours = config.get_mut("mcp").and_then(Value::as_object_mut);
            if ours
                .and_then(|servers| servers.shift_remove(SERVER))
                .is_none()
            {
                return;
            }
            // A one-string permission became `{"*": <it>}`, which means the same, and stays.
            if let Some(Value::Object(rules)) = config.get_mut("permission") {
                rules.shift_remove("facade_*");
            }
            let runs = match (env.get("FACADE_HOME"), env.get("FACADE_AGENT")) {
                (Some(home), Some(agent)) => Some(Path::new(home).join("core/runs").join(agent)),
                _ => None,
            };
            if let (Some(runs), Some(Value::Array(instructions))) =
                (runs, config.get_mut("instructions"))
            {
                let run_skill =
                    |path: &str| Path::new(path).starts_with(&runs) && path.ends_with(SKILL_FILE);
                instructions.retain(|entry| !entry.as_str().is_some_and(run_skill));
            }
            // What only Facade's entries filled goes with them, and so does a configuration that
            // holds nothing else.
            let emptied = |value: &Value| match value {
                Value::Object(object) => object.is_empty(),
                Value::Array(list) => list.is_empty(),
                _ => false,
            };
            config.retain(|key, value| {
                !(["mcp", "permission", "instructions"].contains(&key.as_str()) && emptied(value))
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
