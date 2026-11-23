//! A `facade-mcp` line the person configured in a CLI themselves: a run Facade starts beside it
//! keeps Facade's tools and skill. Each test's CLI settings folders and home are the test's own, so
//! nothing of this computer's own configuration is read or written.

use std::path::PathBuf;
use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Writes `text` to the file `name` of the test's home folder, a path with `/` between its parts.
fn write(test: &TestHome, name: &str, text: &str) {
    let file = name
        .split('/')
        .fold(test.user_home(), |path, part| path.join(part));
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

/// Configures, as the person would, a `facade` server that runs `facade-mcp` in `cli`'s own
/// settings, where `cli` reads them in the test's home: the line a person adds to connect a CLI of
/// their own to Facade.
fn own_facade_line(test: &TestHome, cli: &str) {
    let server = json!({ "mcpServers": { "facade": { "command": "facade-mcp", "args": [] } } });
    match cli {
        "claude" => write(test, ".claude/.claude.json", &server.to_string()),
        "codex" => write(
            test,
            ".codex/config.toml",
            "[mcp_servers.facade]\ncommand = \"facade-mcp\"\n",
        ),
        "opencode" => write(
            test,
            ".config/opencode/opencode.json",
            &json!({ "mcp": { "facade": { "type": "local", "command": ["facade-mcp"] } } })
                .to_string(),
        ),
        "pi" => write(test, ".pi/agent/mcp.json", &server.to_string()),
        "muse" => write(test, ".config/muse/settings.json", &server.to_string()),
        "agy" => write(
            test,
            ".gemini/antigravity-cli/settings.json",
            &server.to_string(),
        ),
        other => panic!("say where {other} reads its MCP servers"),
    }
}

/// A run Facade starts beside a `facade-mcp` line the person configured themselves keeps Facade's
/// tools, the instructions they bring, and Facade's skill, on each of the six built-in CLIs: the
/// person's own line does not get in its way. Each run is the test CLI under its CLI's name.
#[test]
fn a_run_beside_the_person_s_own_facade_line_keeps_facade_s_tools_and_skill() {
    for cli in ["claude", "codex", "opencode", "pi", "muse", "agy"] {
        let test = TestHome::new(&format!("beside-{cli}"));
        own_facade_line(&test, cli);
        let programs = test.path.parent().unwrap().join("programs");
        std::fs::create_dir_all(&programs).unwrap();
        install_program(&programs, cli, &test_binaries().fakecli);
        let started = test
            .command(&test_binaries().facade)
            .env(
                "PATH",
                format!(
                    "{}{PATH_SEPARATOR}{}",
                    programs.display(),
                    test.path_with_test_programs()
                ),
            )
            .args(["start", "-d", "--name", "beside", cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{cli}: {}", stderr(&started));
        let id = started_id(&stdout(&started));
        let run = test.agent_record(&id).expect("the run is listed");
        let given = matches!(
            run["tools_state"].as_str(),
            Some("connecting" | "available" | "unavailable")
        ) && run["tools_reason"] != "not_given";
        assert!(
            given,
            "{cli}'s run was not given the tools: {run}\n{}",
            test.daemon_log()
        );
        assert!(
            has_the_skill(&test, cli, &run),
            "{cli}'s run was not given Facade's skill: {run}"
        );
    }
}

/// Whether `cli`'s run has Facade's skill where its CLI takes it: Claude Code in the plugin
/// `--plugin-dir` loads, Codex in a run file its session-start hook gives with `--skill`,
/// Muse Code in a file of the run's its instructions hook gives, OpenCode and Pi in a file of the
/// run's, and Antigravity in the plugin in its project.
fn has_the_skill(test: &TestHome, cli: &str, run: &Value) -> bool {
    let runs = test
        .path
        .join("core/runs")
        .join(run["reference"]["agent_id"].as_str().unwrap());
    let folder: PathBuf = std::fs::read_dir(&runs)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir())
        .expect("the run's folder");
    let skill = |file: PathBuf| {
        std::fs::read_to_string(file).is_ok_and(|text| text == facade_base::skill::text())
    };
    let command = command_line_of(run["pid"].as_i64().unwrap() as i32);
    // On Windows with the scripts of its encoded PowerShell hooks, each word quoted `'…'`.
    #[cfg(windows)]
    let command = {
        let scripts: Vec<String> = command
            .match_indices("powershell.exe ")
            .filter_map(|(at, _)| powershell_script(&command[at..]))
            .collect();
        format!("{command} {}", scripts.join(" ")).replace('\'', "")
    };
    match cli {
        "claude" => {
            command.contains("--plugin-dir") && skill(folder.join("plugin/skills/facade/SKILL.md"))
        }
        "codex" => command.contains("--skill") && skill(folder.join("skills/facade/SKILL.md")),
        "muse" => {
            command.contains("hook instructions muse")
                && skill(folder.join("skills/facade/SKILL.md"))
        }
        "opencode" | "pi" => skill(folder.join("skills/facade/SKILL.md")),
        "agy" => skill(
            test.project
                .join(".agents/plugins/facade/skills/facade/SKILL.md"),
        ),
        other => panic!("say where {other}'s run takes Facade's skill"),
    }
}
