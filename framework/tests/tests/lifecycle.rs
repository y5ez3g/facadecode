//! When the daemon and keeper start and exit: races between clients and starts, the startup check
//! of the keeper lock, idle exit, and a start that meets an idle offer.

use std::io::{ErrorKind, Write};
use std::time::{Duration, Instant};

use facade_scenarios::serde_json::{self, json};
use facade_scenarios::*;

/// An ordinary command follows a daemon that holds the lock and ends without serving,
/// as one killed a moment before does while its lock is still being released: once it has ended,
/// another starts, and a daemon answers.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_client_starts_after_an_unready_daemon_that_held_the_lock_ends() {
    let home = TestHome::new("detachfollow");
    let mut holder = home.command(&test_binaries().facade);
    holder
        .args(["daemon"])
        .env("FACADE_TEST_PAUSE_AT", "after-daemon-lock")
        .stdin(std::process::Stdio::null());
    let mut holder = holder
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    assert!(
        wait_until(secs(5), || home
            .path
            .join("framework/paused-at-after-daemon-lock")
            .exists()),
        "the holder did not take the lock"
    );
    std::thread::scope(|scope| {
        let command = scope.spawn(|| home.run_facade(&["list"]));
        std::thread::sleep(Duration::from_millis(300));
        kill_process(holder.id() as i32);
        let _ = holder.wait();
        let listed = command.join().unwrap();
        assert!(listed.status.success(), "{}", stderr(&listed));
    });
    let answering = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .expect("no daemon answers after the holder ended");
    assert_ne!(answering, i64::from(holder.id()));
}

/// Commands that find no Facade start it together, as an editor does with several connections:
/// one keeper wins the keeper lock, the others say so and exit, and every command reaches the one
/// daemon that keeper starts.
#[test]
fn commands_starting_facade_together_start_one_keeper_and_one_daemon() {
    let home = TestHome::new("coldstart");
    std::thread::scope(|scope| {
        let commands: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| home.run_facade(&["list"])))
            .collect();
        for command in commands {
            let listed = command.join().unwrap();
            assert!(listed.status.success(), "{}", stderr(&listed));
        }
    });
    // One keeper holds the lock and started one daemon, which is the one that answers.
    let hello = home.hello_result().expect("a daemon answers");
    assert_eq!(
        (
            home.started_daemons(),
            hello["keeper"]["pid"].as_i64().map(|pid| pid as i32)
        ),
        (
            vec![hello["pid"].as_i64().unwrap() as i32],
            home.lock_record("keeper").map(|record| record.0)
        ),
        "{}",
        home.keeper_log()
    );
}

/// A command starts the daemon, then its terminal closes before the daemon is ready. The daemon
/// continues in its own session without a controlling terminal.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_daemon_outlives_the_terminal_that_launched_it() {
    let home = TestHome::new("detached");
    let gate = "after-daemon-lock";
    let mut command = home.command(&test_binaries().facade);
    command.arg("list").env("FACADE_TEST_GATES", gate);
    let term = TestTerminal::spawn(&mut command, 80, 24);
    home.wait_for_gate(gate);
    let (pid, birth) = home.lock_record("daemon").expect("a daemon holds the lock");
    let daemon = process_identity(pid);
    assert!(
        !birth.is_empty() && daemon.birth == birth && alive(&daemon),
        "the daemon lock does not name a live process: {daemon:?}"
    );
    assert!(!socket_exists(&home.daemon_socket()));

    // Dropping the terminal ends the launching command and closes its terminal.
    drop(term);
    assert!(
        alive(&daemon),
        "the original daemon {pid} exited when the terminal closed"
    );
    home.release_gate(gate);
    assert!(
        wait_until(LOADED_TIMEOUT, || home.daemon_pid() == Some(pid)
            && alive(&daemon)),
        "the original daemon {pid} did not answer after its terminal closed:\n{}\n{}",
        home.daemon_log(),
        home.keeper_log()
    );
    // A controlling terminal is Unix's; on Windows the daemon runs without a console.
    #[cfg(unix)]
    {
        let tty = std::process::Command::new("ps")
            .args(["-o", "tty=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        assert!(
            stdout(&tty).trim().starts_with('?'),
            "the daemon has a controlling terminal: {}",
            stdout(&tty)
        );
    }
    home.run_facade_ok(&["list"]);
}

/// With no agent running, the keeper exits on the daemon's next idle offer. The daemon stays while
/// a client is connected and exits 30 seconds after the last one leaves, removing its socket last.
/// Records, screens, and numbering survive, and the next command starts Facade again.
#[test]
fn the_services_exit_when_idle_and_the_records_survive() {
    let home = TestHome::new("idle");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "brief",
        "echo LAST-WORDS; read line; exit 4",
    );
    assert!(wait_for_screen_text(&home, &agent, "LAST-WORDS"));
    let (keeper, daemon) = (
        home.keeper_pid().expect("a keeper"),
        home.lock_record("daemon").unwrap().0,
    );
    let keeper_process = process_identity(keeper);
    let daemon_process = process_identity(daemon);
    type_raw(&mut wire, &agent, "bye\r");
    std::thread::sleep(secs(32));
    assert!(
        alive(&daemon_process) && alive(&keeper_process),
        "the daemon exited with a client connected, or the keeper before it"
    );
    drop(wire);
    let left = Instant::now();
    assert!(
        wait_until(LOADED_TIMEOUT, || !alive(&daemon_process)),
        "the daemon did not exit when idle: {}",
        home.daemon_log()
    );
    assert!(
        left.elapsed() >= Duration::from_millis(29_500),
        "the daemon exited {:?} after the last client left",
        left.elapsed()
    );
    assert!(
        wait_until(secs(5), || !alive(&keeper_process)),
        "the keeper, holding no CLI, did not exit with the daemon: {}",
        home.keeper_log()
    );
    assert!(
        !socket_exists(&home.daemon_socket()) && !socket_exists(&home.keeper_socket()),
        "the sockets are removed"
    );
    let inspected = home.run_facade_ok(&["status", &agent]);
    assert!(
        inspected
            .lines()
            .any(|line| line.starts_with("State ") && line[5..].trim() == "Ended (code 4)"),
        "{inspected}"
    );
    assert_eq!(home.hello_result().unwrap()["agent_count"], 0);
    let records = home.agents();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["reference"]["agent_id"], agent, "{records:?}");
    assert!(home.screen(&agent).contains("LAST-WORDS"));
    assert_eq!(
        start_script(&mut connect(&home), &home, "next", "sleep 60"),
        "a2",
        "numbering continues"
    );
}

/// An unread dedicated Shell connection must release its transport and its connection work on
/// target exit, even while ordinary Attach watches and the unread client handles stay open.
#[test]
fn unread_dedicated_shell_attach_closes_and_allows_natural_idle_exit() {
    let home = TestHome::new("shell-drain");
    home.start_facade_with(&[]);
    let mut terminal = DaemonTestClient::open(&home);
    let hello = terminal.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    assert_eq!(hello["result"]["api_version"], 1, "{hello}");
    assert!(
        hello["result"]["topics"]
            .as_array()
            .is_some_and(|topics| topics.iter().any(|topic| topic == "attach.shell")),
        "{hello}"
    );
    let agent = start_script(
        &mut terminal,
        &home,
        "drain",
        "printf 'READY\\n'; read go; head -c 4000000 /dev/zero | tr '\\0' X; \
         printf '\\nFLOOD-DONE\\n'; read finish; printf 'FINAL-FRAME\\n'; exit 3",
    );
    assert!(wait_for_screen_text(&home, &agent, "READY"));

    let mut editor = DaemonTestClient::open(&home);
    let hello = editor.hello("ide", DAEMON_API_VERSIONS, json!({}));
    assert_eq!(hello["result"]["api_version"], 1, "{hello}");
    assert!(
        hello["result"]["topics"]
            .as_array()
            .is_some_and(|topics| topics.iter().all(|topic| topic != "attach.shell")),
        "{hello}"
    );

    let target =
        terminal.call_ok("agent.inspect", json!({ "target": agent }))["agent"]["reference"].clone();
    let dedicated = json!({ "topic": "attach.shell", "args": { "target": target } });
    let refused = editor.request("watch", dedicated.clone());
    assert_eq!(error_reason(&refused), "refused", "{refused}");
    let refused = terminal.request("watch", dedicated.clone());
    assert_eq!(error_reason(&refused), "refused", "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("fresh Terminal connection")),
        "{refused}"
    );

    let ordinary = json!({ "topic": "attach", "args": { "target": target } });
    let [terminal_watch, editor_watch] = [&mut terminal, &mut editor].map(|client| {
        let reply = client.request("watch", ordinary.clone());
        assert_eq!(reply["result"]["snapshot"]["reference"], target, "{reply}");
        reply["result"]["watch"]
            .as_u64()
            .expect("an ordinary Attach watch")
    });
    let mut stalled = ManualReadClient::open(&home);
    stalled.send(1, "watch", dedicated);
    let reply = stalled
        .read_message()
        .expect("the dedicated watch response");
    assert_eq!(reply["id"], 1, "{reply}");
    assert!(reply["result"]["watch"].is_u64(), "{reply}");
    assert_eq!(reply["result"]["snapshot"]["reference"], target, "{reply}");
    assert_eq!(reply["result"]["snapshot"]["process"], "running", "{reply}");
    // Leave this client unread for the rest of the test. The write probe below does not drain it.
    stalled
        .writer
        .set_write_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let control = b"{\"jsonrpc\":\"2.0\",\"method\":\"cancel\",\"params\":{\"id\":0}}\n";
    let [daemon, keeper] = ["daemon", "keeper"].map(|service| {
        let (pid, birth) = home.lock_record(service).expect("a service lock record");
        let identity = process_identity(pid);
        assert!(!birth.is_empty());
        assert_eq!(identity.birth, birth);
        assert!(alive(&identity), "{service} {pid} was already gone");
        identity
    });

    type_raw(&mut terminal, &agent, "go\r");
    assert!(
        wait_until(LOADED_TIMEOUT, || home
            .screen(&agent)
            .contains("FLOOD-DONE")),
        "the fixture did not finish producing output"
    );
    // Observe the same live output on a reading watch. Require enough payload to exceed the
    // socket buffer even if the actor coalesces some of the fixture's output into redraws.
    let mut payload = 0;
    assert!(
        wait_until(secs(5), || {
            payload = editor
                .changes(editor_watch)
                .iter()
                .filter(|notice| notice["change"]["kind"] == "output")
                .filter_map(|notice| notice["change"]["data"].as_str())
                .map(str::len)
                .sum::<usize>();
            payload >= 2_000_000
        }),
        "the reading Attach watch received only {payload} encoded output bytes"
    );
    stalled
        .writer
        .write_all(control)
        .expect("the unread transport must still be open before the target ends");

    let ending = Instant::now();
    type_raw(&mut terminal, &agent, "finish\r");
    let mut closed = None;
    assert!(
        wait_until(secs(4).saturating_sub(ending.elapsed()), || {
            match stalled.writer.write_all(control) {
                Ok(()) => false,
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::BrokenPipe | ErrorKind::ConnectionReset
                    ) || facade_base::paths::is_connection_lost(&error) =>
                {
                    closed = Some(error);
                    true
                }
                Err(error) => panic!("the write probe must see a closed transport: {error}"),
            }
        }),
        "the unread transport still accepts writes after {:?}: {}",
        ending.elapsed(),
        home.daemon_log()
    );
    assert!(ending.elapsed() <= secs(4), "{:?}", ending.elapsed());
    eprintln!(
        "ordinary Attach saw {payload} encoded output bytes. Unread transport closed {:?} after triggering exit: {}",
        ending.elapsed(),
        closed.unwrap()
    );

    for (client, watch) in [(&mut terminal, terminal_watch), (&mut editor, editor_watch)] {
        assert!(
            wait_until(secs(5), || client.changes(watch).iter().any(|notice| {
                notice["change"]["kind"] == "exit" && notice["change"]["exit_status"] == 3
            })),
            "ordinary Attach watch did not receive exit code 3"
        );
        let ended = client.call_ok("agent.inspect", json!({ "target": target }));
        assert_eq!(ended["agent"]["exit"]["code"], 3, "{ended}");
    }
    assert!(
        alive(&daemon) && alive(&keeper),
        "a service ended during cutoff"
    );
    drop(terminal);
    drop(editor);

    let idle = Instant::now();
    assert!(
        wait_until(LOADED_TIMEOUT, || !alive(&daemon)),
        "original daemon did not exit naturally with the stalled client held: {}",
        home.daemon_log()
    );
    let daemon_idle = idle.elapsed();
    assert!(
        daemon_idle >= Duration::from_millis(29_500),
        "{daemon_idle:?}"
    );
    assert!(
        wait_until(secs(5), || !alive(&keeper)),
        "original Keeper did not exit naturally with the stalled client held: {}",
        home.keeper_log()
    );
    assert!(!socket_exists(&home.daemon_socket()) && !socket_exists(&home.keeper_socket()));
    eprintln!(
        "original daemon {daemon:?} exited after {daemon_idle:?} idle. Original Keeper {keeper:?} was gone at {:?}",
        idle.elapsed()
    );
    drop(stalled);
}

/// A client connects just after the daemon decided to exit. The exiting daemon closes the
/// connection before `hello` instead of serving it, and the client goes on to the next daemon.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_client_arriving_as_the_daemon_exits_reaches_the_next_daemon() {
    let home = TestHome::new("lateclient");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "after-idle-decision")]);
    let exiting = home.lock_record("daemon").unwrap().0;
    let exiting_process = process_identity(exiting);
    assert!(
        wait_until(LOADED_TIMEOUT, || stopped(exiting)),
        "the idle daemon did not stop after deciding to exit"
    );
    let listed = std::thread::scope(|scope| {
        let listed = scope.spawn(|| home.run_facade(&["list"]));
        std::thread::sleep(Duration::from_millis(500));
        resume_process(exiting);
        listed.join().unwrap()
    });
    assert!(listed.status.success(), "{}", stderr(&listed));
    let next = home.lock_record("daemon").unwrap().0;
    assert_ne!(next, exiting, "the exiting daemon served the late client");
    assert_eq!(home.daemon_pid(), Some(next));
    assert!(!alive(&exiting_process));
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the daemon's startup gate")]
fn detach_returns_at_the_lock_before_recovery() {
    let home = TestHome::new("startingreport");
    let gate = "before-recovery";
    let mut child = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let (daemon, birth) = home.lock_record("daemon").expect("daemon has its lock");
    assert_eq!(process_identity(daemon).birth, birth);
    assert!(!socket_exists(&home.daemon_socket()));
    let returned = wait_until(secs(3), || child.try_wait().unwrap().is_some());
    home.release_gate(gate);
    let output = child.wait_with_output().unwrap();
    assert!(
        returned && output.status.success(),
        "detach did not return successfully while the daemon held the lock: {}",
        stderr(&output)
    );
    assert!(wait_until(LOADED_TIMEOUT, || home.daemon_pid() == Some(daemon)));
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the daemon's startup gate")]
fn a_client_waits_for_the_same_daemon_past_the_old_start_timeout() {
    let home = TestHome::new("slow-start-hello");
    let gate = "before-recovery";
    let mut child = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let (pid, _) = home.lock_record("daemon").unwrap();
    let exited_while_starting = wait_until(secs(11), || child.try_wait().unwrap().is_some());
    home.release_gate(gate);
    let output = child.wait_with_output().unwrap();
    assert!(
        !exited_while_starting && output.status.success(),
        "list abandoned its daemon during recovery: {}",
        stderr(&output)
    );
    assert_eq!(home.daemon_pid(), Some(pid));
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the daemon's startup gate")]
fn the_next_command_gets_the_failed_start_even_after_both_services_exit() {
    let home = TestHome::new("failed-after-detach");
    let gate = "after-daemon-lock";
    let child = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    std::fs::write(home.path.join("framework/facade.db"), "not a database").unwrap();
    let detached = child.wait_with_output().unwrap();
    home.release_gate(gate);
    assert!(detached.status.success(), "{}", stderr(&detached));
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&daemon) && !alive(&keeper)));
    let command = home.run_facade(&["list"]);
    assert!(!command.status.success());
    assert!(
        stderr(&command).contains("file is not a database"),
        "{}",
        stderr(&command)
    );
    assert_eq!(home.started_daemons(), vec![daemon.pid as i32]);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the daemon's startup gate")]
fn the_next_command_reports_the_accepted_daemon_if_both_services_die_before_reporting() {
    let home = TestHome::new("startup-both-services-killed");
    let gate = "after-daemon-lock";
    let launcher = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    let framework = home.path.join("framework");
    let current = framework.join("startup/current");
    let original = std::fs::read_to_string(&current).unwrap();
    let accepted = launcher.wait_with_output().unwrap();
    assert!(accepted.status.success(), "{}", stderr(&accepted));
    kill_process(keeper.pid as i32);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&keeper)));
    kill_process(daemon.pid as i32);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&daemon)));

    let first = home.run_facade(&["list"]);
    assert!(!first.status.success(), "{}", stdout(&first));
    let reason = stderr(&first);
    assert!(
        reason.contains(&format!("daemon {}", daemon.pid)),
        "{reason}"
    );
    assert!(
        reason.contains("exited before reporting startup"),
        "{reason}"
    );
    assert!(
        reason.contains("daemon lock acquired") && reason.contains("daemon.log"),
        "{reason}"
    );
    assert_eq!(home.started_daemons(), [daemon.pid as i32]);
    home.run_facade_ok(&["list"]);
    assert_ne!(home.daemon_pid(), Some(daemon.pid as i32));
    assert_ne!(std::fs::read_to_string(current).unwrap(), original);
    let ended = facade_base::startup::Attempt::of(&framework, &original).unwrap();
    assert!(!ended.in_progress());
    assert!(ended.candidate_failure(&daemon).is_some());
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the daemon's startup gates")]
fn a_list_following_an_unready_daemon_keeps_its_failure_after_both_services_exit() {
    let home = TestHome::new("startup-unaccepted-both-exit");
    let after_lock = "after-daemon-lock";
    let following = "startup-following-daemon";
    let follower = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", format!("{after_lock},{following}"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(after_lock);
    let framework = home.path.join("framework");
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    let attempt = facade_base::startup::Attempt::current(&framework).unwrap();
    home.wait_for_gate(following);
    kill_process(keeper.pid as i32);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&keeper)));
    kill_process(daemon.pid as i32);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&daemon)));

    let diagnostic = home.run_facade(&["list"]);
    let successor = home.run_facade(&["list"]);
    home.release_gate(following);
    let original = follower.wait_with_output().unwrap();
    for failed in [diagnostic, original] {
        let reason = stderr(&failed);
        assert!(!failed.status.success(), "{}", stdout(&failed));
        assert!(
            reason.contains(&format!(
                "daemon {} exited before reporting startup",
                daemon.pid
            )),
            "{reason}"
        );
    }
    assert!(successor.status.success(), "{}", stderr(&successor));
    assert_ne!(home.daemon_pid(), Some(daemon.pid as i32));
    let next = facade_base::startup::Attempt::current(&framework).unwrap();
    assert_ne!(next.generation(), attempt.generation());
    assert!(!attempt.in_progress());
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the daemon accept gate and a synthetic time origin"
)]
fn a_late_shell_hello_uses_the_remaining_window_for_the_same_daemon() {
    for (late, observer) in [(false, false), (true, false), (false, true), (true, true)] {
        let goal = if observer { "observer" } else { "list" };
        let home = TestHome::new(&format!("{goal}-hello-late-{late}"));
        let accept = "before-accept-loop";
        let daemon = home
            .command(&test_binaries().facade)
            .args(["daemon", "--detach"])
            .env("FACADE_TEST_GATES", accept)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        home.wait_for_gate(accept);
        assert!(daemon.wait_with_output().unwrap().status.success());
        let (pid, _) = home.lock_record("daemon").unwrap();
        let connect = "startup-before-observing-daemon";
        let mut command = home.command(&test_binaries().facade);
        if observer {
            command.args(["daemon", "--await-startup"]);
        } else {
            command.arg("list");
        }
        let command = command
            .env("FACADE_TEST_GATES", connect)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        home.wait_for_gate(connect);
        let at = backdate_startup(&home, 175, 0);
        home.release_gate(connect);
        if late {
            let release = at + Duration::from_millis(5_400);
            std::thread::sleep(release.saturating_duration_since(Instant::now()));
        } else {
            std::thread::sleep(Duration::from_millis(300));
        }
        home.release_gate(accept);
        let output = command.wait_with_output().unwrap();
        assert_ne!(output.status.success(), late, "{}", stderr(&output));
        if late {
            assert!(
                stderr(&output).contains("180-second startup limit"),
                "{}",
                stderr(&output)
            );
        }
        assert!(wait_until(LOADED_TIMEOUT, || home.daemon_pid() == Some(pid)));
    }
}

fn backdate_startup(home: &TestHome, elapsed_seconds: u64, progress_ago_seconds: u64) -> Instant {
    let startup = home.path.join("framework/startup");
    let generation = std::fs::read_to_string(startup.join("current")).unwrap();
    let records = startup.join(generation);
    let at = Instant::now();
    let now = facade_base::startup::now();
    let started = now - elapsed_seconds * 1_000_000_000;
    let advanced = now - progress_ago_seconds * 1_000_000_000;
    let origin = records.join("origin");
    let window = records.join("window");
    let mut beginning: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&origin).unwrap()).unwrap();
    let mut progress: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&window).unwrap()).unwrap();
    beginning["started"] = json!(started);
    progress["progress"]["at"] = json!(advanced);
    progress["idle"] = json!(advanced + 75_000_000_000u64);
    progress["hard"] = json!(started + 180_000_000_000u64);
    std::fs::write(origin, serde_json::to_vec(&beginning).unwrap()).unwrap();
    std::fs::write(window, serde_json::to_vec(&progress).unwrap()).unwrap();
    at
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the daemon startup and Shell probe gates"
)]
fn startup_progress_before_the_first_hello_probe_extends_the_same_daemons_idle_deadline() {
    startup_progress_during_shell_wait("before-probe", "startup-before-daemon-probe", false);
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the daemon startup and Shell hello gates"
)]
fn startup_progress_while_reading_the_first_hello_extends_the_same_daemons_idle_deadline() {
    startup_progress_during_shell_wait("during-hello", "startup-before-daemon-probe", true);
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the daemon startup and Shell probe gates"
)]
fn startup_progress_after_the_first_hello_probe_extends_the_same_daemons_idle_deadline() {
    startup_progress_during_shell_wait("after-probe", "startup-after-daemon-probe", false);
}

fn startup_progress_during_shell_wait(case: &str, probe: &str, read_hello: bool) {
    let home = TestHome::new(&format!("startup-progress-{case}"));
    let recovery = "before-recovery";
    let accept = "before-accept-loop";
    let detached = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", format!("{recovery},{accept}"))
        .output()
        .unwrap();
    assert!(detached.status.success(), "{}", stderr(&detached));
    home.wait_for_gate(recovery);
    let framework = home.path.join("framework");
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let observe = "startup-before-observing-daemon";
    let hello = "startup-before-native-hello";
    let gates = if read_hello {
        format!("{observe},{probe},{hello}")
    } else {
        format!("{observe},{probe}")
    };
    let client = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", gates)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(observe);
    let attempt = facade_base::startup::Attempt::current(&framework).unwrap();
    let ping = format!("first authenticated ping from daemon {}", daemon.pid);
    assert!(wait_until(LOADED_TIMEOUT, || home
        .keeper_log()
        .contains(&ping)));
    let old = attempt.status().0;
    let start = old.deadline() - secs(12);
    std::thread::sleep(start.saturating_duration_since(Instant::now()));
    home.release_gate(observe);
    home.wait_for_gate(probe);
    assert!(
        !old.exhausted(),
        "the first probe already missed the original window"
    );
    assert_eq!(attempt.status().0.end(), old.end());
    assert!(!socket_exists(&home.daemon_socket()));
    // The daemon starts its idle timer after recovery, so it still holds its lock at the old cutoff.
    home.release_gate(recovery);
    home.wait_for_gate(accept);
    let updated = attempt.status().0;
    assert!(updated.end() > old.end());
    assert_eq!(updated.hard(), old.hard());
    if read_hello {
        home.release_gate(probe);
        home.wait_for_gate(hello);
        home.release_gate(hello);
    }
    let release = old.deadline() + Duration::from_millis(650);
    std::thread::sleep(release.saturating_duration_since(Instant::now()));
    home.release_gate(accept);
    if !read_hello {
        home.release_gate(probe);
    }
    let result = client.wait_with_output().unwrap();
    assert!(result.status.success(), "{}", stderr(&result));
    assert_eq!(home.daemon_pid(), Some(daemon.pid as i32));
    assert_eq!(
        home.lock_record("daemon"),
        Some((daemon.pid as i32, daemon.birth))
    );
    assert_eq!(home.started_daemons(), [daemon.pid as i32]);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the daemon's startup gate")]
fn detach_of_a_living_successor_does_not_take_the_previous_failure() {
    let home = TestHome::new("detach-keeps-previous-failure");
    let gate = "after-daemon-lock";
    let launcher = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    let store = home.path.join("framework/facade.db");
    std::fs::write(&store, "not a database").unwrap();
    assert!(launcher.wait_with_output().unwrap().status.success());
    home.release_gate(gate);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&daemon) && !alive(&keeper)));
    std::fs::remove_file(store).unwrap();
    let mut successor = home
        .command(&test_binaries().facade)
        .arg("daemon")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    assert!(wait_until(LOADED_TIMEOUT, || home.daemon_pid()
        == Some(successor.id() as i32)));
    let detach = home.run_facade(&["daemon", "--detach"]);
    let order = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(home.path.join("framework/startup/order.lock"))
        .unwrap();
    order.lock().unwrap();
    let gate = "startup-after-detach-probe";
    let contender = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    order.unlock().unwrap();
    home.release_gate(gate);
    let contended = contender.wait_with_output().unwrap();
    assert!(contended.status.success(), "{}", stderr(&contended));
    assert_eq!(home.daemon_pid(), Some(successor.id() as i32));
    let list = home.run_facade(&["list"]);
    let _ = successor.kill();
    let _ = successor.wait();
    assert!(detach.status.success(), "{}", stderr(&detach));
    assert!(!list.status.success() && stderr(&list).contains("file is not a database"));
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the service creation gates")]
fn the_keeper_keeps_the_claim_if_the_launcher_dies_before_publishing_its_pid() {
    let home = TestHome::new("startup-claim-transfer");
    let parent_gate = "startup-after-keeper-create";
    let keeper_gate = "startup-before-keeper-lock";
    let mut first = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", format!("{parent_gate},{keeper_gate}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    home.wait_for_gate(parent_gate);
    home.wait_for_gate(keeper_gate);
    let framework = home.path.join("framework");
    let generation = std::fs::read_to_string(framework.join("startup/current")).unwrap();
    let created = || {
        std::fs::read_dir(&framework)
            .unwrap()
            .filter_map(|entry| {
                entry
                    .ok()?
                    .file_name()
                    .to_str()?
                    .strip_prefix("reached-keeper-created-")?
                    .parse::<i32>()
                    .ok()
            })
            .collect::<Vec<_>>()
    };
    let [keeper] = created().try_into().expect("one process was created");
    let identity = process_identity(keeper);
    assert!(home.lock_record("keeper").is_none());
    first.kill().unwrap();
    let _ = first.wait().unwrap();
    assert!(alive(&identity));
    let mut next = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", keeper_gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let premature = wait_until(Duration::from_millis(600), || {
        next.try_wait().unwrap().is_some() || created().len() != 1
    });
    home.release_gate(keeper_gate);
    let listed = next.wait_with_output().unwrap();
    assert!(!premature && listed.status.success(), "{}", stderr(&listed));
    assert_eq!(home.keeper_pid(), Some(keeper));
    assert_eq!(home.lock_record("keeper").unwrap().1, identity.birth);
    assert_eq!(created(), vec![keeper]);
    assert_eq!(
        std::fs::read_to_string(framework.join("startup/current")).unwrap(),
        generation
    );
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the service creation gate")]
fn an_expired_send_leaves_its_uncreated_attempt_for_the_next_caller() {
    let home = TestHome::new("startup-short-send");
    home.run_facade_ok(&["daemon", "--install-only"]);
    let gate = "startup-before-keeper-create";
    let mut first = home
        .command(&test_binaries().facade)
        .args(["send", "absent", "pending", "--timeout", "6"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let current = home.path.join("framework/startup/current");
    let generation = std::fs::read_to_string(&current).unwrap();
    let returned = wait_until(LOADED_TIMEOUT, || first.try_wait().unwrap().is_some());
    home.release_gate(gate);
    let output = first.wait_with_output().unwrap();
    let diagnostic = stderr(&output);
    assert!(
        returned && !output.status.success() && diagnostic.contains("the command deadline elapsed"),
        "{diagnostic}"
    );
    assert!(home.lock_record("keeper").is_none());
    home.run_facade_ok(&["list"]);
    assert_eq!(std::fs::read_to_string(current).unwrap(), generation);
    assert_eq!(home.started_daemons(), [home.daemon_pid().unwrap()]);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the daemon observation gate")]
fn an_expired_send_does_not_consume_a_queued_startup_failure() {
    let home = TestHome::new("startup-expired-send-diagnostic");
    let framework = home.path.join("framework");
    let attempt = facade_base::startup::Attempt::begin(&framework).unwrap();
    let reason = "the previous keeper creation failed";
    attempt
        .launch_failed(&framework, "starting the keeper", reason)
        .unwrap();

    let gate = "startup-before-observing-daemon";
    let child = home
        .command(&test_binaries().facade)
        .args(["send", "absent", "pending", "--timeout", "3"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    std::thread::sleep(Duration::from_millis(3_200));
    home.release_gate(gate);
    let expired = child.wait_with_output().unwrap();
    assert!(!expired.status.success());
    assert!(
        stderr(&expired).contains("the command deadline elapsed"),
        "{}",
        stderr(&expired)
    );
    let diagnostic = home.run_facade(&["list"]);
    assert!(
        !diagnostic.status.success() && stderr(&diagnostic).contains(reason),
        "{}",
        stderr(&diagnostic)
    );
    assert!(home.lock_record("keeper").is_none());
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the diagnostic output gate")]
fn a_waiting_failure_report_does_not_block_the_next_start_or_change_its_outcome() {
    let home = TestHome::new("startup-report-handoff");
    let gate = "after-daemon-lock";
    let launcher = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .env("FACADE_STARTUP_REPORT", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let old_daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let old_keeper = process_identity(home.lock_record("keeper").unwrap().0);
    let database = home.path.join("framework/facade.db");
    std::fs::write(&database, "not a database").unwrap();
    let detached = launcher.wait_with_output().unwrap();
    assert!(detached.status.success(), "{}", stderr(&detached));
    let output = stdout(&detached);
    let ticket: serde_json::Value = serde_json::from_str(
        output
            .trim()
            .strip_prefix("facade-startup-locked ")
            .unwrap(),
    )
    .unwrap();
    let generation = ticket["generation"].as_str().unwrap();
    let records = home.path.join("framework/startup").join(generation);
    home.release_gate(gate);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&old_daemon)
        && !alive(&old_keeper)));
    std::fs::remove_file(database).unwrap();

    let gate = "startup-before-failure-report";
    let mut reporter = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let dispatch = format!(
        "dispatched-{}-{}",
        old_daemon.pid,
        old_daemon.birth.replace(':', "_")
    );
    let report = records.join(dispatch.replacen("dispatched-", "reported-", 1));
    assert!(records.join(dispatch).is_file() && !report.exists());
    home.run_facade_ok(&["list"]);
    let successor = home.daemon_pid().unwrap();
    assert_ne!(successor, old_daemon.pid as i32);
    assert!(reporter.try_wait().unwrap().is_none());
    let previous = home.run_facade(&[
        "daemon",
        "--await-startup",
        generation,
        &old_daemon.pid.to_string(),
        &old_daemon.birth,
    ]);
    assert!(
        !previous.status.success() && stderr(&previous).contains("file is not a database"),
        "{}",
        stderr(&previous)
    );
    home.release_gate(gate);
    let result = reporter.wait_with_output().unwrap();
    assert!(!result.status.success() && stderr(&result).contains("file is not a database"));
    assert!(report.is_file());
    assert_eq!(home.daemon_pid(), Some(successor));
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses Relay's native launcher gates")]
fn relay_reads_eof_while_the_native_launcher_is_still_before_the_lock() {
    let home = TestHome::new("relay-eof-before-startup-lock");
    let gate = "startup-selecting-programs";
    let mut relay = home
        .command(&test_binaries().mcp)
        .args(["--guest", "codex"])
        .env("FACADE_TEST_GATES", gate)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let mut input = relay.stdin.take().unwrap();
    writeln!(input, "{}", relay_initialize()).unwrap();
    writeln!(
        input,
        "{}",
        json!({
            "jsonrpc": "2.0", "method": "notifications/cancelled",
            "params": {"requestId": 1}
        })
    )
    .unwrap();
    drop(input);
    let returned = wait_until(secs(4), || relay.try_wait().unwrap().is_some());
    home.release_gate(gate);
    let output = relay.wait_with_output().unwrap();
    assert!(returned && output.status.success(), "{}", stderr(&output));
    home.run_facade_ok(&["list"]);
    assert_eq!(home.started_daemons(), [home.daemon_pid().unwrap()]);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the MCP hello gate")]
fn relay_holds_mcp_requests_until_a_successors_hello_is_verified() {
    use std::io::{BufRead, BufReader};

    let home = TestHome::new("relay-startup-hello-replaced");
    let recovery = "before-recovery";
    let hello = "before-relay-hello";
    let mut relay = home
        .command(&test_binaries().mcp)
        .args(["--guest", "codex"])
        .env("FACADE_TEST_GATES", format!("{recovery},{hello}"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = relay.stdin.take().unwrap();
    writeln!(input, "{}", relay_initialize()).unwrap();
    let output = relay.stdout.take().unwrap();
    let (send, received) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(output).read_line(&mut line);
        let _ = send.send(result.map(|_| line));
    });

    home.wait_for_gate(recovery);
    let original = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    home.release_gate(recovery);
    home.wait_for_gate(hello);
    assert!(matches!(
        received.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    kill_process(original.pid as i32);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&original) && !alive(&keeper)));
    home.run_facade_ok(&["list"]);
    assert_ne!(home.daemon_pid(), Some(original.pid as i32));
    let answer = received.recv_timeout(LOADED_TIMEOUT);
    drop(input);
    let exited = relay.wait_with_output().unwrap();
    reader.join().unwrap();
    assert!(exited.status.success(), "{}", stderr(&exited));
    let answer = answer
        .expect("the relay did not forward after the successor's hello")
        .unwrap();
    let response: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
}

fn relay_initialize() -> serde_json::Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "startup-fixture", "version": "1"},
        },
    })
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the keeper hello gate")]
fn a_keeper_hello_can_finish_on_its_original_connection_after_ten_seconds() {
    let home = TestHome::new("keeper-hello-wait");
    let gate = "before-keeper-hello";
    let child = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    let ended_early = wait_until(secs(11), || !alive(&daemon) || !alive(&keeper));
    home.release_gate(gate);
    let output = child.wait_with_output().unwrap();
    assert!(
        !ended_early && output.status.success(),
        "{}",
        stderr(&output)
    );
    assert_eq!(home.daemon_pid(), Some(daemon.pid as i32));
    assert_eq!(home.keeper_pid(), Some(keeper.pid as i32));
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the Keeper hello admission gate")]
fn an_already_received_keeper_hello_cannot_be_admitted_after_the_deadline() {
    let home = TestHome::new("keeper-hello-after-deadline");
    let gate = "before-accepting-startup-keeper-hello";
    let child = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = home.lock_record("keeper").unwrap().0;
    assert!(child.wait_with_output().unwrap().status.success());
    let attempt = facade_base::startup::Attempt::current(&home.path.join("framework")).unwrap();
    // Keep the watchdog from ending the daemon so the admission check owns the outcome.
    pause_process(keeper);
    let until = attempt.status().0.deadline();
    std::thread::sleep(
        until.saturating_duration_since(Instant::now()) + Duration::from_millis(100),
    );
    home.release_gate(gate);
    let ended = wait_until(secs(10), || !alive(&daemon));
    resume_process(keeper);
    assert!(ended, "{}", home.daemon_log());
    assert!(
        home.daemon_log()
            .contains("did not finish its startup hello before the deadline")
    );
    assert!(!home.keeper_log().contains("first authenticated ping"));
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the first ping gate")]
fn the_first_keeper_ping_can_arrive_after_the_runtime_watchdogs_interval() {
    let home = TestHome::new("first-ping-wait");
    let gate = "before-first-keeper-ping";
    let child = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    let killed_early = wait_until(secs(16), || !alive(&daemon) || !alive(&keeper));
    home.release_gate(gate);
    let output = child.wait_with_output().unwrap();
    assert!(
        !killed_early && output.status.success(),
        "{}\n{}",
        stderr(&output),
        home.keeper_log()
    );
    assert_eq!(home.daemon_pid(), Some(daemon.pid as i32));
}
/// A launch failure before the daemon can take its lock is an error to the detaching caller.
#[test]
fn detach_fails_when_no_daemon_started() {
    let home = TestHome::new("unstarted");
    std::fs::create_dir_all(home.path.join("framework/programs.lock")).unwrap();
    let output = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("programs.lock"),
        "{}",
        stderr(&output)
    );
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the first ping gate")]
fn the_first_keeper_ping_cannot_switch_an_expired_startup_to_the_runtime_watchdog() {
    let home = TestHome::new("late-first-ping");
    let gate = "before-first-keeper-ping";
    let child = home
        .command(&test_binaries().facade)
        .arg("list")
        .env("FACADE_TEST_GATES", gate)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = home.lock_record("keeper").unwrap().0;
    let started = child.wait_with_output().unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let _connection = connect(&home);
    let attempt = facade_base::startup::Attempt::current(&home.path.join("framework")).unwrap();
    pause_process(keeper);
    let until = attempt.status().0.deadline();
    std::thread::sleep(
        until.saturating_duration_since(Instant::now()) + Duration::from_millis(100),
    );
    home.release_gate(gate);
    std::thread::sleep(Duration::from_millis(350));
    resume_process(keeper);
    assert!(
        wait_until(secs(10), || !alive(&daemon)),
        "{}",
        home.keeper_log()
    );
    assert!(home.keeper_log().contains(&format!(
        "daemon {} did not finish its first keeper ping before the startup deadline",
        daemon.pid
    )));
    assert!(!home.keeper_log().contains("first authenticated ping"));
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the first ping and daemon accept gates"
)]
fn a_replacement_keeper_before_the_first_ping_uses_the_original_startup_deadline() {
    keeper_handoff_across_first_ping(false);
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the first ping and daemon accept gates"
)]
fn a_replacement_keeper_after_the_first_ping_uses_the_runtime_watchdog() {
    keeper_handoff_across_first_ping(true);
}

fn keeper_handoff_across_first_ping(pinged: bool) {
    let home = TestHome::new(&format!("startup-keeper-handoff-ping-{pinged}"));
    let gate = if pinged {
        "before-accept-loop"
    } else {
        "before-first-keeper-ping"
    };
    let started = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", gate)
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    home.wait_for_gate(gate);
    let daemon = process_identity(home.lock_record("daemon").unwrap().0);
    let keeper = process_identity(home.lock_record("keeper").unwrap().0);
    let framework = home.path.join("framework");
    let ping = format!("first authenticated ping from daemon {}", daemon.pid);
    if pinged {
        assert!(wait_until(LOADED_TIMEOUT, || home
            .keeper_log()
            .contains(&ping)));
        let attempt = facade_base::startup::Attempt::current(&framework).unwrap();
        assert!(!attempt.daemon_ready(&daemon));
    } else {
        assert!(wait_until(LOADED_TIMEOUT, || home.daemon_pid()
            == Some(daemon.pid as i32)));
        assert!(!home.keeper_log().contains(&ping));
    }
    kill_process(keeper.pid as i32);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&keeper)));
    let _connection = (!pinged).then(|| connect(&home));
    if !pinged {
        backdate_startup(&home, 67, 67);
    }
    let log = home.folder().join("replacement-keeper.log");
    let mut replacement = home
        .command(&test_binaries().facade)
        .arg("keeper")
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&log).unwrap())
        .spawn()
        .unwrap();
    let service = facade_base::service::Service::Keeper;
    assert!(wait_until(secs(5), || facade_base::service::live_holder(
        &framework, service
    )
    .is_ok_and(
        |holder| holder.is_some_and(|process| process.pid == replacement.id())
    )));
    let reason = if pinged {
        format!("daemon {} sent no ping for 15 seconds", daemon.pid)
    } else {
        format!(
            "daemon {} did not finish its first keeper ping before the startup deadline",
            daemon.pid
        )
    };
    let wait = if pinged { secs(23) } else { secs(12) };
    let read_log = || std::fs::read_to_string(&log).unwrap_or_default();
    assert!(
        wait_until(wait, || read_log().contains(&reason)),
        "{}",
        read_log()
    );
    assert!(
        wait_until(LOADED_TIMEOUT, || !alive(&daemon)),
        "{}",
        read_log()
    );
    let _ = replacement.wait();
}

#[cfg(unix)]
#[test]
fn a_writable_home_is_used_as_it_is_and_a_lock_keeps_its_inode_when_made_private() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let home = TestHome::new("writablehome");
    std::fs::set_permissions(&home.path, std::fs::Permissions::from_mode(0o777)).unwrap();
    std::fs::create_dir(home.path.join("framework")).unwrap();
    std::fs::set_permissions(
        home.path.join("framework"),
        std::fs::Permissions::from_mode(0o775),
    )
    .unwrap();
    let lock = home.path.join("framework/daemon.lock");
    std::fs::write(&lock, "").unwrap();
    std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o666)).unwrap();
    let inode = std::fs::metadata(&lock).unwrap().ino();
    home.run_facade_ok(&["list"]);
    let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().mode() & 0o777;
    assert_eq!(mode(&home.path), 0o777, "the home is not changed");
    assert_eq!(mode(&home.path.join("framework")), 0o700);
    assert_eq!(mode(&home.path.join("framework/logs")), 0o700);
    let meta = std::fs::metadata(&lock).unwrap();
    assert_eq!((meta.ino(), meta.mode() & 0o777), (inode, 0o600));
}

#[cfg(unix)]
#[test]
fn inherited_descriptor_enumeration_failure_reaches_the_launcher() {
    let home = TestHome::new("fdenumeration");
    home.fault("fail-fd-enumeration", "1");
    let output = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .output()
        .unwrap();
    assert!(
        !output.status.success()
            && stderr(&output).contains("could not enumerate inherited descriptors"),
        "{}",
        stderr(&output)
    );
    assert!(!socket_exists(&home.daemon_socket()));
}

#[cfg(unix)]
#[test]
fn an_eof_before_hello_retries_until_the_real_daemon_serves() {
    use std::io::{BufRead, BufReader};
    let home = TestHome::new("helloeof");
    let socket = home.daemon_socket();
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let peer = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut hello = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut hello)
            .unwrap();
        assert!(hello.contains("hello"));
        std::fs::remove_file(socket).unwrap();
        drop(listener);
        drop(stream); // EOF after the client wrote hello, before any decoded reply.
    });
    let listed = home.run_facade(&["list"]);
    peer.join().unwrap();
    assert!(listed.status.success(), "{}", stderr(&listed));
    assert!(home.lock_record("daemon").is_some());
}

#[cfg(unix)]
#[test]
fn a_malformed_hello_is_a_permanent_failure_without_a_daemon_launch() {
    use std::io::{BufRead, BufReader, Write};
    let home = TestHome::new("badhello");
    let listener = std::os::unix::net::UnixListener::bind(home.daemon_socket()).unwrap();
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut hello = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut hello)
            .unwrap();
        stream.write_all(b"{malformed\n").unwrap();
    });
    let listed = home.run_facade(&["list"]);
    peer.join().unwrap();
    assert_eq!(listed.status.code(), Some(1));
    assert!(
        !stderr(&listed).contains("still starting"),
        "{}",
        stderr(&listed)
    );
    assert!(
        home.lock_record("daemon").is_none(),
        "a protocol error must not launch a daemon"
    );
}

#[test]
fn an_acceptance_pause_requested_before_the_accept_loop_starts_is_observed() {
    let home = TestHome::new("earlyclosing");
    let output = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", "before-accept-loop")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    home.wait_for_gate("before-accept-loop");
    home.wait_for_gate("acceptance-pause-requested");
    assert!(
        socket_exists(&home.daemon_socket()),
        "the listener has not acknowledged pausing acceptance"
    );
    home.release_gate("before-accept-loop");
    home.wait_for_idle_exit();
}

#[cfg(unix)]
#[test]
fn nonregular_lock_paths_fail_promptly_with_the_owned_regular_file_message() {
    use std::os::unix::fs::symlink;
    for service in ["daemon", "keeper"] {
        for fifo in [false, true] {
            let home = TestHome::new("badlock");
            home.fault("test-placeholder", "");
            let lock = home.path.join(format!("framework/{service}.lock"));
            if fifo {
                nix::unistd::mkfifo(
                    &lock,
                    nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
                )
                .unwrap();
            } else {
                std::fs::write(home.path.join("target"), "").unwrap();
                symlink(home.path.join("target"), &lock).unwrap();
            }
            // Exercise the read path used by a client and the write path used by a foreground
            // worker.
            for args in [vec!["list"], vec![service]] {
                let output_file = home.path.join("failure");
                let mut child = home
                    .command(&test_binaries().facade)
                    .args(args)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::fs::File::create(&output_file).unwrap())
                    .spawn()
                    .unwrap();
                let ended = wait_until(secs(3), || child.try_wait().unwrap().is_some());
                if !ended {
                    child.kill().unwrap();
                }
                let status = child.wait().unwrap();
                let text = std::fs::read_to_string(&output_file).unwrap();
                assert!(
                    ended && !status.success(),
                    "a nonregular lock must fail without waiting: {text}"
                );
                assert!(
                    text.contains(&format!(
                        "cannot use {}: it is not a regular file owned by this user",
                        lock.display()
                    )),
                    "{text}"
                );
            }
        }
    }
}
