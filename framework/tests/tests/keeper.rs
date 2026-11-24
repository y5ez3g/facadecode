//! Keeper authentication, PTY ownership, process group stops, replacement of a keeper that ends,
//! and shutdown.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::{Duration, Instant};

use facade_base::paths::ClientSocket;
use facade_base::service::{Locked, Service, lock_home};
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

#[test]
fn keeper_v1_handshake_and_native_terminal_ownership() {
    let _ = test_binaries();
    let home = TestHome::new("keeper-v1-native");
    let temp = home.folder().join("driver-temp");
    std::fs::create_dir(&temp).unwrap();
    // The keeper can stop its proved daemon if the link stalls. Give that identity to a child
    // in the test's own home so the ordinary scenario runner can still report the result.
    let mut driver = home.command(std::env::current_exe().unwrap());
    driver
        .args([
            "--ignored",
            "--exact",
            "keeper_v1_native_fixture",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("FACADE_SCENARIO_NATIVE_KEEPER", "1")
        .env("FACADE_TEST_BINARIES_BUILT", "1")
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env("TMPDIR", &temp)
        .stdin(Stdio::null());
    if let Some(keep) = std::env::var_os("FACADE_SCENARIO_KEEP") {
        driver.env("FACADE_SCENARIO_KEEP", keep);
    }
    let output = driver.output().unwrap();
    assert!(
        output.status.success(),
        "keeper fixture exited {}\n{}\n{}\nkeeper stderr:\n{}\nkeeper log:\n{}",
        output.status,
        stdout(&output),
        stderr(&output),
        std::fs::read_to_string(home.folder().join("keeper-stderr.log")).unwrap_or_default(),
        home.keeper_log()
    );
    assert!(stdout(&output).contains("1 passed"), "{}", stdout(&output));
    print!("{}", stdout(&output));
}

/// Exercise the real keeper with this test process holding its isolated daemon lock.
#[test]
#[ignore = "spawned as the proved daemon by keeper_v1_handshake_and_native_terminal_ownership"]
fn keeper_v1_native_fixture() {
    assert_eq!(
        std::env::var("FACADE_SCENARIO_NATIVE_KEEPER").as_deref(),
        Ok("1")
    );
    let home = TestHome {
        path: std::env::var_os("FACADE_HOME").unwrap().into(),
        project: std::env::current_dir().unwrap(),
        fake_log: std::env::var_os("FAKECLI_LOG").unwrap().into(),
    };
    let installed =
        facade_base::programs::install(&test_binaries().facade, &facade_base::build_id()).unwrap();
    let framework = home.path.join("framework");
    std::fs::create_dir_all(framework.join("logs")).unwrap();
    assert!(matches!(
        lock_home(&framework, Service::Daemon).unwrap(),
        Locked::Held
    ));
    let daemon = home.lock_record("daemon").unwrap();
    assert_eq!(daemon.0, std::process::id() as i32);
    assert_eq!(daemon.1, process_identity(daemon.0).birth);

    let started = Instant::now();
    let stage = |name| {
        eprintln!(
            "native keeper fixture after {:?}: {name}",
            started.elapsed()
        )
    };
    let start_keeper = || {
        let keeper_stderr = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(home.folder().join("keeper-stderr.log"))
            .unwrap();
        let keeper = home
            .command(&installed)
            .arg("keeper")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(keeper_stderr)
            .spawn()
            .unwrap();
        assert!(
            wait_until(LOADED_TIMEOUT, || {
                home.lock_record("keeper")
                    .is_some_and(|(pid, _)| pid == keeper.id() as i32)
                    && ClientSocket::connect(home.keeper_socket()).is_ok()
            }),
            "the proved keeper did not start: {}",
            home.keeper_log()
        );
        keeper
    };
    stage("starting the first keeper");
    let mut keeper = start_keeper();
    let before = home.lock_record("keeper").unwrap();
    stage("checking first keeper hello");
    let mut wire = KeeperTestClient::open(&home);
    let (early, resource) = wire.call("daemon.ping", json!({}), None);
    assert_eq!(error_reason(&early), "invalid_argument", "{early}");
    assert!(resource.is_none());
    let (range, resource) = wire.request("hello", json!({ "protocol": [1, 1] }), None);
    assert_eq!(range["error"]["code"], -32602, "{range}");
    assert_eq!(error_reason(&range), "invalid_argument", "{range}");
    assert!(resource.is_none());
    let (disjoint, resource) = wire.request("hello", json!({ "api_versions": [2] }), None);
    assert_eq!(disjoint["error"]["code"], -32000, "{disjoint}");
    assert_eq!(
        error_reason(&disjoint),
        "protocol_incompatible",
        "{disjoint}"
    );
    assert_eq!(
        disjoint["error"]["data"]["details"]["supported_api_versions"],
        json!([1])
    );
    assert!(resource.is_none());
    let (hello, resource) = wire.request("hello", json!({ "api_versions": [2, 1, 1] }), None);
    assert_eq!(hello["result"]["api_version"], 1, "{hello}");
    assert_eq!(hello["result"]["agents"], json!([]), "{hello}");
    assert!(resource.is_none());
    let (duplicate, resource) = wire.request("hello", json!({ "api_versions": [1] }), None);
    assert_eq!(error_reason(&duplicate), "invalid_argument", "{duplicate}");
    assert!(resource.is_none());

    let program = home.command(&test_binaries().fakecli);
    let env: BTreeMap<_, _> = program
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| (key.to_string_lossy(), value.to_string_lossy()))
        })
        .collect();
    let start = |wire: &mut KeeperTestClient, id| {
        let (reply, resource) = wire.call(
            "agent.start",
            json!({
                "agent_id": id, "command": [test_binaries().fakecli], "env": env,
                "cwd": home.project, "size": { "cols": 80, "rows": 24 },
            }),
            None,
        );
        let pid = reply["result"]["pid"]
            .as_i64()
            .unwrap_or_else(|| panic!("keeper agent.start reply: {reply}"));
        let identity = process_identity(pid as i32);
        assert_eq!(reply["result"]["birth"], identity.birth, "{reply}");
        let sync = json!({ "agent_id": id, "pid": identity.pid, "birth": identity.birth });
        (
            identity,
            sync,
            resource.expect("start carries a native terminal copy"),
        )
    };
    stage("starting the two CLIs");
    let (agent, sync, terminal) = start(&mut wire, "a1");
    #[cfg(unix)]
    let running_output = drain_unix_master(&terminal);
    let (_, exited_sync, exited_terminal) = start(&mut wire, "a2");
    #[cfg(unix)]
    let exiting_output = drain_unix_master(&exited_terminal);

    stage("queueing the ordinary ping and native sync");
    // Queue an ordinary request before a native resource request without reading a reply.
    #[cfg(unix)]
    pause_process(keeper.id() as i32);
    let ping = wire.send("call", json!({ "op": "daemon.ping", "args": {} }), None);
    let extra = wire.send(
        "call",
        json!({ "op": "agent.sync", "args": sync }),
        Some(&terminal),
    );
    #[cfg(unix)]
    resume_process(keeper.id() as i32);
    stage("reading the ping and native sync replies");
    for id in [ping, extra] {
        let (reply, resource) = wire.receive();
        assert_eq!(reply["id"], id, "{reply}");
        assert_eq!(reply["result"], json!({}), "{reply}");
        assert!(resource.is_none());
    }
    let (returned, resource) = wire.call("agent.sync", sync.clone(), None);
    assert_eq!(returned["result"], json!({}), "{returned}");
    drop(resource.expect("a keeper holding the terminal returns a copy"));
    let mut wrong_birth = sync.clone();
    wrong_birth["birth"] = json!("a different process birth");
    let (mismatch, resource) = wire.call("agent.sync", wrong_birth, Some(&terminal));
    assert_eq!(error_reason(&mismatch), "invalid_argument", "{mismatch}");
    assert!(resource.is_none() && alive(&agent));
    stage("stopping the second CLI and waiting for changed");
    let (stop, resource) = wire.call("agent.stop", json!({ "agent_id": "a2" }), None);
    assert_eq!(stop["result"], json!({}), "{stop}");
    assert!(resource.is_none());
    let (changed, resource) = wire.receive();
    assert_eq!(changed["method"], "changed", "{changed}");
    assert_eq!(changed["params"]["kind"], "exit", "{changed}");
    assert_eq!(changed["params"]["agent_id"], "a2", "{changed}");
    assert!(
        changed["params"]["exit"]["at"].is_string() && resource.is_none(),
        "{changed}"
    );

    keeper.kill().unwrap();
    keeper.wait().unwrap();
    drop(wire);
    stage("starting the replacement keeper");
    let mut keeper = start_keeper();
    let after = home.lock_record("keeper").unwrap();
    assert_ne!(after.0, before.0);
    assert_ne!(after.1, before.1);
    stage("checking the replacement keeper hello");
    let mut wire = KeeperTestClient::open(&home);
    let (hello, resource) = wire.request("hello", json!({ "api_versions": [1] }), None);
    assert_eq!(hello["result"]["agents"], json!([]), "{hello}");
    assert!(resource.is_none());
    stage("syncing the running and exited CLIs after replacement");
    let (missing, resource) = wire.call("agent.sync", sync.clone(), None);
    assert_eq!(error_reason(&missing), "not_found", "{missing}");
    assert!(resource.is_none());
    let (held, resource) = wire.call("agent.sync", sync, Some(&terminal));
    assert_eq!(held["result"], json!({}), "{held}");
    assert!(resource.is_none() && alive(&agent));
    let (ack, resource) = wire.call("agent.sync", exited_sync, Some(&exited_terminal));
    assert_eq!(ack["result"], json!({}), "{ack}");
    assert!(resource.is_none());
    let (changed, resource) = wire.receive();
    assert_eq!(changed["method"], "changed", "{changed}");
    assert_eq!(changed["params"]["kind"], "exit", "{changed}");
    assert_eq!(changed["params"]["agent_id"], "a2", "{changed}");
    assert!(
        changed["params"]["exit"]["at"].is_string() && resource.is_none(),
        "{changed}"
    );
    stage("stopping the adopted CLI and waiting for changed");
    let (stop, resource) = wire.call("agent.stop", json!({ "agent_id": "a1" }), None);
    assert_eq!(stop["result"], json!({}), "{stop}");
    assert!(resource.is_none());
    let (changed, resource) = wire.receive();
    assert_eq!(changed["params"]["agent_id"], "a1", "{changed}");
    assert!(resource.is_none());
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&agent)));
    println!("proved daemon {daemon:?}, keeper {before:?} -> {after:?}, adopted CLI {agent:?}");
    keeper.kill().unwrap();
    keeper.wait().unwrap();
    #[cfg(unix)]
    for output in [running_output, exiting_output] {
        output.join().unwrap().unwrap();
    }
}

/// Drain the CLI's output as the real daemon does, while retaining the master for sync.
/// On Darwin unread output can keep the CLI in kernel exit even after it has stopped.
#[cfg(unix)]
fn drain_unix_master(
    master: &facade_base::terminal::PtyMaster,
) -> std::thread::JoinHandle<std::io::Result<()>> {
    let descriptor = std::os::fd::OwnedFd::from(master.try_clone().unwrap());
    std::thread::spawn(move || {
        let mut reader = std::fs::File::from(descriptor);
        match std::io::copy(&mut reader, &mut std::io::sink()) {
            Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(()),
            copied => copied.map(|_| ()),
        }
    })
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
        "env": { "PATH": SYSTEM_PATH.as_str() }, "size": { "cols": 80, "rows": 24 },
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
    let response = probe.call("agent.screen", json!({ "target": "w1" }));
    let took = asked.elapsed();
    resume_process(keeper);
    assert!(response["result"]["text"].is_string(), "{response}");
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

/// The keeper ends while the daemon holds a running agent. Keep the original daemon connection,
/// Attach watch, and CLI alive through replacement, then observe the adopted CLI's exit on that watch.
#[test]
fn a_dead_keeper_is_replaced_and_the_daemon_keeps_every_terminal() {
    let home = TestHome::new("keepergone");
    let agent = home.start_fake_with("w1", &[("FAKECLI_STATUS", "1")]);
    let stopped = home.start_fake("w2");
    let mut connection = DaemonTestClient::open(&home);
    let welcome = connection.request(
        "hello",
        json!({ "api_versions": [1], "build": "test", "kind": "terminal" }),
    );
    assert_eq!(welcome["result"]["api_version"], 1, "{welcome}");
    let reference = json!({
        "machine_id": welcome["result"]["machine_id"], "agent_id": agent.id,
    });
    let opened = connection.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": reference, "size": { "cols": 80, "rows": 24 } } }),
    );
    let watch = opened["result"]["watch"]
        .as_u64()
        .expect("the original Attach watch");
    assert_eq!(
        opened["result"]["snapshot"]["reference"], reference,
        "{opened}"
    );
    let (keeper, daemon) = (
        home.lock_record("keeper")
            .expect("expected a running keeper"),
        home.lock_record("daemon")
            .expect("expected a running daemon"),
    );
    kill_process(keeper.0);
    let mut replacement = None;
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            replacement = home
                .lock_record("keeper")
                .filter(|record| record.0 != keeper.0);
            replacement.is_some()
        }),
        "no replacement keeper: {}",
        home.daemon_log()
    );
    let replacement = replacement.unwrap();
    assert_ne!(
        replacement.1, keeper.1,
        "the replacement keeper has a new birth identity"
    );
    // Whether the daemon meets the keeper dead or its connection closed first, the new keeper is
    // given the terminal.
    assert!(
        wait_until(secs(10), || home.keeper_log().contains("holding a1's CLI")),
        "{}\n{}",
        home.keeper_log(),
        home.daemon_log()
    );
    assert_eq!(
        home.lock_record("daemon"),
        Some(daemon.clone()),
        "the daemon stays"
    );
    assert!(alive(&agent.process), "the CLI keeps running");
    assert_eq!(process_identity(agent.pid), agent.process);
    let typed = |bytes: &[u8]| {
        json!({
            "jsonrpc": "2.0", "method": "call", "params": {
                "op": "agent.type", "args": {
                    "target": reference, "input": { "kind": "raw", "raw": facade_base::base64::encode(bytes) },
                },
            },
        })
    };
    let before = connection.changes(watch).len();
    connection.write(&typed(b"still here\r"));
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            let output: Vec<_> = connection
                .changes(watch)
                .into_iter()
                .skip(before)
                .filter_map(|frame| {
                    frame["change"]["data"]
                        .as_str()
                        .and_then(|data| facade_base::base64::decode(data).ok())
                })
                .flatten()
                .collect();
            output
                .windows(b"still here".len())
                .any(|bytes| bytes == b"still here")
        }),
        "the original Attach watch stopped receiving output: {:?}",
        connection.changes(watch)
    );
    assert!(wait_until(LOADED_TIMEOUT, || home.submitted_messages()
        == ["still here"]));

    connection.write(&typed(b"/fake exit 42\r"));
    let mut exit = None;
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            exit = connection.changes(watch).into_iter().find_map(|event| {
                let change = &event["change"];
                (change["kind"] == "exit").then(|| change["exit"].clone())
            });
            exit.is_some()
        }),
        "the original Attach watch did not report exit: {:?}",
        connection.changes(watch)
    );
    let exit = exit.unwrap();
    assert!(
        exit["at"].is_string() && exit.get("signal").is_none(),
        "{exit}"
    );
    #[cfg(unix)]
    assert!(
        exit.as_object().is_some_and(|fields| fields.len() == 1),
        "an adopted Unix CLI reports only its observed exit time: {exit}"
    );
    #[cfg(windows)]
    assert_eq!(exit["code"], 42, "{exit}");
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&agent.process)));
    assert!(alive(&stopped.process));
    home.run_facade_ok(&["stop", "w2"]);
    assert!(
        wait_until(LOADED_TIMEOUT, || !alive(&stopped.process)),
        "the replacement keeper stopped the other adopted CLI"
    );
    println!(
        "daemon {daemon:?}, keeper {keeper:?} -> {replacement:?}, CLI {:?}, watch {watch}, exit {exit}",
        agent.process
    );
    let inspected = home.run_facade_ok(&["status", "w2"]);
    assert!(
        inspected
            .lines()
            .any(|line| line.starts_with("State ")
                && line[5..].trim() == "Ended (stopped by Facade)"),
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
        "env": { "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path }, "size": { "cols": 80, "rows": 24 },
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
    assert_eq!(
        started["result"]["agent"]["reference"]["agent_id"], "a1",
        "{started}"
    );
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
    // Let the daemon finish normal shutdown while the keeper cannot restart it.
    pause_process(keeper);
    assert!(
        wait_until(secs(10), || stopped(keeper) && alive(&keeper_process)),
        "keeper did not pause: {}",
        home.keeper_log()
    );
    send_signal(daemon, libc::SIGTERM);
    assert!(
        wait_until(secs(10), || !alive(&daemon_process)
            && !socket_exists(&home.daemon_socket())),
        "daemon did not exit and remove its socket: {}",
        home.daemon_log()
    );
    // Queue normal shutdown before the keeper can act on the daemon's exit.
    send_signal(keeper, libc::SIGTERM);
    resume_process(keeper);
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
    let started = home.started_daemons();
    assert_eq!(started, [daemon], "{}", home.keeper_log());
    let live = home.processes();
    assert!(
        started.iter().all(|pid| !live.contains(pid)),
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
                        "env": { "PATH": SYSTEM_PATH.as_str() }, "size": { "cols": 80, "rows": 24 },
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
                response["result"]["agent"]["reference"]["agent_id"].is_string(),
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
