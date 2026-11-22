//! Lines another build wrote, which this build may not understand: a hook line naming an event or
//! an argument it does not know never fails its CLI, and facade-mcp serves a line with words it
//! does not know.

use std::io::Write;
use std::process::{Command, Output, Stdio};

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
    for (words, reason) in [
        (
            ["hook", "later-event", file].as_slice(),
            "InvalidSubcommand",
        ),
        (
            &["hook", "session-start", file, "--later"],
            "UnknownArgument",
        ),
    ] {
        let output = hook_line(&home, words);
        assert!(
            output.status.success() && output.stdout.is_empty(),
            "{words:?}: {output:?}"
        );
        let why = format!("ignored a hook this build cannot use: {reason}");
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
    assert!(
        !socket_exists(&home.daemon_socket()) && !socket_exists(&home.keeper_socket()),
        "a hook line started Facade"
    );
    let typo = home.run_facade(&["lsit"]);
    assert_eq!(typo.status.code(), Some(2), "{typo:?}");
}

/// An unrecognized argument leaves the managed hooks idle. The Antigravity instructions hook
/// still returns the empty JSON object its caller needs.
#[test]
fn every_cli_s_hook_lines_do_nothing_where_this_build_does_not_know_them() {
    let home = TestHome::new("clilines");
    let file = home.project.join("session");
    let file = file.to_str().unwrap();
    let lines = [
        (["hook", "session-start", file, "--later"], ""),
        (["hook", "title", file, "--later"], ""),
        (["hook", "instructions", "muse", "--later"], ""),
        (["hook", "instructions", "agy", "--later"], "{}\n"),
        (["hook", "approve", "muse", "--later"], ""),
    ];
    for (words, answer) in lines {
        let output = hook_line(&home, &words);
        assert!(
            output.status.success() && output.stdout == answer.as_bytes(),
            "{words:?}: {output:?}"
        );
        assert!(
            stderr(&output).contains("ignored a hook this build cannot use: UnknownArgument"),
            "{words:?}: {}",
            stderr(&output)
        );
    }
    assert!(
        !std::path::Path::new(file).exists(),
        "a line this build cannot use wrote the session"
    );
    assert!(
        !socket_exists(&home.daemon_socket()) && !socket_exists(&home.keeper_socket()),
        "a hook line started Facade"
    );
}

/// Runs a relay with an additional word, asks for its tools, and returns its answers and exit.
fn server_line(mut command: Command) -> (Vec<Value>, Output) {
    command
        .arg("--later")
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
/// the rest says: a run's server with its credential, and a Guest's server without one.
#[test]
fn facade_mcp_serves_a_line_with_words_this_build_does_not_know() {
    let home = TestHome::new("serverlines");
    let agent = home.start_fake("w1");
    let run = facade_rules::run_folder(&home.path.join("core/runs"), &agent.id).unwrap();
    let config: Value =
        facade_scenarios::serde_json::from_slice(&std::fs::read(run.join("mcp.json")).unwrap())
            .unwrap();
    let managed = mcp_command(&config, &home.path, |program| home.command(program)).unwrap();
    for (kind, command) in [
        ("managed", managed),
        ("guest", home.command(&test_binaries().mcp)),
    ] {
        let (answers, output) = server_line(command);
        assert!(output.status.success(), "{kind}: {output:?}");
        assert_eq!(
            answers.len(),
            2,
            "{kind}: initialized sends no reply: {answers:?}"
        );
        let initialized = answers
            .iter()
            .find(|answer| answer["id"] == 1)
            .unwrap_or_else(|| panic!("{kind}: missing initialize reply: {answers:?}"));
        assert_eq!(initialized["jsonrpc"], "2.0", "{initialized}");
        assert_eq!(
            initialized["result"]["protocolVersion"], "2025-06-18",
            "{initialized}"
        );
        let listed = answers
            .iter()
            .find(|answer| answer["id"] == 2)
            .unwrap_or_else(|| panic!("{kind}: missing tools/list reply: {answers:?}"));
        assert_eq!(listed["jsonrpc"], "2.0", "{listed}");
        assert!(
            listed["result"]["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty()),
            "{kind}: {listed}"
        );
    }
}
