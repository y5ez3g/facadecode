//! Lines another build wrote, which this build may not understand: a hook line naming an event or
//! an argument it does not know never fails its CLI, and facade-mcp serves a line with words it
//! does not know.

use std::io::Write;
use std::process::{Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Runs `facade <words>` as a CLI runs a hook line, with a session-start event on standard input.
fn hook_line(home: &TestHome, words: &[&str]) -> Output {
    let mut command = home.command(&test_binaries().facade);
    let mut child = command
        .args(words)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let event =
        r#"{"hook_event_name":"SessionStart","session_id":"86da4482-2bae-4a45-b193-a5664c19826a"}"#;
    let _ = child.stdin.take().unwrap().write_all(event.as_bytes());
    child.wait_with_output().unwrap()
}

/// A hook line with an event or an argument this build does not know does nothing: it prints
/// nothing and exits 0, as a hook does whatever happens, and says why on standard error, where its
/// CLI keeps a hook's errors. Other commands still refuse what they do not know.
#[test]
fn a_hook_line_this_build_cannot_use_does_nothing_and_exits_0() {
    let home = TestHome::new("hooklines");
    let file = home.project.join("session");
    let file = file.to_str().unwrap();
    for words in [
        ["hook", "later-event", file].as_slice(),
        &["hook", "session-start", file, "--later"],
    ] {
        let output = hook_line(&home, words);
        assert!(
            output.status.success() && output.stdout.is_empty(),
            "{words:?}: {output:?}"
        );
        let why = format!(
            "did nothing for `{}`, which this build cannot use",
            words.join(" ")
        );
        assert!(
            stderr(&output).contains(&why),
            "{words:?}: {}",
            stderr(&output)
        );
    }
    assert!(
        !std::path::Path::new(file).exists(),
        "a line this build cannot use wrote the session"
    );
    assert!(!home.daemon_socket().exists(), "a hook line started Facade");
    let typo = home.run_facade(&["lsit"]);
    assert_eq!(typo.status.code(), Some(2), "{typo:?}");
}

/// Every hook line of the six CLIs, a run's and a guest's, with an argument this build does not
/// know, and each CLI's guest line with an event it does not know, does nothing and exits 0.
/// Antigravity, which reads every hook's answer as a JSON object, gets an empty one.
#[test]
fn every_cli_s_hook_lines_do_nothing_where_this_build_does_not_know_them() {
    let home = TestHome::new("clilines");
    let file = home.project.join("session");
    let file = file.to_str().unwrap();
    let mut lines: Vec<Vec<&str>> = vec![
        vec!["hook", "session-start", file, "--later"],
        vec!["hook", "title", file, "--later"],
        vec!["hook", "instructions", "muse", "--later"],
        vec!["hook", "instructions", "agy", "--later"],
        vec!["hook", "approve", "muse", "--later"],
    ];
    for cli in ["claude", "codex", "opencode", "pi", "muse", "agy"] {
        for event in ["session-start", "prompt", "turn-end", "idle", "session-end"] {
            lines.push(vec!["hook", event, "--cli", cli, "--later"]);
        }
        lines.push(vec!["hook", "later-event", "--cli", cli]);
    }
    for words in &lines {
        let output = hook_line(&home, words);
        let answer = if words.contains(&"agy") { "{}\n" } else { "" };
        assert!(
            output.status.success() && output.stdout == answer.as_bytes(),
            "{words:?}: {output:?}"
        );
        assert!(
            stderr(&output).contains("which this build cannot use"),
            "{words:?}: {}",
            stderr(&output)
        );
    }
    assert!(
        !std::path::Path::new(file).exists(),
        "a line this build cannot use wrote the session"
    );
    assert!(!home.daemon_socket().exists(), "a hook line started Facade");
}

/// Runs `facade-mcp <words>` with `env` as a CLI runs its server, asks for its tools, and returns
/// its answers once its input ends, with how it ended.
fn server_line(home: &TestHome, words: &[&str], env: &[(&str, &str)]) -> (Vec<Value>, Output) {
    let mut command = home.command(&test_binaries().mcp);
    command
        .args(words)
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let lines = [
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "test", "version": "1" },
            },
        }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    ];
    let input: String = lines.iter().map(|line| format!("{line}\n")).collect();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let answers = stdout(&output)
        .lines()
        .map(|line| facade_scenarios::serde_json::from_str(line).unwrap())
        .collect();
    (answers, output)
}

/// facade-mcp passes on the words of its line this build does not know, and the daemon serves as
/// the rest says: a run's server its agent's tools, a guest's server its CLI's sessions.
#[test]
fn facade_mcp_serves_a_line_with_words_this_build_does_not_know() {
    let home = TestHome::new("serverlines");
    let agent = home.start_fake("w1");
    for (words, env) in [
        (vec!["--later"], vec![("FACADE_AGENT", agent.id.as_str())]),
        (vec!["--guest", "claude", "--later"], vec![]),
    ] {
        let (answers, output) = server_line(&home, &words, &env);
        let tools = answers
            .iter()
            .find(|answer| answer["id"] == 2)
            .and_then(|answer| answer["result"]["tools"].as_array().cloned())
            .unwrap_or_default();
        assert!(
            output.status.success() && !tools.is_empty(),
            "{words:?}: {answers:?} {output:?}"
        );
    }
}
