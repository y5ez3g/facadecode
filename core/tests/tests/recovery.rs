//! Checks daemon replacement and recovery of agent records, exits, screens, and terminals before
//! clients can connect.

#[cfg(unix)]
use std::path::PathBuf;
use std::time::{Duration, Instant};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Opens a daemon protocol connection, without starting Facade.
fn open(home: &TestHome) -> DaemonTestClient {
    let mut wire = DaemonTestClient::open(home);
    assert!(wire.hello("terminal", DAEMON_API_VERSIONS, json!({}))["result"].is_object());
    wire
}

/// Starts Facade with a pause marker already present, so the first daemon passes the pause point.
/// Returns the marker path; deleting it makes the next daemon pause there.
#[cfg(unix)]
fn start_facade_with_pause_disarmed(home: &TestHome, point: &str) -> PathBuf {
    let marker = home.path.join(format!("core/paused-at-{point}"));
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(&marker, "").unwrap();
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", point)]);
    marker
}

/// Waits for the keeper to start a daemon that is not in `known`, and returns it.
#[cfg(unix)]
fn next_started_daemon(home: &TestHome, known: &[i32]) -> i32 {
    let mut found = None;
    assert!(
        wait_until(secs(30), || {
            found = home
                .started_daemons()
                .into_iter()
                .find(|pid| !known.contains(pid));
            found.is_some()
        }),
        "the keeper started no other daemon: {}",
        home.keeper_log()
    );
    found.unwrap()
}

fn read_pid(home: &TestHome, file: &str) -> i32 {
    let path = home.project.join(file);
    assert!(
        wait_until(secs(10), || std::fs::read_to_string(&path)
            .is_ok_and(|pid| pid.ends_with('\n'))),
        "no {file}"
    );
    std::fs::read_to_string(&path)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn agent(home: &TestHome, id: &str) -> Option<Value> {
    home.agents()
        .into_iter()
        .find(|agent| agent["reference"]["agent_id"] == id)
}

#[test]
fn a_killed_daemon_is_replaced_and_takes_back_every_agent() {
    let home = TestHome::new("recover");
    let mut wire = connect(&home);
    let running = start_script(
        &mut wire,
        &home,
        "running",
        "echo READY; while read line; do echo \"got:$line\"; done",
    );
    let ended = start_script(&mut wire, &home, "ended", "echo LAST-WORDS; exit 7");
    assert!(wait_for_screen_text(&home, &running, "READY"));
    assert!(wait_until(secs(10), || agent(&home, &ended)
        .is_some_and(|agent| agent["process"] == "ended")));
    let before = home.agents();
    let killed = Instant::now();
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    assert!(
        killed.elapsed() < secs(3),
        "the first replacement took {:?}",
        killed.elapsed()
    );
    assert_eq!(
        home.agents(),
        before,
        "every agent comes back with its name, number, process, size, start time, and exit"
    );
    assert!(
        home.screen(&running).contains("READY") && home.screen(&ended).contains("LAST-WORDS"),
        "the screens come back"
    );
    // The same CLI takes input after recovery.
    type_raw(&mut open(&home), &running, "after\r");
    assert!(
        wait_for_screen_text(&home, &running, "got:after"),
        "{}",
        home.screen(&running)
    );
    assert_eq!(agent(&home, &running).unwrap()["pid"], before[0]["pid"]);
    assert_eq!(
        start_script(&mut open(&home), &home, "next", "sleep 60"),
        "a3",
        "numbering goes on"
    );
    // Checkpoints and screen logs contain terminal output, so only the user may read them. On
    // Windows they inherit the home's permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let screens = home.path.join("core/screens");
        assert_eq!(std::fs::metadata(&screens).unwrap().mode() & 0o777, 0o700);
        for agent in [&running, &ended] {
            let dir = screens.join(agent);
            assert_eq!(
                std::fs::metadata(&dir).unwrap().mode() & 0o777,
                0o700,
                "{}",
                dir.display()
            );
            for file in std::fs::read_dir(&dir).unwrap() {
                let file = file.unwrap().path();
                assert_eq!(
                    std::fs::metadata(&file).unwrap().mode() & 0o777,
                    0o600,
                    "{}",
                    file.display()
                );
            }
        }
    }
}

#[test]
fn a_daemon_that_stops_answering_is_replaced() {
    let home = TestHome::new("stalled");
    let agent = home.start_fake("w1");
    let old = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .unwrap() as i32;
    pause_process(old);
    let stalled = Instant::now();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    assert!(
        stalled.elapsed() >= secs(14) && stalled.elapsed() < secs(20),
        "replaced after {:?}",
        stalled.elapsed()
    );
    assert!(
        home.keeper_log()
            .contains(&format!("daemon {old} sent no ping for 15 seconds")),
        "{}",
        home.keeper_log()
    );
    assert!(
        home.agent_from_watch("w1")
            .is_some_and(|agent| agent["process"] == "running")
            && alive(&agent.process)
    );
}

/// The daemon ends after committing a record's deletion but before deleting the agent's screen
/// folder. The next daemon finishes the removal.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_removal_interrupted_after_its_record_is_deleted_is_finished_by_the_next_daemon() {
    let home = TestHome::new("halfremoved");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-record-delete")]);
    let mut wire = open(&home);
    let doomed = start_script(&mut wire, &home, "doomed", "echo DOOMED; exit 0");
    assert!(wait_until(LOADED_TIMEOUT, || agent(&home, &doomed)
        .is_some_and(|agent| agent["process"] == "ended")));
    let daemon = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .unwrap() as i32;
    let keeper = home.lock_record("keeper").expect("a keeper").0;
    let keeper_process = process_identity(keeper);
    let removing = wire.send(
        "call",
        json!({ "op": "agent.remove", "args": { "target": doomed } }),
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || stopped(daemon)),
        "the daemon did not stop after deleting the record"
    );
    kill_process(daemon);
    assert!(
        wire.wait_for_response(removing, secs(1)).is_none(),
        "the interrupted removal must not report a confirmed outcome"
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || !alive(&keeper_process)),
        "a keeper holding nothing exits with its daemon: {}",
        home.keeper_log()
    );
    // The ended run was released before the removal, so the keeper held nothing and ended with the
    // daemon. A command starts the next daemon.
    let listed = home.run_facade(&["list"]);
    assert_eq!(
        (listed.status.code(), stdout(&listed), stderr(&listed)),
        (Some(0), String::new(), "No active agents.\nStart one with 'facade start codex', or run 'facade resume' to find saved sessions.\n".to_string())
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || !home
            .path
            .join("core/screens")
            .join(&doomed)
            .exists()),
        "the screen folder is deleted"
    );
    assert!(
        home.daemon_log()
            .contains(&format!("deleting the screen folder of {doomed}")),
        "{}",
        home.daemon_log()
    );
}

/// The daemon ends after the keeper starts a run but before its record is committed. Recovery must
/// stop and remove the run without reusing its agent number.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_start_interrupted_before_its_record_is_undone_and_its_number_never_reused() {
    let home = TestHome::new("halfstarted");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-run-start")]);
    let mut wire = open(&home);
    let daemon = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .unwrap() as i32;
    let args = json!({
        "cli": home.shell_cli(),
        "args": ["-c", "echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > orphan-pid; sleep 60"],
        "name": "orphan", "folder": home.project, "env": { "PATH": SYSTEM_PATH.as_str() },
        "size": { "cols": 80, "rows": 24 },
    });
    wire.send("call", json!({ "op": "agent.start", "args": args }));
    assert!(
        wait_until(secs(10), || stopped(daemon)),
        "the daemon did not stop after starting the run"
    );
    let orphan = read_pid(&home, "orphan-pid");
    let orphan_process = process_identity(orphan);
    kill_process(daemon);
    home.wait_for_daemon_after(daemon, secs(30))
        .expect("a replacement daemon");
    assert!(home.agents().is_empty(), "{:?}", home.agents());
    assert!(
        wait_until(secs(10), || !alive(&orphan_process)),
        "the run without a record keeps running"
    );
    assert_eq!(
        start_script(&mut open(&home), &home, "next", "sleep 60"),
        "a2",
        "the interrupted start's number is not reused"
    );
}

#[test]
fn attach_reconnects_without_leaving_or_duplicating_the_view() {
    let home = TestHome::new("reattach");
    let mut wire = connect(&home);
    let agent_id = start_script(
        &mut wire,
        &home,
        "lines",
        "seq -f 'numbered-%03g' 1 150; echo READY; while read line; do echo \"got:$line\"; done",
    );
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .env("FACADE_TEST_GATES", "attach-evidence")
            .args(["attach", &agent_id]),
        80,
        24,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("READY")),
        "{}",
        term.text()
    );
    for round in 1..=2 {
        let reconnected = home.path.join("core/reached-attach-reconnected");
        if round > 1 {
            std::fs::remove_file(&reconnected).unwrap();
        }
        let previous = term.output_len();
        let old = home.kill_daemon();
        home.wait_for_daemon_after(old, secs(30))
            .expect("a replacement daemon");
        assert!(
            term.wait_for_bytes(previous, b"READY", secs(10)),
            "attempt {round}: {}",
            term.text()
        );
        // The first visible bytes can arrive while the rest of the frame is still being drawn.
        home.wait_for_gate("attach-reconnected");
        // The reconnect redraws the view in place: the host keeps its alternate screen, and the
        // agent's visible rows are there once.
        assert!(term.on_alternate_screen(), "attempt {round}");
        let redraw = String::from_utf8_lossy(&term.output_since(previous)).into_owned();
        assert!(
            !redraw.contains("\x1b[?1049"),
            "attempt {round}: {redraw:?}"
        );
        let shown = term.text();
        for row in ["numbered-150", "READY"] {
            assert_eq!(
                shown.matches(row).count(),
                1,
                "attempt {round}, {row}:\n{shown}"
            );
        }
    }
    assert_eq!(term.output_count(ATTACH_RECONNECT_NOTE), 0);
    assert_eq!(
        term.output_count("bytes typed while disconnected were not sent"),
        0
    );
    term.send(b"after\r");
    assert!(
        term.wait_for(secs(10), |text| text.contains("got:after")),
        "{}",
        term.text()
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success())
    );
    assert!(!term.on_alternate_screen(), "left on the alternate screen");
}

/// Disconnected input is discarded. Attach redraws the screen before reporting its UTF-8 bytes.
#[test]
fn keys_typed_while_attach_is_disconnected_are_reported_after_the_redraw() {
    let home = TestHome::new("offlinekeys");
    let agent = home.start_fake("w1");
    let away = "界";
    let note = format!(
        "Reconnected to w1 ({}). {} bytes typed while disconnected were not sent; check the screen and retype if needed.",
        agent.address,
        away.len()
    );
    // Allow the whole notice plus the terminal's last column, even with a long runner hostname.
    let cols = u16::try_from(note.len() + 1).expect("the reconnect notice fits a terminal");
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .env("FACADE_TEST_GATES", "attach-evidence")
            .args(["attach", "w1"]),
        cols,
        30,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯")),
        "{}",
        term.text()
    );
    let marker = "the retained terminal screen";
    term.send(format!("{marker}\r").as_bytes());
    assert!(term.wait_for(secs(10), |text| text.contains(marker)));
    assert!(wait_until(secs(10), || home.submitted_messages() == [marker]));
    let keeper = home.keeper_pid().expect("a keeper");
    // The paused keeper starts no daemon, so the attachment stays disconnected while the keys are
    // typed.
    pause_process(keeper);
    home.kill_daemon();
    assert!(wait_until(secs(10), || home.hello_result().is_none()));
    // The socket can disappear before Attach switches its input queue to disconnected.
    home.wait_for_gate("attach-disconnected");
    let disconnected = term.output_len();
    term.send(away.as_bytes());
    home.wait_for_gate("attach-buffered-input");
    resume_process(keeper);
    assert!(term.wait_for_output(secs(15), &note), "{}", term.text());
    let written = term.output_since(disconnected);
    let written = String::from_utf8_lossy(&written);
    assert!(
        written
            .find(marker)
            .zip(written.find(&note))
            .is_some_and(|(screen, notice)| screen < notice),
        "{written:?}"
    );
    term.send(b"after\r");
    assert!(
        wait_until(secs(10), || home.submitted_messages() == [marker, "after"]),
        "{:?}",
        home.submitted_messages()
    );
    for point in ["attach-disconnected", "attach-buffered-input"] {
        std::fs::remove_file(home.path.join(format!("core/reached-{point}"))).unwrap();
    }
    pause_process(keeper);
    home.kill_daemon();
    assert!(wait_until(secs(10), || home.hello_result().is_none()));
    home.wait_for_gate("attach-disconnected");
    term.send(b"never sent");
    home.wait_for_gate("attach-buffered-input");
    term.send(b"\x1d");
    let status = term
        .wait_exit(secs(5))
        .expect("Ctrl-] ends a disconnected attachment");
    resume_process(keeper);
    assert!(status.success(), "{status:?}");
    assert!(
        term.wait_for(secs(2), |text| text
            .contains("warning: 10 bytes you typed were not sent")
            && text.contains("Detached from ")),
        "{}",
        term.text()
    );
}

/// When the keeper and the daemon both end, no Facade process holds the terminals any more. The
/// next daemon recovers the saved screens and lists the agents as ended because their terminals
/// closed. A CLI that ignores the hangup may still run; Facade never signals its recorded process
/// ID. Stop, input and attach refuse the ended agent, and remove deletes the record.
#[test]
fn when_both_services_end_agents_are_ended_because_their_terminals_closed_and_nothing_is_signalled()
{
    let home = TestHome::new("bothended");
    let mut wire = connect(&home);
    let agent_id = start_script(
        &mut wire,
        &home,
        "survivor",
        "trap '' HUP; echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > survivor-pid; echo SURVIVOR-READY; while :; do sleep 1; done",
    );
    assert!(wait_for_screen_text(&home, &agent_id, "SURVIVOR-READY"));
    let survivor = read_pid(&home, "survivor-pid");
    let survivor_process = process_identity(survivor);
    let keeper = home.keeper_pid().expect("a keeper");
    let keeper_process = process_identity(keeper);
    let daemon = home.lock_record("daemon").unwrap().0;
    let daemon_process = process_identity(daemon);
    pause_process(daemon);
    kill_process(keeper);
    kill_process(daemon);
    assert!(wait_until(secs(5), || !alive(&keeper_process)
        && !alive(&daemon_process)));
    // A terminal whose last holder ended leaves a CLI that ignores the hang-up running on Unix;
    // on Windows the console ends, and with it every program in it.
    #[cfg(unix)]
    assert!(
        alive(&survivor_process),
        "the CLI ignores the hangup and survives both services"
    );
    #[cfg(windows)]
    assert!(
        wait_until(secs(15), || !alive(&survivor_process)),
        "the CLI outlived its console"
    );
    home.run_facade_ok(&["status", &agent_id]);
    let ended = agent(&home, &agent_id).unwrap();
    assert!(
        ended["process"] == "ended"
            && ended["exit"]["reason"] == "terminal_closed"
            && ended["exit"].get("code").is_none(),
        "{ended}"
    );
    assert!(
        home.screen(&agent_id).contains("SURVIVOR-READY"),
        "the saved screen comes back"
    );
    let mut wire = open(&home);
    let stopped = wire.call_ok(
        "agent.stop",
        json!({ "selection": { "kind": "targets", "targets": [agent_id] } }),
    );
    assert_eq!(stopped["items"][0]["status"], "failed", "{stopped}");
    assert_eq!(
        stopped["items"][0]["error"]["data"]["reason"], "ended",
        "{stopped}"
    );
    let target = agent(&home, &agent_id).unwrap()["reference"].clone();
    let typed = wire.call(
        "agent.type",
        json!({ "target": target, "input": { "kind": "raw", "raw": facade_base::base64::encode(b"x") } }),
    );
    assert_eq!(error_reason(&typed), "ended", "{typed}");
    let address = ended["address"].as_str().expect("the recovered reference");
    let refused = home.run_facade(&["type", &agent_id, "x"]);
    assert_eq!(
        (stdout(&refused), stderr(&refused), refused.status.code()),
        (
            String::new(),
            format!("error: survivor ({address}) has stopped and cannot accept input.\n"),
            Some(1),
        )
    );
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &agent_id]),
        80,
        24,
    );
    let status = term
        .wait_exit(secs(10))
        .expect("an attachment to an ended agent is refused");
    assert_eq!(status.code(), Some(1), "attaching to an ended agent fails");
    let shown = |term: &TestTerminal| term.text_with_scrollback();
    let stopped = format!("error: survivor ({address}) has stopped.");
    let read = format!("Read its final screen with 'facade screen {address}'.");
    assert!(
        wait_until(secs(2), || {
            let text = shown(&term);
            text.contains(&stopped) && text.contains(&read)
        }),
        "{}",
        shown(&term)
    );
    home.remove_agent(&agent_id);
    assert!(home.agents().is_empty());
    std::thread::sleep(Duration::from_millis(500));
    // On Windows the CLI ended with its console, before any stop.
    #[cfg(unix)]
    assert!(
        alive(&survivor_process),
        "neither stop nor remove signals the recorded process ID"
    );
    kill_process(survivor);
}

/// A stop in progress when the daemon dies still ends the process group at the keeper's original
/// deadline. The caller learns that the outcome is unknown.
// A process group and SIGHUP are Unix's: a Windows stop closes the console and ends the job.
#[cfg(unix)]
#[test]
fn a_stop_in_progress_when_the_daemon_dies_still_ends_the_agent_at_its_deadline() {
    let home = TestHome::new("stopdeadline");
    let mut wire = connect(&home);
    let script = "trap 'touch hup-seen' HUP; sh -c 'trap \"\" HUP; echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > member-pid; exec \
                  sleep 60' & echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > leader-pid; echo READY; while :; do sleep 1; done";
    let agent_id = start_script(&mut wire, &home, "stubborn", script);
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let (leader, member) = (read_pid(&home, "leader-pid"), read_pid(&home, "member-pid"));
    let leader_process = process_identity(leader);
    let member_process = process_identity(member);
    std::thread::scope(|scope| {
        let stopping = scope.spawn(|| home.run_facade(&["stop", &agent_id]));
        assert!(
            wait_until(secs(5), || home.project.join("hup-seen").exists()),
            "the stop was not accepted"
        );
        let accepted = Instant::now();
        let daemon = home.kill_daemon();
        let stopped = stopping.join().unwrap();
        assert!(
            !stopped.status.success() && stderr(&stopped).contains("the outcome is unknown"),
            "{}",
            stderr(&stopped)
        );
        home.wait_for_daemon_after(daemon, secs(30))
            .expect("a replacement daemon");
        assert!(
            wait_until(secs(5), || !alive(&leader_process)
                && !alive(&member_process)),
            "the group outlived its deadline"
        );
        assert!(
            accepted.elapsed() < secs(5),
            "the group ended {:?} after the stop",
            accepted.elapsed()
        );
    });
    let killed =
        |agent: &Value| agent["process"] == "ended" && agent["exit"]["signal"] == "SIGKILL";
    assert!(
        wait_until(secs(5), || agent(&home, &agent_id)
            .is_some_and(|agent| killed(&agent))),
        "{:?}",
        agent(&home, &agent_id)
    );
}

/// An ended CLI may leave another process holding its terminal open. That process must not delay
/// recovery. Test on Linux; macOS closes that process's terminal when the CLI ends.
#[test]
fn an_ended_run_whose_terminal_a_descendant_holds_does_not_hold_up_recovery() {
    let home = TestHome::new("heldterminal");
    let mut wire = connect(&home);
    let agent_id = start_script(
        &mut wire,
        &home,
        "parent",
        "sh -c 'trap \"\" HUP; exec sleep 60' & echo READY; exit 3",
    );
    assert!(wait_until(secs(10), || agent(&home, &agent_id)
        .is_some_and(|agent| agent["process"] == "ended")));
    home.kill_daemon();
    // The saved exit released the run, so no keeper holds it and none restarts the daemon. A
    // command starts the next one.
    let started = Instant::now();
    let inspected = home.run_facade_ok(&["status", &agent_id]);
    assert!(
        inspected
            .lines()
            .any(|line| line.starts_with("State ") && line[5..].trim() == "Ended (code 3)"),
        "{inspected}"
    );
    assert!(
        started.elapsed() < secs(4),
        "recovery took {:?}",
        started.elapsed()
    );
    assert_eq!(agent(&home, &agent_id).unwrap()["exit"]["code"], 3);
}

#[test]
fn a_hundred_agents_are_recovered_without_a_stall_kill_and_listed_all_at_once() {
    let home = TestHome::new("hundred");
    let mut wire = connect(&home);
    let ids: Vec<String> = (0..100)
        .map(|n| {
            start_script(
                &mut wire,
                &home,
                &format!("agent{n}"),
                &format!("echo READY-{n}; sleep 600"),
            )
        })
        .collect();
    assert!(wait_for_screen_text(&home, &ids[99], "READY-99"));
    let old = home.kill_daemon();
    // A client either cannot connect yet or sees every agent.
    let mut seen = None;
    assert!(
        wait_until(secs(60), || {
            let hello = home.hello_result();
            if let Some(hello) = hello.filter(|hello| hello["pid"].as_i64() != Some(old as i64)) {
                seen = Some(hello["agent_count"].clone());
            }
            seen.is_some()
        }),
        "no replacement daemon"
    );
    assert_eq!(seen, Some(json!(100)));
    assert_eq!(home.agents().len(), 100);
    assert!(home.screen(&ids[0]).contains("READY-0") && home.screen(&ids[99]).contains("READY-99"));
    assert!(
        !home.keeper_log().contains("sent no ping"),
        "{}",
        home.keeper_log()
    );
}

/// Deliver a screen log through a FIFO in 4 MiB chunks every four seconds. Recovery must last
/// beyond the 15-second watchdog deadline and keep the daemon alive by pinging as replay advances.
#[cfg(unix)]
#[test]
fn a_slow_recovery_that_keeps_progressing_is_not_killed() {
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let home = TestHome::new("slowrecovery");
    let mut wire = connect(&home);
    let agent_id = start_script(&mut wire, &home, "slow", "echo READY; sleep 600");
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let keeper = home.keeper_pid().expect("a keeper");
    // The paused keeper starts no daemon while the published generation's log becomes a FIFO.
    pause_process(keeper);
    let old_process = process_identity(home.lock_record("daemon").unwrap().0);
    let old = home.kill_daemon();
    assert!(wait_until(secs(5), || !alive(&old_process)));
    let screens = home.path.join("core/screens").join(&agent_id);
    let published = std::fs::read_to_string(screens.join("current")).unwrap();
    let log = screens.join(format!("{}.log", published.trim()));
    let logged = std::fs::read(&log).unwrap();
    std::fs::remove_file(&log).unwrap();
    make_fifo(&log);
    resume_process(keeper);
    let recovering = next_started_daemon(&home, &[old]);
    let recovering_process = process_identity(recovering);
    // A writer can open the FIFO without waiting only once the recovering daemon opened it to read.
    let mut fifo = None;
    assert!(
        wait_until(secs(30), || {
            fifo = std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&log)
                .ok();
            fifo.is_some()
        }),
        "recovery did not open the log"
    );
    let mut fifo = fifo.unwrap();
    // SAFETY: F_SETFL changes this test's descriptor flags. Clearing O_NONBLOCK makes writes wait
    // for the reader.
    assert_eq!(
        unsafe { libc::fcntl(fifo.as_raw_fd(), libc::F_SETFL, 0) },
        0
    );
    fifo.write_all(&logged).unwrap();
    let record = [
        format!("output {}\n", 64 * 1024).into_bytes(),
        vec![0; 64 * 1024],
        b"\n".to_vec(),
    ]
    .concat();
    for step in 1..=5 {
        for _ in 0..64 {
            fifo.write_all(&record).unwrap_or_else(|err| {
                panic!(
                    "step {step}: the recovering daemon stopped reading ({err}): {}",
                    home.keeper_log()
                )
            });
        }
        std::thread::sleep(Duration::from_secs(4));
        assert!(
            alive(&recovering_process),
            "step {step}: the slow recovery was killed: {}",
            home.keeper_log()
        );
    }
    drop(fifo);
    assert_eq!(
        home.wait_for_daemon_after(old, secs(30)),
        Some(recovering),
        "the recovering daemon serves once its log ends"
    );
    assert!(
        !home.keeper_log().contains("sent no ping"),
        "{}",
        home.keeper_log()
    );
    assert!(agent(&home, &agent_id).is_some_and(|agent| agent["process"] == "running"));
    assert!(home.screen(&agent_id).contains("READY"));
}

/// Recovery narrows a running CLI's terminal by one column, then returns it to the logged size to
/// prompt a redraw.
// The narrower step of the redraw nudge is Unix's to check: a Windows CLI may not see it.
#[cfg(unix)]
#[test]
fn the_redraw_nudge_shows_the_cli_a_narrower_terminal_and_then_its_own() {
    let home = TestHome::new("nudge");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "inside-nudge")]);
    let mut wire = connect(&home);
    let agent_id = start_script(
        &mut wire,
        &home,
        "sizes",
        "trap 'stty size >> sizes' WINCH; echo READY; while :; do sleep 0.1; done",
    );
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let old = home.kill_daemon();
    assert!(
        wait_until(secs(10), || home
            .lock_record("daemon")
            .is_some_and(|(pid, _)| pid != old && stopped(pid))),
        "the replacement did not reach inside-nudge"
    );
    let replacement = home.lock_record("daemon").unwrap().0;
    assert!(home.path.join("core/paused-at-inside-nudge").exists());
    assert!(wait_until(secs(10), || std::fs::read_to_string(
        home.project.join("sizes")
    )
    .unwrap_or_default()
    .contains("24 79")));
    resume_process(replacement);
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    let sizes = || std::fs::read_to_string(home.project.join("sizes")).unwrap_or_default();
    assert!(
        wait_until(secs(5), || sizes().lines().count() >= 2),
        "{:?}",
        sizes()
    );
    assert_eq!(sizes().lines().collect::<Vec<_>>(), ["24 79", "24 80"]);
}

/// The two redraws the nudge prompts leave a recovered CLI's screen as it was: the test CLI redraws
/// in place, as a real CLI does, so neither adds its frame to the scrollback, and the screen reads
/// as before, its banner once.
#[test]
fn a_recovered_cli_s_screen_reads_as_before_after_the_nudge_s_redraws() {
    let home = TestHome::new("nudgeframes");
    home.start_named_fake("idle", &[]);
    let screen = || stdout(&home.run_facade(&["screen", "idle", "--lines", "1000"]));
    assert!(
        wait_until(secs(10), || screen().contains("Enter to send")),
        "{}",
        screen()
    );
    let before = screen();
    let cols = before
        .lines()
        .find(|line| line.starts_with('─'))
        .map(|line| line.chars().count())
        .expect("the input's frame");
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    // The CLI draws its input's frame across the terminal: once one column narrower, then at its
    // own width again. A Windows CLI may not see a narrower size it holds this briefly; the
    // console host redraws the whole screen after a resize all the same.
    #[cfg(unix)]
    {
        let logged = || {
            let screens = std::fs::read_dir(home.path.join("core/screens/a1"))
                .into_iter()
                .flatten()
                .flatten();
            screens
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
                .map(|entry| std::fs::read(entry.path()).unwrap_or_default())
                .collect::<Vec<_>>()
        };
        let narrow = format!("\x1b[2m{}\x1b[0m", "─".repeat(cols - 1)).into_bytes();
        assert!(
            wait_until(secs(10), || logged()
                .iter()
                .any(|log| log.windows(narrow.len()).any(|bytes| bytes == narrow))),
            "no narrower frame"
        );
    }
    let own = "─".repeat(cols);
    assert!(
        wait_until(secs(10), || screen().lines().any(|line| line == own)),
        "{}",
        screen()
    );
    let after = screen();
    assert_eq!(after.matches("(Facade test CLI)").count(), 1, "{after}");
    assert_eq!(after, before);
}

/// A successful `agent.type` confirms queued input. Daemon failure loses bytes still in that queue;
/// recovery must not repeat input.
// Input queued in a terminal is Unix's: a pseudo console's host reads all its input.
#[cfg(unix)]
#[test]
fn input_queued_when_the_daemon_dies_is_lost_and_never_sent_twice() {
    let home = TestHome::new("queuedinput");
    let mut wire = connect(&home);
    let script = "stty raw -echo; echo READY; while [ ! -e resume ]; do sleep 0.1; done; stty min \
                  0 time 20; cat > got; echo COUNTED; sleep 60";
    let agent_id = start_script(&mut wire, &home, "deaf", script);
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let mut sent = Vec::new();
    let target = home.inspect_agent(&agent_id)["agent"]["reference"].clone();
    for chunk in 0..4u8 {
        let bytes = vec![b'a' + chunk; 256 * 1024];
        let typed = wire.call(
            "agent.type",
            json!({ "target": target, "input": { "kind": "raw", "raw": facade_base::base64::encode(&bytes) } }),
        );
        assert!(typed["result"].is_object(), "{typed}");
        sent.extend(bytes);
    }
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    std::fs::write(home.project.join("resume"), "").unwrap();
    assert!(
        wait_for_screen_text(&home, &agent_id, "COUNTED"),
        "{}",
        home.screen(&agent_id)
    );
    let got = std::fs::read(home.project.join("got")).unwrap();
    assert!(
        got.len() < sent.len(),
        "all {} bytes arrived: some input queued before the daemon ended should be missing",
        got.len()
    );
    assert!(
        sent.starts_with(&got),
        "the {} bytes that arrived are not the start of what was typed",
        got.len()
    );
}

/// Makes `path` a FIFO. Opening it waits for the other end, so a daemon opening it is stuck there.
#[cfg(unix)]
fn make_fifo(path: &std::path::Path) {
    let path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    // SAFETY: mkfifo reads the NUL-terminated path.
    assert_eq!(
        unsafe { libc::mkfifo(path.as_ptr(), 0o600) },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
}

/// If the daemon ends during its redraw nudge, the terminal stays one column narrower. Recovery
/// must use the screen log's size and reset the terminal to it.
// The narrower step of the redraw nudge is Unix's to check: a Windows CLI may not see it.
#[cfg(unix)]
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_daemon_ending_inside_its_redraw_nudge_leaves_the_agent_s_size() {
    let home = TestHome::new("nudgecrash");
    let marker = start_facade_with_pause_disarmed(&home, "inside-nudge");
    let mut wire = open(&home);
    let agent_id = start_script(
        &mut wire,
        &home,
        "sizes",
        "trap 'stty size >> sizes' WINCH; echo READY; while :; do sleep 0.05; done",
    );
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let sizes = || std::fs::read_to_string(home.project.join("sizes")).unwrap_or_default();
    let mut daemon = home.hello_result().unwrap()["pid"].as_i64().unwrap() as i32;
    let mut known = vec![daemon];
    for round in 1..=3 {
        // The next daemon stops itself inside its nudge, with the terminal a column narrower, and
        // is ended there.
        std::fs::remove_file(&marker).unwrap();
        kill_process(daemon);
        daemon = next_started_daemon(&home, &known);
        known.push(daemon);
        assert!(
            wait_until(secs(30), || stopped(daemon)),
            "attempt {round}: the daemon did not stop inside its nudge"
        );
        assert!(
            wait_until(secs(10), || sizes()
                .lines()
                .filter(|line| *line == "24 79")
                .count()
                >= round),
            "attempt {round}: {:?}",
            sizes()
        );
    }
    kill_process(daemon);
    home.wait_for_daemon_after(daemon, secs(30))
        .expect("a daemon that finishes its nudge");
    assert!(
        wait_until(secs(5), || sizes().lines().last() == Some("24 80")),
        "{:?}",
        sizes()
    );
    assert!(
        sizes()
            .lines()
            .all(|line| line == "24 80" || line == "24 79"),
        "the nudge is always one column: {:?}",
        sizes()
    );
    assert_eq!(agent(&home, &agent_id).unwrap()["size"]["cols"], 80);
}

/// Logging a resize before applying it lets recovery reproduce the size and output drawn at that
/// size.
#[test]
fn a_resize_survives_the_daemon_with_what_was_drawn_at_it() {
    let home = TestHome::new("resized");
    let mut wire = connect(&home);
    let agent_id = start_script(
        &mut wire,
        &home,
        "wide",
        "stty -echo; echo READY; while read line; do echo \"$line\"; done",
    );
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let opened = wire.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": agent_id } }),
    );
    let watch = opened["result"]["watch"]
        .as_u64()
        .unwrap_or_else(|| panic!("{opened}"));
    wire.call_ok(
        "attach.resize",
        json!({ "watch": watch, "size": { "cols": 100, "rows": 30 } }),
    );
    let wide = format!("{}END", "w".repeat(92));
    type_raw(&mut wire, &agent_id, &format!("{wide}\r"));
    assert!(
        wait_for_screen_text(&home, &agent_id, "END"),
        "{}",
        home.screen(&agent_id)
    );
    let before = home.screen(&agent_id);
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    let recovered = agent(&home, &agent_id).unwrap();
    assert_eq!(
        recovered["size"],
        json!({ "cols": 100, "rows": 30 }),
        "{recovered}"
    );
    assert_eq!(home.screen(&agent_id), before);
}

/// The redraw after a reconnect restores the cursor the agent saved, and nothing is drawn over it
/// afterwards.
#[test]
fn a_reconnect_keeps_the_cursor_the_agent_saved() {
    let home = TestHome::new("savedcursor");
    let mut wire = connect(&home);
    let script = "printf '\\033[2J\\033[2;3H\\0337\\033[4;5HREADY'; while [ ! -e go ]; do sleep \
                  0.1; done; printf '\\0338X'; sleep 60";
    let agent_id = start_script(&mut wire, &home, "cursor", script);
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", &agent_id]),
        80,
        24,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("READY")),
        "{}",
        term.text()
    );
    let previous = term.output_len();
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    assert!(
        term.wait_for_bytes(previous, b"READY", secs(10)),
        "{}",
        term.text()
    );
    assert_eq!(term.output_count(ATTACH_RECONNECT_NOTE), 0);
    assert_eq!(
        term.output_count("bytes typed while disconnected were not sent"),
        0
    );
    std::fs::write(home.project.join("go"), "").unwrap();
    // The agent saved its cursor two rows above READY, in column 3.
    let x_where_saved = || {
        let shown = term.text_with_scrollback();
        let lines: Vec<&str> = shown.lines().collect();
        lines
            .iter()
            .position(|line| *line == "    READY")
            .is_some_and(|ready| ready >= 2 && lines[ready - 2] == "  X")
    };
    assert!(
        wait_until(secs(10), x_where_saved),
        "ESC 8 must return where the agent saved its cursor:\n{}\nagent: {}",
        term.text_with_scrollback(),
        home.screen(&agent_id)
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success())
    );
}

/// The input queue is full and the daemon cannot read more keys. Signals must end attachment
/// without waiting; Ctrl-] waits at most one second. Both restore the person's terminal.
#[cfg(unix)]
#[test]
fn attach_ends_at_once_on_a_signal_or_ctrl_bracket_while_its_input_is_blocked() {
    let home = TestHome::new("blockedinput");
    let mut wire = connect(&home);
    let agent_id = start_script(
        &mut wire,
        &home,
        "deaf",
        "stty raw -echo; printf READY; sleep 600",
    );
    assert!(wait_for_screen_text(&home, &agent_id, "READY"));
    let target = home.inspect_agent(&agent_id)["agent"]["reference"].clone();
    let full = wire.call(
        "agent.type",
        json!({
            "target": target, "input": {
                "kind": "raw", "raw": facade_base::base64::encode(&vec![b'a'; 1024 * 1024]),
            },
        }),
    );
    assert!(full["result"].is_object(), "{full}");
    for end in ["SIGTERM", "SIGHUP", "ctrl-]"] {
        let mut term = TestTerminal::spawn(
            home.command(&test_binaries().facade)
                .args(["attach", &agent_id]),
            80,
            24,
        );
        assert!(
            term.wait_for(secs(10), |text| text.contains("READY")),
            "{end}: {}",
            term.text()
        );
        // Type on a separate thread because typing blocks if the attachment stops reading input.
        let mut keys = vec![b'b'; 256 * 1024];
        if end == "ctrl-]" {
            keys.push(0x1d);
        }
        let mut keyboard = term.keyboard();
        let (typing, typed) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = keyboard.write_all(&keys);
            let _ = typing.send(());
        });
        std::thread::sleep(Duration::from_millis(500));
        match end {
            "SIGTERM" => send_signal(term.pid(), libc::SIGTERM),
            "SIGHUP" => send_signal(term.pid(), libc::SIGHUP),
            // Ctrl-]'s second counts from when the attachment took the keys before it, which a
            // loaded machine delivers later than half a second.
            _ => typed
                .recv_timeout(LOADED_TIMEOUT)
                .expect("the attachment takes the keys before Ctrl-]"),
        }
        let ended = Instant::now();
        let status = term.wait_exit(secs(5));
        assert!(status.is_some(), "{end}: the attachment did not end");
        assert!(
            ended.elapsed() < secs(3),
            "{end}: it took {:?}",
            ended.elapsed()
        );
        assert!(
            term.canonical_input_and_echo_enabled(),
            "{end}: the terminal was left raw"
        );
    }
}

/// While the keeper runs, a client starts no daemon of its own: attach waits for the paused
/// keeper's, so its reconnect attempts time out. Attach keeps retrying past one ten-second attempt,
/// sends no key twice, and ends at once on Ctrl-].
#[test]
fn attach_keeps_retrying_while_recovery_waits_and_detaches_at_once() {
    let home = TestHome::new("heldrecovery");
    home.start_fake("w1");
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .env("FACADE_TEST_GATES", "attach-evidence")
            .args(["attach", "w1"]),
        100,
        30,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯")),
        "{}",
        term.text()
    );
    let keeper = home.keeper_pid().expect("a keeper");
    pause_process(keeper);
    home.kill_daemon();
    assert!(wait_until(secs(10), || home.hello_result().is_none()));
    home.wait_for_gate("attach-disconnected");
    term.send(b"held keys");
    home.wait_for_gate("attach-buffered-input");
    std::thread::sleep(secs(12));
    assert_eq!(
        home.daemon_log().matches(" listening on ").count(),
        1,
        "a client started a daemon: {}",
        home.daemon_log()
    );
    assert!(
        term.wait_exit(Duration::from_millis(10)).is_none(),
        "attach gave up: {}",
        term.text()
    );
    let detached = Instant::now();
    term.send(b"\x1d");
    let status = term.wait_exit(secs(5)).expect("Ctrl-] ends the attachment");
    assert!(
        detached.elapsed() < secs(3),
        "it took {:?}",
        detached.elapsed()
    );
    assert!(status.success(), "{status:?}");
    assert!(
        term.wait_for(secs(2), |text| text
            .contains("warning: 9 bytes you typed were not sent")
            && text.contains("Detached from ")),
        "{}",
        term.text()
    );
    resume_process(keeper);
    assert!(
        home.submitted_messages().is_empty(),
        "{:?}",
        home.submitted_messages()
    );
}

#[test]
fn a_failed_exit_commit_retains_evidence_and_delays_idle_until_it_succeeds() {
    let home = TestHome::new("failedcommit");
    home.start_facade_with(&[("FACADE_TEST_GATES", "commit-evidence")]);
    let mut wire = connect(&home);
    let id = start_script(&mut wire, &home, "saving", "echo READY; read line; exit 6");
    assert!(wait_for_screen_text(&home, &id, "READY"));
    let fail = home.path.join("core/fail-exit-commit");
    std::fs::write(&fail, "").unwrap();
    type_raw(&mut wire, &id, "end\r");
    home.wait_for_gate("failed-exit-commit");
    drop(wire);
    assert!(wait_until(secs(5), || home
        .daemon_log()
        .contains("idle exit delayed: could not save the exit")));
    std::thread::sleep(secs(7));
    assert!(socket_exists(&home.daemon_socket()) && socket_exists(&home.keeper_socket()));
    assert_eq!(
        home.daemon_log()
            .matches("idle exit delayed: could not save the exit")
            .count(),
        1
    );
    std::fs::remove_file(fail).unwrap();
    home.wait_for_idle_exit();
    let store = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    assert_eq!(
        store
            .query_row(
                "SELECT exit_code FROM agents WHERE agent_id=?1",
                [&id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        6
    );
}

#[cfg(unix)]
#[test]
fn a_blocked_log_open_keeps_exit_drain_and_the_socket_pending() {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let home = TestHome::new("blockeddrain");
    home.start_facade_with(&[("FACADE_TEST_GATES", "drain-evidence")]);
    let mut wire = connect(&home);
    let id = start_script(
        &mut wire,
        &home,
        "draining",
        "printf READY; while [ ! -e go ]; do sleep 0.05; done; head -c 4194299 /dev/zero; exit 0",
    );
    assert!(wait_for_screen_text(&home, &id, "READY"));
    let log = home.path.join("core/screens").join(&id).join("2.log");
    make_fifo(&log);
    std::fs::write(home.project.join("go"), "").unwrap();
    let mut asked = 0;
    assert!(wait_until(secs(10), || {
        asked = wire.send(
            "call",
            json!({ "op": "agent.screen", "args": { "target": id, "lines": 1 } }),
        );
        wire.wait_for_response(asked, Duration::from_millis(500))
            .is_none()
    }));
    assert!(wire.wait_for_response(asked, secs(1)).is_none());
    // Exactly 4 MiB crossed the terminal before log opening blocks: the producer can exit without
    // pending PTY bytes.
    drop(wire);
    let store = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    assert!(wait_until(secs(5), || store
        .query_row(
            "SELECT exit_at FROM agents WHERE agent_id=?1",
            [&id],
            |row| row.get::<_, Option<String>>(0)
        )
        .unwrap()
        .is_some()));
    // The daemon marks this once its exit has begun with the drain and the blocked writer counted.
    home.wait_for_gate("exit-drain-and-writer-counted");
    std::thread::sleep(secs(7));
    assert!(
        socket_exists(&home.daemon_socket()),
        "the blocked writer and exit drain are still work"
    );
    let mut read = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&log)
        .unwrap();
    let drain = std::thread::spawn(move || {
        let until = Instant::now() + secs(15);
        let mut bytes = [0; 65536];
        while Instant::now() < until {
            match read.read(&mut bytes) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => break,
            }
        }
    });
    home.wait_for_idle_exit();
    drain.join().unwrap();
}
