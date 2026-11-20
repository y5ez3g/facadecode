//! Sessions and resume: a CLI's session-start hook reports its session, the daemon records it, and
//! `facade resume` starts an ended agent's CLI again in the same terminal, continuing that session.

use std::io::Write;
use std::path::Path;
use std::process::{Child, Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

const FIRST: &str = "86da4482-2bae-4a45-b193-a5664c19826a";
const SECOND: &str = "96da4482-2bae-4a45-b193-a5664c19826b";

fn recorded_cli_args(file: &Path) -> Vec<String> {
    let mut argv = None;
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            argv = std::fs::read_to_string(file)
                .ok()
                .and_then(|text| facade_scenarios::serde_json::from_str(&text).ok());
            argv.is_some()
        }),
        "no complete argv at {}",
        file.display()
    );
    argv.unwrap()
}

fn inspected_agent(home: &TestHome, agent: &str) -> Value {
    home.inspect_agent(agent)["agent"].clone()
}

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
        .args(["start", "-d", "--name", "codex", "codex"])
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
        .args(["resume", "-d", "codex"])
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
        .args(["start", "-d", "--name", cli, cli])
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

/// Runs `facade resume -d <agent>` without a terminal, with the test programs on `PATH` so the fake
/// CLI's rule finds its program.
fn resume(home: &TestHome, agent: &str) -> Output {
    home.command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(["resume", "-d", agent])
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

/// Starts `facade resume <agent>` as `resume` does, without waiting for it.
fn start_resume(home: &TestHome, agent: &str) -> Child {
    let mut command = home.command(&test_binaries().facade);
    command
        .env("PATH", home.path_with_test_programs())
        .args(["resume", "-d", agent])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.spawn().unwrap()
}

/// Waits until the agent's record shows `session`.
fn records_session(home: &TestHome, name: &str, session: Option<&str>) -> bool {
    wait_until(secs(10), || {
        home.agent_from_watch(name)
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
        home.listed_agent("worker")
    );
    let mut wire = connect(&home);
    let inspected = wire.call("agent.inspect", json!({ "agent": agent.address }));
    assert_eq!(inspected["result"]["session_tracking"], true, "{inspected}");
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
    let unsaved = home.start_named_fake(
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
        home.listed_agent("saved")
    );
    home.run_facade_ok(&["send", "saved", "hello"]);
    assert!(
        records_session(&home, "saved", Some(SECOND)),
        "saved with its first message"
    );
    home.run_facade_ok(&["stop", "unsaved"]);
    let refused = resume(&home, "unsaved");
    assert_eq!(
        (stdout(&refused), stderr(&refused), refused.status.code()),
        (
            String::new(),
            format!(
                "error: unsaved ({}) has no saved session to resume.\n",
                unsaved.address
            ),
            Some(1),
        )
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
    assert_eq!(inspected_agent(&home, "worker")["session"], SECOND);
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
        home.agent_record(&agent.id).unwrap()["session"],
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
    let before = home.agent_record(&first.id).unwrap();
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
    assert_eq!(second.address, first.address);
    assert_ne!(second.pid, first.pid);
    let after = home.agent_record(&first.id).unwrap();
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

/// The Shell lists a stopped Agent and resumes its session and launch settings, attached by
/// default or in the background with `-d`.
#[test]
fn resume_lists_a_stopped_agent_and_reuses_its_launch_choices() {
    let home = TestHome::new("resume-choices");
    let first_args = home.folder().join("first-argv.json");
    let mut launch = home.command(&test_binaries().facade);
    launch
        .env("FAKECLI_SESSION", FIRST)
        .env("FAKECLI_ARGS", &first_args);
    let env = launch
        .get_envs()
        .filter_map(|(name, value)| Some((name.to_str()?, value?.to_str()?)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let original = connect(&home).call_ok(
        "agent.start",
        json!({
            "name": "ada", "cli": "fake", "folder": home.project,
            "model": "qa-original", "effort": "low",
            "args": ["qa-saved-argument"],
            "cols": 80, "rows": 24,
            "env": env,
        }),
    );
    let address = original["agent"]["address"].as_str().unwrap();
    assert!(address.contains('@'), "{original}");
    let inspect = || inspected_agent(&home, address);
    assert!(
        wait_until(LOADED_TIMEOUT, || inspect()["session"] == FIRST),
        "the first session was not recorded: {}",
        inspect()
    );
    let original = inspect();
    assert_eq!(original["address"], address);
    assert_eq!(original["model"], "qa-original");
    assert_eq!(original["effort"], "low");
    let assert_args = |file: &std::path::Path| {
        let words = recorded_cli_args(file);
        assert!(
            words
                .windows(2)
                .any(|pair| pair == ["--model", "qa-original"]),
            "{words:?}"
        );
        assert!(
            words.windows(2).any(|pair| pair == ["--effort", "low"]),
            "{words:?}"
        );
        assert!(
            words.iter().any(|word| word == "qa-saved-argument"),
            "{words:?}"
        );
    };
    assert_args(&first_args);

    home.run_facade_ok(&["stop", address]);
    assert!(wait_until(LOADED_TIMEOUT, || inspect()["process"] == "ended"));
    let choices = home.run_facade_ok(&["resume"]);
    assert!(
        choices
            .lines()
            .any(|line| line.split_whitespace().any(|word| word == address)),
        "{choices}"
    );
    std::fs::write(
        home.path.join("facade.json"),
        r#"{"clis":{"fake":{"model":"qa-new-default","effort":"high"}}}"#,
    )
    .unwrap();
    let check_resume = |before: &Value| {
        let resumed = inspect();
        for field in ["address", "cwd", "session", "model", "effort"] {
            assert_eq!(resumed[field], original[field], "the resume keeps {field}");
        }
        assert_eq!(resumed["process"], "running");
        assert_ne!(resumed["pid"], before["pid"]);
        resumed
    };

    let attached_args = home.folder().join("attached-resume-argv.json");
    let mut resume_terminal = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .env("FAKECLI_ARGS", &attached_args)
            .args(["resume", address]),
        90,
        24,
    );
    assert!(
        resume_terminal.wait_for(LOADED_TIMEOUT, |screen| screen
            .contains(&format!("session {FIRST}"))),
        "foreground resume shows the resumed session: {}",
        resume_terminal.text()
    );
    assert_args(&attached_args);
    let attached = check_resume(&original);
    resume_terminal.send(b"\x1d");
    assert_eq!(
        resume_terminal
            .wait_exit(LOADED_TIMEOUT)
            .and_then(|exit| exit.code()),
        Some(0),
        "Ctrl-] detaches the Shell without ending the agent"
    );
    assert_eq!(inspect()["pid"], attached["pid"]);
    home.run_facade_ok(&["stop", address]);

    let resumed_args = home.folder().join("background-resume-argv.json");
    let outcome = home
        .command(&test_binaries().facade)
        .env("FAKECLI_ARGS", &resumed_args)
        .args(["resume", "-d", address])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(outcome.status.success(), "{}", stderr(&outcome));
    assert_eq!(
        stdout(&outcome),
        format!("Resumed ada ({address}) in the background.\n")
    );
    assert_args(&resumed_args);
    assert!(wait_for_screen_text(
        &home,
        address,
        &format!("session {FIRST}")
    ));
    check_resume(&attached);
}

/// An actual v2 run lacks a launch snapshot. Takeover must choose it before any Resume.
#[test]
fn a_resume_after_v2_takeover_uses_the_launch_choices_from_migration() {
    let home = TestHome::new("v2resume");
    let old = v2_facade(&home);
    let set_choices = |model: &str, effort: &str| {
        let settings = json!({ "clis": { "fake": {
            "type": "fake", "command": test_binaries().fakecli, "model": model, "effort": effort,
        } } });
        std::fs::write(home.path.join("facade.json"), settings.to_string()).unwrap();
    };
    set_choices("qa-before-upgrade", "high");
    let before_args = home.folder().join("legacy-argv.json");
    let started = home
        .command(&old)
        .env("FAKECLI_SESSION", FIRST)
        .env("FAKECLI_ARGS", &before_args)
        .args(["start", "-d", "--name", "ada", "fake", "qa-legacy-argument"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let started_id = stdout(&started);
    let id = started_id.trim();
    assert_eq!(id, "a1");
    assert!(
        recorded_cli_args(&before_args)
            .iter()
            .any(|word| word == "qa-legacy-argument")
    );

    let mut legacy = DaemonTestClient::open(&home);
    let old_hello = legacy.hello("terminal", [2, 2], json!({}));
    assert_eq!(old_hello["result"]["protocol"], 2, "{old_hello}");
    assert_eq!(old_hello["result"]["build"], V2_TEST_BUILD, "{old_hello}");
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            legacy.call("agent.inspect", json!({ "agent": id }))["result"]["agent"]["session"]
                == FIRST
        }),
        "the v2 fake CLI did not report its session"
    );
    let before = legacy.call("agent.inspect", json!({ "agent": id }))["result"]["agent"].clone();
    drop(legacy);

    set_choices("qa-at-migration", "low");
    home.run_facade_ok(&["daemon", "--takeover"]);
    assert!(wait_until(LOADED_TIMEOUT, || home.hello_result().is_some()));
    let hello = home.hello_result().unwrap();
    assert_eq!(hello["protocol"], 3, "{hello}");
    assert_ne!(hello["pid"], old_hello["result"]["pid"]);
    assert_eq!(hello["keeper"]["pid"], old_hello["result"]["keeper"]["pid"]);
    let migrated = inspected_agent(&home, id);
    for key in ["agent_id", "machine_id", "cwd", "session", "pid"] {
        assert_eq!(migrated[key], before[key], "takeover keeps {key}");
    }
    let address = migrated["address"].as_str().unwrap();
    assert!(address.starts_with("a1@"), "{migrated}");
    assert_eq!(migrated["model"], "qa-at-migration");
    assert_eq!(migrated["effort"], "low");
    assert_eq!(migrated["args"], json!([]));

    set_choices("qa-after-upgrade", "high");
    home.run_facade_ok(&["stop", address]);
    let after_args = home.folder().join("resumed-legacy-argv.json");
    let resumed = home
        .command(&test_binaries().facade)
        .env("FAKECLI_ARGS", &after_args)
        .args(["resume", "-d", address])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert_eq!(
        stdout(&resumed),
        format!("Resumed ada ({address}) in the background.\n")
    );
    let argv = recorded_cli_args(&after_args);
    for [flag, expected] in [
        ["--model", "qa-at-migration"],
        ["--effort", "low"],
        ["--resume", FIRST],
    ] {
        let values: Vec<_> = argv
            .windows(2)
            .filter(|pair| pair[0] == flag)
            .map(|pair| pair[1].as_str())
            .collect();
        assert_eq!(values, [expected], "{flag} in {argv:?}");
    }
    for omitted in [
        "qa-legacy-argument",
        "qa-before-upgrade",
        "qa-after-upgrade",
    ] {
        assert!(!argv.iter().any(|word| word == omitted), "{argv:?}");
    }
    let public = inspected_agent(&home, address);
    assert_eq!(public["address"], address);
    assert_eq!(public["session"], FIRST);
    assert_eq!(public["model"], "qa-at-migration");
    assert_eq!(public["effort"], "low");
    assert_eq!(public["args"], json!([]));
    assert_ne!(inspected_agent(&home, address)["pid"], before["pid"]);
}

#[test]
fn resume_refuses_a_running_agent_one_without_a_rule_and_one_without_a_session() {
    let home = TestHome::new("refusals");
    let running = home.start_named_fake("running", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "running", Some(FIRST)));
    let mut wire = connect(&home);
    let raw = start_script(&mut wire, &home, "raw", "echo READY; sleep 60");
    let silent = home.start_named_fake("silent", &[]);
    let refused = |home: &TestHome, agent: &str| {
        let output = resume(home, agent);
        assert_eq!(output.status.code(), Some(1), "{agent}");
        stderr(&output)
    };
    assert_eq!(
        refused(&home, "running"),
        format!(
            "error: running ({0}) is already running.\nOpen it with 'facade attach {0}'.\n",
            running.address
        )
    );
    let stopped = wire.call("agent.stop", json!({ "agent": raw }));
    assert!(stopped["result"].is_object(), "{stopped}");
    let reply = wire.call(
        "agent.resume",
        json!({ "reference": "raw", "cols": 80, "rows": 24 }),
    );
    assert!(reply["error"].is_object(), "{reply}");
    let custom = reply["error"]["message"].as_str().unwrap();
    assert!(
        custom.contains("is a custom program and cannot be resumed"),
        "{custom}"
    );
    wire.call("agent.stop", json!({ "agent": silent.id }));
    let said = refused(&home, "silent");
    assert!(
        said.starts_with("error: ")
            && said.contains("has no saved session to resume.")
            && !said.contains("(unavailable)"),
        "{said}"
    );
    assert_eq!(
        home.agent_record(&silent.id).unwrap()["process"],
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
    assert_eq!(home.agent_record(&agent.id).unwrap()["session"], FIRST);
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
            .args(["resume", "-d", "held"])
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
    let recovered = home.agent_record(&held.id).unwrap();
    assert_eq!(
        (recovered["process"].as_str(), recovered.get("exit")),
        (Some("running"), None),
        "{recovered}"
    );
    assert_ne!(
        recovered["pid"].as_i64().expect("the resumed process"),
        i64::from(held.pid),
        "the resumed process is the agent's now"
    );
    assert!(wait_for_screen_text(
        &home,
        "held",
        &format!("session {FIRST}")
    ));
    let again = resume(&home, "held");
    assert_eq!(
        (stdout(&again), stderr(&again), again.status.code()),
        (
            String::new(),
            format!(
                "error: held ({0}) is already running.\nOpen it with 'facade attach {0}'.\n",
                held.address
            ),
            Some(1),
        )
    );
}

/// Two editor connections observe the same stop, join one overlapping resume, and receive the
/// same removal.
#[test]
fn two_editor_connections_resume_one_stopped_process() {
    let home = TestHome::new("resumemembers");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-restart-commit")]);
    let folder = facade_base::files::real_path(&home.project).unwrap();
    let editor = || {
        let mut wire = DaemonTestClient::open(&home);
        let hello = wire.hello("ide", DAEMON_RANGE, json!({}));
        assert_eq!(hello["result"]["protocol"], 3, "{hello}");
        wire
    };
    let mut first = editor();
    let mut second = editor();
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
            "cli": "fake", "name": "worker", "folder": folder,
            "env": env, "cols": 80, "rows": 24,
        }),
    );
    let record = &started["result"]["agent"];
    let address = record["address"].as_str().expect("the copyable address");
    let id = record["agent_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"));
    let pid = record["pid"].as_i64().expect("the original PID") as i32;
    let original = process_identity(pid);
    assert!(records_session(&home, "worker", Some(FIRST)));

    let watch = |wire: &mut DaemonTestClient| {
        let reply = wire.request("watch", json!({ "topic": "agents" }));
        reply["result"]["watch"]
            .as_u64()
            .unwrap_or_else(|| panic!("{reply}"))
    };
    let (a, b) = (watch(&mut first), watch(&mut second));
    let stopped = first.call("agent.stop", json!({ "agent": address }));
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
                    && agent["address"] == address
            })),
            "both editors see the same stopped record: {:?}",
            wire.changes(watch)
        );
    }

    let resume = json!({
        "op": "agent.resume",
        "args": { "reference": address, "env": env, "cols": 80, "rows": 24 }
    });
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
    let next_pid = a_result["result"]["agent"]["pid"]
        .as_i64()
        .expect("the first resume starts a process");
    assert_ne!(next_pid, i64::from(pid));
    for reply in [a_result, b_result] {
        let resumed = &reply["result"]["agent"];
        assert_eq!(resumed["agent_id"], id, "{reply}");
        assert_eq!(resumed["pid"], next_pid, "{reply}");
        assert_eq!(resumed["address"], address, "{reply}");
        assert_eq!(resumed["session"], FIRST, "{reply}");
    }
    assert_eq!(
        home.agents()
            .into_iter()
            .map(|agent| agent["pid"].clone())
            .collect::<Vec<_>>(),
        [json!(next_pid)]
    );

    let removed = second.call("agent.remove", json!({ "agent": address }));
    assert!(removed["result"].is_object(), "{removed}");
    for (wire, watch) in [(&mut first, a), (&mut second, b)] {
        assert!(
            wait_until(secs(10), || wire.changes(watch).iter().any(
                |event| event["change"]["kind"] == "removed"
                    && event["change"]["agent_id"] == id
                    && event["change"]["cause"] == "removed"
            )),
            "{:?}",
            wire.changes(watch)
        );
        let snapshot = wire.request("watch", json!({ "topic": "agents" }));
        assert_eq!(
            snapshot["result"]["snapshot"]["agents"],
            json!([]),
            "{snapshot}"
        );
        let refused = wire.call("agent.inspect", json!({ "agent": address }));
        assert_eq!(error_reason(&refused), "not_found", "{refused}");
    }
}

#[test]
fn an_agent_whose_terminal_closed_resumes_and_keeps_logging_its_screen() {
    let home = TestHome::new("closedresume");
    let agent = home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let mut wire = connect(&home);
    type_raw(&mut wire, &agent.id, "before the end\r");
    assert!(wait_for_screen_text(&home, "worker", "> before the end"));
    drop(wire);
    // Both services and the CLI end together; the next daemon finds the terminal closed.
    home.kill_home_processes();
    let listed = inspected_agent(&home, &agent.address);
    assert_eq!(listed["exit"]["reason"], "terminal_closed", "{listed}");
    let resumed = resume(&home, "worker");
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    let resumed = home.started_agent(&stdout(&resumed));
    assert_eq!(resumed.address, agent.address);
    assert_ne!(resumed.pid, agent.pid);
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
fn a_screen_viewer_reattaches_to_the_same_agent_after_resume() {
    let home = TestHome::new("watchresume");
    let agent = home.start_named_fake("worker", &[("FAKECLI_SESSION", FIRST)]);
    assert!(records_session(&home, "worker", Some(FIRST)));
    let mut watcher = connect(&home);
    let watch_screen = |wire: &mut DaemonTestClient| {
        let watched = wire.request(
            "watch",
            json!({ "topic": "screen", "args": { "agent": agent.address } }),
        );
        assert_eq!(
            watched["result"]["snapshot"]["address"], agent.address,
            "{watched}"
        );
        assert_eq!(
            watched["result"]["snapshot"]["process"], "running",
            "{watched}"
        );
        watched["result"]["watch"]
            .as_u64()
            .expect("the screen watch")
    };
    let first = watch_screen(&mut watcher);
    let mut wire = connect(&home);
    let stopped = wire.call("agent.stop", json!({ "agent": agent.address }));
    assert!(stopped["result"].is_object(), "{stopped}");
    assert!(
        wait_until(secs(10), || watcher
            .changes(first)
            .iter()
            .any(|event| { event["change"]["kind"] == "exit" })),
        "the first viewer receives the run's exit: {:?}",
        watcher.changes(first)
    );
    assert!(resume(&home, "worker").status.success());
    let second = watch_screen(&mut watcher);
    assert_ne!(first, second);
    type_raw(&mut wire, &agent.id, "after the resume\r");
    assert!(wait_for_screen_text(&home, "worker", "> after the resume"));
    assert!(wait_until(secs(10), || {
        let output: Vec<_> = watcher
            .changes(second)
            .iter()
            .filter_map(|event| event["change"]["data"].as_str())
            .flat_map(|data| facade_base::base64::decode(data).unwrap())
            .collect();
        String::from_utf8_lossy(&output).contains("after the resume")
    }));
    let original = watcher.changes(first);
    assert_eq!(
        original.last().expect("a final change")["change"]["kind"],
        "exit",
        "{original:?}"
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
        "cli": "codex", "name": "codex", "folder": home.project,
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
        .args(["resume", "-d", "codex"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(resumed.status.success(), "{}", stderr(&resumed));
    assert!(kept("0.167.0"), "{:?}", std::fs::read_to_string(&facts));
}

/// Resuming a saved session whose agent was removed creates a new agent and passes the original
/// session to the CLI.
#[test]
fn resuming_a_saved_session_after_removal_creates_a_new_agent() {
    let home = TestHome::new("continue");
    let programs = home.folder().join("programs");
    install_program(&programs, "claude", &test_binaries().fakecli);
    let path = format!("{}{PATH_SEPARATOR}{}", programs.display(), home.test_path());
    let project_name: String = home
        .project
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let history = home.user_home().join(".claude/projects").join(project_name);
    std::fs::create_dir_all(&history).unwrap();
    std::fs::write(
        history.join(format!("{FIRST}.jsonl")),
        format!(
            "{}\n",
            json!({
                "type": "user", "sessionId": FIRST, "cwd": home.project,
                "message": { "role": "user", "content": "resume this saved conversation" }
            })
        ),
    )
    .unwrap();
    let file = home.folder().join("after.args");
    let mut wire = connect(&home);
    let mut args = json!({
        "reference": format!("claude:{FIRST}"), "folder": home.project,
        "env": { "PATH": path },
        "cols": 80, "rows": 24,
    });
    let first = wire.call("agent.resume", args.clone());
    let before = first["result"]["agent"]["address"]
        .as_str()
        .unwrap_or_else(|| panic!("{first}"));
    assert_eq!(first["result"]["agent"]["session"], FIRST);
    home.run_facade_ok(&["stop", before]);
    home.remove_agent(before);
    args["env"]["FAKECLI_ARGS"] = json!(file);
    let started = wire.call("agent.resume", args);
    let address = started["result"]["agent"]["address"]
        .as_str()
        .unwrap_or_else(|| panic!("{started}"));
    assert_ne!(address, before, "a new agent");
    let words = recorded_cli_args(&file);
    assert_eq!(
        words
            .windows(2)
            .filter(|pair| pair[0] == "--resume")
            .collect::<Vec<_>>(),
        [vec!["--resume", FIRST]],
        "{words:?}"
    );
    assert!(
        wait_for_screen_text(&home, address, &format!("session {FIRST}")),
        "the CLI continued the session"
    );
    let record = &started["result"]["agent"];
    let id = record["agent_id"].as_str().expect("the new agent ID");
    let name = record["name"].as_str().expect("the new agent's name");
    let event = format!(r#"{{"hook_event_name":"SessionStart","session_id":"{FIRST}"}}"#);
    let reported = run_hook(&home, &session_file(&home, id), event.as_bytes(), &[]);
    assert!(reported.status.success(), "{}", stderr(&reported));
    assert!(
        records_session(&home, name, Some(FIRST)),
        "the new agent records the session its CLI continued: {}",
        inspected_agent(&home, address)
    );
}
