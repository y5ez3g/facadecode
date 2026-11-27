//! Environment inherited by a new run, with Facade Code Framework's terminal and identity substituted. The run
//! keeps the name of the terminal it was started from (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`),
//! as a CLI draws for the terminal it is shown in.

use std::collections::BTreeMap;
use std::path::Path;

use facade_base::system::{SYSTEM, System, env_var};
use serde::{Deserialize, Serialize};

/// Travels with a run's environment so a Shell command inside the run can restore its inputs.
const LAUNCH_ENV: &str = "FACADE_LAUNCH_ENV";

#[derive(Serialize, Deserialize)]
struct LaunchValue {
    generated: String,
    previous: Option<String>,
}

const FACADE_VARIABLES: &[&str] = &[
    "FACADE_AGENT",
    "FACADE_CODE_SESSION_FILE",
    "FACADE_CODE_TITLE_COMMAND",
    "FACADE_RUN",
    "FACADE_RUN_TOKEN",
    "FACADE_PTYD",
    facade_base::start::LAUNCH_CONTEXT,
    "FACADE_ELECTRON_RUN_AS_NODE",
    "ELECTRON_RUN_AS_NODE",
    "TERM",
    "COLORTERM",
    "PWD",
    "STY",
    "TERMINAL_EMULATOR",
    "WT_SESSION",
    "TERM_SESSION_ID",
    "__CFBundleIdentifier",
];

fn keep(name: &str) -> bool {
    match name {
        "VSCODE_IPC_HOOK_CLI"
        | "VSCODE_PORTABLE"
        | "VSCODE_SHELL_LOGIN"
        | "VSCODE_ENV_REPLACE"
        | "VSCODE_ENV_APPEND"
        | "VSCODE_ENV_PREPEND" => true,
        "SNAP" => false,
        _ => {
            !FACADE_VARIABLES.contains(&name)
                && !facade_rules::is_session_variable(name)
                && ![
                    "ELECTRON_",
                    "VSCODE_",
                    "SNAP_",
                    "GDK_PIXBUF_",
                    "ITERM_",
                    "LC_TERMINAL",
                    "KITTY_",
                    "GHOSTTY_",
                    "WEZTERM_",
                    "ALACRITTY_",
                    "TMUX",
                ]
                .iter()
                .any(|prefix| name.starts_with(prefix))
        }
    }
}

pub(super) fn build(
    mut inherited: BTreeMap<String, String>,
    cwd: &str,
    home: &Path,
    id: &str,
) -> BTreeMap<String, String> {
    facade_rules::restore_config_environment(&mut inherited);
    inherited.retain(|name, _| keep(name));
    remove(&mut inherited, LAUNCH_ENV);
    for (name, value) in [
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("PWD", cwd),
        ("FACADE_HOME", &home.to_string_lossy()),
        ("FACADE_AGENT", id),
    ] {
        inherited.insert(name.to_owned(), value.to_owned());
    }
    inherited
}

/// Installs generated variables and records the launch settings this run actually changed.
pub(super) fn apply(
    env: &mut BTreeMap<String, String>,
    added: Vec<(String, String)>,
    launch_env: BTreeMap<String, String>,
) {
    for (name, value) in added {
        set(env, name, value);
    }
    let mut changed = BTreeMap::new();
    for (name, generated) in launch_env {
        let previous = env_var(env, &name);
        if previous != Some(&generated) {
            let value = LaunchValue {
                generated: generated.clone(),
                previous: previous.map(str::to_owned),
            };
            set(env, name.clone(), generated);
            changed.insert(name, value);
        }
    }
    if !changed.is_empty() {
        let changes = serde_json::to_string(&changed).expect("launch environment values are JSON");
        env.insert(LAUNCH_ENV.to_owned(), changes);
    }
}

/// Restores inputs before the destination applies its entry. A later change from the invoking
/// shell, including unsetting a variable, takes precedence over the recorded value.
pub(crate) fn restore_launch_environment(env: &mut BTreeMap<String, String>) {
    let changed = env_var(env, LAUNCH_ENV)
        .and_then(|text| serde_json::from_str::<BTreeMap<String, LaunchValue>>(text).ok());
    remove(env, LAUNCH_ENV);
    for (name, value) in changed.into_iter().flatten() {
        if env_var(env, &name) == Some(&value.generated)
            && facade_rules::is_launch_env_value(&name, &value.generated)
        {
            remove(env, &name);
            if let Some(previous) = value.previous {
                env.insert(name, previous);
            }
        }
    }
}

fn set(env: &mut BTreeMap<String, String>, name: String, value: String) {
    remove(env, &name);
    env.insert(name, value);
}

fn remove(env: &mut BTreeMap<String, String>, name: &str) {
    if SYSTEM == System::Windows {
        env.retain(|key, _| !key.eq_ignore_ascii_case(name));
    } else {
        env.remove(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_environment_removes_session_state_and_preserves_user_settings() {
        let inherited: BTreeMap<String, String> = [
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/me"),
            ("ANTHROPIC_API_KEY", "k"),
            ("HTTPS_PROXY", "http://proxy"),
            ("CLAUDE_CONFIG_DIR", "/Users/me/.claude-work"),
            ("VSCODE_IPC_HOOK_CLI", "/tmp/cli.sock"),
            ("TERM_PROGRAM", "iTerm.app"),
            ("ITERM_SESSION_ID", "w0t0p0"),
            ("TMUX", "/tmp/tmux-1/default,1,0"),
            ("CLAUDECODE", "1"),
            ("CODEX_SANDBOX", "seatbelt"),
            ("VSCODE_PID", "1"),
            ("PWD", "/elsewhere"),
            ("TERM", "screen"),
            ("FACADE_AGENT", "#a1685"),
            ("FACADE_HOME", "/elsewhere/.facade"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        let env = build(inherited, "/work", Path::new("/Users/me/.facade"), "a3");
        let names: Vec<&str> = env.keys().map(String::as_str).collect();
        assert_eq!(
            names,
            [
                "ANTHROPIC_API_KEY",
                "CLAUDE_CONFIG_DIR",
                "COLORTERM",
                "FACADE_AGENT",
                "FACADE_HOME",
                "HOME",
                "HTTPS_PROXY",
                "PATH",
                "PWD",
                "TERM",
                "TERM_PROGRAM",
                "VSCODE_IPC_HOOK_CLI"
            ]
        );
        assert_eq!(
            (env["TERM"].as_str(), env["PWD"].as_str()),
            ("xterm-256color", "/work")
        );
        assert_eq!(
            (env["FACADE_HOME"].as_str(), env["FACADE_AGENT"].as_str()),
            ("/Users/me/.facade", "a3")
        );
    }
}
