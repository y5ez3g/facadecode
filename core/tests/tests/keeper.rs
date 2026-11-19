//! Keeper authentication, PTY ownership, process group stops, replacement of a keeper that ends,
//! and shutdown.

use std::time::{Duration, Instant};

use facade_scenarios::serde_json::json;
use facade_scenarios::*;

/// Only the daemon holding the daemon lock may connect. Any other process is closed as it connects,
/// before it can start or stop a CLI.
#[test]
fn the_keeper_refuses_every_process_but_its_own_daemon_at_hello() {
    use std::io::Read;
    let home = TestHome::new("keeperwire");
    let agent = home.start_fake("w1");
    // This test is not the daemon holding the daemon lock: the keeper closes it before a word.
    let mut stranger = facade_base::paths::ClientSocket::connect(home.keeper_socket()).unwrap();
    stranger
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut rest = Vec::new();
    assert_eq!(
        stranger.read_to_end(&mut rest).unwrap_or(0),
        0,
        "the refused connection closes unanswered: {}",
        String::from_utf8_lossy(&rest)
    );
    assert!(
        alive(&agent.process),
        "the refused client must not stop the agent"
    );
    assert!(home.agent_from_watch("w1").expect("w1 is recorded")["process"] == "running");
}

/// A second daemon loses the daemon lock and exits without touching the running daemon's socket,
/// store, or keeper.
#[test]
fn a_second_daemon_loses_the_home_lock_and_changes_nothing() {
    let home = TestHome::new("seconddaemon");
    home.start_fake("w1");
    let first = home.daemon_pid().expect("expected a running daemon");
    // A pipe has no inode; on Windows its name goes with the daemon that made it.
    #[cfg(unix)]
    let socket =
        std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(home.daemon_socket()).unwrap());
    let mut second = home
        .command(&test_binaries().facade)
        .arg("daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("could not run facade");
    let ended = wait_until(secs(10), || second.try_wait().ok().flatten().is_some());
    if !ended {
        let _ = second.kill();
    }
    assert!(ended, "the second daemon kept running");
    assert!(
        second.wait().unwrap().success(),
        "losing the lock is not a failure"
    );
    assert_eq!(
        home.daemon_pid(),
        Some(first),
        "the original daemon must still respond"
    );
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(home.daemon_socket()).unwrap()),
        socket,
        "the socket was not replaced"
    );
    assert_eq!(
        home.lock_record("daemon").map(|record| record.0),
        Some(first),
        "the lock record still names the first daemon"
    );
    assert!(home.list_state("w1").is_some());
}

/// A paused keeper may delay starts and stops, but must not delay other daemon responses.
#[test]
fn daemon_responds_while_keeper_is_blocked() {
    let home = TestHome::new("pausedkeeper");
    home.start_fake("w1");
    let keeper = home.keeper_pid().expect("expected a running keeper");
    let cli = home.shell_cli();
    pause_process(keeper);
    let mut flood = connect(&home);
    let args = json!({
        "cli": cli, "args": ["-c", "sleep 600"], "folder": home.project,
        "env": { "PATH": SYSTEM_PATH.as_str() }, "cols": 80, "rows": 24,
    });
    std::thread::spawn(move || {
        for _ in 0..24 {
            flood.send("call", json!({ "op": "agent.start", "args": args }));
        }
        std::thread::sleep(secs(30));
    });
    std::thread::sleep(secs(1));
    let asked = Instant::now();
    let mut probe = connect(&home);
    assert!(probe.call("agent.screen", json!({ "agent": "w1" }))["result"]["text"].is_string());
    let took = asked.elapsed();
    resume_process(keeper);
    assert!(
        took < secs(2),
        "daemon response took {took:?} with the keeper paused"
    );
}

/// A CLI must not inherit another run's PTY or descriptors inherited by the keeper.
#[cfg(unix)]
#[test]
fn agents_do_not_inherit_other_ptys_or_launcher_fds() {
    use std::os::unix::process::CommandExt;
    let home = TestHome::new("descriptors");
    // The fake CLI writes the descriptors it was given before it opens anything itself. A shell
    // would list its own too.
    let mut first = home.command(&test_binaries().facade);
    first
        .args(["start", "-d", "--name", "first", "fake"])
        .env("FAKECLI_FDS", "first-fds")
        .stdin(std::process::Stdio::null());
    // SAFETY: open and dup2 are async-signal-safe. Descriptor 9 intentionally remains open across
    // exec to test inherited-descriptor cleanup.
    unsafe {
        first.pre_exec(|| {
            let fd = libc::open(c"/etc/hosts".as_ptr(), libc::O_RDONLY);
            libc::dup2(fd, 9);
            Ok(())
        });
    }
    let started = first.output().expect("could not run facade");
    assert!(started.status.success(), "{}", stderr(&started));
    assert!(wait_for_screen_text(&home, "first", "❯"));
    home.start_fake_with("second", &[("FAKECLI_FDS", "second-fds")]);
    for file in ["first-fds", "second-fds"] {
        let open = std::fs::read_to_string(home.project.join(file)).unwrap();
        assert!(open.is_empty(), "{file}: descriptors {open:?} are open");
    }
}

/// The keeper ends while the daemon holds a running agent. The daemon keeps its socket,
/// connections, and terminals, starts a replacement keeper, and hands it the run. The CLI keeps
/// running. When it ends, the daemon records an exit without a code or signal.
#[test]
fn a_dead_keeper_is_replaced_and_the_daemon_keeps_every_terminal() {
    let home = TestHome::new("keepergone");
    let agent = home.start_fake("w1");
    let mut connection = ManualReadClient::open(&home);
    let (keeper, daemon) = (
        home.keeper_pid().expect("expected a running keeper"),
        home.daemon_pid().unwrap(),
    );
    kill_process(keeper);
    let mut replacement = None;
    assert!(
        wait_until(secs(10), || {
            replacement = home.keeper_pid().filter(|pid| *pid != keeper);
            replacement.is_some()
        }),
        "no replacement keeper: {}",
        home.daemon_log()
    );
    // Whether the daemon meets the keeper dead or its connection closed first, the new keeper is
    // given the terminal.
    assert!(
        wait_until(secs(10), || home.keeper_log().contains("holding a1's CLI")),
        "{}\n{}",
        home.keeper_log(),
        home.daemon_log()
    );
    assert_eq!(home.daemon_pid(), Some(daemon), "the daemon stays");
    assert!(alive(&agent.process), "the CLI keeps running");
    connection.send(
        9,
        "call",
        json!({ "op": "agent.screen", "args": { "agent": "w1", "lines": 1 } }),
    );
    assert!(
        connection
            .read_message()
            .is_some_and(|response| response["id"] == 9),
        "the open connection still works"
    );
    let mut wire = connect(&home);
    type_raw(&mut wire, "w1", "still here\r");
    assert!(
        wait_until(secs(5), || home.submitted_messages() == ["still here"]),
        "{:?}",
        home.submitted_messages()
    );
    home.run_facade_ok(&["stop", "w1"]);
    assert!(
        wait_until(secs(10), || !alive(&agent.process)),
        "the replacement keeper stopped the CLI"
    );
    let inspected = home.run_facade_ok(&["inspect", "w1"]);
    assert!(
        inspected
            .lines()
            .any(|line| line.starts_with("State:") && line[6..].trim() == "stopped"),
        "the record retains the stop: {inspected}"
    );
}

/// A CLI stopped with SIGSTOP has not ended: it stays running, and once continued, a stop ends it
/// as Facade's stop.
#[cfg(unix)]
#[test]
fn a_stopped_cli_is_still_running_and_a_stop_ends_it() {
    let home = TestHome::new("sigstop");
    let agent = home.start_fake("w1");
    pause_process(agent.pid);
    // The keeper hears of the stop at once; a second is ample for it to misread one as an exit.
    std::thread::sleep(secs(1));
    assert_eq!(
        home.agent_from_watch("w1").unwrap()["process"],
        "running",
        "a stopped CLI has not ended"
    );
    resume_process(agent.pid);
    home.run_facade_ok(&["stop", "w1"]);
    let record = home.agent_from_watch("w1").unwrap();
    assert_eq!(record["process"], "ended");
    assert_ne!(record["exit"]["signal"], "SIGSTOP", "{record}");
    assert!(
        wait_until(secs(10), || !alive(&agent.process)),
        "the CLI ended"
    );
}

/// The daemon registers a started run, then its keeper dies before the agent is listed. The daemon
/// hands the run to a replacement keeper and the start completes with the same CLI.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_keeper_dying_after_the_daemon_registered_a_start_hands_the_run_over() {
    let home = TestHome::new("startkept");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-run-start")]);
    let mut wire = connect(&home);
    let daemon = home.lock_record("daemon").unwrap().0;
    let args = json!({
        "cli": home.shell_cli(),
        "args": ["-c", "echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > cli-pid; echo READY; while :; do sleep 0.2; done"],
        "name": "kept", "folder": home.project,
        "env": { "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path }, "cols": 80, "rows": 24,
    });
    let asked = wire.send("call", json!({ "op": "agent.start", "args": args }));
    assert!(
        wait_until(secs(10), || stopped(daemon)),
        "the daemon did not stop after registering the run"
    );
    let keeper = home
        .lock_record("keeper")
        .expect("the keeper recorded itself")
        .0;
    let keeper_process = process_identity(keeper);
    kill_process(keeper);
    assert!(wait_until(secs(5), || !alive(&keeper_process)));
    resume_process(daemon);
    let started = wire
        .wait_for_response(asked, secs(15))
        .expect("the start responds");
    assert_eq!(started["result"]["agent"]["agent_id"], "a1", "{started}");
    // A pseudo console starts its program once its terminal answered, or after 3 seconds, and no
    // daemon read this one while it was paused.
    let mut shell = None;
    assert!(
        wait_until(secs(10), || {
            shell = std::fs::read_to_string(home.project.join("cli-pid"))
                .ok()
                .and_then(|pid| pid.trim().parse::<i32>().ok());
            shell.is_some()
        }),
        "the CLI did not report its PID"
    );
    let shell = shell.unwrap();
    // On Windows Git's sh is a launcher whose child runs the script.
    #[cfg(unix)]
    let cli = shell;
    #[cfg(windows)]
    let cli = facade_base::unix_process::parent(shell as u32)
        .unwrap()
        .expect("the shell's launcher") as i32;
    let cli_process = process_identity(cli);
    assert_eq!(started["result"]["agent"]["pid"], cli);
    assert!(
        wait_until(secs(10), || home
            .keeper_pid()
            .is_some_and(|pid| pid != keeper)),
        "{}",
        home.daemon_log()
    );
    assert!(alive(&cli_process), "the run survived its keeper");
    assert!(
        home.agents()[0]["process"] == "running",
        "{:?}",
        home.agents()
    );
    assert!(wait_for_screen_text(&home, "a1", "READY"));
}

/// Both services are paused with a ping outstanding, past the keeper's 15-second watchdog. Only the
/// keeper may end the other: at most the daemon is replaced, and the keeper and its terminals
/// survive.
#[test]
fn when_both_services_pause_past_the_watchdog_at_most_the_daemon_is_replaced() {
    let home = TestHome::new("bothpaused");
    let agent = home.start_fake("w1");
    let (keeper, daemon) = (
        home.keeper_pid().expect("expected a running keeper"),
        home.daemon_pid().unwrap(),
    );
    let keeper_process = process_identity(keeper);
    // The paused keeper leaves the daemon's next ping unanswered.
    pause_process(keeper);
    std::thread::sleep(Duration::from_millis(1500));
    pause_process(daemon);
    std::thread::sleep(secs(16));
    resume_process(keeper);
    resume_process(daemon);
    assert!(
        wait_until(secs(20), || home.hello_result().is_some()),
        "no daemon serves: {}",
        home.keeper_log()
    );
    std::thread::sleep(secs(2));
    assert!(
        alive(&keeper_process) && home.keeper_pid() == Some(keeper),
        "the keeper survives: {}",
        home.daemon_log()
    );
    assert!(
        alive(&agent.process)
            && home
                .agent_from_watch("w1")
                .is_some_and(|agent| agent["process"] == "running")
    );
}

#[cfg(unix)]
#[test]
fn a_keeper_and_daemon_asked_to_end_take_their_sockets_with_them() {
    let home = TestHome::new("socketsend");
    // Keep a PTY alive without an MCP relay that can restart the daemon during shutdown.
    home.add_custom_cli("shutdown-fixture", &test_binaries().fakecli);
    home.run_facade_ok(&["start", "-d", "--name", "w1", "shutdown-fixture"]);
    let (keeper, daemon) = (
        home.keeper_pid().expect("expected a running keeper"),
        home.daemon_pid().expect("expected a running daemon"),
    );
    let keeper_process = process_identity(keeper);
    let daemon_process = process_identity(daemon);
    assert!(socket_exists(&home.keeper_socket()) && socket_exists(&home.daemon_socket()));
    // Request normal shutdown of both processes.
    send_signal(daemon, libc::SIGTERM);
    send_signal(keeper, libc::SIGTERM);
    assert!(
        wait_until(secs(10), || !alive(&keeper_process)
            && !alive(&daemon_process)),
        "keeper and daemon did not exit"
    );
    assert!(
        wait_until(secs(5), || !socket_exists(&home.keeper_socket())
            && !socket_exists(&home.daemon_socket())),
        "sockets remain after shutdown: keeper {} daemon {}\nkeeper: {}\ndaemon: {}",
        socket_exists(&home.keeper_socket()),
        socket_exists(&home.daemon_socket()),
        home.keeper_log(),
        home.daemon_log()
    );
    // The keeper restarts a daemon that ends, but not while it is shutting down: no daemon is left
    // behind.
    std::thread::sleep(secs(1));
    let live = home.processes();
    assert!(
        home.started_daemons().iter().all(|pid| !live.contains(pid)),
        "a daemon from this home outlived its keeper: {}",
        home.keeper_log()
    );
}

#[test]
fn an_explicit_start_refusal_preserves_every_other_pipelined_start() {
    let home = TestHome::new("startrefusal");
    let mut wire = connect(&home);
    // Establish the keeper connection before sending all thirty calls.
    start_script(&mut wire, &home, "warm", "sleep 600");
    let keeper = home.lock_record("keeper").unwrap();
    let invalid = home
        .project
        .join(format!("invalid-program{}", std::env::consts::EXE_SUFFIX));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The executable bit lets resolution reach the keeper. A missing interpreter makes
        // exec fail, while an executable text file without a shebang can run under sh.
        let interpreter = home.project.join("missing-interpreter");
        std::fs::write(&invalid, format!("#!{}\n", interpreter.display())).unwrap();
        std::fs::set_permissions(&invalid, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(windows)]
    std::fs::write(&invalid, "not an executable").unwrap();
    home.add_custom_cli("invalid-program", &invalid);
    let start_error = format!("could not start {}", invalid.display());
    let requests: Vec<_> = (0..30)
        .map(|n| {
            let good = n % 5 != 0;
            let cli = if good { SHELL_CLI } else { "invalid-program" };
            let asked = wire.send(
                "call",
                json!({
                    "op": "agent.start",
                    "args": {
                        "cli": cli, "args": ["-c", "sleep 600"], "folder": home.project,
                        "env": { "PATH": SYSTEM_PATH.as_str() }, "cols": 80, "rows": 24,
                    },
                }),
            );
            (asked, good)
        })
        .collect();
    let mut processes = Vec::new();
    for (asked, good) in requests {
        let response = wire
            .wait_for_response(asked, secs(30))
            .expect("every start responds");
        if good {
            assert!(
                response["result"]["agent"]["agent_id"].is_string(),
                "{response}"
            );
            processes.push(process_identity(
                response["result"]["agent"]["pid"].as_i64().unwrap() as i32,
            ));
        } else {
            assert_eq!(error_reason(&response), "unavailable", "{response}");
            assert!(
                response["error"]["message"]
                    .as_str()
                    .is_some_and(|message| message.contains(&start_error)),
                "{response}"
            );
        }
    }
    assert_eq!(processes.len(), 24);
    assert!(processes.iter().all(alive));
    assert_eq!(home.agents().len(), 25);
    assert_eq!(home.lock_record("keeper").unwrap(), keeper);
    assert_eq!(
        home.daemon_log().matches("connected to keeper").count(),
        1,
        "{}",
        home.daemon_log()
    );
}
