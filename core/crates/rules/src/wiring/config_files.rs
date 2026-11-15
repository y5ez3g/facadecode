//! Where the CLIs keep the configuration a run reads, by the environment it starts with, and
//! reading it as they do.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::formats::parse_jsonc;

/// The project MCP file Claude Code and Muse Code read in a folder.
pub(super) const MCP_FILE: &str = ".mcp.json";

/// A configuration file's JSON, comments allowed, or None where it is missing or cannot be read.
pub(super) fn read_config(file: &Path) -> Option<Value> {
    parse_jsonc(&std::fs::read_to_string(file).ok()?).ok()
}

/// The home folder of `environment`.
pub(super) fn home(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    environment.get("HOME").map(PathBuf::from)
}

/// The folder `name` in `environment` names, where it is set and not empty.
pub(super) fn folder_named(environment: &BTreeMap<String, String>, name: &str) -> Option<PathBuf> {
    environment
        .get(name)
        .filter(|folder| !folder.is_empty())
        .map(PathBuf::from)
}

/// The user configuration folder of `environment`: an absolute `XDG_CONFIG_HOME`, or `.config` in
/// the home folder.
pub(super) fn config_home(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    let xdg = environment.get("XDG_CONFIG_HOME").map(PathBuf::from);
    xdg.filter(|folder| folder.is_absolute())
        .or_else(|| Some(home(environment)?.join(".config")))
}

/// Muse Code's settings file.
pub(super) fn muse_settings_file(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    Some(config_home(environment)?.join("muse").join("settings.json"))
}

/// Antigravity's settings file.
pub(super) fn agy_settings_file(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    Some(
        home(environment)?
            .join(".gemini")
            .join("antigravity-cli")
            .join("settings.json"),
    )
}

/// The files named `names` a CLI started in `cwd` reads as its project's, nearest first: in each
/// folder from `cwd` up to the top of its repository, the folder that holds `.git`, and outside a
/// repository in `cwd` alone.
pub(super) fn project_files(cwd: &Path, names: &[&str]) -> Vec<PathBuf> {
    let top = cwd
        .ancestors()
        .position(|folder| folder.join(".git").exists());
    cwd.ancestors()
        .take(top.map_or(1, |top| top + 1))
        .flat_map(|folder| names.iter().map(move |name| folder.join(name)))
        .collect()
}
