//! A run's hooks: `facade hook session-start <session-file>`, `title`, `instructions` and
//! `approve`, which Facade Code Framework gives the CLI of a run it starts. They record the run's own session in
//! its private folder and nothing else: they join no guest and take no message, and they never
//! start Facade Code Framework or fail the CLI.

use std::path::PathBuf;
use std::process::{Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// The session a run's hooks record in this file's tests.
const SESSION: &str = "86da4482-2bae-4a45-b193-a5664c19826a";

/// Runs `facade hook <args>` from this test, as a CLI's hook runs it, with `env` set and `input` on
/// standard input.
fn hook(home: &TestHome, args: &[&str], env: &[(&str, &str)], input: &str) -> Output {
    let mut command = home.command(&test_binaries().facade);
    command.arg("hook").args(args).envs(env.iter().copied());
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A hook may end before it reads its input, as one in a background job of Claude Code does: a
    // write it no longer takes is no failure.
    let _ = std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes());
    child.wait_with_output().unwrap()
}

/// A hook's input from a CLI: `event` for `session`, with `more`.
fn input(event: &str, session: &str, more: Value) -> String {
    let mut input = json!({ "hook_event_name": event, "session_id": session });
    input
        .as_object_mut()
        .unwrap()
        .extend(more.as_object().cloned().unwrap_or_default());
    input.to_string()
}

/// The session file of agent `id`'s run, which Facade Code Framework names in its CLI's session-start hook.
fn session_file(home: &TestHome, id: &str) -> PathBuf {
    facade_rules::run_folder(&home.path.join("framework/runs"), id)
        .expect("the agent has one run")
        .join(facade_rules::SESSION_FILE)
}

/// The session the daemon has recorded for this agent.
fn inspected_session(home: &TestHome, name: &str) -> Value {
    home.inspect_agent(name)["agent"]["session"].clone()
}

/// In a run Facade Code Framework started, the run's hooks record its own session and do nothing else: they join
/// no guest and take nothing, and its typist delivers its messages.
#[test]
fn a_run_s_hooks_record_its_session_and_join_no_guest() {
    let home = TestHome::new("ownrun");
    let ada = home.start_fake("ada");
    let file = session_file(&home, &ada.id);
    let file = file.to_str().unwrap();
    let own = [("FACADE_AGENT", ada.id.as_str())];
    let started = hook(
        &home,
        &["session-start", file],
        &own,
        &input("SessionStart", SESSION, json!({})),
    );
    assert!(
        started.status.success() && started.stdout.is_empty(),
        "{started:?}"
    );
    assert!(
        wait_until(secs(10), || inspected_session(&home, "ada") == SESSION),
        "the run's session: {}",
        inspected_session(&home, "ada")
    );
    for (args, input) in [
        (&["title", file][..], "{}".to_string()),
        (
            &["instructions", "muse"][..],
            input("UserPromptSubmit", SESSION, json!({})),
        ),
        (
            &["approve", "muse"][..],
            input("PreToolUse", SESSION, json!({})),
        ),
    ] {
        let output = hook(&home, args, &own, &input);
        assert!(output.status.success(), "{args:?}: {output:?}");
    }
    assert_eq!(
        home.agents().len(),
        1,
        "a run's hooks joined a guest: {:?}",
        home.agents()
    );
    let sent = home.run_facade(&["send", "ada", "for the typist"]);
    assert!(sent.status.success(), "{}", stderr(&sent));
    assert!(
        wait_until(secs(10), || home
            .submitted_messages()
            .iter()
            .any(|text| text.ends_with("\nfor the typist"))),
        "the hooks took nothing: {:?}",
        home.submitted_messages()
    );
}

/// Qoder's prompt hook records the run's own session from a prompt's input, which names the
/// session and its transcript.
#[test]
fn the_prompt_hook_records_the_session_a_prompt_names() {
    let home = TestHome::new("prompthook");
    let bea = home.start_fake("bea");
    let file = session_file(&home, &bea.id);
    let file = file.to_str().unwrap();
    let own = [("FACADE_AGENT", bea.id.as_str())];
    let transcript = home.path.join("qoder").join(format!("{SESSION}.jsonl"));
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    std::fs::write(&transcript, "").unwrap();
    let prompted = hook(
        &home,
        &["session-prompt", file, "qoder"],
        &own,
        &input(
            "UserPromptSubmit",
            SESSION,
            json!({ "transcript_path": transcript.to_str().unwrap() }),
        ),
    );
    assert!(
        prompted.status.success() && prompted.stdout.is_empty(),
        "{prompted:?}"
    );
    assert!(
        wait_until(secs(10), || inspected_session(&home, "bea") == SESSION),
        "the run's session: {}",
        inspected_session(&home, "bea")
    );
}

/// A hook exits 0 whatever its variables and words: one with a variable that is not UTF-8 records
/// the run's session, and a line with a word that is not UTF-8 does nothing.
#[cfg(unix)]
#[test]
fn a_hook_with_a_variable_or_a_word_that_is_not_utf8_exits_0() {
    use std::os::unix::ffi::OsStrExt;
    let home = TestHome::new("notutf8hook");
    let ada = home.start_fake("ada");
    let file = session_file(&home, &ada.id);
    let not_utf8 = std::ffi::OsStr::from_bytes(b"caf\xe9");
    let run = |words: &[&std::ffi::OsStr], input: &str| {
        let mut command = home.command(&test_binaries().facade);
        command
            .arg("hook")
            .args(words)
            .env("FACADE_AGENT", &ada.id)
            .env("NOT_UTF8", not_utf8);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes());
        child.wait_with_output().unwrap()
    };
    let start = [std::ffi::OsStr::new("session-start"), file.as_os_str()];
    let recorded = run(&start, &input("SessionStart", SESSION, json!({})));
    assert!(recorded.status.success(), "{recorded:?}");
    assert!(
        wait_until(secs(10), || inspected_session(&home, "ada") == SESSION),
        "the run's session: {}",
        inspected_session(&home, "ada")
    );
    let other = "0c5d1f6e-8a51-4f8e-9a3b-6f0e2d7c4b19";
    let unknown = run(
        &[start[0], start[1], not_utf8],
        &input("SessionStart", other, json!({})),
    );
    assert!(
        unknown.status.success() && unknown.stdout.is_empty(),
        "{unknown:?}"
    );
    std::thread::sleep(secs(2));
    assert_eq!(
        inspected_session(&home, "ada"),
        SESSION,
        "a line this build cannot read did something"
    );
}

/// A hook never starts Facade Code Framework and never fails its CLI's turn, whatever its input; in a background
/// job of Claude Code it does nothing.
#[test]
fn hooks_never_start_facade_and_always_exit_0() {
    let home = TestHome::new("idlehooks");
    let elsewhere = home.path.join("framework/runs/a1/run/session");
    let elsewhere = elsewhere.to_str().unwrap();
    for (args, input) in [
        (&["session-start", elsewhere][..], "not JSON".to_string()),
        (
            &["session-start", elsewhere][..],
            input("SessionStart", SESSION, json!({})),
        ),
        (&["title", elsewhere][..], String::new()),
        (&["approve", "muse"][..], "not JSON".to_string()),
    ] {
        let output = hook(&home, args, &[], &input);
        assert!(
            output.status.success() && output.stdout.is_empty() && output.stderr.is_empty(),
            "{args:?}: {output:?}"
        );
    }
    assert!(
        !socket_exists(&home.daemon_socket()),
        "a hook started Facade Code Framework"
    );
    let ada = home.start_fake("ada");
    let file = session_file(&home, &ada.id);
    let job = hook(
        &home,
        &["session-start", file.to_str().unwrap()],
        &[
            ("FACADE_AGENT", ada.id.as_str()),
            ("CLAUDE_JOB_DIR", "/tmp/job"),
        ],
        &input("SessionStart", SESSION, json!({})),
    );
    assert!(job.status.success() && job.stdout.is_empty(), "{job:?}");
    std::thread::sleep(secs(2));
    assert_ne!(
        inspected_session(&home, "ada"),
        SESSION,
        "a background job's session was recorded"
    );
}
