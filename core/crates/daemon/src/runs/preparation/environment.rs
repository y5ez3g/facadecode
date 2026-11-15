//! Environment inherited by a new run, with Facade's terminal and identity substituted. The run
//! keeps the name of the terminal it was started from (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`),
//! as a CLI draws for the terminal it is shown in.

use std::collections::BTreeMap;
use std::path::Path;

const FACADE_VARIABLES: &[&str] = &[
    "FACADE_AGENT",
    "FACADE_CODE_SESSION_FILE",
    "FACADE_CODE_TITLE_COMMAND",
    "FACADE_RUN",
    "FACADE_RUN_TOKEN",
    "FACADE_PTYD",
    "FACADE_LAUNCH_CONTEXT",
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
    inherited.retain(|name, _| keep(name));
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
