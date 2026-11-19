//! Sessions and resume: a CLI's session-start hook reports its session, the daemon records it, and
//! `facade resume` starts an ended agent's CLI again in the same terminal, continuing that session.

use std::io::Write;
use std::process::{Child, Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

const FIRST: &str = "86da4482-2bae-4a45-b193-a5664c19826a";
const SECOND: &str = "96da4482-2bae-4a45-b193-a5664c19826b";

/// Codex runs its SessionStart command through its session's PowerShell shell on Windows.
/// The command supplied by Facade must report the session at both start and resume.
#[cfg(windows)]
#[test]
fn a_codex_session_start_hook_runs_in_powershell_and_the_session_resumes() {
    let home = TestHome::new("codexpowershell");
    let programs = home.folder().join("programs");
    install_program(&programs, "codex", &test_binaries().fakecli);
    let path = format!("{}{PATH_SEPARATOR}{}", programs.display(), home.test_path());
    let started = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .env("FAKECLI_SESSION", FIRST)
        .args(["start", "--name", "codex", "codex"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let first = home.started_agent(&stdout(&started));
    assert!(
        records_session(&home, "codex", Some(FIRST)),
        "Codex's PowerShell SessionStart hook did not report its session: {}",
        home.daemon_log()
    );
    let first_session = session_file(&home, &first.id);
    home.run_facade_ok(&["stop", "codex"]);
    let resumed = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .args(["resume", "codex"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    let second = home.started_agent(&stdout(&resumed));
    assert_eq!(second.id, first.id);
    assert_ne!(second.pid, first.pid);
    let resumed_session = session_file(&home, &second.id);
    assert_ne!(
        resumed_session, first_session,
        "a resume has its own run folder"
    );
    assert!(
        wait_for_screen_text(&home, "codex", &format!("session {FIRST}")),
        "the resumed CLI selects the recorded session"
    );
    assert_eq!(
        std::fs::read_to_string(resumed_session).unwrap(),
        format!("{FIRST}\n")
    );
}

/// Starts a copy of the test CLI named `cli`, which runs the command Facade gives it to report its
/// session as that CLI does on Windows, and checks that the run's session is recorded.
#[cfg(windows)]
fn reports_session_through_cmd_quoted(cli: &str) {
    let home = TestHome::new(&format!("cmdquoted{cli}"));
    let programs = home.folder().join("programs");
    install_program(&programs, cli, &test_binaries().fakecli);
    let path = format!("{}{PATH_SEPARATOR}{}", programs.display(), home.test_path());
    let started = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .env("FAKECLI_SESSION", FIRST)
        .args(["start", "--name", cli, cli])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let agent = home.started_agent(&stdout(&started));
    assert!(
        records_session(&home, cli, Some(FIRST)),
        "{cli}'s command did not report its session: {}",
        home.daemon_log()
    );
    assert_eq!(
        std::fs::read_to_string(session_file(&home, &agent.id)).unwrap(),
        format!(
            "{FIRST}
"
        )
    );
}

/// Muse Code runs its hooks on Windows as one argument of `cmd.exe /C`, quoted the standard way:
/// Facade's session-start hook must still report the run's session.
#[cfg(windows)]
#[test]
fn muse_code_s_session_start_hook_reports_the_session_through_cmd_s_standard_quoting() {
    reports_session_through_cmd_quoted("muse");
}

/// Antigravity runs its title command on Windows as one argument of `cmd.exe /C`, quoted the
/// standard way: Facade's title command must still report the run's conversation.
#[cfg(windows)]
#[test]
fn antigravity_s_title_command_reports_the_session_through_cmd_s_standard_quoting() {
    reports_session_through_cmd_quoted("agy");
}

/// Runs `facade resume <agent>` without a terminal, with the test programs on `PATH` so the fake
/// CLI's rule finds its program.
fn resume(home: &TestHome, agent: &str) -> Output {
    home.command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(["resume", agent])
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

/// Starts `facade resume <agent>` as `resume` does, without waiting for it.
fn start_resume(home: &TestHome, agent: &str) -> Child {
    let mut command = home.command(&test_binaries().facade);
    command
        .env("PATH", home.path_with_test_programs())
        .args(["resume", agent])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.spawn().unwrap()
}

/// Waits until the agent's record shows `session`.
fn records_session(home: &TestHome, name: &str, session: Option<&str>) -> bool {
    wait_until(secs(10), || {
        home.agent_from_list_json(name)
            .is_some_and(|agent| agent.get("session").and_then(Value::as_str) == session)
    })
}

/// The session file of the agent's current run.
fn session_file(home: &TestHome, agent: &str) -> std::path::PathBuf {
    let runs: Vec<_> = std::fs::read_dir(home.path.join("core/runs").join(agent))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(runs.len(), 1, "one run folder per agent: {runs:?}");
    runs[0].join("session")
}

/// Runs `facade hook session-start` as a CLI's hook would, with `input` on standard input.
fn run_hook(home: &TestHome, file: &std::path::Path, input: &[u8], env: &[(&str, &str)]) -> Output {
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", "session-start"])
        .arg(file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn().unwrap();
    // The hook stops reading after 1 MiB and a byte, or after a second: the rest of a longer input
    // can meet a closed pipe.
    let _ = child.stdin.take().unwrap().write_all(input);
    child.wait_with_output().unwrap()
}

#[test]
fn a_session_the_cli_reports_is_recorded_and_follows_the_cli() {
    let home = TestHome::new("sessions");
    let agent = home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(
        records_session(&home, "worker", Some(FIRST)),
        "{:?}",
        home.agent_from_list_json("worker")
    );
    assert!(
        home.run_facade_ok(&["inspect", "worker", "--json"])
            .contains("\"session_tracking\": true")
    );
    let mut wire = connect(&home);
    type_raw(&mut wire, &agent.id, &format!("/session {SECOND}\r"));
    assert!(records_session(&home, "worker", Some(SECOND)));
    type_raw(&mut wire, &agent.id, "/session none\r");
    assert!(
        records_session(&home, "worker", None),
        "a CLI that selects no session clears it"
    );
    // The record keeps the session across the daemon's end.
    type_raw(&mut wire, &agent.id, &format!("/session {FIRST}\r"));
    assert!(records_session(&home, "worker", Some(FIRST)));
    let daemon = home.kill_daemon();
    home.wait_for_daemon_after(daemon, secs(30))
        .expect("a replacement daemon");
    assert!(records_session(&home, "worker", Some(FIRST)));
}

/// A session the CLI names the file of counts once the CLI saved it there, as after its first
/// message: a session it never saved cannot be resumed, and `facade resume` says so before anything
/// starts, the same for every CLI.
#[test]
fn a_session_counts_once_its_cli_saved_it() {
    let home = TestHome::new("savedsession");
    let transcripts = home.project.parent().unwrap().join("transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    let saved = transcripts.to_string_lossy().into_owned();
    home.start_named_fake(
        "unsaved",
        &[("FAKECLI_SESSION", FIRST), ("FAKECLI_TRANSCRIPTS", &saved)],
    );
    home.start_named_fake(
        "saved",
        &[("FAKECLI_SESSION", SECOND), ("FAKECLI_TRANSCRIPTS", &saved)],
    );
    assert!(wait_until(secs(10), || std::fs::read_to_string(
        session_file(&home, "a2")
    )
    .is_ok_and(|text| text.starts_with(SECOND))));
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(
        records_session(&home, "saved", None),
        "not saved yet: {:?}",
        home.agent_from_list_json("saved")
    );
    home.run_facade_ok(&["send", "saved", "hello"]);
    assert!(
        records_session(&home, "saved", Some(SECOND)),
        "saved with its first message"
    );
    home.run_facade_ok(&["stop", "unsaved"]);
    let refused = resume(&home, "unsaved");
    assert!(
        !refused.status.success()
            && stderr(&refused).contains(
                "#a1 has no session to resume yet: its CLI has not saved one, as when no turn has run",
            ),
        "{}",
        stderr(&refused)
    );
    home.run_facade_ok(&["stop", "saved"]);
    let resumed = resume(&home, "saved");
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert!(
        wait_until(secs(30), || home
            .screen("saved")
            .contains(&format!("session {SECOND}"))),
        "{}",
        home.screen("saved")
    );
}

/// Where a launch asks it, as Codex's does, the session hook prints the skill in the run's folder,
/// which the run's start wrote, as the context its session starts with, and still records the
/// session.
#[test]
fn the_session_hook_gives_the_skill_where_asked_and_records_the_session() {
    let home = TestHome::new("hookskill");
    home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let file = session_file(&home, "a1");
    // The skill beside the session file, as a Codex run's start writes it.
    let skill = file.parent().unwrap().join("skills/facade/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::write(&skill, "The skill of the build that started the run.").unwrap();
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", "session-start"])
        .arg(&file)
        .arg("--skill")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            format!(r#"{{"hook_event_name":"SessionStart","session_id":"{SECOND}"}}"#).as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success() && output.stderr.is_empty(),
        "{output:?}"
    );
    let given: Value = serde_json::from_slice(&output.stdout).unwrap();
    let context = "The skill of the build that started the run.";
    assert_eq!(
        given,
        json!({
            "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": context },
        })
    );
    assert!(
        records_session(&home, "worker", Some(SECOND)),
        "the session is still recorded"
    );
}

#[test]
fn a_session_reported_while_no_daemon_ran_is_recorded_before_clients_are_served() {
    let home = TestHome::new("downtime");
    home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let file = session_file(&home, "a1");
    let daemon_pid = home.hello_result().unwrap()["pid"].as_i64().unwrap() as i32;
    pause_process(daemon_pid);
    let reported = run_hook(
        &home,
        &file,
        format!(r#"{{"hook_event_name":"SessionStart","session_id":"{SECOND}"}}"#).as_bytes(),
        &[],
    );
    assert!(reported.status.success() && reported.stdout.is_empty() && reported.stderr.is_empty());
    kill_process(daemon_pid);
    home.wait_for_daemon_after(daemon_pid, secs(30))
        .expect("a replacement daemon");
    // The first list after recovery already shows the session.
    assert_eq!(
        home.agent_from_list_json("worker").unwrap()["session"],
        SECOND
    );
}

#[test]
fn hooks_report_in_order_even_when_the_first_is_slow() {
    let home = TestHome::new("hookorder");
    let agent = home.start_named_fake(
        "worker",
        &[
            ("FAKECLI_SESSION", FIRST),
            ("FAKECLI_FIRST_HOOK_DELAY_MS", "400"),
        ],
    );
    let mut wire = connect(&home);
    type_raw(&mut wire, &agent.id, &format!("/session {SECOND}\r"));
    assert!(wait_for_screen_text(
        &home,
        "worker",
        &format!("session {SECOND}")
    ));
    assert!(records_session(&home, "worker", Some(SECOND)));
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(
        home.agent_from_list_json("worker").unwrap()["session"],
        SECOND,
        "the slow first report never lands last"
    );
}

#[test]
fn the_hook_writes_only_a_session_start_with_a_session_and_never_holds_up_the_cli() {
    let home = TestHome::new("hookinput");
    home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    let file = session_file(&home, "a1");
    assert!(wait_until(secs(10), || std::fs::read_to_string(&file)
        .is_ok_and(|text| text == format!("{FIRST}\n"))));
    let start = |id: &str| {
        format!(r#"{{"hook_event_name":"SessionStart","session_id":"{id}"}}"#).into_bytes()
    };
    for (input, env) in [
        (start(SECOND), vec![("CLAUDE_JOB_DIR", "/tmp/job")]),
        (b"{not json".to_vec(), vec![]),
        (
            br#"{"hook_event_name":"Stop","session_id":"96da4482-2bae-4a45-b193-a5664c19826b"}"#
                .to_vec(),
            vec![],
        ),
        (
            br#"{"hook_event_name":"SessionStart","session_id":"not-a-uuid"}"#.to_vec(),
            vec![],
        ),
        ([start(SECOND), vec![b' '; 1024 * 1024]].concat(), vec![]),
    ] {
        let output = run_hook(&home, &file, &input, &env);
        assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!("{FIRST}\n"),
            "the file stays as it was"
        );
    }
    // Input that never ends: the hook gives up after a second.
    let mut child = home
        .command(&test_binaries().facade)
        .args(["hook", "session-start"])
        .arg(&file)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&start(SECOND)).unwrap();
    let began = std::time::Instant::now();
    assert!(child.wait().unwrap().success());
    assert!(
        began.elapsed() < secs(5),
        "the hook waited {:?}",
        began.elapsed()
    );
    drop(stdin);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        format!("{FIRST}\n")
    );
    let output = run_hook(
        &home,
        &file,
        br#"{"hook_event_name":"SessionStart","session_id":null}"#,
        &[],
    );
    assert!(output.status.success());
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "",
        "a CLI that selects no session leaves the file empty"
    );
}

/// Muse Code runs a run's hooks for the sessions its subagents start too: only the session Muse
/// Code names as the run's own, `MUSE_SESSION_ID`, is written.
#[test]
fn a_session_a_subagent_of_muse_code_starts_is_not_the_run_s() {
    let home = TestHome::new("musesubagent");
    let folder = home.path.join("core/runs/a1/1f");
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join("session");
    let start = |session: &str| {
        format!(r#"{{"hook_event_name":"SessionStart","session_id":"{session}"}}"#).into_bytes()
    };
    run_hook(&home, &file, &start(SECOND), &[("MUSE_SESSION_ID", FIRST)]);
    assert!(!file.exists(), "a subagent's session is not written");
    run_hook(&home, &file, &start(FIRST), &[("MUSE_SESSION_ID", FIRST)]);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        format!("{FIRST}\n")
    );
}

/// Antigravity's title command writes the conversation its input names, then runs the person's own
/// title command with the same input, whose output is the title.
#[test]
fn antigravity_s_title_command_writes_the_conversation_and_runs_the_person_s_own() {
    let home = TestHome::new("agytitle");
    let folder = home.path.join("core/runs/a1/1f");
    std::fs::create_dir_all(&folder).unwrap();
    let (file, forwarded) = (folder.join("session"), home.project.join("forwarded.json"));
    let input =
        format!(r#"{{"product":"antigravity","conversation_id":"{FIRST}","agent_state":"idle"}}"#);
    // The person's own command, for the shell Antigravity runs it with: sh, or on Windows cmd.exe.
    // Facade adds no title hook on Windows for a command with a `"` in it, which cmd.exe could not
    // be given whole, so this one has none, and only Unix's keeps what it was given.
    #[cfg(unix)]
    let theirs = format!("cat > '{}'; printf 'my title'", forwarded.display());
    #[cfg(windows)]
    let theirs = "<nul set /p =my title".to_string();
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", "title"])
        .arg(&file)
        .arg(&theirs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success() && output.stderr.is_empty(),
        "{output:?}"
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "my title",
        "only the person's title reaches Antigravity"
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        format!("{FIRST}\n")
    );
    #[cfg(unix)]
    assert_eq!(
        std::fs::read_to_string(&forwarded).unwrap(),
        input,
        "the same input"
    );
    #[cfg(windows)]
    let _ = (&forwarded, &input);
}

#[test]
fn a_resumed_agent_keeps_its_id_name_record_and_screen_and_continues_its_session() {
    let home = TestHome::new("resume");
    let first = home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let mut wire = connect(&home);
    type_raw(&mut wire, &first.id, "before the resume\r");
    assert!(wait_for_screen_text(&home, "worker", "> before the resume"));
    let before = home.agent_from_list_json("worker").unwrap();
    wire.call("agent.stop", json!({ "agent": first.id }));
    let resumed = resume(&home, "worker");
    assert!(
        resumed.status.success(),
        "{}{}",
        stdout(&resumed),
        stderr(&resumed)
    );
    let second = home.started_agent(&stdout(&resumed));
    assert_eq!(second.id, first.id, "the agent keeps its ID");
    assert_ne!(second.pid, first.pid);
    let after = home.agent_from_list_json("worker").unwrap();
    for field in ["agent_id", "name", "cli", "cwd", "created_at", "session"] {
        assert_eq!(after[field], before[field], "{field}");
    }
    assert_eq!(
        (
            after["process"].as_str(),
            after.get("exit"),
            after["pid"].as_i64()
        ),
        (Some("running"), None, Some(second.pid as i64))
    );
    assert!(
        wait_for_screen_text(&home, "worker", &format!("session {FIRST}")),
        "the CLI selected the recorded session"
    );
    // The fake CLI's first frame moves the earlier run's rows up into the scrollback.
    let screen = home.run_facade_ok(&["screen", "worker", "--lines", "2000"]);
    assert!(
        screen.contains("> before the resume"),
        "the screen keeps the earlier run's rows: {screen}"
    );
    type_raw(&mut wire, &first.id, "after the resume\r");
    assert!(wait_for_screen_text(&home, "worker", "> after the resume"));
    assert_eq!(
        home.submitted_messages(),
        ["before the resume", "after the resume"]
    );
    let next = home.start_fake("next");
    assert_eq!(next.id, "a2", "a resume takes no agent number");
}

#[test]
fn resume_refuses_a_running_agent_one_without_a_rule_and_one_without_a_session() {
    let home = TestHome::new("refusals");
    home.start_named_fake("running", &[("FAKECLI_SESSION", FIRST)]);
    let raw = home.start_fake("raw");
    let silent = home.start_named_fake("silent", &[]);
    let mut wire = connect(&home);
    let refused = |home: &TestHome, agent: &str| {
        let output = resume(home, agent);
        assert_eq!(output.status.code(), Some(1), "{agent}");
        stderr(&output)
    };
    assert_eq!(
        refused(&home, "running"),
        "error: a1 is still running\n  tip: run 'facade attach a1' to watch it\n"
    );
    wire.call("agent.stop", json!({ "agent": raw.id }));
    assert_eq!(
        refused(&home, "raw"),
        format!(
            "error: {} was started as a plain program and cannot resume\n",
            raw.id
        )
    );
    wire.call("agent.stop", json!({ "agent": silent.id }));
    let said = refused(&home, "silent");
    assert!(
        said.starts_with("error: ")
            && said.contains("has no recorded session")
            && !said.contains("(unavailable)"),
        "{said}"
    );
    assert_eq!(
        home.agent_from_list_json("silent").unwrap()["process"],
        "ended",
        "a refused resume changes nothing"
    );
}

#[test]
fn a_hook_from_an_earlier_run_cannot_reach_the_resumed_run() {
    let home = TestHome::new("latehook");
    let agent = home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let earlier = session_file(&home, &agent.id);
    let mut wire = connect(&home);
    wire.call("agent.stop", json!({ "agent": agent.id }));
    assert!(resume(&home, "worker").status.success());
    assert_ne!(
        session_file(&home, &agent.id),
        earlier,
        "the resumed run has a folder of its own"
    );
    let late = run_hook(
        &home,
        &earlier,
        format!(r#"{{"hook_event_name":"SessionStart","session_id":"{SECOND}"}}"#).as_bytes(),
        &[],
    );
    assert!(late.status.success());
    assert!(
        !earlier.parent().unwrap().exists(),
        "the hook never recreates an earlier run's folder"
    );
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(
        home.agent_from_list_json("worker").unwrap()["session"],
        FIRST
    );
}

#[test]
fn recovery_commits_a_resume_the_interrupted_daemon_could_not_save() {
    let home = TestHome::new("resumecrash");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-restart-commit")]);
    let held = home.start_named_fake("held", &[("FAKECLI_SESSION", FIRST)]);
    let other = home.start_named_fake("other", &[("FAKECLI_SESSION", SECOND)]);
    assert!(
        records_session(&home, "held", Some(FIRST))
            && records_session(&home, "other", Some(SECOND))
    );
    let mut wire = connect(&home);
    wire.call("agent.stop", json!({ "agent": held.id }));
    wire.call("agent.stop", json!({ "agent": other.id }));
    let resuming = {
        let mut command = home.command(&test_binaries().facade);
        command
            .env("PATH", home.path_with_test_programs())
            .args(["resume", "held"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.spawn().unwrap()
    };
    home.wait_for_gate("before-restart-commit");
    let elsewhere = resume(&home, "other");
    assert!(
        elsewhere.status.success(),
        "another agent resumes meanwhile: {}",
        stderr(&elsewhere)
    );
    let daemon = home.kill_daemon();
    let _ = resuming.wait_with_output();
    home.wait_for_daemon_after(daemon, secs(30))
        .expect("a replacement daemon");
    let recovered = home.agent_from_list_json("held").unwrap();
    assert_eq!(
        (recovered["process"].as_str(), recovered.get("exit")),
        (Some("running"), None),
        "{recovered}"
    );
    assert_ne!(
        recovered["pid"].as_i64(),
        Some(held.pid as i64),
        "the resumed process is the agent's now"
    );
    assert!(wait_for_screen_text(
        &home,
        "held",
        &format!("session {FIRST}")
    ));
    let again = stderr(&resume(&home, "held"));
    assert!(
        again
            == format!(
                "error: {} is still running\n  tip: run 'facade attach {}' to watch it\n",
                held.id, held.id
            ),
        "{again}"
    );
}

/// Two member windows observe the same stop, join one overlapping resume, and lose the record
/// together when it is removed.
#[test]
fn two_member_windows_resume_one_stopped_process() {
    let home = TestHome::new("resumemembers");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-restart-commit")]);
    let folder = facade_base::files::real_path(&home.project).unwrap();
    let describe = |id: &str| {
        json!({
            "id": id, "label": id, "workspace": id, "environment": "local", "folders": [folder],
        })
    };
    let (mut first, left) = ide_binding(&home, &describe("first"));
    let (mut second, right) = ide_binding(&home, &describe("second"));
    let env = json!({
        "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path,
        "FAKECLI_LOG": home.fake_log, "FAKECLI_SESSION": FIRST,
    });
    // PowerShell needs SystemRoot to run the session hook on Windows.
    #[cfg(windows)]
    let env = {
        let mut env = env;
        env["SystemRoot"] = json!(std::env::var("SystemRoot").unwrap());
        env
    };
    let started = first.call(
        "agent.start",
        json!({
            "command": ["fake"], "name": "worker", "cwd": folder, "location_source_window": left,
            "env": env, "cols": 80, "rows": 24,
        }),
    );
    let record = &started["result"]["agent"];
    let id = record["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"));
    let pid = record["pid"].as_i64().expect("the original PID") as i32;
    let original = process_identity(pid);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let mut members = [left, right];
    members.sort();
    let adopted = second.call("agent.adopt", json!({ "agent": id }));
    assert_eq!(adopted["result"]["windows"], json!(members), "{adopted}");

    let watch = |wire: &mut DaemonTestClient| {
        let reply = wire.request("watch", json!({ "topic": "agents" }));
        reply["result"]["watch"]
            .as_u64()
            .unwrap_or_else(|| panic!("{reply}"))
    };
    let (a, b) = (watch(&mut first), watch(&mut second));
    let stopped = first.call("agent.stop", json!({ "agent": id }));
    assert!(stopped["result"].is_object(), "{stopped}");
    assert!(
        wait_until(secs(15), || !alive(&original)),
        "the original process has ended"
    );
    for (wire, watch) in [(&first, a), (&second, b)] {
        assert!(
            wait_until(secs(10), || wire.changes(watch).iter().any(|event| {
                let agent = &event["change"]["agent"];
                agent["agent_id"] == id
                    && agent["process"] == "ended"
                    && agent["windows"] == json!(members)
            })),
            "both windows see the stopped record and its members: {:?}",
            wire.changes(watch)
        );
    }

    let resume = json!({ "op": "agent.resume", "args": { "agent": id, "env": env, "cols": 80, "rows": 24 } });
    let pending = first.send("call", resume.clone());
    home.wait_for_gate("before-restart-commit");
    let joining = second.send("call", resume);
    let premature = second.wait_for_response(joining, secs(1));
    home.release_gate("before-restart-commit");
    assert!(
        premature.is_none(),
        "the second request waits for the first: {premature:?}"
    );
    let a_result = first
        .wait_for_response(pending, LOADED_TIMEOUT)
        .expect("the first resume answers");
    let b_result = second
        .wait_for_response(joining, LOADED_TIMEOUT)
        .expect("the second resume answers");
    let next_pid = a_result["result"]["pid"]
        .as_i64()
        .expect("the first resume starts a process");
    assert_ne!(next_pid, i64::from(pid));
    for reply in [a_result, b_result] {
        let resumed = &reply["result"];
        assert_eq!(resumed["agent_id"], id, "{reply}");
        assert_eq!(resumed["pid"], next_pid, "{reply}");
        assert_eq!(resumed["windows"], json!(members), "{reply}");
    }
    assert_eq!(
        home.agents()
            .into_iter()
            .map(|agent| agent["pid"].clone())
            .collect::<Vec<_>>(),
        [json!(next_pid)]
    );

    let removed = second.call("agent.remove", json!({ "agent": id }));
    assert!(removed["result"].is_object(), "{removed}");
    for (wire, watch) in [(&mut first, a), (&mut second, b)] {
        assert!(
            wait_until(secs(10), || wire
                .changes(watch)
                .iter()
                .any(|event| event["change"]["kind"] == "removed"
                    && event["change"]["agent_id"] == id)),
            "{:?}",
            wire.changes(watch)
        );
        let snapshot = wire.request("watch", json!({ "topic": "agents" }));
        assert_eq!(
            snapshot["result"]["snapshot"]["agents"],
            json!([]),
            "{snapshot}"
        );
        let refused = wire.call("agent.adopt", json!({ "agent": id }));
        assert_eq!(error_reason(&refused), "not_found", "{refused}");
    }
    let memberships: i64 = rusqlite::Connection::open(home.path.join("core/facade.db"))
        .unwrap()
        .query_row(
            "SELECT count(*) FROM agent_windows WHERE agent_id = ?",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(memberships, 0, "removal deleted every stored membership");
}

#[test]
fn an_agent_whose_terminal_closed_resumes_with_a_warning_and_keeps_logging_its_screen() {
    let home = TestHome::new("closedresume");
    let agent = home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let mut wire = connect(&home);
    type_raw(&mut wire, &agent.id, "before the end\r");
    assert!(wait_for_screen_text(&home, "worker", "> before the end"));
    drop(wire);
    // Both services and the CLI end together; the next daemon finds the terminal closed.
    home.kill_home_processes();
    let listed = home.agent_from_list_json("worker").unwrap();
    assert_eq!(listed["exit"]["reason"], "terminal_closed", "{listed}");
    let resumed = resume(&home, "worker");
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert_eq!(
        stderr(&resumed),
        format!(
            "warning: {}'s earlier CLI may still be running because its terminal closed\n",
            agent.id
        )
    );
    let mut wire = connect(&home);
    type_raw(&mut wire, &agent.id, "after the resume\r");
    assert!(wait_for_screen_text(&home, "worker", "> after the resume"));
    // End the resumed run, so no CLI can draw the screen again: what the next daemon shows comes
    // from the screen log alone.
    wire.call("agent.stop", json!({ "agent": agent.id }));
    drop(wire);
    home.kill_daemon();
    // The fake CLI's first frame moves the earlier run's rows up into the scrollback.
    let screen = home.run_facade_ok(&["screen", "worker", "--lines", "2000"]);
    assert!(
        screen.contains("> before the end") && screen.contains("> after the resume"),
        "the resumed run's output is logged: {screen}"
    );
}

#[test]
fn a_screen_watch_follows_the_agent_through_its_end_and_resume() {
    let home = TestHome::new("watchresume");
    let agent = home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let mut watcher = connect(&home);
    let watch = watcher.request(
        "watch",
        json!({ "topic": "screen", "args": { "agent": agent.id } }),
    )["result"]["watch"]
        .as_u64()
        .unwrap();
    let mut wire = connect(&home);
    wire.call("agent.stop", json!({ "agent": agent.id }));
    assert!(resume(&home, "worker").status.success());
    type_raw(&mut wire, &agent.id, "after the resume\r");
    assert!(wait_for_screen_text(&home, "worker", "> after the resume"));
    let mut kinds = Vec::new();
    let mut after_exit = Vec::new();
    assert!(wait_until(secs(10), || {
        (kinds, after_exit) = (Vec::new(), Vec::new());
        for change in watcher.changes(watch) {
            let change = &change["change"];
            let kind = change["kind"].as_str().unwrap().to_string();
            if kinds.contains(&"exit".to_string())
                && let Some(data) = change["data"].as_str()
            {
                after_exit.extend(facade_base::base64::decode(data).unwrap());
            }
            kinds.push(kind);
        }
        String::from_utf8_lossy(&after_exit).contains("after the resume")
    }));
    assert_eq!(
        kinds.iter().filter(|kind| *kind == "exit").count(),
        1,
        "{kinds:?}"
    );
    assert!(
        !kinds.contains(&"removed".to_string()),
        "the watch lasts through the resume: {kinds:?}"
    );
}

/// Input that waited for room when its run ended, and retries only after the agent resumed, never
/// reaches the new CLI.
// Input waiting for room is Unix's: a pseudo console's host reads all its input.
#[cfg(unix)]
#[test]
fn input_waiting_when_its_run_ends_never_reaches_the_resumed_run() {
    let home = TestHome::new("waitinginput");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-input-retry")]);
    let agent = home.start_named_fake(
        "worker",
        &[("FAKECLI_SESSION", FIRST), ("FAKECLI_IGNORE_INPUT", "1")],
    );
    assert!(records_session(&home, "worker", Some(FIRST)));
    let mut waiting = connect(&home);
    // Fill the agent's waiting input: the CLI reads none of it.
    let filled = waiting.call(
        "agent.type",
        json!({
            "agent": agent.id, "raw": facade_base::base64::encode(&vec![b'x'; 1024 * 1024]),
        }),
    );
    assert!(filled["result"].is_object(), "{filled}");
    waiting.write(&json!({
        "jsonrpc": "2.0", "method": "call",
        "params": {
            "op": "agent.type",
            "args": {
                "agent": agent.id, "raw": facade_base::base64::encode(&vec![b'O'; 512 * 1024]),
            },
        },
    }));
    // The run ends while that input waits for room: input that arrives after the end is refused,
    // and never waits.
    home.wait_for_gate("input-without-room");
    let mut wire = connect(&home);
    wire.call("agent.stop", json!({ "agent": agent.id }));
    home.wait_for_gate("before-input-retry");
    let resumed = resume(&home, "worker");
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert!(wait_for_screen_text(
        &home,
        "worker",
        &format!("session {FIRST}")
    ));
    home.release_gate("before-input-retry");
    // Typing sent after the waiting input on its connection runs once that input is done with.
    type_raw(&mut waiting, &agent.id, "fresh\r");
    assert!(wait_for_screen_text(&home, "worker", "> fresh"));
    assert!(
        !home
            .run_facade_ok(&["screen", "worker", "--lines", "2000"])
            .contains("OOO"),
        "no input of the ended run reached the new CLI"
    );
    assert_eq!(home.submitted_messages(), ["fresh"]);
}

/// A resume waits for the ended run's exit to be saved, so the saved record ends with the new
/// process and no exit.
#[test]
fn a_resume_waits_for_the_ended_run_s_exit_to_be_saved_before_saving_its_own_run() {
    let home = TestHome::new("exitwriter");
    home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    // Both services and the CLI end; the next daemon cannot save the closed terminal's exit until
    // the fault goes.
    home.kill_home_processes();
    home.fault("fail-exit-commit", "");
    home.start_facade_with(&[("FACADE_TEST_GATES", "marks")]);
    home.wait_for_gate("failed-exit-commit");
    let resuming = start_resume(&home, "worker");
    home.wait_for_gate("waiting-for-previous-run");
    std::fs::remove_file(home.path.join("core/fail-exit-commit")).unwrap();
    let resumed = resuming.wait_with_output().unwrap();
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    let new = home.started_agent(&stdout(&resumed));
    let database = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    let (pid, exit_at): (i64, Option<String>) = database
        .query_row(
            "SELECT pid, exit_at FROM agents WHERE agent_id = 'a1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (pid, exit_at),
        (new.pid as i64, None),
        "the earlier exit was saved first, then replaced by the resumed run"
    );
}

/// A Codex run keeps the version its installation names beside the program its rule starts, which
/// decides its rule's screen evidence, and a resume reads the version again.
#[test]
fn a_codex_run_keeps_the_version_its_installation_names_and_a_resume_reads_it_again() {
    let home = TestHome::new("codexversion");
    let release = home.project.parent().unwrap().join("codex-release");
    std::fs::create_dir_all(release.join("bin")).unwrap();
    let install = |version: &str| {
        std::fs::write(
            release.join("codex-package.json"),
            format!(r#"{{"name":"codex","version":"{version}"}}"#),
        )
        .unwrap()
    };
    install("0.166.0");
    #[cfg(unix)]
    install_script(
        &release.join("bin"),
        "codex",
        "#!/bin/sh\nprintf '\\033]7501;state=idle\\007› '\nexec sleep 600\n",
    );
    // A program of its own on Windows: a stand-in .cmd would go through cmd.exe, which Codex's
    // arguments cannot (npm's own shims are read through to the program behind them).
    #[cfg(windows)]
    install_program(&release.join("bin"), "codex", &test_binaries().fakecli);
    let path = std::iter::once(release.join("bin").display().to_string())
        .chain(system_folders())
        .collect::<Vec<_>>()
        .join(PATH_SEPARATOR);
    let mut wire = connect(&home);
    let args = json!({
        "command": ["codex"], "name": "codex", "cwd": home.project,
        "env": { "PATH": path, "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    let started = wire.call("agent.start", args);
    let id = started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"))
        .to_string();
    let facts = home.path.join("core/screens").join(&id).join("state");
    let kept = |version: &str| {
        wait_until(secs(10), || {
            std::fs::read_to_string(&facts)
                .unwrap_or_default()
                .contains(&format!(r#""version":"{version}""#))
        })
    };
    assert!(kept("0.166.0"), "{:?}", std::fs::read_to_string(&facts));
    let reported = run_hook(
        &home,
        &session_file(&home, &id),
        format!(r#"{{"hook_event_name":"SessionStart","session_id":"{FIRST}"}}"#).as_bytes(),
        &[],
    );
    assert!(reported.status.success());
    assert!(records_session(&home, "codex", Some(FIRST)));
    wire.call("agent.stop", json!({ "agent": id }));
    install("0.167.0");
    let resumed = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .args(["resume", "codex"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert!(kept("0.167.0"), "{:?}", std::fs::read_to_string(&facts));
}

/// A start that continues a session is a new agent, with a number of its own, whose CLI continues
/// that session as its rule's resume says, after the agent that had it was removed.
#[test]
fn a_start_with_a_session_continues_it_as_a_new_agent() {
    let home = TestHome::new("continue");
    let first = home.start_named_fake("before", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "before", Some(FIRST)));
    home.run_facade_ok(&["stop", "before"]);
    home.run_facade_ok(&["remove", "before"]);
    let file = home.project.parent().unwrap().join("after.args");
    let mut wire = connect(&home);
    let args = json!({
        "command": ["fake"], "session": FIRST, "name": "after", "cwd": home.project,
        "env": {
            "PATH": home.path_with_test_programs(), "FACADE_HOME": home.path, "FAKECLI_ARGS": file,
        },
        "cols": 80, "rows": 24,
    });
    // Windows PowerShell, which runs the session hook on Windows, does not start without it.
    #[cfg(windows)]
    let args = {
        let mut args = args;
        args["env"]["SystemRoot"] = json!(std::env::var("SystemRoot").unwrap());
        args
    };
    let started = wire.call("agent.start", args);
    let id = started["result"]["agent"]["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"));
    assert_ne!(id, first.id, "a new agent");
    assert!(
        wait_until(secs(10), || file.exists()),
        "the CLI wrote no arguments"
    );
    let words: Vec<String> =
        facade_scenarios::serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(words, ["--resume", FIRST]);
    assert!(
        wait_for_screen_text(&home, "after", &format!("session {FIRST}")),
        "the CLI continued the session"
    );
    assert!(
        records_session(&home, "after", Some(FIRST)),
        "the run reports the session: {:?}\n{}",
        home.agent_from_list_json("after"),
        home.daemon_log()
    );
}
