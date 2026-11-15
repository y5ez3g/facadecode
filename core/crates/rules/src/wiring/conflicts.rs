//! Why a run is not given Facade's tools: a `facade` server of the person's own in a configuration
//! its CLI reads, which Facade's would take the place of or stand beside, or, for Muse Code,
//! anything that has it refuse Facade's server. Facade changes none of these files.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::OPENCODE_CONFIG;
use super::config_files::{
    MCP_FILE, config_home, folder_named, home, muse_settings_file, project_files, read_config,
};
use super::integration::written_by_facade;
use super::servers::{SERVER, is_muse_guest_entry, runs_facade_mcp};
use crate::formats::parse_jsonc;

/// What every refusal of a server of the person's own ends with.
const LEFT_AS_IT_IS: &str = "Facade leaves it as it is, and the run has no Facade tools";

/// Why a run of `cli` in `cwd`, with the CLI's own `environment`, is not given Facade's tools: a
/// `facade` server of the person's own that `cli` reads. None where there is none. Muse Code's
/// refusals are [`muse_refusal`].
pub(super) fn persons_server(
    cli: &str,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Option<String> {
    let found = match cli {
        "claude" => claude_servers(cwd, environment),
        "codex" => codex_servers(environment),
        "opencode" => opencode_servers(cwd, environment),
        "agy" => agy_servers(environment),
        "pi" => return pi_registration(cwd, environment),
        _ => Vec::new(),
    };
    let (place, _) = found
        .into_iter()
        .find(|(_, entry)| !runs_facade_mcp(entry))?;
    Some(format!(
        "{place} names a {SERVER} server that is not Facade's; {LEFT_AS_IT_IS}"
    ))
}

/// The `facade` server among `servers` of the configuration in `file`, if it names one.
fn facade_in(file: &Path, servers: &Value) -> Option<(String, Value)> {
    Some((file.display().to_string(), servers.get(SERVER)?.clone()))
}

/// Claude Code's: the user's and the run folder's own in `.claude.json` of `$CLAUDE_CONFIG_DIR` or
/// the home folder, and the project's in each `.mcp.json` it reads.
fn claude_servers(cwd: &Path, environment: &BTreeMap<String, String>) -> Vec<(String, Value)> {
    let mut found = Vec::new();
    let folder = folder_named(environment, "CLAUDE_CONFIG_DIR").or_else(|| home(environment));
    if let Some(file) = folder.map(|folder| folder.join(".claude.json"))
        && let Some(config) = read_config(&file)
    {
        found.extend(facade_in(&file, &config["mcpServers"]));
        // Claude Code keys a project by its folder, which may be the canonical path.
        let canonical = std::fs::canonicalize(cwd).ok();
        for folder in std::iter::once(cwd.to_path_buf()).chain(canonical) {
            let project = &config["projects"][folder.to_string_lossy().as_ref()];
            found.extend(facade_in(&file, &project["mcpServers"]));
        }
    }
    for file in project_files(cwd, &[MCP_FILE]) {
        found.extend(read_config(&file).and_then(|config| facade_in(&file, &config["mcpServers"])));
    }
    found
}

/// Codex's: `[mcp_servers.facade]` in `config.toml` of `$CODEX_HOME`, or of `.codex` in the home
/// folder.
fn codex_servers(environment: &BTreeMap<String, String>) -> Vec<(String, Value)> {
    let folder = folder_named(environment, "CODEX_HOME")
        .or_else(|| home(environment).map(|home| home.join(".codex")));
    let found = || {
        let file = folder?.join("config.toml");
        let config: toml::Table = std::fs::read_to_string(&file).ok()?.parse().ok()?;
        let entry = serde_json::to_value(config.get("mcp_servers")?.get(SERVER)?).ok()?;
        Some((file.display().to_string(), entry))
    };
    found().into_iter().collect()
}

/// A configuration file OpenCode reads besides its own.
const OPENCODE_CONFIG_FILE: &str = "OPENCODE_CONFIG";

/// OpenCode's: `mcp.facade` in its global configuration, in `$OPENCODE_CONFIG`, in each project
/// configuration it reads, and in the person's own inline configuration.
fn opencode_servers(cwd: &Path, environment: &BTreeMap<String, String>) -> Vec<(String, Value)> {
    let names = ["opencode.json", "opencode.jsonc"];
    let global = config_home(environment).map(|config| config.join("opencode"));
    let mut files: Vec<PathBuf> = global
        .into_iter()
        .flat_map(|folder| names.map(|name| folder.join(name)))
        .collect();
    files.extend(folder_named(environment, OPENCODE_CONFIG_FILE));
    files.extend(project_files(cwd, &names));
    let mut found: Vec<(String, Value)> = files
        .iter()
        .filter_map(|file| facade_in(file, &read_config(file)?["mcp"]))
        .collect();
    let inline = environment
        .get(OPENCODE_CONFIG)
        .and_then(|text| parse_jsonc(text).ok());
    if let Some(entry) = inline.as_ref().and_then(|inline| inline["mcp"].get(SERVER)) {
        found.push((format!("its {OPENCODE_CONFIG}"), entry.clone()));
    }
    found
}

/// Antigravity's: `mcpServers.facade` in its own MCP configuration, which `agy mcp add` writes.
fn agy_servers(environment: &BTreeMap<String, String>) -> Vec<(String, Value)> {
    let file = home(environment).map(|home| home.join(".gemini/config/mcp_config.json"));
    let found = || facade_in(file.as_ref()?, &read_config(file.as_ref()?)?["mcpServers"]);
    found().into_iter().collect()
}

/// An extension Pi loads that registers a `facade` server: Pi does not start at all beside a second
/// registration of the name, so Facade starts it without its own. The guest extension `facade
/// integration add pi` writes is not one: it registers Facade's server only where Facade did not
/// start Pi. Pi loads extensions from `.pi/extensions` of the folder it starts in and from
/// `extensions` of its agent folder, `$PI_CODING_AGENT_DIR` or `.pi/agent` in the home folder.
fn pi_registration(cwd: &Path, environment: &BTreeMap<String, String>) -> Option<String> {
    let agent = folder_named(environment, "PI_CODING_AGENT_DIR")
        .or_else(|| home(environment).map(|home| home.join(".pi").join("agent")));
    let folders = std::iter::once(cwd.join(".pi"))
        .chain(agent)
        .map(|f| f.join("extensions"));
    let file = folders
        .flat_map(|folder| pi_extension_files(&folder))
        .find(|file| {
            std::fs::read_to_string(file)
                .is_ok_and(|text| registers_facade(&text) && !written_by_facade(&text))
        })?;
    Some(format!(
        "{} registers a {SERVER} server that is not Facade's; {LEFT_AS_IT_IS}",
        file.display()
    ))
}

/// The extension files Pi loads from `folder`: each `.ts` or `.js` file in it, and in each folder
/// in it the files its `package.json` names under `pi.extensions`, or else its `index.ts` or
/// `index.js`.
fn pi_extension_files(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        if path.is_file() {
            let script = path
                .extension()
                .is_some_and(|extension| extension == "ts" || extension == "js");
            files.extend(script.then_some(path));
            continue;
        }
        let manifest = read_config(&path.join("package.json"));
        let named = manifest
            .as_ref()
            .and_then(|manifest| manifest["pi"]["extensions"].as_array());
        let declared: Vec<PathBuf> = named
            .into_iter()
            .flatten()
            .filter_map(|entry| Some(path.join(entry.as_str()?)))
            .filter(|file| file.exists())
            .collect();
        if declared.is_empty() {
            let index = ["index.ts", "index.js"].map(|name| path.join(name));
            files.extend(index.into_iter().find(|index| index.exists()));
        } else {
            files.extend(declared);
        }
    }
    files
}

/// Whether an extension's `text` registers a server named `facade`: `registerMcpServer(` with that
/// name, quoted, as its first argument.
fn registers_facade(text: &str) -> bool {
    text.match_indices("registerMcpServer(").any(|(at, call)| {
        let argument = text[at + call.len()..].trim_start();
        ['"', '\'', '`'].iter().any(|quote| {
            argument
                .strip_prefix(*quote)
                .and_then(|rest| rest.strip_prefix(SERVER))
                .is_some_and(|rest| rest.starts_with(*quote))
        })
    })
}

/// Why Muse Code would refuse to run in `cwd` with Facade's server: its own settings, as
/// `environment` places them, or a project MCP file it reads there names a `facade` server, or a
/// project MCP file it reads cannot be loaded. None where nothing is in the way. Facade's guest
/// entry in the settings is the run's own server, and not in the way.
pub(super) fn muse_refusal(cwd: &Path, environment: &BTreeMap<String, String>) -> Option<String> {
    let names_ours = |config: &Value| config["mcpServers"].get(SERVER).is_some();
    let named = |file: &Path| {
        format!(
            "{} names a {SERVER} server, beside which Muse Code refuses to run with Facade's; \
             Facade leaves it as it is",
            file.display()
        )
    };
    if let Some(file) = muse_settings_file(environment)
        && let Some(settings) = read_config(&file)
        && names_ours(&settings)
        && !is_muse_guest_entry(&settings["mcpServers"][SERVER])
    {
        return Some(named(&file));
    }
    for file in project_files(cwd, &[MCP_FILE]) {
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
                continue;
            }
            Err(err) => {
                let file = file.display();
                return Some(format!(
                    "{file} could not be read: {err}; Facade leaves it as it is"
                ));
            }
        };
        match muse_project_config(&text) {
            Ok(config) if names_ours(&config) => return Some(named(&file)),
            Ok(_) => {}
            Err(why) => {
                return Some(format!(
                    "{} {why}, and Muse Code refuses to run with Facade's server beside a project \
                     MCP file it cannot load; Facade leaves it as it is",
                    file.display()
                ));
            }
        }
    }
    None
}

/// A project MCP file's `text` as Muse Code loads it, or why it cannot: text that is not plain JSON
/// (a byte order mark, a comment, a trailing comma, or nothing), no JSON object, an `mcpServers`
/// that is no object, or a server in it that is no object with a `command` or `url` string.
fn muse_project_config(text: &str) -> Result<Value, String> {
    let config: Value = serde_json::from_str(text)
        .map_err(|_| "is not plain JSON, as Muse Code reads it".to_string())?;
    if !config.is_object() {
        return Err("holds no JSON object".into());
    }
    match config.get("mcpServers") {
        None => {}
        Some(Value::Object(servers)) => {
            let usable =
                |server: &Value| server["command"].is_string() || server["url"].is_string();
            if let Some((name, _)) = servers.iter().find(|(_, server)| !usable(server)) {
                return Err(format!(
                    "names a server {name:?} with neither a command nor a url"
                ));
            }
        }
        Some(_) => return Err("has an mcpServers that is not a JSON object".into()),
    }
    Ok(config)
}
