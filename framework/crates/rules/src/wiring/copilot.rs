//! Copilot's private MCP override and the local plugin that reports its session.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use facade_base::system::{SYSTEM, System, env_var, home_folder_in};
use serde_json::{Value, json};

use super::config_files::project_files;
use super::servers::{Entry, SERVER, claude_entry, runs_facade_mcp};
use super::{MergedSettings, Server, SessionReport, Wiring};
use crate::Rule;
use crate::formats::{parse_jsonc, powershell_word, shell_word};

const MCP_CONFIG: &str = "copilot-mcp.json";
const PLUGIN: &str = "copilot-session";

pub(super) fn tools(
    rule: &Rule,
    words: &[String],
    server: &Server<'_>,
    entry: &Entry<'_>,
    environment: &BTreeMap<String, String>,
) -> Result<Wiring, String> {
    check_sources(rule, words, server.cwd, environment)?;
    let mut entry = claude_entry(entry);
    entry["type"] = json!("local");
    entry["tools"] = json!(["*"]);
    let config = json!({ "mcpServers": { SERVER: entry } });
    Ok(Wiring {
        args: vec![format!("--allow-tool={SERVER}")],
        files: vec![(MCP_CONFIG.into(), format!("{config:#}\n"))],
        ..Wiring::default()
    })
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

/// Look for the winning native binding before appending our highest-priority override.
fn check_sources(
    rule: &Rule,
    words: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<(), String> {
    let folder_options = ["-C".into(), "-w".into(), "--worktree".into()];
    if rule.arguments.holds(words, &folder_options, None) {
        return Err(unchecked(&"alternate session directory"));
    }
    for (index, option) in rule
        .arguments
        .found(words, "--additional-mcp-config")
        .into_iter()
        .enumerate()
        .rev()
    {
        let place = format!("--additional-mcp-config argument {}", index + 1);
        let value = option.value.as_deref().ok_or_else(|| unchecked(&place))?;
        let selected = if let Some(file) = value.strip_prefix('@') {
            let file = local_path(cwd, environment, file).ok_or_else(|| unchecked(&place))?;
            let config = read_object(&file)?.ok_or_else(|| unchecked(&file.display()))?;
            binding(&config, &file.display(), false)?
        } else {
            let config = serde_json::from_str(value).map_err(|_| unchecked(&place))?;
            binding(&config, &place, false)?
        };
        if selected {
            return Ok(());
        }
    }

    for (index, option) in rule
        .arguments
        .found(words, "--plugin-dir")
        .into_iter()
        .enumerate()
        .rev()
    {
        let place = format!("--plugin-dir argument {}", index + 1);
        let path = option
            .value
            .as_deref()
            .and_then(|value| local_path(cwd, environment, value))
            .ok_or_else(|| unchecked(&place))?;
        if plugin_binding(&path)? {
            return Ok(());
        }
    }

    let root = crate::copilot_config_dir(rule, cwd, environment, words)
        .ok_or_else(|| unchecked(&"configuration directory"))?;
    let workspace = project_files(cwd, &[".mcp.json", ".github/mcp.json"]);
    let project = workspace
        .last()
        .and_then(|file| file.parent()?.parent())
        .unwrap_or(cwd);
    let directories_only = env_var(environment, "COPILOT_PLUGIN_DIR_ONLY") == Some("true");
    // A person can accept trust during startup. Consider the bindings with and without the
    // repository's files and plugin activation in effect.
    for trusted in [true, false] {
        if !directories_only && ambient_binding(&root, cwd, project, environment, trusted)? {
            continue;
        }
        if trusted && workspace_binding(&workspace)? {
            continue;
        }
        let file = root.join("mcp-config.json");
        if let Some(config) = read_object(&file)? {
            binding(&config, &file.display(), false)?;
        }
    }
    Ok(())
}

fn workspace_binding(files: &[PathBuf]) -> Result<bool, String> {
    for file in files {
        if let Some(config) = read_object(file)?
            && binding(&config, &file.display(), true)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Returns whether this source selects an existing Facade relay, so lower sources cannot win.
fn binding(config: &Value, place: &impl std::fmt::Display, bare: bool) -> Result<bool, String> {
    let object = config.as_object().ok_or_else(|| unchecked(place))?;
    let servers = match object.get("mcpServers") {
        Some(map) => map.as_object().ok_or_else(|| unchecked(place))?,
        None if bare => object,
        None => return Ok(false),
    };
    let Some(entry) = servers.get(SERVER).filter(|entry| entry.is_object()) else {
        return Ok(false);
    };
    if runs_facade_mcp(entry) {
        Ok(true)
    } else {
        Err(format!(
            "Copilot's {place} names a {SERVER} MCP server that is not Facade's; Facade leaves it as it is, and the run has no Facade tools"
        ))
    }
}

fn read_object(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_jsonc(&text)
            .ok()
            .filter(Value::is_object)
            .map(Some)
            .ok_or_else(|| unchecked(&path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(unchecked(&path.display())),
    }
}

fn unchecked(place: &impl std::fmt::Display) -> String {
    format!(
        "Could not check Copilot's {place} for a {SERVER} MCP server; Facade leaves it as it is, and the run has no Facade tools"
    )
}

fn local_path(cwd: &Path, environment: &BTreeMap<String, String>, value: &str) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }
    let path = Path::new(value);
    if let Ok(relative) = path.strip_prefix("~") {
        return Some(cwd.join(home_folder_in(environment)?).join(relative));
    }
    Some(cwd.join(path))
}

fn plugin_binding(folder: &Path) -> Result<bool, String> {
    let root_manifest = folder.join("plugin.json");
    let root = read_object(&root_manifest)?;
    if let Some(manifest) = &root
        && let Some(schema) = manifest["$schema"].as_str()
        && schema.starts_with("https://agent-plugins.org/schemas/")
    {
        return match schema {
            "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
            | "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json" => {
                let file = folder.join("mcp.json");
                read_object(&file)?
                    .map_or(Ok(false), |config| binding(&config, &file.display(), true))
            }
            _ => Ok(false), // Copilot rejects an unsupported Agent Plugins manifest.
        };
    }

    let mut manifest_file = folder.join(".plugin/plugin.json");
    let mut manifest = read_object(&manifest_file)?;
    if manifest.is_none() {
        manifest_file = root_manifest;
        manifest = root;
    }
    for name in [".github/plugin/plugin.json", ".claude-plugin/plugin.json"] {
        if manifest.is_some() {
            break;
        }
        manifest_file = folder.join(name);
        manifest = read_object(&manifest_file)?;
    }
    let manifest = manifest.ok_or_else(|| unchecked(&folder.display()))?;
    for name in [".mcp.json", ".github/mcp.json"] {
        let file = folder.join(name);
        if let Some(config) = read_object(&file)? {
            return binding(&config, &file.display(), true);
        }
    }
    match manifest.get("mcpServers") {
        Some(Value::String(name)) => {
            let file = folder.join(name);
            let config = read_object(&file)?.ok_or_else(|| unchecked(&file.display()))?;
            binding(&config, &file.display(), true)
        }
        Some(_) => binding(&manifest, &manifest_file.display(), false),
        None => Ok(false),
    }
}

#[derive(Default)]
struct PluginSettings {
    enabled: BTreeMap<String, (bool, PathBuf)>,
    marketplaces: BTreeMap<String, Value>,
}

/// Only installed or selected plugins can take part. A selected source whose native activation
/// cannot be resolved locally is a reason to leave the native MCP configuration in effect.
fn ambient_binding(
    root: &Path,
    cwd: &Path,
    project: &Path,
    environment: &BTreeMap<String, String>,
    trusted: bool,
) -> Result<bool, String> {
    let mut settings = PluginSettings::default();
    settings.read(&root.join("settings.json"))?;
    if trusted {
        for name in [
            ".claude/settings.json",
            ".claude/settings.local.json",
            ".github/copilot/settings.json",
            ".github/copilot/settings.local.json",
        ] {
            settings.read(&project.join(name))?;
        }
    }
    let managed = match SYSTEM {
        System::Unix => match std::env::consts::OS {
            "macos" => Some(PathBuf::from(
                "/Library/Application Support/GitHubCopilot/managed-settings.json",
            )),
            "linux" => Some(PathBuf::from("/etc/github-copilot/managed-settings.json")),
            _ => None,
        },
        System::Windows => env_var(environment, "ProgramFiles")
            .map(|path| Path::new(path).join("GitHubCopilot/managed-settings.json")),
    };
    if let Some(file) = managed {
        settings.read(&file)?;
    }
    let state = root.join("config.json");
    let config = read_object(&state)?.unwrap_or_else(|| json!({}));
    let installed = match config.get("installedPlugins") {
        Some(value) => value
            .as_array()
            .ok_or_else(|| unchecked(&state.display()))?
            .as_slice(),
        None => &[],
    };
    let mut active = Vec::new();
    for plugin in installed {
        let name = plugin["name"]
            .as_str()
            .ok_or_else(|| unchecked(&state.display()))?;
        let marketplace = plugin["marketplace"].as_str();
        let spec = marketplace.map_or_else(|| name.into(), |market| format!("{name}@{market}"));
        let selected = settings.enabled.remove(&spec).or_else(|| {
            plugin["installed_from"]
                .as_str()
                .and_then(|source| settings.enabled.remove(source))
        });
        if selected
            .as_ref()
            .map_or(plugin["enabled"].as_bool() != Some(false), |(on, _)| *on)
        {
            active.push((plugin, spec, selected));
        }
    }

    let mut selected_binding = false;
    for (spec, (on, file)) in &settings.enabled {
        if *on {
            let folder = settings
                .declared_plugin(spec, cwd, environment, file)?
                .ok_or_else(|| unchecked(&file.display()))?;
            selected_binding |= plugin_binding(&folder)?;
        }
    }
    for (plugin, spec, selected) in active.into_iter().rev() {
        let place = selected.as_ref().map_or(&state, |(_, file)| file);
        let folder = settings
            .declared_plugin(&spec, cwd, environment, place)?
            .or_else(|| plugin["cache_path"].as_str().map(PathBuf::from))
            .filter(|path| path.is_absolute())
            .ok_or_else(|| unchecked(&place.display()))?;
        if plugin_binding(&folder)? {
            return Ok(true);
        }
    }
    Ok(selected_binding)
}

impl PluginSettings {
    fn read(&mut self, file: &Path) -> Result<(), String> {
        let Some(config) = read_object(file)? else {
            return Ok(());
        };
        if let Some(entries) = config.get("enabledPlugins") {
            let entries = entries
                .as_object()
                .ok_or_else(|| unchecked(&file.display()))?;
            for (spec, on) in entries {
                let on = on.as_bool().ok_or_else(|| unchecked(&file.display()))?;
                self.enabled.insert(spec.clone(), (on, file.to_path_buf()));
            }
        }
        if let Some(entries) = config.get("extraKnownMarketplaces") {
            let entries = entries
                .as_object()
                .ok_or_else(|| unchecked(&file.display()))?;
            self.marketplaces.extend(entries.clone());
        }
        Ok(())
    }

    /// Directory marketplaces load path-sourced plugins live, even before any installed copy.
    fn declared_plugin(
        &self,
        spec: &str,
        cwd: &Path,
        environment: &BTreeMap<String, String>,
        place: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if Path::new(spec).is_absolute()
            || ["./", "../", "~/"]
                .iter()
                .any(|prefix| spec.starts_with(prefix))
        {
            return local_path(cwd, environment, spec)
                .map(Some)
                .ok_or_else(|| unchecked(&place.display()));
        }
        let Some((name, marketplace)) = spec.rsplit_once('@') else {
            return Ok(None);
        };
        let Some(marketplace) = self.marketplaces.get(marketplace) else {
            return Ok(None);
        };
        let source = &marketplace["source"];
        if source["source"] != "directory" {
            return Ok(None);
        }
        let base = source["path"]
            .as_str()
            .and_then(|value| local_path(cwd, environment, value))
            .ok_or_else(|| unchecked(&place.display()))?;
        for manifest in [
            "marketplace.json",
            ".plugin/marketplace.json",
            ".github/plugin/marketplace.json",
            ".claude-plugin/marketplace.json",
        ] {
            let file = base.join(manifest);
            let Some(catalog) = read_object(&file)? else {
                continue;
            };
            let entries = catalog["plugins"]
                .as_array()
                .ok_or_else(|| unchecked(&file.display()))?;
            let Some(entry) = entries.iter().find(|entry| entry["name"] == name) else {
                return Ok(None);
            };
            let path = entry["source"]
                .as_str()
                .ok_or_else(|| unchecked(&file.display()))?;
            let root = base
                .canonicalize()
                .map_err(|_| unchecked(&file.display()))?;
            let folder = root.join(path);
            let folder = folder
                .canonicalize()
                .map_err(|_| unchecked(&file.display()))?;
            return folder
                .starts_with(root)
                .then_some(Some(folder))
                .ok_or_else(|| unchecked(&file.display()));
        }
        Err(unchecked(&base.display()))
    }
}
