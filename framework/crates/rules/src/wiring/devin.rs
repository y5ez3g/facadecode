//! Devin reads its user MCP file from the platform configuration directory, including when
//! the main configuration was selected by --config.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use facade_base::system::{SYSTEM, System, env_var};
use serde_json::{Map, Value, json};

use super::config_files::{config_home, folder_named, home, project_files};
use super::servers::{Entry, SERVER, agy_entry, runs_facade_mcp};
use super::{MergedSettings, Server, Wiring};
use crate::formats::parse_jsonc;

const CONFIG_HOME: &str = match SYSTEM {
    System::Unix => "XDG_CONFIG_HOME",
    System::Windows => "APPDATA",
};
const ORIGINAL_HOME: &str = "FACADE_DEVIN_ORIGINAL_CONFIG_HOME";
const RUN_CONFIG: &str = "devin-config";
const USER_SETTINGS: &str = "devin-config/devin/config.json";
const USER_MCP: &str = "devin-config/devin/mcp_config.json";

pub(crate) fn user_dir(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    let root = match SYSTEM {
        System::Unix => config_home(environment),
        System::Windows => folder_named(environment, "APPDATA")
            .or_else(|| Some(home(environment)?.join("AppData").join("Roaming"))),
    }?;
    Some(root.join("devin"))
}

fn read_object(file: &Path) -> Result<Value, String> {
    let invalid = || {
        format!(
            "{} is not a JSON object Facade Code Framework can read",
            file.display()
        )
    };
    match std::fs::read_to_string(file) {
        Ok(text) => parse_jsonc(&text)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(invalid),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("could not read {} ({error})", file.display())),
    }
}

fn object_at<'a>(
    value: &'a mut Value,
    key: &str,
    place: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{place} is not an object"))?
        .entry(key)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("{place} has a {key} that is not an object"))
}

pub(super) fn tools(
    server: &Server<'_>,
    entry: &Entry<'_>,
    environment: &BTreeMap<String, String>,
) -> Result<Wiring, String> {
    let (mut settings, mut mcp) = user_settings(server.cwd, environment)?;
    if mcp["mcpServers"]
        .get(SERVER)
        .is_some_and(|entry| !runs_facade_mcp(entry))
    {
        return Err(format!(
            "Devin's user MCP configuration names a {SERVER} server that is not Facade Code Framework's"
        ));
    }
    for file in project_files(
        server.cwd,
        &[
            ".devin/config.json",
            ".devin/config.local.json",
            ".devin/mcp_config.json",
            ".devin/mcp_config.local.json",
            // Devin also loads these MCP files of other tools ahead of its user configuration.
            ".mcp.json",
            ".cursor/mcp.json",
        ],
    ) {
        if read_object(&file)?["mcpServers"].get(SERVER).is_some() {
            return Err(format!(
                "{} already defines the {SERVER} server with project precedence",
                file.display()
            ));
        }
    }
    session_start(&mut settings)?;
    let servers = object_at(&mut mcp, "mcpServers", "the user MCP configuration")?;
    servers.insert(SERVER.into(), agy_entry(entry));
    let permissions = object_at(&mut settings, "permissions", "the user configuration")?;
    let allow = permissions.entry("allow").or_insert_with(|| json!([]));
    let allow = allow
        .as_array_mut()
        .ok_or("the user configuration's permissions.allow is not a list")?;
    let grant = json!("mcp__facade__*");
    if !allow.contains(&grant) {
        allow.push(grant);
    }

    let mut config_links = Vec::new();
    if let Some(user) = user_dir(environment).map(|path| server.cwd.join(path)) {
        let root = user
            .parent()
            .expect("Devin's folder has a configuration root");
        config_links.extend(config_aliases(root, Path::new(RUN_CONFIG), &["devin"])?);
        config_links.extend(config_aliases(
            &user,
            Path::new(RUN_CONFIG).join("devin").as_path(),
            &["config.json", "mcp_config.json"],
        )?);
    }
    let overlay = server
        .folder
        .join(RUN_CONFIG)
        .to_string_lossy()
        .into_owned();
    let original = serde_json::to_string(&(&overlay, env_var(environment, CONFIG_HOME)))
        .expect("a configuration directory variable is JSON");
    let config_key = environment
        .keys()
        .find(|key| config_key(key))
        .map_or(CONFIG_HOME, String::as_str);
    Ok(Wiring {
        settings: Some(settings),
        env: vec![
            (config_key.into(), overlay),
            (ORIGINAL_HOME.into(), original),
        ],
        files: vec![(USER_MCP.into(), format!("{mcp:#}\n"))],
        config_links,
        ..Wiring::default()
    })
}

fn config_aliases(
    source: &Path,
    destination: &Path,
    replaced: &[&str],
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let error = |error| {
        format!(
            "could not read Devin's configuration directory {} ({error})",
            source.display()
        )
    };
    let entries = match std::fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(why) => return Err(error(why)),
    };
    let mut aliases = Vec::new();
    for entry in entries {
        let entry = entry.map_err(error)?;
        let name = entry.file_name();
        if !replaced.iter().any(|item| {
            if SYSTEM == System::Windows {
                name.to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(item))
            } else {
                name == *item
            }
        }) {
            aliases.push((destination.join(name), entry.path()));
        }
    }
    Ok(aliases)
}

/// Another Facade Code Framework run gets the original user config root, even if it was unset.
pub(super) fn restore_config_home(environment: &mut BTreeMap<String, String>) {
    let Some(original) = environment.remove(ORIGINAL_HOME) else {
        return;
    };
    let Ok((overlay, original)) = serde_json::from_str::<(String, Option<String>)>(&original)
    else {
        return;
    };
    if env_var(environment, CONFIG_HOME) != Some(&overlay) {
        return;
    }
    environment.retain(|key, _| !config_key(key));
    if let Some(original) = original {
        environment.insert(CONFIG_HOME.into(), original);
    }
}

fn config_key(key: &str) -> bool {
    match SYSTEM {
        System::Unix => key == CONFIG_HOME,
        System::Windows => key.eq_ignore_ascii_case(CONFIG_HOME),
    }
}

fn user_settings(
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<(Value, Value), String> {
    let user = user_dir(environment).map(|path| cwd.join(path));
    let mut settings = user
        .as_ref()
        .map(|dir| read_object(&dir.join("config.json")))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let mut mcp = user
        .as_ref()
        .map(|dir| read_object(&dir.join("mcp_config.json")))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    // Move old-style user entries into the run's sibling file. No migration has to write to the
    // user's config, and the current dedicated MCP settings take precedence over legacy entries.
    if let Some(legacy) = settings
        .as_object_mut()
        .expect("read_object checked")
        .remove("mcpServers")
    {
        let legacy = legacy
            .as_object()
            .ok_or("the user configuration's mcpServers is not an object")?;
        let servers = object_at(&mut mcp, "mcpServers", "the user MCP configuration")?;
        for (name, entry) in legacy {
            servers.entry(name).or_insert_with(|| entry.clone());
        }
    }
    Ok((settings, mcp))
}

pub(super) fn settings(
    wiring: &Wiring,
    words: &[String],
    cwd: &Path,
    folder: &Path,
    environment: &BTreeMap<String, String>,
) -> Option<MergedSettings> {
    let (mut settings, name) = match &wiring.settings {
        Some(settings) => (settings.clone(), USER_SETTINGS),
        None => (
            user_dir(environment)
                .map(|path| read_object(&cwd.join(path).join("config.json")))
                .transpose()
                .ok()?
                .unwrap_or_else(|| json!({})),
            "config.json",
        ),
    };
    if !wiring.hooks.is_empty() {
        let starts = session_start(&mut settings).ok()?;
        for (_, command) in &wiring.hooks {
            starts.push(json!({
                "hooks": [{ "type": "command", "command": command, "timeout": 10 }]
            }));
        }
    }
    let file = folder.join(name);
    Some(MergedSettings {
        args: vec!["--config".into(), file.to_string_lossy().into_owned()],
        files: vec![(name.into(), format!("{settings:#}\n"))],
        rest: words.to_vec(),
    })
}

fn session_start(settings: &mut Value) -> Result<&mut Vec<Value>, String> {
    let hooks = object_at(settings, "hooks", "the user configuration")?;
    hooks
        .entry("SessionStart")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| "the user configuration's SessionStart hooks are not a list".into())
}
