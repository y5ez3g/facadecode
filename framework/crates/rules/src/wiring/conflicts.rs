//! Why a run is not given Facade Code Framework's tools: a `facade` server of the person's own in a configuration
//! its CLI reads, which Facade Code Framework's would take the place of or stand beside, or, for Muse Code,
//! anything that has it refuse Facade Code Framework's server. Facade Code Framework changes none of these files.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::OPENCODE_CONFIG;
use super::config_files::{
    MCP_FILE, config_home, folder_named, home, muse_settings_file, project_files, read_config,
};
use super::integration::written_by_facade;
use super::servers::{SERVER, is_server_program, runs_facade_mcp};
use crate::formats::parse_jsonc;

/// What every refusal of a server of the person's own ends with.
const LEFT_AS_IT_IS: &str =
    "Facade Code Framework leaves it as it is, and the run has no Facade Code Framework tools";

/// Why a run of `cli` in `cwd`, with the CLI's own `environment`, is not given Facade Code Framework's tools: a
/// `facade` server of the person's own that `cli` reads. None where there is none. Muse Code's
/// refusals are checked by [`muse_config`]. Antigravity has no such check: it names a plugin's
/// server after the plugin, so Facade Code Framework's is `facade_facade`, and neither it nor a `facade` server
/// of the person's own takes the other's place.
pub(super) fn persons_server(
    cli: &str,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Option<String> {
    let found = match cli {
        "claude" => claude_servers(cwd, environment),
        "codex" => codex_servers(environment),
        "opencode" => opencode_servers(cwd, environment),
        "pi" => return pi_registration(cwd, environment),
        _ => Vec::new(),
    };
    let (place, _) = found
        .into_iter()
        .find(|(_, entry)| !runs_facade_mcp(entry))?;
    Some(format!(
        "{place} names a {SERVER} server that is not Facade Code Framework's; {LEFT_AS_IT_IS}"
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
        // Claude Code keys a project by its folder, which may be the canonical path, and on
        // Windows with forward slashes.
        let canonical = std::fs::canonicalize(cwd).ok();
        let mut keys: Vec<String> = Vec::new();
        for folder in std::iter::once(cwd.to_path_buf()).chain(canonical) {
            let folder = folder.to_string_lossy();
            for key in [folder.to_string(), folder.replace('\\', "/")] {
                if !keys.contains(&key) {
                    found.extend(facade_in(&file, &config["projects"][&key]["mcpServers"]));
                    keys.push(key);
                }
            }
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
        .filter_map(|file| {
            let config = read_config(file)?;
            let entry = opencode_server(&config)?;
            Some((file.display().to_string(), entry.clone()))
        })
        .collect();
    let inline = environment
        .get(OPENCODE_CONFIG)
        .and_then(|text| parse_jsonc(text).ok());
    if let Some(entry) = inline.as_ref().and_then(opencode_server) {
        found.push((format!("its {OPENCODE_CONFIG}"), entry.clone()));
    }
    found
}

fn opencode_server(config: &Value) -> Option<&Value> {
    let mcp = &config["mcp"];
    // In OpenCode 2, native server definitions take precedence over the legacy map.
    mcp["servers"].get(SERVER).or_else(|| mcp.get(SERVER))
}

/// An extension Pi loads that registers a `facade` server: Pi does not start at all beside a second
/// registration of the name, so Facade Code Framework starts it without its own. The guest extension `facade
/// integration add pi` writes is not one: it registers Facade Code Framework's server only where Facade Code Framework did not
/// start Pi. Pi loads extensions from `.pi/extensions` of the folder it starts in and from
/// `extensions` of its agent folder, `$PI_CODING_AGENT_DIR` or `.pi/agent` in the home folder.
fn pi_registration(cwd: &Path, environment: &BTreeMap<String, String>) -> Option<String> {
    let folders = std::iter::once(cwd.join(".pi"))
        .chain(pi_agent_folder(environment))
        .map(|f| f.join("extensions"));
    let file = folders
        .flat_map(|folder| pi_extension_files(&folder))
        .find(|file| {
            std::fs::read_to_string(file)
                .is_ok_and(|text| registers_facade(&text) && !written_by_facade(&text))
        })?;
    Some(format!(
        "{} registers a {SERVER} server that is not Facade Code Framework's; {LEFT_AS_IT_IS}",
        file.display()
    ))
}

fn pi_agent_folder(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    folder_named(environment, "PI_CODING_AGENT_DIR")
        .or_else(|| home(environment).map(|home| home.join(".pi").join("agent")))
}

/// Pi's distinct managed namespace when the user's native configuration already names `facade`.
pub(super) const PI_MANAGED_SERVER: &str = "facade_managed";

/// Pi gives its native MCP files precedence over a server registered by an extension. Check only
/// the two files it can load for this run, leaving the project trust decision with Pi.
pub(super) fn pi_has_server(
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<bool, String> {
    let project = cwd.join(".pi").join("mcp.json");
    let files =
        std::iter::once(project.clone()).chain(pi_agent_folder(environment).map(|folder| {
            let folder = folder
                .strip_prefix("~")
                .ok()
                .and_then(|relative| Some(home(environment)?.join(relative)))
                .unwrap_or(folder);
            cwd.join(folder).join("mcp.json")
        }));
    let mut configured = false;
    let mut alternate_source = None;
    for file in files {
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("{} could not be read: {err}", file.display())),
        };
        let config: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|_| format!("{} is not plain JSON, as Pi reads it", file.display()))?;
        let servers = &config["mcpServers"];
        let defines_server =
            |entry: &Value| entry["command"].is_string() || entry["url"].is_string();
        // Pi normalizes hyphens to underscores when comparing namespaces.
        if alternate_source.is_none()
            && [PI_MANAGED_SERVER, "facade-managed"]
                .into_iter()
                .any(|name| servers.get(name).is_some_and(defines_server))
        {
            alternate_source = Some(file.clone());
        }
        let Some(entry) = servers.get(SERVER) else {
            continue;
        };
        if file == project && !defines_server(entry) {
            // A project entry can adjust a user's server without defining one of its own.
            continue;
        }
        if !is_server_program(entry["command"].as_str()) {
            return Err(format!(
                "{} names a {SERVER} server that is not Facade Code Framework's; {LEFT_AS_IT_IS}",
                file.display()
            ));
        }
        configured = true;
    }
    if configured && let Some(file) = alternate_source {
        return Err(format!(
            "{} already uses the {PI_MANAGED_SERVER} namespace; {LEFT_AS_IT_IS}",
            file.display()
        ));
    }
    Ok(configured)
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

/// Whether a run can use a configured Facade Code Framework server, or why its MCP configuration precludes it.
pub(super) fn muse_config(
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<bool, String> {
    let mut has_server = false;
    let named = |file: &Path| {
        format!(
            "{} names a {SERVER} server, beside which Muse Code refuses to run with Facade Code Framework's; \
             Facade Code Framework leaves it as it is",
            file.display()
        )
    };
    if let Some(file) = muse_settings_file(environment)
        && let Some(settings) = read_config(&file)
        && let Some(entry) = settings
            .get("mcpServers")
            .or_else(|| settings.get("mcp_servers"))
            .and_then(|servers| servers.get(SERVER))
    {
        if !is_server_program(entry["command"].as_str()) {
            return Err(named(&file));
        }
        if entry["enabled"] == false {
            return Err(format!("{} disables the {SERVER} server", file.display()));
        }
        has_server = true;
    }
    for file in project_files(cwd, &[MCP_FILE]) {
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
                continue;
            }
            Err(err) => {
                let file = file.display();
                return Err(format!(
                    "{file} could not be read: {err}; Facade Code Framework leaves it as it is"
                ));
            }
        };
        match muse_project_config(&text) {
            Ok(config) => {
                if let Some(entry) = config["mcpServers"].get(SERVER) {
                    if !is_server_program(entry["command"].as_str()) {
                        return Err(named(&file));
                    }
                    if entry["enabled"] == false {
                        return Err(format!("{} disables the {SERVER} server", file.display()));
                    }
                    has_server = true;
                }
            }
            Err(why) => {
                return Err(format!(
                    "{} {why}, and Muse Code refuses to run with Facade Code Framework's server beside a project \
                     MCP file it cannot load; Facade Code Framework leaves it as it is",
                    file.display()
                ));
            }
        }
    }
    Ok(has_server)
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
