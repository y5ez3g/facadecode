//! The wrappers some CLIs' installers put on `PATH` on Windows, a `.cmd` file that runs the CLI's
//! own program, and what to start in their place, so that the CLI's arguments reach it as they
//! are, never through cmd.exe. npm's shims are base's to read; Pi's and Muse Code's own wrappers
//! are read here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use facade_base::programs;
use facade_base::system::{SYSTEM, System, env_var};
use regex::Regex;

use crate::Rule;

/// The program and arguments that start `program`, the file a start's command resolved to, for
/// `rule`'s CLI where the start has a rule. On Windows, Pi's `pi.cmd` as Pi's installer writes it
/// starts its `pi-launcher.js` with the Node it chooses, and Muse Code's installer's wrapper starts
/// its active native program. Everything else is as base's [`programs::direct_command`] has it:
/// npm's shims start what they run, and any other file is started as it is. A file that cannot be
/// read, or that is not exactly what the installer writes, is taken for what it is. `env` and
/// `cwd` are the start's environment and folder.
pub fn direct_command(
    rule: Option<&Rule>,
    program: &Path,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Vec<String> {
    let own = match rule.map(|rule| rule.cli.as_str()) {
        _ if SYSTEM != System::Windows || !is_cmd_file(program) => None,
        Some("pi") => pi_command(program, env, cwd),
        Some("muse") => muse_command(program, env),
        _ => None,
    };
    own.unwrap_or_else(|| programs::direct_command(program, env, cwd))
}

/// Whether `file` is a `.cmd` file, by its name.
fn is_cmd_file(file: &Path) -> bool {
    file.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
}

/// The path as a command's word.
fn word(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `line` as a pattern that matches it alone.
fn literal(line: &str) -> String {
    regex::escape(line)
}

/// The line of Pi's installer that chooses its own Node, where it installed one, while that is
/// there.
const PI_OWN_NODE: &str = r#"IF EXIST "%LOCALAPPDATA%\pi-node\current\node.exe" SET "node=%LOCALAPPDATA%\pi-node\current\node.exe""#;

/// The `pi.cmd` Pi's own installer writes (pi.dev, for Pi 1.4.0), whole, its line endings aside:
/// `node` chosen, then its own Node where it installed one; its `pi-launcher.js` beside it run
/// with every argument; and, where no Node is found, a message whose words may change. Nothing
/// else: a line of any other kind may make the wrapper run another program, Node or environment.
static PI_WRAPPER: LazyLock<Regex> = LazyLock::new(|| {
    let mut lines = vec![
        "^@ECHO off".to_string(),
        "SETLOCAL".into(),
        r#"SET "node=node""#.into(),
        format!(
            r#"(?<own>{}\n)?"%node%" "%~dp0pi-launcher\.js" %\*"#,
            literal(PI_OWN_NODE)
        ),
    ];
    lines.extend(
        [
            r#"SET "pi_exit_code=%ERRORLEVEL%""#,
            r#"IF "%pi_exit_code%"=="9009" ("#,
            r#"  IF "%node%"=="node" ("#,
            r#"    "%SystemRoot%\System32\where.exe" /Q node"#,
            "    IF ERRORLEVEL 1 GOTO node_missing",
            r#"  ) ELSE IF NOT EXIST "%node%" GOTO node_missing"#,
            ")",
            "EXIT /B %pi_exit_code%",
            ":node_missing",
        ]
        .map(literal),
    );
    lines.push(r"ECHO [^\n&|<>]* 1>&2".into());
    lines.push(r"EXIT /B %pi_exit_code%\n?$".into());
    Regex::new(&lines.join(r"\n")).expect("Pi's wrapper pattern is valid")
});

/// Pi's `pi.cmd`, as Pi's installer writes it: `[<node>, <its folder>\pi-launcher.js]`, with the
/// installer's own Node in `LOCALAPPDATA` where the wrapper names it and it is there, else a Node
/// program on the start's `PATH`. None for any other file, or where there is no such Node.
fn pi_command(file: &Path, env: &BTreeMap<String, String>, cwd: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(file).ok()?.replace("\r\n", "\n");
    let wrapper = PI_WRAPPER.captures(&text)?;
    let launcher = file.parent()?.join("pi-launcher.js");
    if !launcher.is_file() {
        return None;
    }
    let own = env_var(env, "LOCALAPPDATA")
        .filter(|_| wrapper.name("own").is_some())
        .map(|local| Path::new(local).join(r"pi-node\current\node.exe"))
        .filter(|node| node.is_file());
    let node = own.or_else(|| node_on_path(env, cwd))?;
    Some(vec![word(&node), word(&launcher)])
}

/// `node` on the start's `PATH`, where it is a program of its own (`.exe` or `.com`), never a
/// version manager's `.cmd` or `.bat`.
fn node_on_path(env: &BTreeMap<String, String>, cwd: &Path) -> Option<PathBuf> {
    let node = programs::on_path("node", env_var(env, "PATH"), cwd)?;
    let extension = node.extension()?.to_string_lossy().to_ascii_lowercase();
    ["exe", "com"].contains(&extension.as_str()).then_some(node)
}

/// The line of Muse Code's installer's wrapper that runs its script with every argument.
static MUSE_WRAPPER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)-File\s+"%~dp0\.muse-launcher\.ps1"\s+%\*"#)
        .expect("Muse Code's wrapper pattern is valid")
});

/// A version of Muse Code as its installer names it in `.muse-version`.
static MUSE_VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$").expect("Muse Code's version pattern is valid")
});

/// Muse Code's installer's wrapper: the native program its script would run,
/// `muse-bin-<version>.exe` beside it, for the version `.muse-version` names, where the channel
/// the installer chose (`.muse-channel`, else `muse-stable`) is the one `MUSE_CHANNEL` asks for.
/// None for any other file.
fn muse_command(file: &Path, env: &BTreeMap<String, String>) -> Option<Vec<String>> {
    if !MUSE_WRAPPER.is_match(&std::fs::read_to_string(file).ok()?) {
        return None;
    }
    let folder = file.parent()?;
    let script = std::fs::read_to_string(folder.join(".muse-launcher.ps1")).ok()?;
    if !script.contains("function Get-ActiveBinary")
        || !script.contains(r#""muse-bin-$version.exe""#)
    {
        return None;
    }
    let version = std::fs::read_to_string(folder.join(".muse-version")).ok()?;
    let version = version.trim();
    if !MUSE_VERSION.is_match(version) {
        return None;
    }
    let chosen = std::fs::read_to_string(folder.join(".muse-channel"));
    let chosen = chosen.as_deref().map_or("muse-stable", str::trim);
    let asked = env_var(env, "MUSE_CHANNEL")
        .map(str::trim)
        .filter(|channel| !channel.is_empty())
        .unwrap_or("muse-stable");
    let program = folder.join(format!("muse-bin-{version}.exe"));
    (chosen == asked && program.is_file()).then(|| vec![word(&program)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_folder::TestFolder;

    /// Pi's `pi.cmd` as its installer writes it, with `setup` choosing its Node.
    fn pi_cmd(setup: &str) -> String {
        format!(
            "@ECHO off\r\nSETLOCAL\r\n{setup}\r\n\"%node%\" \"%~dp0pi-launcher.js\" %*\r\nSET \"pi_exit_code=%ERRORLEVEL%\"\r\nIF \"%pi_exit_code%\"==\"9009\" (\r\n  IF \"%node%\"==\"node\" (\r\n    \"%SystemRoot%\\System32\\where.exe\" /Q node\r\n    IF ERRORLEVEL 1 GOTO node_missing\r\n  ) ELSE IF NOT EXIST \"%node%\" GOTO node_missing\r\n)\r\nEXIT /B %pi_exit_code%\r\n:node_missing\r\nECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2\r\nEXIT /B %pi_exit_code%\r\n"
        )
    }

    const PATH_NODE: &str = "SET \"node=node\"";

    fn own_node() -> String {
        format!("{PATH_NODE}\r\n{PI_OWN_NODE}")
    }

    /// Pi's installer wrapper runs its pi-launcher.js with the Node it chooses: its own Node in
    /// LOCALAPPDATA while that is there, else node on PATH. Another shape or choice of Node is
    /// taken for what it is.
    #[test]
    fn pi_s_wrapper_runs_its_launcher_with_the_node_it_chooses() {
        let temp = TestFolder::new("rules-pi-wrapper");
        let (bin, local) = (temp.join("bin"), temp.join("local"));
        std::fs::create_dir_all(&bin).unwrap();
        let (wrapper, launcher) = (bin.join("pi.cmd"), bin.join("pi-launcher.js"));
        std::fs::write(&launcher, "").unwrap();
        let own = local.join(r"pi-node\current\node.exe");
        let env: BTreeMap<String, String> = [("LOCALAPPDATA".to_string(), word(&local))].into();
        let command = |text: &str| {
            std::fs::write(&wrapper, text).unwrap();
            pi_command(&wrapper, &env, &temp)
        };
        let with_own = Some(vec![word(&own), word(&launcher)]);
        std::fs::create_dir_all(own.parent().unwrap()).unwrap();
        std::fs::write(&own, "").unwrap();
        assert_eq!(command(&pi_cmd(&own_node())), with_own);
        // LF line endings, but for one CRLF, as one machine's installer wrote it
        let mixed = pi_cmd(&own_node())
            .replace("\r\n", "\n")
            .replace("SETLOCAL\n", "SETLOCAL\r\n");
        assert_eq!(command(&mixed), with_own);
        // Its message where it finds no Node may be worded otherwise, and its last line end
        let reworded = pi_cmd(&own_node())
            .replace(
                "Install Node.js 22.19.0 or newer",
                "Install Node.js 24 or newer",
            )
            .trim_end_matches("\r\n")
            .to_string();
        assert_eq!(command(&reworded), with_own);
        // Not the file Pi's installer writes, whole: each would run something else
        let own_text = pi_cmd(&own_node());
        let launched = "\"%node%\" \"%~dp0pi-launcher.js\" %*";
        for text in [
            pi_cmd("SET \"node=C:\\Other\\node.exe\""),
            pi_cmd(&format!("{PATH_NODE}\r\nSET \"node=C:\\Other\\node.exe\"")),
            pi_cmd(&format!("{PATH_NODE}\r\nSET node=C:\\Other\\node.exe")),
            pi_cmd(&format!("{PI_OWN_NODE}\r\n{PATH_NODE}")),
            own_text.replace(
                launched,
                &format!("IF EXIST \"%~dp0pi.exe\" \"%~dp0pi.exe\" %*\r\n{launched}"),
            ),
            own_text.replace(
                "SETLOCAL\r\n",
                "SETLOCAL\r\nSET \"PI_CODING_AGENT_DIR=C:\\elsewhere\"\r\n",
            ),
            own_text.replace("SETLOCAL\r\n", "SETLOCAL\r\nSET NODE_OPTIONS=--inspect\r\n"),
            own_text.replace("pi-launcher.js", "other.js"),
            own_text.replace("ECHO Pi could not find", "ECHO Pi could not find & calc &"),
        ] {
            assert_eq!(command(&text), None, "{text}");
        }
        // Without its launcher, nothing to run
        std::fs::remove_file(&launcher).unwrap();
        assert_eq!(command(&pi_cmd(&own_node())), None);
    }

    /// Where its own Node is not there, Pi's wrapper runs node from PATH: a Node program of its
    /// own, never a version manager's .cmd. Windows finds programs by PATHEXT.
    #[test]
    fn pi_s_wrapper_takes_node_from_path_without_its_own() {
        if SYSTEM != System::Windows {
            return;
        }
        let temp = TestFolder::new("rules-pi-path-node");
        let (bin, nodes) = (temp.join("bin"), temp.join("nodejs"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&nodes).unwrap();
        let (wrapper, launcher) = (bin.join("pi.cmd"), bin.join("pi-launcher.js"));
        std::fs::write(&launcher, "").unwrap();
        std::fs::write(&wrapper, pi_cmd(&own_node())).unwrap();
        let env: BTreeMap<String, String> = [
            ("Path".to_string(), word(&nodes)),
            ("PATHEXT".to_string(), ".EXE;.CMD".to_string()),
            ("LOCALAPPDATA".to_string(), word(&temp.join("local"))),
        ]
        .into();
        std::fs::write(nodes.join("node.exe"), "").unwrap();
        assert_eq!(
            direct_command(find("pi").unwrap(), &wrapper, &env, &temp),
            [word(&nodes.join("node.exe")), word(&launcher)]
        );
        std::fs::remove_file(nodes.join("node.exe")).unwrap();
        std::fs::write(nodes.join("node.cmd"), "").unwrap();
        assert_eq!(pi_command(&wrapper, &env, &temp), None);
    }

    /// Muse Code's installer's wrapper starts its selected native version, never another
    /// channel's or an arbitrary wrapper's.
    #[test]
    fn muse_code_s_wrapper_starts_its_selected_native_program() {
        let temp = TestFolder::new("rules-muse-wrapper");
        let (wrapper, program) = (
            temp.join("muse.cmd"),
            temp.join("muse-bin-1.4.14-R7309.1.exe"),
        );
        std::fs::write(&wrapper, "@echo off\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%~dp0.muse-launcher.ps1\" %*\r\nexit /b %ERRORLEVEL%\r\n").unwrap();
        std::fs::write(
            temp.join(".muse-launcher.ps1"),
            "function Get-ActiveBinary { $binary = Join-Path $Dir \"muse-bin-$version.exe\" }",
        )
        .unwrap();
        std::fs::write(temp.join(".muse-version"), "1.4.14-R7309.1\n").unwrap();
        std::fs::write(&program, "native").unwrap();
        let none = BTreeMap::new();
        assert_eq!(muse_command(&wrapper, &none), Some(vec![word(&program)]));
        let canary: BTreeMap<String, String> =
            [("MUSE_CHANNEL".to_string(), "muse-canary".to_string())].into();
        assert_eq!(muse_command(&wrapper, &canary), None);
        std::fs::write(&wrapper, "@echo off\r\nmy-own-launcher %*\r\n").unwrap();
        assert_eq!(muse_command(&wrapper, &none), None);
    }

    use crate::find;
}
