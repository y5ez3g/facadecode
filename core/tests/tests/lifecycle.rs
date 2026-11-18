//! When the daemon and keeper start and exit: races between clients and starts, the startup check
//! of the keeper lock, idle exit, and a start that meets an idle offer.

use std::time::{Duration, Instant};

use facade_scenarios::*;

/// `facade daemon --detach` follows a daemon that holds the daemon lock and ends without serving,
/// as one killed a moment before does while its lock is still being released: once it has ended,
/// another starts, and a daemon answers.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn detach_starts_a_daemon_once_one_that_held_the_lock_has_ended() {
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
            .join("core/paused-at-after-daemon-lock")
            .exists()),
        "the holder did not take the lock"
    );
    std::thread::scope(|scope| {
        let detach = scope.spawn(|| home.run_facade(&["daemon", "--detach"]));
        std::thread::sleep(Duration::from_millis(300));
        kill_process(holder.id() as i32);
        let _ = holder.wait();
        let detached = detach.join().unwrap();
        assert!(detached.status.success(), "{}", stderr(&detached));
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
    let said: Vec<String> = std::thread::scope(|scope| {
        let commands: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| home.run_facade(&["status"])))
            .collect();
        commands
            .into_iter()
            .map(|command| {
                let status = command.join().unwrap();
                assert!(status.status.success(), "{}", stderr(&status));
                stdout(&status)
            })
            .collect()
    });
    // Each status names the daemon and the keeper that served it: one of each, whatever ran when.
    let served: std::collections::HashSet<String> = said
        .iter()
        .map(|status| {
            let daemon = status
                .split("daemon pid ")
                .nth(1)
                .and_then(|rest| rest.split(' ').next());
            let keeper = status
                .split("keeper pid ")
                .nth(1)
                .and_then(|rest| rest.split(' ').next());
            match (daemon, keeper) {
                (Some(daemon), Some(keeper)) => format!("{daemon} {keeper}"),
                _ => panic!("{status}"),
            }
        })
        .collect();
    assert_eq!(served.len(), 1, "{said:?}");
}

/// A command starts the daemon, then its terminal closes before the daemon is ready. The daemon
/// continues in its own session without a controlling terminal. Reading status starts no keeper.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn a_daemon_outlives_the_terminal_that_launched_it() {
    let home = TestHome::new("detached");
    let mut command = home.command(&test_binaries().facade);
    command
        .arg("status")
        .env("FACADE_TEST_PAUSE_AT", "after-daemon-lock");
    let mut term = TestTerminal::spawn(&mut command, 80, 24);
    assert!(
        wait_until(secs(10), || home.lock_record("daemon").is_some()),
        "no daemon started"
    );
    let daemon = home.lock_record("daemon").unwrap().0;
    assert!(wait_until(secs(5), || stopped(daemon)));
    kill_process(term.pid());
    term.wait_exit(secs(5));
    drop(term);
    resume_process(daemon);
    assert!(
        wait_until(secs(10), || home.hello_result().is_some()),
        "the daemon did not survive its terminal: {}",
        home.daemon_log()
    );
    // A controlling terminal is Unix's; on Windows the daemon runs without a console.
    #[cfg(unix)]
    {
        let tty = std::process::Command::new("ps")
            .args(["-o", "tty=", "-p", &daemon.to_string()])
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
/// a client is connected and exits 5 seconds after the last one leaves, removing its socket last.
/// Records, screens, and numbering survive; status then starts only the daemon.
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
    std::thread::sleep(secs(7));
    assert!(
        alive(&daemon_process) && alive(&keeper_process),
        "the daemon exited with a client connected, or the keeper before it"
    );
    drop(wire);
    let left = Instant::now();
    assert!(
        wait_until(secs(12), || !alive(&daemon_process)),
        "the daemon did not exit when idle: {}",
        home.daemon_log()
    );
    assert!(
        left.elapsed() >= Duration::from_millis(4500),
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
    let status = home.run_facade_ok(&["status"]);
    assert!(status.contains("with 1 agents"), "{status}");
    assert!(
        home.list_line("brief")
            .is_some_and(|line| line.contains("ended: crashed (code 4)")),
        "{:?}",
        home.list_line("brief")
    );
    assert!(home.screen(&agent).contains("LAST-WORDS"));
    assert_eq!(
        start_script(&mut connect(&home), &home, "next", "sleep 60"),
        "a2",
        "numbering continues"
    );
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
        wait_until(secs(15), || stopped(exiting)),
        "the idle daemon did not stop after deciding to exit"
    );
    let status = std::thread::scope(|scope| {
        let status = scope.spawn(|| home.run_facade(&["status"]));
        std::thread::sleep(Duration::from_millis(500));
        resume_process(exiting);
        status.join().unwrap()
    });
    assert!(status.status.success(), "{}", stderr(&status));
    let next = home.lock_record("daemon").unwrap().0;
    assert_ne!(next, exiting, "the exiting daemon served the late client");
    assert!(
        stdout(&status).contains(&format!("daemon pid {next} ")),
        "{}",
        stdout(&status)
    );
    assert!(!alive(&exiting_process));
}

#[test]
fn detach_reports_a_living_worker_still_recovering_as_starting() {
    let home = TestHome::new("startingreport");
    let child = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env("FACADE_TEST_GATES", "before-recovery")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate("before-recovery");
    assert!(
        !socket_exists(&home.daemon_socket()),
        "started cannot be reported before serving"
    );
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success()
            && stderr(&output).contains("facade: Facade is still starting; see "),
        "{}",
        stderr(&output)
    );
    home.release_gate("before-recovery");
    assert!(wait_until(secs(5), || home.hello_result().is_some()));
    home.wait_for_idle_exit();
}

#[cfg(unix)]
#[test]
fn a_writable_home_is_used_as_it_is_and_a_lock_keeps_its_inode_when_made_private() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let home = TestHome::new("writablehome");
    std::fs::set_permissions(&home.path, std::fs::Permissions::from_mode(0o777)).unwrap();
    std::fs::create_dir(home.path.join("core")).unwrap();
    std::fs::set_permissions(
        home.path.join("core"),
        std::fs::Permissions::from_mode(0o775),
    )
    .unwrap();
    let lock = home.path.join("core/daemon.lock");
    std::fs::write(&lock, "").unwrap();
    std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o666)).unwrap();
    let inode = std::fs::metadata(&lock).unwrap().ino();
    home.run_facade_ok(&["list"]);
    let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().mode() & 0o777;
    assert_eq!(mode(&home.path), 0o777, "the home is not changed");
    assert_eq!(mode(&home.path.join("core")), 0o700);
    assert_eq!(mode(&home.path.join("core/logs")), 0o700);
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
            let lock = home.path.join(format!("core/{service}.lock"));
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
            for args in [vec!["status"], vec![service]] {
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
