//! A new Facade taking over while agents run: the keeper becoming another build in place, the same
//! process, with every run, and a command of a newer build handing the running Facade over to it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use facade_scenarios::serde_json::json;
use facade_scenarios::*;

/// The command line of process `pid`.
fn command_of(pid: i32) -> String {
    command_line_of(pid)
}

/// When the first line of `log` that says `text` was written, in milliseconds of its day, as Facade
/// stamps each line: `2026-11-13T22:50:45.971Z daemon[6355] info: …`.
fn logged_at(log: &str, text: &str) -> u64 {
    let line = log
        .lines()
        .find(|line| line.contains(text))
        .unwrap_or_else(|| panic!("no line says {text:?}:\n{log}"));
    let time: Vec<u64> = line
        .get(11..23)
        .unwrap_or(line)
        .split([':', '.'])
        .map(|part| part.parse().unwrap())
        .collect();
    ((time[0] * 60 + time[1]) * 60 + time[2]) * 1000 + time[3]
}

/// The milliseconds from `earlier` to `later`, two times [`logged_at`] read, across midnight too.
fn millis_between(earlier: u64, later: u64) -> u64 {
    (later + 86_400_000 - earlier) % 86_400_000
}

/// Process `pid`'s state on Windows: `R` while it runs, nothing once it is gone.
#[cfg(windows)]
fn process_state(pid: i32) -> String {
    // Windows keeps no zombies: a process runs, or it is gone.
    if alive(&process_identity(pid)) {
        "R".to_string()
    } else {
        String::new()
    }
}

/// What `ps` shows of process `pid`'s state, nothing once it is gone.
#[cfg(unix)]
fn process_state(pid: i32) -> String {
    let ps = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&ps.stdout).trim().to_string()
}

/// Whether process `pid` ended and its parent has not reaped it.
fn zombie(pid: i32) -> bool {
    process_state(pid).starts_with('Z')
}

/// Whether process `pid` is gone, reaped.
fn gone(pid: i32) -> bool {
    process_state(pid).is_empty()
}

/// This Facade's version, the workspace's: the builds the tests make are named from it, so a
/// release that changes the version changes none of them.
const CURRENT: &str = env!("CARGO_PKG_VERSION");

/// The numbers of this Facade's version: major, minor and patch.
fn version() -> [u64; 3] {
    let numbers: Vec<u64> = CURRENT
        .split(['.', '-', '+'])
        .take(3)
        .map(|number| number.parse().expect("a version number"))
        .collect();
    [numbers[0], numbers[1], numbers[2]]
}

/// A version newer than this Facade's: its next patch.
fn newer() -> String {
    let [major, minor, patch] = version();
    format!("{major}.{minor}.{}", patch + 1)
}

/// A version older than this Facade's.
fn older() -> String {
    match version() {
        [major, minor, patch] if patch > 0 => format!("{major}.{minor}.{}", patch - 1),
        [major, minor, _] if minor > 0 => format!("{major}.{}.0", minor - 1),
        [major, _, _] => format!("{}.0.0", major - 1),
    }
}

/// A pre-release of this Facade's version.
fn pre_release() -> String {
    format!("{CURRENT}-rc1")
}

/// The keeper as its lock records it: its process ID and birth value.
fn keeper(home: &TestHome) -> facade_base::process::ProcessIdentity {
    let (pid, birth) = home
        .lock_record("keeper")
        .expect("the keeper holds its lock");
    facade_base::process::ProcessIdentity {
        pid: pid as u32,
        birth,
    }
}

/// The program of another build in the test's folder, as a person installs one: a script that plays
/// build `build` and runs the test binary, with the test's `facade-mcp` beside it.
fn program_of_build(home: &TestHome, build: &str) -> PathBuf {
    build_failing_as(home, build, "")
}

/// A client with changed bytes and the same build ID starts services from those bytes after the
/// home's earlier services have ended.
#[cfg(any(windows, target_os = "linux"))]
#[test]
fn a_client_with_the_same_build_and_different_bytes_restarts_the_services() {
    restart_with_changed_bytes(false);
}

/// An existing build folder may hold a hard link to the earlier program.
#[cfg(target_os = "linux")]
#[test]
fn a_client_with_the_same_build_and_different_bytes_replaces_a_hard_link() {
    restart_with_changed_bytes(true);
}

#[cfg(any(windows, target_os = "linux"))]
fn restart_with_changed_bytes(hard_link: bool) {
    use std::io::Write;

    let home = TestHome::new(if hard_link {
        "samebuildlink"
    } else {
        "samebuildcopy"
    });
    let binaries = test_binaries();
    let copy = |name: &str, marker: &[u8]| {
        let folder = home.folder().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        let program = folder.join(program_name("facade"));
        std::fs::copy(&binaries.facade, &program).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&program)
            .unwrap()
            .write_all(marker)
            .unwrap();
        std::fs::copy(&binaries.mcp, folder.join(program_name("facade-mcp"))).unwrap();
        #[cfg(windows)]
        {
            let conpty = folder.join("conpty");
            std::fs::create_dir_all(&conpty).unwrap();
            for file in std::fs::read_dir(binaries.facade.parent().unwrap().join("conpty")).unwrap()
            {
                let file = file.unwrap();
                std::fs::copy(file.path(), conpty.join(file.file_name())).unwrap();
            }
        }
        program
    };
    let before = copy("before", b"\nfacade same build: old\n");
    let after = copy("after", b"\nfacade same build: new\n");
    let old_bytes = std::fs::read(&before).unwrap();
    let new_bytes = std::fs::read(&after).unwrap();
    assert!(old_bytes != new_bytes);
    // Use the normal install path: the harness otherwise asks debug builds for test-only links.
    let start = |program: &Path, name: &str| {
        let output = home
            .command(program)
            .env_remove("FACADE_TEST_LINK_PROGRAMS")
            .args(["start", "--name", name, "fake"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}\n{}",
            stderr(&output),
            home.keeper_log(),
            home.daemon_log()
        );
        home.started_agent(&stdout(&output))
    };
    let first = start(&before, "before");
    let hello = home.hello_result().unwrap();
    let build = hello["build"].as_str().unwrap().to_string();
    let previous_keeper = process_identity(home.keeper_pid().unwrap());
    let previous_daemon = process_identity(home.daemon_pid().unwrap());
    assert!(service_images_match(
        &home, "before", &old_bytes, &new_bytes, false
    ));
    {
        let mut wire = connect(&home);
        let removed = wire.call("agent.remove", json!({ "agent": first.id }));
        assert!(removed.get("error").is_none(), "{removed}");
    }
    assert!(
        wait_until(LOADED_TIMEOUT, || !alive(&previous_keeper)
            && !alive(&previous_daemon)),
        "the earlier services have not ended\n{}\n{}",
        home.keeper_log(),
        home.daemon_log()
    );
    assert!(!alive(&first.process), "the earlier fake CLI has ended");
    let installed = home
        .path
        .join("core/bin")
        .join(&build)
        .join(program_name("facade"));
    assert!(std::fs::read(&installed).unwrap() == old_bytes);
    #[cfg(target_os = "linux")]
    if hard_link {
        std::fs::remove_file(&installed).unwrap();
        std::fs::hard_link(&before, &installed).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            std::fs::metadata(&before).unwrap().ino(),
            std::fs::metadata(&installed).unwrap().ino()
        );
    }
    eprintln!(
        "existing home build={build}, hard_link={hard_link}, previous keeper={} and daemon={} ended",
        previous_keeper.pid, previous_daemon.pid
    );
    let second = start(&after, "after");
    assert_eq!(
        home.hello_result().unwrap()["build"],
        build,
        "the build ID stays the same"
    );
    assert!(alive(&second.process), "the new fake CLI runs");
    assert!(
        service_images_match(&home, "after", &old_bytes, &new_bytes, true),
        "a client with the same build ID must restart both services from its own bytes"
    );
}

/// Reads the service's actual program: /proc keeps the running inode on Linux, even if its path
/// was replaced; Windows reports the image path and holds that file while the service runs.
#[cfg(any(windows, target_os = "linux"))]
fn service_images_match(
    home: &TestHome,
    when: &str,
    old: &[u8],
    new: &[u8],
    want_new: bool,
) -> bool {
    let services = [
        ("keeper", home.keeper_pid().unwrap()),
        ("daemon", home.daemon_pid().unwrap()),
    ];
    let mut matched = true;
    for (role, pid) in services {
        #[cfg(target_os = "linux")]
        let (path, bytes) = {
            let image = PathBuf::from(format!("/proc/{pid}/exe"));
            (
                std::fs::read_link(&image).unwrap(),
                std::fs::read(image).unwrap(),
            )
        };
        #[cfg(windows)]
        let (path, bytes) = {
            let image = program_of(pid).expect("the service's image path");
            let bytes = std::fs::read(&image).unwrap();
            (image, bytes)
        };
        let (is_old, is_new) = (bytes == old, bytes == new);
        let marker = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(24)..]);
        eprintln!(
            "{when} {role} pid={pid} image={} bytes={} old={is_old} new={is_new} tail={marker:?}",
            path.display(),
            bytes.len()
        );
        matched &= if want_new { is_new } else { is_old };
    }
    matched
}

/// Another build, as [`program_of_build`] is, that ends with code 3 when it runs as `role`, such as
/// `daemon`.
fn build_failing_as(home: &TestHome, build: &str, role: &str) -> PathBuf {
    build_doing_as(home, build, role, "echo 'broken on purpose' >&2; exit 3")
}

/// Another build, as [`program_of_build`] is, that runs the shell commands `what` instead when it
/// runs as `role`.
fn build_doing_as(home: &TestHome, build: &str, role: &str, what: &str) -> PathBuf {
    let folder = home.folder().join(format!("build-{build}"));
    std::fs::create_dir_all(&folder).unwrap();
    // Windows has no exec for a script to become the program: a copy of the program plays the
    // build the file beside it names, and notes each line it runs in the log that file names.
    #[cfg(windows)]
    {
        assert!(
            role.is_empty(),
            "a build fails as {role} on Unix only: {what}"
        );
        let program = folder.join("facade.exe");
        std::fs::copy(&test_binaries().facade, &program).unwrap();
        std::fs::copy(&test_binaries().mcp, folder.join("facade-mcp.exe")).unwrap();
        std::fs::write(
            folder.join("facade.exe.test-build"),
            format!("{build}\n{}\n", folder.join("ran.log").display()),
        )
        .unwrap();
        program
    }
    #[cfg(unix)]
    {
        let program = folder.join(program_name("facade"));
        let fails = if role.is_empty() {
            String::new()
        } else {
            format!("[ \"$1\" = '{role}' ] && {{ {what}; }}\n")
        };
        // It notes each line it runs, as `ran.log` beside it.
        let ran = folder.join("ran.log");
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n{fails}FACADE_TEST_BUILD='{build}' \
         FACADE_TEST_PROGRAM=\"$0\" exec '{}' \"$@\"\n",
            ran.display(),
            test_binaries().facade.display()
        );
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(
            &program,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        install_program(&folder, "facade-mcp", &test_binaries().mcp);
        program
    }
}

/// A window whose connection ended during an upgrade keeps its running agent and screen.
#[test]
fn an_editor_window_s_agents_outlive_a_newer_daemon_taking_over() {
    let home = TestHome::new("windowupgrade");
    // Earlier daemons use this setting to give recovered windows a 1.5-second grace period.
    home.start_facade_with(&[("FACADE_TEST_GRACE_MS", "1500")]);
    let folder = facade_base::files::real_path(&home.project).unwrap();
    let (mut editor, reference) = ide_binding(
        &home,
        &json!({
            "id": "win-1", "label": "Editor", "environment": "local", "workspace": "app",
            "folders": [folder],
        }),
    );
    let started = editor.call(
        "agent.start",
        json!({
            "command": [shell(), "-c", "echo BEFORE-UPGRADE; sleep 600"], "name": "kept",
            "cwd": folder, "location_source_window": reference, "cols": 80, "rows": 24,
            "env": { "PATH": SYSTEM_PATH.as_str(), "FACADE_HOME": home.path },
        }),
    );
    let before = &started["result"]["agent"];
    let id = before["agent_id"]
        .as_str()
        .expect("an editor agent started");
    let process = process_identity(before["pid"].as_i64().expect("the agent has a PID") as i32);
    assert!(wait_for_screen_text(&home, id, "BEFORE-UPGRADE"));
    let screen = home.screen(id);
    let daemon = home.daemon_pid().unwrap();

    let next = newer();
    let output = home
        .command(program_of_build(&home, &next))
        .arg("list")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    let hello = home.hello_result().expect("the new daemon answers");
    assert_eq!(hello["build"], next);
    assert_ne!(hello["pid"], daemon);
    drop(editor);

    std::thread::sleep(secs(3));
    let after = home
        .agent_from_list_json("kept")
        .expect("the agent's record");
    assert_eq!(after["agent_id"], id);
    assert_eq!(after["windows"], json!([reference]));
    assert_eq!(after["location_source_window"], json!(reference));
    assert_eq!(after["process"], "running", "{after}");
    assert_eq!(after["pid"], before["pid"]);
    assert!(alive(&process), "the original process is still alive");
    assert_eq!(home.screen(id), screen);
    let windows = connect(&home).request("watch", json!({ "topic": "windows" }));
    let window = windows["result"]["snapshot"]
        .as_array()
        .expect("the windows snapshot")
        .iter()
        .find(|window| window["window_id"] == reference.window_id)
        .expect("the disconnected window stays listed");
    assert_eq!(window["connected"], false, "{window}");
}

/// A command of a newer build hands the running Facade over to it and says so on one line. The
/// agents' CLIs and the keeper keep their processes, the keeper as the new build; a new daemon
/// serves them. Once the new build proves healthy, the launchers point at it.
/// A newer build's `status` shows its own version beside the running services' older build, and
/// upgrades nothing: the daemon keeps its process and build.
#[test]
fn a_newer_build_s_status_shows_both_builds_and_upgrades_nothing() {
    let home = TestHome::new("statusnewer");
    home.start_named_fake("w1", &[]);
    let hello = home.hello_result().unwrap();
    let (daemon, keeper) = (hello["pid"].clone(), hello["keeper"]["pid"].clone());
    let program = program_of_build(&home, &newer());
    let status = home
        .command(&program)
        .arg("status")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        (stdout(&status), stderr(&status), status.status.code()),
        (
            format!(
                "Facade is running.\n  Home:      {}\n  Version:   {}\n  Daemon:    pid {daemon} \
                 ({CURRENT})\n  Keeper:    pid {keeper} ({CURRENT})\n  Agents:    1\n",
                home.path.display(),
                newer()
            ),
            String::new(),
            Some(0)
        )
    );
    let after = home.hello_result().unwrap();
    assert_eq!(
        (&after["pid"], &after["build"]),
        (&daemon, &json!(CURRENT)),
        "status upgraded the running Facade"
    );
}

#[test]
fn a_newer_build_s_command_takes_over_while_agents_run() {
    let home = TestHome::new("takeover");
    // A daemon that asked a CLI to redraw would pause here.
    home.start_facade_with(&[
        ("FACADE_TEST_TRIAL_MS", "10000"),
        ("FACADE_TEST_PAUSE_AT", "inside-nudge"),
    ]);
    let (w1, w2) = (home.start_fake("w1"), home.start_fake("w2"));
    let (before, daemon) = (keeper(&home), home.daemon_pid().unwrap());
    // A build older than the one before, unchanged for an hour.
    let older = home.path.join(format!("core/bin/{}", older()));
    std::fs::create_dir_all(&older).unwrap();
    std::fs::write(older.join(program_name("facade")), "").unwrap();
    let hour_ago = std::time::SystemTime::now() - secs(3600);
    #[cfg(unix)]
    let folder = std::fs::File::open(&older).unwrap();
    // Windows opens a folder only with backup semantics, and changes its times only with the right
    // to write its attributes.
    #[cfg(windows)]
    let folder = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .access_mode(0x0100)
            .custom_flags(0x0200_0000)
            .open(&older)
            .unwrap()
    };
    folder.set_modified(hour_ago).unwrap();
    // A file written in place, until its rename, is none of the screen's yet.
    let screen_files = || {
        let names = std::fs::read_dir(home.path.join("core/screens/a1"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name());
        names
            .filter(|name| !name.to_string_lossy().ends_with(".tmp"))
            .collect::<std::collections::BTreeSet<_>>()
    };
    let files = screen_files();
    let program = program_of_build(&home, &newer());
    let listed = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let said = stderr(&listed);
    assert!(
        listed.status.success(),
        "{said}\n{}\n{}",
        home.daemon_log(),
        home.keeper_log()
    );
    assert!(
        said.starts_with(&format!(
            "note: upgraded running Facade {CURRENT} to {}; 2 agents kept running",
            newer()
        )),
        "{said}"
    );
    assert!(
        Table::parse(&stdout(&listed)).column("NAME") == ["w1", "w2"],
        "{}",
        stdout(&listed)
    );
    let hello = home.hello_result().expect("the new daemon answers");
    assert_eq!(
        (
            hello["build"].as_str(),
            hello["keeper"]["pid"].as_u64(),
            hello["keeper"]["build"].as_str()
        ),
        (
            Some(newer().as_str()),
            Some(before.pid as u64),
            Some(CURRENT)
        ),
        "the keeper stays as it was: {hello}"
    );
    assert_ne!(
        hello["pid"].as_i64(),
        Some(daemon as i64),
        "a new daemon serves"
    );
    assert!(
        !home.path.join("core/paused-at-inside-nudge").exists(),
        "the new daemon asked a CLI to redraw after a clean handover"
    );
    assert!(alive(&w1.process) && alive(&w2.process), "the CLIs run on");
    type_raw(&mut connect(&home), "w1", "after the takeover\r");
    assert!(
        wait_until(secs(10), || home.submitted_messages()
            == ["after the takeover"]),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        screen_files(),
        files,
        "w1's output goes on in its published screen log"
    );
    // The take-over pointed the launchers at the new build, which a new run names.
    home.start_fake("w3");
    assert_eq!(
        launcher_build(&home.path).as_deref(),
        Some(newer().as_str()),
        "{}",
        home.keeper_log()
    );
    // A crash now recovers each screen from the log both daemons wrote, as it was.
    let shown = home.screen("w1");
    let crashed = home.kill_daemon();
    home.wait_for_daemon_after(crashed, secs(20))
        .expect("the keeper starts the daemon again");
    // After a crash the CLI is asked to redraw, narrowed by a column for a moment: the clean end's
    // note served the daemon after it alone.
    assert!(
        wait_until(secs(10), || home.screen("w1") == shown),
        "{}\n{shown}",
        home.screen("w1")
    );
    assert!(
        wait_until(secs(10), || home
            .path
            .join("core/paused-at-inside-nudge")
            .exists()),
        "the CLI was not asked to redraw after a crash"
    );
    // Healthy, the new build keeps the one before it, and an older one goes.
    assert!(
        home.path
            .join(format!("core/bin/{CURRENT}"))
            .join(program_name("facade"))
            .exists()
            && !older.exists(),
        "{:?}",
        std::fs::read_dir(home.path.join("core").join("bin"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name())
            .collect::<Vec<_>>()
    );
}

/// A call on a connection that said hello before the drain is refused as `upgrading` and does
/// nothing; a command repeats it at the next daemon, which does it once.
#[test]
fn a_call_made_while_the_daemon_before_drains_is_refused_and_repeated_at_the_next_daemon() {
    let home = TestHome::new("drainedcall");
    home.start_facade_with(&[("FACADE_TEST_GATES", "upgrade-draining")]);
    home.start_named_fake("w1", &[]);
    // Both say hello before the drain: a client of the test's, and a send held once it has.
    let mut wire = connect(&home);
    let mut send = home.command(&test_binaries().facade);
    send.args(["send", "w1", "during the drain"])
        .env("FACADE_TEST_GATES", "command-connected");
    let sending = send
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate("command-connected");
    let program = program_of_build(&home, &newer());
    let asking = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate("upgrade-draining");
    let refused = wire.call("agent.rename", json!({ "agent": "w1", "name": "renamed" }));
    assert_eq!(refused["error"]["data"]["reason"], "upgrading", "{refused}");
    home.release_gate("command-connected");
    // The send's call reaches the daemon before, which refuses it.
    std::thread::sleep(secs(1));
    home.release_gate("upgrade-draining");
    let sent = sending.wait_with_output().unwrap();
    assert!(sent.status.success(), "{}{}", stdout(&sent), stderr(&sent));
    let listed = asking.wait_with_output().unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    let typed = || {
        home.submitted_messages()
            .iter()
            .filter(|submitted| submitted.ends_with("during the drain"))
            .count()
            == 1
    };
    assert!(
        wait_until(secs(10), typed),
        "{:?}",
        home.submitted_messages()
    );
    assert!(
        home.agent_from_list_json("renamed").is_none(),
        "the refused rename did nothing"
    );
}

/// A message whose Enter went as a newer Facade takes over is settled by the daemon before, which
/// reads its agent until the CLI took the message, before the agent goes quiet: the send answers
/// success, and the message is typed once.
#[test]
fn a_message_entered_as_a_newer_facade_takes_over_is_settled_by_the_daemon_before() {
    let home = TestHome::new("enteredthrough");
    home.start_facade_with(&[("FACADE_TEST_GATES", "message-enter")]);
    home.start_named_fake("w1", &[]);
    let mut send = home.command(&test_binaries().facade);
    let sending = send
        .args(["send", "w1", "entered as it takes over"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // The agent is held as its message's Enter goes, and the daemon before hands over meanwhile.
    home.wait_for_gate("message-enter");
    let program = program_of_build(&home, &newer());
    let asking = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    assert!(
        wait_until(secs(10), || home
            .daemon_log()
            .contains(&format!("handing over to build {}", newer()))),
        "{}",
        home.daemon_log()
    );
    std::thread::sleep(std::time::Duration::from_millis(300));
    home.release_gate("message-enter");
    let sent = sending.wait_with_output().unwrap();
    assert!(sent.status.success(), "{}{}", stdout(&sent), stderr(&sent));
    let listed = asking.wait_with_output().unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    let typed = || {
        home.submitted_messages()
            .iter()
            .filter(|submitted| submitted.ends_with("entered as it takes over"))
            .count()
            == 1
    };
    assert!(
        wait_until(secs(10), typed),
        "{:?}",
        home.submitted_messages()
    );
    assert!(
        !home.daemon_log().contains("may still be inside a paste"),
        "{}",
        home.daemon_log()
    );
}

/// A message already waiting for its recipient when the daemon before drains begins no paste in the
/// drain, though the person empties the input meanwhile: the next daemon types it once, and the
/// send answers success.
#[test]
fn a_message_waiting_as_the_daemon_before_drains_is_typed_by_the_next_daemon_alone() {
    let home = TestHome::new("waitingdrain");
    home.start_facade_with(&[("FACADE_TEST_GATES", "upgrade-drained")]);
    home.start_named_fake("w1", &[]);
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade).args(["attach", "w1"]),
        100,
        30,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯")),
        "{}",
        term.text()
    );
    home.run_facade_ok(&["type", "w1", "my draft"]);
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯ my draft")),
        "{}",
        term.text()
    );
    let mut send = home.command(&test_binaries().facade);
    let sending = send
        .args(["send", "w1", "waits through the drain"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let store = || rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    let kept = || {
        store()
            .query_row("SELECT count(*) FROM messages", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0)
            == 1
    };
    assert!(wait_until(secs(10), kept), "the send waits on the draft");
    let program = program_of_build(&home, &newer());
    let asking = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate("upgrade-drained");
    // The person empties the input in the attached terminal, whose keys reach the agent in the
    // drain; the daemon before reads on and begins no paste. Calls would wait for the next daemon,
    // so the test reads the terminal and the CLI's own log.
    term.send(b"\x03");
    assert!(
        term.wait_for(secs(10), |text| !text.contains("my draft")),
        "{}",
        term.text()
    );
    let pasted =
        || term.text().contains("waits through the drain") || !home.submitted_messages().is_empty();
    assert!(
        !wait_until(secs(2), pasted),
        "a paste began in the drain: {}",
        term.text()
    );
    home.release_gate("upgrade-drained");
    let sent = sending.wait_with_output().unwrap();
    assert!(sent.status.success(), "{}{}", stdout(&sent), stderr(&sent));
    let listed = asking.wait_with_output().unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    let typed = || {
        home.submitted_messages()
            .iter()
            .filter(|submitted| submitted.ends_with("waits through the drain"))
            .count()
            == 1
    };
    assert!(
        wait_until(secs(10), typed),
        "{:?}",
        home.submitted_messages()
    );
    assert!(
        !home.daemon_log().contains("may still be inside a paste"),
        "{}",
        home.daemon_log()
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success()),
        "Ctrl-] detaches: {}",
        term.text()
    );
}

/// Starts `name` as Antigravity, played by the test CLI in its look, and has its CLI ask from its
/// screen: a question with a menu in place of its input, as a permission question shows. Returns
/// once the agent waits for the person.
fn start_asking_from_its_screen(home: &TestHome, name: &str) {
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let mut command = home.facade_in_an_empty_home();
    let started = command
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .args(["start", "--name", name, "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    // Its start readies its tools in a panel, which closes before the input shows again.
    let ready = || {
        home.agent_from_list_json(name)
            .is_some_and(|agent| agent["tools_state"] == "available")
            && home.screen(name).contains("? for shortcuts")
    };
    assert!(
        wait_until(secs(15), ready),
        "{:?} {}",
        home.agent_from_list_json(name),
        home.screen(name)
    );
    home.run_facade_ok(&["type", name, "/fake menu Which branch?"]);
    home.run_facade_ok(&["type", name, "--key", "Enter"]);
    let waits = || {
        home.agent_from_list_json(name)
            .is_some_and(|agent| agent["state"] == "waiting_for_you")
    };
    assert!(
        wait_until(secs(10), waits),
        "{:?} {}",
        home.agent_from_list_json(name),
        home.screen(name)
    );
}

/// An agent whose CLI asks from its screen still waits for the person after a newer Facade takes
/// over: the next daemon asks no CLI to redraw after a clean end, so it reads the screen it
/// recovered at once.
#[test]
fn an_agent_asking_from_its_screen_still_waits_for_the_person_after_a_takeover() {
    let home = TestHome::new("askstakeover");
    start_asking_from_its_screen(&home, "ada");
    let program = program_of_build(&home, &newer());
    let listed = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    // Past the screen's read, and with nothing written since: the state is what the recovered
    // screen shows.
    std::thread::sleep(std::time::Duration::from_secs(1));
    let agent = home.agent_from_list_json("ada").unwrap();
    assert_eq!(
        agent["state"],
        "waiting_for_you",
        "{agent} {}",
        home.screen("ada")
    );
}

/// The same after a crash: the next daemon asks the CLI to redraw, and reads the screen it redraws,
/// which still asks.
#[test]
fn an_agent_asking_from_its_screen_still_waits_for_the_person_after_a_crash() {
    let home = TestHome::new("askscrash");
    start_asking_from_its_screen(&home, "ada");
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(20))
        .expect("the keeper starts the daemon again");
    std::thread::sleep(std::time::Duration::from_secs(2));
    let agent = home.agent_from_list_json("ada").unwrap();
    assert_eq!(
        agent["state"],
        "waiting_for_you",
        "{agent} {}",
        home.screen("ada")
    );
}

/// The end is noted clean only once every agent went quiet in time: an agent held past its half
/// second leaves no note, and the new daemon folds each screen log into a new generation, as after
/// a crash.
#[test]
fn an_agent_that_goes_quiet_too_late_leaves_no_clean_end() {
    let home = TestHome::new("quiettoolate");
    home.start_facade_with(&[("FACADE_TEST_GATES", "agent-quiesce")]);
    home.start_fake("w1");
    // A file written in place, until its rename, is none of the screen's yet.
    let screen_files = || {
        let names = std::fs::read_dir(home.path.join("core/screens/a1"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name());
        names
            .filter(|name| !name.to_string_lossy().ends_with(".tmp"))
            .collect::<std::collections::BTreeSet<_>>()
    };
    let files = screen_files();
    let program = program_of_build(&home, &newer());
    let asking = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate("agent-quiesce");
    std::thread::sleep(secs(1));
    home.release_gate("agent-quiesce");
    let listed = asking.wait_with_output().unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    assert_ne!(
        screen_files(),
        files,
        "the new daemon folded w1's screen log"
    );
}

/// Facade's plugin, which the build before wrote in the folder of an Antigravity run, stays as the
/// run has it through a takeover and through a start beside it, as every run keeps the files of the
/// build that started it. It goes with the last run that uses it, and the next start places the new
/// build's.
#[test]
fn an_antigravity_run_keeps_its_plugin_through_a_takeover_and_the_next_start_places_the_new_build_s()
 {
    let home = TestHome::new("takeoverplugin");
    let programs = home.folder().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let program = program_of_build(&home, &newer());
    // Starts Antigravity by `facade`, one build's program, in a home with none of the person's
    // settings.
    let own = home.project.parent().unwrap().join("home");
    std::fs::create_dir_all(&own).unwrap();
    let start = |facade: &Path, name: &str| {
        let mut command = home.command(facade);
        command
            .env("HOME", &own)
            .env("XDG_CONFIG_HOME", own.join(".config"))
            .env("PATH", &path)
            .env("FAKECLI_LOOK", "agy");
        let started = command
            .args(["start", "--name", name, "agy"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{name}: {}", stderr(&started));
    };
    let stop = |name: &str| {
        let stopped = home
            .command(&program)
            .args(["stop", name])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(stopped.status.success(), "{name}: {}", stderr(&stopped));
    };
    let plugin = home.project.join(".agents/plugins/facade");
    let version = || std::fs::read_to_string(plugin.join("plugin.json")).unwrap_or_default();
    start(&test_binaries().facade, "ada");
    assert!(
        version().contains(&format!("Facade core {CURRENT}")),
        "{}",
        version()
    );
    let listed = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    assert!(
        version().contains(&format!("Facade core {CURRENT}")),
        "the run keeps its plugin: {}",
        version()
    );
    start(&program, "bea");
    assert!(
        version().contains(&format!("Facade core {CURRENT}")),
        "a start beside the run leaves it: {}",
        version()
    );
    stop("ada");
    assert!(
        version().contains(&format!("Facade core {CURRENT}")),
        "bea's run uses it still: {}",
        version()
    );
    stop("bea");
    assert!(
        wait_until(secs(15), || !plugin.exists()),
        "the plugin goes with its last run: {}",
        home.daemon_log()
    );
    start(&program, "cy");
    assert!(
        version().contains(&format!("Facade core {}", newer())),
        "the next start places the new build's: {}",
        version()
    );
    stop("cy");
    assert!(
        wait_until(secs(15), || !plugin.exists()),
        "and it goes with its run: {}",
        home.daemon_log()
    );
}

/// Sends waiting on their recipient's draft when a newer Facade takes over are typed once after it:
/// facade-mcp's caller and `facade send` each answer what became of their message, not that it is
/// unknown. The old daemon's drain does not wait for them, as the store keeps their messages.
#[test]
fn sends_waiting_through_a_takeover_are_typed_once_and_answered() {
    let home = TestHome::new("takeoversends");
    home.start_named_fake("worker", &[]);
    home.start_named_fake("boss", &[]);
    home.run_facade_ok(&["type", "worker", "my draft"]);
    assert!(
        wait_until(secs(10), || home.screen("worker").contains("❯ my draft")),
        "{}",
        home.screen("worker")
    );
    let mut boss = McpTestClient::open(&home, "a2");
    let tool = boss.send(
        "tools/call",
        json!({ "name": "send_message", "arguments": { "to": "#a1", "text": "from the tool" } }),
    );
    let command = home
        .command(&test_binaries().facade)
        .args(["send", "worker", "from the command"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let store = || rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    let kept = || {
        store()
            .query_row("SELECT count(*) FROM messages", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0)
            == 2
    };
    assert!(wait_until(secs(10), kept), "both sends wait on the draft");
    let program = program_of_build(&home, &newer());
    let listed = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    // The drain does not wait for the sends: the old daemon ends well within its 3 seconds of
    // handing over.
    let handing = logged_at(
        &home.daemon_log(),
        &format!("handing over to build {}", newer()),
    );
    let ended = millis_between(handing, logged_at(&home.keeper_log(), "ended with code 0"));
    assert!(
        ended < 2500,
        "the old daemon ended {ended} ms after handing over"
    );
    home.run_facade_ok(&["type", "worker", "--key", "Ctrl+C"]);
    let answered = boss
        .answer(tool, secs(30))
        .expect("the tool's call is answered");
    assert_eq!(
        answered["result"]["structuredContent"]["status"], "success",
        "{answered}"
    );
    let sent = command.wait_with_output().unwrap();
    assert!(sent.status.success(), "{}{}", stdout(&sent), stderr(&sent));
    // Messages waiting together go in one paste.
    let typed = |text: &str| {
        home.submitted_messages()
            .iter()
            .map(|submitted| submitted.matches(text).count())
            .sum::<usize>()
    };
    assert!(
        wait_until(secs(10), || typed("from the tool") == 1
            && typed("from the command") == 1),
        "{:?}",
        home.submitted_messages()
    );
}

/// A running Facade whose version is a pre-release of this version, such as this version with
/// `-rc1`, is taken over by no build: a command of this version asks nothing, says nothing, and
/// works with it. The command and the daemon decide by one rule.
#[test]
fn a_pre_release_that_runs_is_taken_over_by_no_build() {
    let home = TestHome::new("prerelease");
    let candidate = program_of_build(&home, &pre_release());
    let detached = home
        .command(&candidate)
        .args(["daemon", "--detach"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(detached.status.success(), "{}", stderr(&detached));
    assert_eq!(home.hello_result().unwrap()["build"], pre_release());
    let listed = home
        .command(&test_binaries().facade)
        .args(["list", "--quiet"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        listed.status.success() && stderr(&listed).is_empty(),
        "{}",
        stderr(&listed)
    );
    assert_eq!(
        home.hello_result().unwrap()["build"],
        pre_release(),
        "nothing taken over"
    );
}

/// The daemon itself refuses a takeover by a build of its own version and by an older one, and says
/// why; the running Facade stays as it was.
#[test]
fn the_daemon_refuses_a_takeover_by_its_own_version_and_an_older_one() {
    let home = TestHome::new("takeoverrefused");
    home.start_fake("w1");
    let (before, daemon) = (keeper(&home), home.daemon_pid().unwrap());
    let launcher = launcher_build(&home.path).expect("the launchers point at a build");
    let mut wire = connect(&home);
    let program = program_of_build(&home, &newer());
    for (build, why) in [
        (
            CURRENT.to_string(),
            format!(
                "{CURRENT} is of this Facade's own version, {CURRENT}: builds of one version do not \
                 take over from each other"
            ),
        ),
        (
            older(),
            format!("{} is not newer than this Facade, {CURRENT}", older()),
        ),
    ] {
        let args = json!({
            "program": program, "build": build, "daemon_protocol": DAEMON_RANGE,
            "keeper_protocol": [1, 1],
        });
        let asked = wire.send("call", json!({ "op": "daemon.upgrade", "args": args }));
        let answer = wire
            .wait_for_response(asked, secs(10))
            .expect("the daemon answers");
        assert_eq!(
            (
                answer["error"]["data"]["reason"].as_str(),
                answer["error"]["message"].as_str()
            ),
            (Some("refused"), Some(why.as_str())),
            "{answer}"
        );
    }
    assert_eq!((keeper(&home), home.daemon_pid()), (before, Some(daemon)));
    assert_eq!(
        launcher_build(&home.path).expect("the launchers point at a build"),
        launcher
    );
}

/// An attached terminal stays attached through a takeover: it says that the newer build takes over
/// and reconnects, with no note of a lost connection. Keys typed before it, while the daemon before
/// drains, once its agents went quiet, and after it reach the agent once each.
#[test]
fn an_attached_terminal_reconnects_through_a_takeover_and_its_keys_arrive_once() {
    let home = TestHome::new("takeoverattach");
    // An Enter that waited to see its input drawn would go only after 10 seconds.
    home.start_facade_with(&[
        ("FACADE_TEST_GATES", "upgrade-draining,upgrade-quiet"),
        ("FACADE_TEST_ENTER_HELD_MS", "10000"),
    ]);
    // By its rule, whose CLI's input Facade reads, so that the person's Enter waits to see its
    // input drawn.
    home.start_named_fake("w1", &[]);
    // An agent that ended does not count as kept running.
    home.start_fake("w2");
    home.run_facade_ok(&["stop", "w2"]);
    let mut term = TestTerminal::spawn(
        home.command(&test_binaries().facade).args(["attach", "w1"]),
        100,
        30,
    );
    assert!(
        term.wait_for(secs(10), |text| text.contains("❯")),
        "{}",
        term.text()
    );
    term.send(b"before\r");
    assert!(
        wait_until(secs(10), || home.submitted_messages() == ["before"]),
        "{:?}",
        home.submitted_messages()
    );
    let program = program_of_build(&home, &newer());
    let asking = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate("upgrade-draining");
    term.send(b"during\r");
    assert!(
        wait_until(secs(10), || home.submitted_messages()
            == ["before", "during"]),
        "{:?}",
        home.submitted_messages()
    );
    home.release_gate("upgrade-draining");
    home.wait_for_gate("upgrade-quiet");
    term.send(b"quiet\r");
    assert!(
        wait_until(secs(5), || home.submitted_messages()
            == ["before", "during", "quiet"]),
        "{:?}",
        home.submitted_messages()
    );
    home.release_gate("upgrade-quiet");
    let listed = asking.wait_with_output().unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!(
                "upgraded running Facade {CURRENT} to {}; 1 agent kept running",
                newer()
            )),
        "{}",
        stderr(&listed)
    );
    assert!(
        term.wait_for_output(secs(10), "Reconnecting to Facade. Recent keys may be lost."),
        "{}",
        term.text()
    );
    term.send(b"after\r");
    let all = ["before", "during", "quiet", "after"];
    assert!(
        wait_until(secs(15), || home.submitted_messages() == all),
        "{:?}",
        home.submitted_messages()
    );
    term.send(b"\x1d");
    assert!(
        term.wait_exit(secs(5))
            .is_some_and(|status| status.success()),
        "Ctrl-] detaches: {}",
        term.text()
    );
}

/// An older build's command and facade-mcp work with the running Facade and take nothing over, as
/// N−1 does with N.
#[test]
fn an_older_build_s_command_and_server_work_with_the_running_facade() {
    let home = TestHome::new("olderbuild");
    home.start_fake("w1");
    let (before, daemon) = (keeper(&home), home.daemon_pid().unwrap());
    let program = program_of_build(&home, &older());
    let listed = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        listed.status.success()
            && Table::parse(&stdout(&listed)).column("NAME") == ["w1"]
            && stderr(&listed).is_empty(),
        "{}{}",
        stdout(&listed),
        stderr(&listed)
    );
    let mcp = test_binaries().mcp.display().to_string();
    let mut server = McpTestClient::open_with(
        &home,
        "a1",
        &[
            ("FACADE_TEST_BUILD", &older()),
            ("FACADE_TEST_PROGRAM", &mcp),
        ],
    );
    let listed = server.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    assert_eq!((keeper(&home), home.daemon_pid()), (before, Some(daemon)));
    assert_eq!(home.hello_result().unwrap()["build"], CURRENT);
}

/// Messages sent without pause through facade-mcp and `facade send` while a newer Facade takes over
/// are all answered and typed once each. One agent holds a draft, and a message to it from each way
/// of sending waits through the takeover. Every CLI and the keeper keep their processes, and a new
/// daemon serves. The longest wait between two deliveries of the messages sent without pause, the
/// takeover's pause, stays under 8 seconds: the old daemon hands over within 4.8 seconds (its
/// drain, 3, its agents going quiet, 0.5 twice, its connections' `closing`, 0.3, and the attached
/// terminals' last keys, 0.5), the keeper starts the new one after 0.5 seconds, and the new daemon
/// gets 2.7 seconds to load its 100 agents and deliver again, where it takes under a second on a
/// fast machine and on Linux with half a CPU. Both builds' programs are copies, as release builds
/// install them.
#[test]
fn messages_sent_through_a_takeover_arrive_once_each_after_a_short_pause() {
    const AGENTS: usize = 100;
    let home = TestHome::new("takeoverload");
    let detached = home
        .command(&test_binaries().facade)
        .args(["daemon", "--detach"])
        .env_remove("FACADE_TEST_LINK_PROGRAMS")
        .output()
        .unwrap();
    assert!(detached.status.success(), "{}", stderr(&detached));
    let agents: Vec<TestAgent> = (0..AGENTS)
        .map(|n| home.start_named_fake(&format!("w{n}"), &[]))
        .collect();
    let (before, daemon) = (keeper(&home), home.daemon_pid().unwrap());
    // The last agent holds a draft, so the messages to it wait, and the messages sent without pause
    // go to the others.
    let held = format!("w{}", AGENTS - 1);
    home.run_facade_ok(&["type", &held, "my draft"]);
    assert!(
        wait_until(secs(10), || home.screen(&held).contains("❯ my draft")),
        "{}",
        home.screen(&held)
    );
    let mut waiting_tool = McpTestClient::open(&home, "a2");
    let waiting_call = waiting_tool.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": { "to": format!("#a{AGENTS}"), "text": "waiting by the tool" },
        }),
    );
    let waiting_command = home
        .command(&test_binaries().facade)
        .args(["send", &held, "waiting by the command"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let store = || rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    let kept = || {
        store()
            .query_row("SELECT count(*) FROM messages", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0)
            == 2
    };
    assert!(
        wait_until(secs(10), kept),
        "both messages to {held} wait on its draft"
    );
    let program = program_of_build(&home, &newer());
    let sending = AtomicBool::new(true);
    let (listed, by_tool, by_command) = std::thread::scope(|scope| {
        let tool = scope.spawn(|| {
            let mut client = McpTestClient::open(&home, "a1");
            let mut sent = Vec::new();
            while sending.load(Ordering::SeqCst) {
                let text = format!("tool {}", sent.len());
                let answer = client.call(
                    "send_message",
                    json!({ "to": format!("#a{}", 2 + sent.len() % (AGENTS - 2)), "text": text }),
                );
                sent.push((text, answer));
            }
            sent
        });
        let command = scope.spawn(|| {
            let mut sent = Vec::new();
            while sending.load(Ordering::SeqCst) {
                let text = format!("command {}", sent.len());
                let output = home.run_facade(&[
                    "send",
                    &format!("w{}", 1 + sent.len() % (AGENTS - 2)),
                    &text,
                ]);
                sent.push((text, output.status.success(), stderr(&output)));
            }
            sent
        });
        std::thread::sleep(secs(2));
        let listed = home
            .command(&program)
            .arg("list")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        std::thread::sleep(secs(2));
        // The senders stop whatever the takeover answered: a failed one is told after them, not
        // waited for forever.
        sending.store(false, Ordering::SeqCst);
        (listed, tool.join().unwrap(), command.join().unwrap())
    });
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    let failed: Vec<_> = by_tool
        .iter()
        .filter(|(_, answer)| answer["status"] != "success")
        .collect();
    assert!(failed.is_empty(), "{failed:?}");
    let failed: Vec<_> = by_command.iter().filter(|(_, ok, _)| !ok).collect();
    assert!(failed.is_empty(), "{failed:?}");
    // The draft goes, and the messages that waited through the takeover are answered and typed.
    home.run_facade_ok(&["type", &held, "--key", "Ctrl+C"]);
    let answered = waiting_tool
        .answer(waiting_call, secs(30))
        .expect("the waiting tool call is answered");
    assert_eq!(
        answered["result"]["structuredContent"]["status"], "success",
        "{answered}"
    );
    let sent = waiting_command.wait_with_output().unwrap();
    assert!(sent.status.success(), "{}{}", stdout(&sent), stderr(&sent));
    let read_log = || -> Vec<facade_scenarios::serde_json::Value> {
        std::fs::read_to_string(&home.fake_log)
            .unwrap()
            .lines()
            .filter_map(|line| facade_scenarios::serde_json::from_str(line).ok())
            .collect()
    };
    let typed = |log: &[facade_scenarios::serde_json::Value], text: &str| {
        log.iter()
            .filter(|entry| {
                entry["text"]
                    .as_str()
                    .is_some_and(|typed| typed.ends_with(&format!("\n{text}")))
            })
            .count()
    };
    // Messages waiting together go in one paste.
    let waited = |text: &str| {
        read_log()
            .iter()
            .filter_map(|entry| {
                entry["text"]
                    .as_str()
                    .map(|typed| typed.matches(text).count())
            })
            .sum::<usize>()
    };
    assert!(
        wait_until(secs(10), || waited("waiting by the tool") == 1
            && waited("waiting by the command") == 1),
        "{:?}",
        home.submitted_messages()
    );
    let log = read_log();
    for text in by_tool
        .iter()
        .map(|(text, _)| text)
        .chain(by_command.iter().map(|(text, _, _)| text))
    {
        assert_eq!(typed(&log, text), 1, "{text} typed once");
    }
    let without_pause = |entry: &&facade_scenarios::serde_json::Value| {
        entry["text"]
            .as_str()
            .and_then(|text| text.rsplit('\n').next())
            .is_some_and(|last| last.starts_with("tool ") || last.starts_with("command "))
    };
    let mut at: Vec<u64> = log
        .iter()
        .filter(without_pause)
        .filter_map(|entry| entry["at"].as_u64())
        .collect();
    at.sort_unstable();
    let gap = at
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .max()
        .unwrap_or(0);
    eprintln!(
        "{} messages through the takeover; the longest wait between two deliveries was {gap} ms",
        at.len()
    );
    assert!(
        gap < 8000,
        "the longest wait between two deliveries was {gap} ms; the daemons' log:\n{}",
        home.daemon_log()
    );
    assert!(
        agents.iter().all(|agent| alive(&agent.process)),
        "every CLI runs on"
    );
    for build in [CURRENT.to_string(), newer()] {
        let program = home
            .path
            .join("core")
            .join("bin")
            .join(build)
            .join(program_name("facade"));
        assert!(
            !std::fs::symlink_metadata(&program)
                .unwrap()
                .file_type()
                .is_symlink(),
            "{} is a copy",
            program.display()
        );
    }
    let hello = home.hello_result().unwrap();
    assert_eq!(
        (hello["keeper"]["pid"].as_u64(), hello["build"].as_str()),
        (Some(before.pid as u64), Some(newer().as_str()))
    );
    assert_ne!(hello["pid"].as_i64(), Some(daemon as i64));
}

/// A start, a stop and a `facade type` under way when a newer Facade takes over finish before the
/// daemon before it ends: its drain waits for them, and each command answers what it did.
#[test]
fn a_start_a_stop_and_a_type_under_way_finish_before_the_takeover_ends() {
    let gates = ["before-start-run", "before-stop-run", "before-type-input"];
    let home = TestHome::new("takeoverunderway");
    home.start_facade_with(&[(
        "FACADE_TEST_GATES",
        &format!("{},upgrade-draining", gates.join(",")),
    )]);
    let reached = |gate: &str| home.path.join(format!("core/reached-{gate}"));
    // The agents the calls name start with the gates open; then they close.
    for gate in gates {
        std::fs::write(reached(gate), "").unwrap();
    }
    home.start_named_fake("stopped", &[]);
    home.start_named_fake("typed", &[]);
    for gate in gates {
        std::fs::remove_file(reached(gate)).unwrap();
    }
    let old = home.daemon_pid().unwrap();
    let path = home.path_with_test_programs();
    let run = |program: &Path, args: &[&str]| {
        home.command(program)
            .args(args)
            .env("PATH", &path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let facade = test_binaries().facade.clone();
    let start = run(&facade, &["start", "--name", "started", "fake"]);
    let stop = run(&facade, &["stop", "stopped"]);
    let typing = run(&facade, &["type", "typed", "typed under way"]);
    for gate in gates {
        home.wait_for_gate(gate);
    }
    let program = program_of_build(&home, &newer());
    let asking = run(&program, &["list"]);
    home.wait_for_gate("upgrade-draining");
    home.release_gate("upgrade-draining");
    std::thread::sleep(secs(1));
    assert!(
        !gone(old) && !zombie(old),
        "the daemon before waits for the calls under way: {}",
        process_state(old)
    );
    for gate in gates {
        home.release_gate(gate);
    }
    for (what, child) in [("start", start), ("stop", stop), ("type", typing)] {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{what}: {}{}",
            stdout(&output),
            stderr(&output)
        );
    }
    let asked = asking.wait_with_output().unwrap();
    assert!(
        asked.status.success()
            && stderr(&asked).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&asked)
    );
    assert_eq!(home.hello_result().unwrap()["build"], newer());
    let state = |name: &str| home.list_state(name).unwrap_or_default();
    assert!(
        !["stopped", "ended"].contains(&state("started").as_str()) && state("stopped") == "stopped",
        "{}",
        stdout(&home.run_facade(&["list"]))
    );
    assert_eq!(
        home.screen("typed").matches("typed under way").count(),
        1,
        "{}",
        home.screen("typed")
    );
}

/// The test CLI under each of the six CLIs' names, through a takeover: each keeps its process and
/// its tools reconnect. Nothing its run was given names a build's folder, so once the new build
/// proves healthy, the hook lines its CLI runs, which name the launcher, run the new build; what
/// they give the model is the run's own, the skill and instructions of the build that started it,
/// as Claude Code's, OpenCode's and Pi's files are. Pi's and OpenCode's runs report their sessions
/// from code of their own, which runs no program of Facade's.
#[test]
fn every_cli_s_run_keeps_its_process_and_tools_through_a_takeover_and_its_hooks_run_the_new_build()
{
    const CLIS: [&str; 6] = ["claude", "codex", "agy", "muse", "opencode", "pi"];
    const SESSION: &str = "96da4482-2bae-4a45-b193-a5664c19826c";
    let home = TestHome::new("takeoversix");
    home.start_facade_with(&[("FACADE_TEST_TRIAL_MS", "2000")]);
    let programs = home.folder().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let bin = home.path.join("core").join("bin");
    let run = |name: &str| home.agent_from_list_json(name).unwrap_or_default();
    let mut runs = Vec::new();
    for cli in CLIS {
        install_program(&programs, cli, &test_binaries().fakecli);
        let mut start = home.facade_in_an_empty_home();
        start.env("PATH", &path);
        // Antigravity starts its plugin's server from its `/mcp` panel, which Facade's start opens;
        // the test CLI runs the others' from the launcher their settings name, as each CLI does.
        match cli {
            "agy" => start.env("FAKECLI_LOOK", "agy"),
            _ => start.env("FAKECLI_MCP", bin.join(program_name("facade-mcp"))),
        };
        let name = format!("{cli}-run");
        let started = start
            .args(["start", "--name", &name, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{cli}: {}", stderr(&started));
        let available = || run(&name)["tools_state"] == "available";
        assert!(
            wait_until(secs(30), available),
            "{cli}'s tools before: {}",
            run(&name)
        );
        let pid = run(&name)["pid"].as_i64().unwrap() as i32;
        runs.push((cli, name, process_identity(pid)));
    }
    let program = program_of_build(&home, &newer());
    let listed = home
        .command(&program)
        .arg("list")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        listed.status.success()
            && stderr(&listed).contains(&format!("upgraded running Facade {CURRENT} to ")),
        "{}",
        stderr(&listed)
    );
    for (cli, name, process) in &runs {
        assert!(
            alive(process) && run(name)["pid"].as_i64() == Some(process.pid as i64),
            "{cli} keeps its process: {}",
            run(name)
        );
        assert!(
            wait_until(secs(30), || run(name)["tools_state"] == "available"),
            "{cli}'s tools after: {}",
            run(name)
        );
    }
    assert_eq!(home.hello_result().unwrap()["build"], newer());
    // What each run was given, its arguments, its environment and its files, names Facade's
    // programs by their launchers only.
    let mut hooks = Vec::new();
    for (cli, name, process) in &runs {
        let id = run(name)["agent_id"].as_str().unwrap().to_string();
        // On Windows a command line, which quotes each argument by the C runtime's rules, read back
        // as its arguments, one a line.
        #[cfg(unix)]
        let line = command_of(process.pid as i32);
        #[cfg(windows)]
        let line = arguments_of(&command_of(process.pid as i32)).join("\n");
        let mut given = vec![line];
        given.extend(
            facade_base::unix_process::environment(process)
                .unwrap()
                .unwrap_or_default()
                .into_iter()
                .map(|(key, value)| format!("{key}={value}")),
        );
        let mut folders = vec![home.path.join("core/runs").join(&id)];
        if *cli == "agy" {
            folders.push(home.project.join(".agents/plugins/facade"));
        }
        let before_files = given.len();
        for folder in folders {
            given.extend(
                files_under(&folder)
                    .into_iter()
                    .filter_map(|file| std::fs::read_to_string(file).ok()),
            );
        }
        let files = given.len() - before_files;
        for text in &given {
            for build in [CURRENT.to_string(), newer()] {
                assert!(
                    !text.contains(&bin.join(&build).display().to_string()),
                    "{cli}'s run names build {build}'s folder: {text}"
                );
            }
        }
        // The environment holds no hook line of the six CLIs'.
        let mut lines: Vec<String> = given[..1]
            .iter()
            .chain(&given[given.len() - files..])
            .flat_map(|text| hook_lines(text, &bin.join(program_name("facade"))))
            .collect();
        lines.sort();
        lines.dedup();
        assert_eq!(
            lines.is_empty(),
            matches!(*cli, "pi" | "opencode"),
            "{cli}'s hook lines: {lines:?}"
        );
        hooks.extend(
            lines
                .into_iter()
                .map(|line| (cli.to_string(), name.clone(), line)),
        );
    }
    let launcher = || launcher_build(&home.path).as_deref() == Some(newer().as_str());
    assert!(
        wait_until(secs(15), launcher),
        "{:?}\n{}",
        launcher_build(&home.path),
        home.keeper_log()
    );
    // The person deletes the build before; the servers that started from it run on, and the hooks
    // run the new build. Windows deletes no program while it runs, so there the build stays.
    #[cfg(unix)]
    std::fs::remove_dir_all(bin.join(CURRENT)).unwrap();
    assert!(!hooks.is_empty(), "no run's hook runs Facade's launcher");
    let ran = home.folder().join(format!("build-{}/ran.log", newer()));
    let hooks_ran = || {
        std::fs::read_to_string(&ran)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("hook "))
            .count()
    };
    for (cli, name, hook) in hooks {
        let before = hooks_ran();
        let id = run(&name)["agent_id"].as_str().unwrap().to_string();
        // The variables its CLI gives it: Antigravity's hooks get the run's agent, and Muse Code's
        // run its own session's.
        // Each CLI runs its hooks with its own shell. On Windows Codex's session uses PowerShell;
        // Antigravity gives its plugin's hooks to cmd.exe as written; Muse Code's hooks and
        // Antigravity's title command go to `%COMSPEC% /C` as one argument, quoted the standard way.
        #[cfg(windows)]
        let mut command = {
            let script = powershell_script(&hook).unwrap_or_default();
            let title = hook.contains(" hook title ") || script.contains("'hook' 'title' ");
            let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
            let powershell = powershell();
            let (program, words, raw): (&std::ffi::OsStr, Vec<&str>, Option<String>) =
                match cli.as_str() {
                    "claude" => (SH.as_str().as_ref(), vec!["-c", &hook], None),
                    "codex" => (
                        powershell.as_os_str(),
                        vec!["-NoProfile", "-Command", &hook],
                        None,
                    ),
                    "agy" if !title => (
                        &comspec,
                        vec!["/d", "/s", "/c"],
                        Some(format!("\"{hook}\"")),
                    ),
                    _ => (&comspec, vec!["/C", &hook], None),
                };
            let mut shell = home.command(program);
            shell.args(words);
            if let Some(raw) = raw {
                std::os::windows::process::CommandExt::raw_arg(&mut shell, raw);
            }
            shell
        };
        #[cfg(unix)]
        let mut command = {
            let mut sh = home.command(SH.as_str());
            sh.args(["-c", &hook]);
            sh
        };
        command
            .env("FACADE_AGENT", &id)
            .env("MUSE_SESSION_ID", SESSION);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let event = format!(r#"{{"hook_event_name":"SessionStart","session_id":"{SESSION}"}}"#);
        std::io::Write::write_all(&mut child.stdin.take().unwrap(), event.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{cli}'s hook `{hook}`: {}",
            stderr(&output)
        );
        assert_eq!(
            hooks_ran(),
            before + 1,
            "{cli}'s hook `{hook}` ran the new build"
        );
        #[cfg(windows)]
        let script = powershell_script(&hook).unwrap_or_default();
        #[cfg(unix)]
        let script = String::new();
        if hook.contains(" hook session-start ") || script.contains("'hook' 'session-start' ") {
            // A CLI draws as its hook runs, and the daemon reads the run's session after the
            // terminal's output: a key typed into the test CLI makes it draw.
            let typed = home.run_facade(&["type", &name, "x"]);
            assert!(typed.status.success(), "{cli}: {}", stderr(&typed));
            assert!(
                wait_until(secs(10), || run(&name)["session"] == SESSION),
                "{cli}'s session: {}",
                run(&name)
            );
        }
        // What it gives the model is the run's own, which the build before wrote as the run
        // started.
        let folder = std::fs::read_dir(home.path.join("core/runs").join(&id))
            .unwrap()
            .flatten()
            .next()
            .unwrap()
            .path();
        let own = |file: &str| std::fs::read_to_string(folder.join(file)).unwrap();
        let given: facade_scenarios::serde_json::Value =
            facade_scenarios::serde_json::from_str(&stdout(&output)).unwrap_or_default();
        let context = given["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .map(str::to_string);
        let (skill, instructions) = ("skills/facade/SKILL.md", "instructions.md");
        if hook.contains(" --skill") || script.contains("'--skill'") {
            assert_eq!(context, Some(own(skill)), "{cli}'s hook `{hook}`");
        } else if hook.contains(" hook instructions muse") {
            assert_eq!(
                context,
                Some(format!("{}\n\n{}", own(instructions), own(skill))),
                "{cli}'s hook `{hook}`"
            );
        } else if hook.contains(" hook instructions agy") {
            assert_eq!(
                given["injectSteps"][0]["ephemeralMessage"].as_str(),
                Some(own(instructions).as_str()),
                "{cli}'s hook `{hook}`"
            );
        }
        if matches!(cli.as_str(), "codex" | "muse") {
            assert!(
                own(skill).ends_with(&format!("Written by Facade core {CURRENT}.\n")),
                "{cli}'s skill is the build before's: {}",
                own(skill)
            );
        }
    }
    for (cli, name, process) in &runs {
        assert!(
            alive(process) && run(name)["tools_state"] == "available",
            "{cli} after the build before was deleted: {}",
            run(name)
        );
    }
}

/// The hook lines in `text` that run Facade's launcher `facade`: each whole command as a CLI's
/// settings hold it, the string it stands in or its line.
#[cfg(windows)]
fn hook_lines(text: &str, facade: &Path) -> Vec<String> {
    // Inside a JSON string, as the CLIs' files hold them: quoted for Git Bash ('…', Claude Code's
    // hooks) or for cmd.exe (\"…\"), each `\` of the path written `\\`. The line comes back as the
    // shell reads it.
    let path = facade.display().to_string().replace('\\', "\\\\");
    let mut lines = Vec::new();
    let encoded = "powershell.exe -NoProfile -NonInteractive -EncodedCommand ";
    for (start, _) in text.match_indices(encoded) {
        let end = start
            + encoded.len()
            + text[start + encoded.len()..]
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
                .count();
        let command = &text[start..end];
        if powershell_script(command)
            .is_some_and(|script| script.contains(&facade.display().to_string()))
        {
            lines.push(command.to_string());
        }
    }
    for marker in [format!("'{path}' hook "), format!("\\\"{path}\\\" hook ")] {
        for (at, _) in text.match_indices(&marker) {
            // A string ends at a quote no `\` escapes, or at the end of its line.
            let unescaped_quote = |i: usize| {
                text.as_bytes()[i] == b'\n'
                    || (text.as_bytes()[i] == b'"' && text.as_bytes()[i - 1] != b'\\')
            };
            let start = (1..at)
                .rev()
                .find(|&i| unescaped_quote(i))
                .map_or(0, |i| i + 1);
            let end = (at + 1..text.len())
                .find(|&i| unescaped_quote(i))
                .unwrap_or(text.len());
            lines.push(text[start..end].replace("\\\"", "\"").replace("\\\\", "\\"));
        }
    }
    lines
}

/// The lines in `text` that run `facade` as a hook, each whole between the quotes or line ends
/// around it.
#[cfg(unix)]
fn hook_lines(text: &str, facade: &Path) -> Vec<String> {
    let marker = format!("'{}' hook ", facade.display());
    let bounds = |c: char| c == '"' || c == '\n';
    text.match_indices(&marker)
        .map(|(at, _)| {
            let start = text[..at].rfind(bounds).map_or(0, |bound| bound + 1);
            let end = text[at..].find(bounds).map_or(text.len(), |end| at + end);
            text[start..end].trim().to_string()
        })
        .collect()
}

/// Every file under `folder`, at any depth; none where it does not exist.
fn files_under(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .flat_map(|entry| {
            if entry.path().is_dir() {
                files_under(&entry.path())
            } else {
                vec![entry.path()]
            }
        })
        .collect()
}

/// The arguments of the Windows command line `line`, split as the C runtime splits them: words
/// between spaces or tabs, quotes around parts of a word, `\"` a quote, and backslashes literal but
/// before a quote, where each pair is one.
#[cfg(windows)]
fn arguments_of(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let (mut quoted, mut in_word, mut backslashes) = (false, false, 0usize);
    for c in line.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                in_word = true;
                continue;
            }
            '"' => {
                word.extend(std::iter::repeat_n('\\', backslashes / 2));
                if backslashes % 2 == 1 {
                    word.push('"');
                } else {
                    quoted = !quoted;
                }
                in_word = true;
            }
            ' ' | '\t' if !quoted => {
                word.extend(std::iter::repeat_n('\\', backslashes));
                if in_word {
                    words.push(std::mem::take(&mut word));
                }
                in_word = false;
            }
            c => {
                word.extend(std::iter::repeat_n('\\', backslashes));
                word.push(c);
                in_word = true;
            }
        }
        backslashes = 0;
    }
    word.extend(std::iter::repeat_n('\\', backslashes));
    if in_word {
        words.push(word);
    }
    words
}
