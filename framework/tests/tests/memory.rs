//! Memory: an ended agent's screen leaves the daemon's memory and comes back from its files when
//! something reads, shows or resumes it; a restarted daemon reads it only then. Idle and ended agents
//! take little of it, as Windows counts it. The measurement at the end, run on purpose, reads the
//! daemon's memory with 1, 10 and 100 idle agents, a flood, and a restart.

use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

const SESSION: &str = "86da4482-2bae-4a45-b193-a5664c19826a";

/// The mark a daemon leaves at `point`.
fn mark(home: &TestHome, point: &str) -> std::path::PathBuf {
    home.path.join(format!("framework/reached-{point}"))
}

/// Waits for the mark at `point`.
fn reaches(home: &TestHome, point: &str) -> bool {
    wait_until(secs(30), || mark(home, point).exists())
}

/// Forgets the mark at `point`, so that the next one can be seen.
fn forget(home: &TestHome, point: &str) {
    let _ = std::fs::remove_file(mark(home, point));
}

fn agent(home: &TestHome, id: &str) -> Option<Value> {
    home.agents()
        .into_iter()
        .find(|agent| agent["reference"]["agent_id"] == id)
}

/// Starts Facade with the marks of debug builds on, which the keeper and every later daemon
/// inherit.
fn start_marking(home: &TestHome) {
    home.start_facade_with(&[("FACADE_TEST_GATES", "none")]);
}

/// A script that prints `rows` numbered rows, then `last`, and exits with `code`: more rows than
/// alacritty keeps, so that the compact scrollback holds some of them.
fn printer(rows: usize, last: &str, code: i32) -> String {
    format!(
        "i=0; while [ $i -lt {rows} ]; do echo \"row $i\"; i=$((i+1)); done; echo {last}; \
         exit {code}"
    )
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test marks of debug builds")]
fn an_ended_agent_s_screen_leaves_memory_and_comes_back_when_read_or_shown() {
    let home = TestHome::new("letgo");
    start_marking(&home);
    let mut wire = connect(&home);
    let script = format!(
        "while [ ! -e go ]; do sleep 0.05; done; {}",
        printer(400, "FINAL", 3)
    );
    let id = start_script(&mut wire, &home, "printer", &script);
    // Attach follows an active terminal, delivering its last output before the exit.
    let watching = wire.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": id } }),
    );
    let watch = watching["result"]["watch"]
        .as_u64()
        .expect("an Attach watch");
    assert_eq!(watching["result"]["snapshot"]["process"], "running");
    std::fs::write(home.project.join("go"), "").unwrap();
    let exit = |event: &Value| event["change"]["kind"] == "exit";
    assert!(wait_until(secs(30), || wire
        .changes(watch)
        .iter()
        .any(exit)));
    let changes = wire.changes(watch);
    let last = changes.iter().position(exit).unwrap();
    assert_eq!(changes[last]["change"]["exit"]["code"], 3);
    let output: Vec<_> = changes[..last]
        .iter()
        .filter_map(|event| event["change"]["data"].as_str())
        .flat_map(|data| facade_base::base64::decode(data).unwrap())
        .collect();
    assert!(String::from_utf8_lossy(&output).contains("FINAL"));
    assert!(
        reaches(&home, &format!("screen-dropped-{id}")),
        "the ended agent's screen did not leave memory: {}",
        home.daemon_log()
    );
    assert!(
        !mark(&home, &format!("screen-loaded-{id}")).exists(),
        "nothing read it back yet"
    );

    // A read brings it back from its files, whole, and lets it go again.
    forget(&home, &format!("screen-dropped-{id}"));
    let read = home.run_facade_ok(&["screen", &id, "--lines", "2000"]);
    let lines: Vec<&str> = read.lines().collect();
    assert_eq!(
        (lines.first().copied(), lines.last().copied(), lines.len()),
        (Some("row 0"), Some("FINAL"), 401),
        "{read}"
    );
    assert!(mark(&home, &format!("screen-loaded-{id}")).exists());
    assert!(
        reaches(&home, &format!("screen-dropped-{id}")),
        "the screen stayed after the read"
    );

    let ended = wire.request(
        "watch",
        json!({ "topic": "attach", "args": { "target": id } }),
    );
    assert_eq!(error_reason(&ended), "ended", "{ended}");
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test marks of debug builds")]
fn a_resumed_agent_starts_empty_and_saves_its_new_screen() {
    let home = TestHome::new("letgoresume");
    start_marking(&home);
    let agent = home.start_named_fake("worker", &[("FAKECLI_SESSION", SESSION)]);
    // The resume below needs the session the CLI reports, which its record shows a moment after the
    // start.
    assert!(wait_until(secs(30), || home
        .agent_from_watch("worker")
        .is_some_and(|agent| agent["session"] == SESSION)));
    type_raw(&mut connect(&home), &agent.id, "said before\r");
    assert!(wait_for_screen_text(&home, &agent.id, "said before"));
    home.run_facade_ok(&["stop", &agent.id]);
    assert!(reaches(&home, &format!("screen-dropped-{}", agent.id)));
    let resumed = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(["resume", "-d", &agent.id])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        resumed.status.success(),
        "{}{}",
        stdout(&resumed),
        stderr(&resumed)
    );
    let whole = |home: &TestHome| home.run_facade_ok(&["screen", &agent.id, "--lines", "2000"]);
    assert!(wait_for_screen_text(
        &home,
        &agent.id,
        &format!("session {SESSION}")
    ));
    let screen = whole(&home);
    assert!(
        !screen.contains("said before"),
        "the new session screen starts clear: {screen}"
    );
    // The resumed run writes on: what it writes reaches the screen and its log. Once the run ends,
    // the screen is let go again, and a read takes it from the files alone: a restart would find
    // there what the keeper no longer holds.
    type_raw(&mut connect(&home), &agent.id, "said after\r");
    assert!(wait_for_screen_text(&home, &agent.id, "said after"));
    forget(&home, &format!("screen-dropped-{}", agent.id));
    home.run_facade_ok(&["stop", &agent.id]);
    assert!(reaches(&home, &format!("screen-dropped-{}", agent.id)));
    let screen = whole(&home);
    assert!(
        screen.contains("said after"),
        "the resumed run's output is saved: {screen}"
    );
    assert!(
        !screen.contains("said before"),
        "reading from the files keeps the prior run's output cleared: {screen}"
    );
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test marks of debug builds")]
fn a_restarted_daemon_reads_an_ended_agent_s_screen_only_when_asked() {
    let home = TestHome::new("letgorestart");
    start_marking(&home);
    let mut wire = connect(&home);
    // A running agent keeps the keeper, which starts the next daemon.
    let running = start_script(&mut wire, &home, "running", "sleep 600");
    let id = start_script(
        &mut wire,
        &home,
        "resized",
        "echo READY; while [ ! -e go ]; do sleep 0.1; done; echo DONE; exit 7",
    );
    assert!(wait_for_screen_text(&home, &id, "READY"));
    let watching = wire.request(
        "watch",
        json!({
            "topic": "attach", "args": { "target": id, "size": { "cols": 80, "rows": 24 } }
        }),
    );
    let watch = watching["result"]["watch"]
        .as_u64()
        .expect("an Attach watch");
    let resized = wire.call(
        "attach.resize",
        json!({ "watch": watch, "size": { "cols": 100, "rows": 30 } }),
    );
    assert!(resized["result"].is_object(), "{resized}");
    std::fs::write(home.project.join("go"), "").unwrap();
    assert!(reaches(&home, &format!("screen-dropped-{id}")));
    let before = home.agents();
    forget(&home, &format!("screen-loaded-{id}"));
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    assert_eq!(
        home.agents(),
        before,
        "the ended agent comes back as it was, its size read from its files"
    );
    assert!(
        mark(&home, &format!("screen-replayed-{running}")).exists(),
        "recovery replayed the running agent's screen"
    );
    assert!(
        !mark(&home, &format!("screen-replayed-{id}")).exists(),
        "and not the ended agent's"
    );
    assert!(
        !mark(&home, &format!("screen-loaded-{id}")).exists(),
        "recovery did not read the ended agent's screen"
    );
    assert!(home.screen(&id).contains("DONE"));
    assert!(
        mark(&home, &format!("screen-loaded-{id}")).exists(),
        "the read did"
    );
    assert_eq!(
        agent(&home, &id)
            .map(|agent| (agent["size"]["cols"].clone(), agent["size"]["rows"].clone())),
        Some((json!(100), json!(30)))
    );
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test marks of debug builds")]
fn an_ended_agent_whose_screen_files_cannot_be_read_is_unavailable() {
    let home = TestHome::new("letgounreadable");
    start_marking(&home);
    let id = start_script(&mut connect(&home), &home, "gone", &printer(5, "BYE", 0));
    assert!(reaches(&home, &format!("screen-dropped-{id}")));
    // `current` names the published checkpoint; one that names none makes the files unreadable, as
    // recovery reads them.
    let current = home
        .path
        .join("framework/screens")
        .join(&id)
        .join("current");
    let published = std::fs::read(&current).unwrap();
    std::fs::write(&current, "not a number").unwrap();
    let read = home.run_facade(&["screen", &id]);
    assert!(
        !read.status.success() && stderr(&read).contains("unavailable"),
        "{}{}",
        stdout(&read),
        stderr(&read)
    );
    std::fs::write(&current, published).unwrap();
    assert!(
        home.screen(&id).contains("BYE"),
        "readable again, it comes back"
    );
}

/// Private memory counts what is allocated and never touched, which resident memory does not. A first
/// round of as many agents leaves what the daemon keeps once.
#[cfg(windows)]
#[test]
fn idle_and_ended_agents_take_little_private_memory() {
    const MANY: usize = 24;
    const MOST_IDLE: usize = 1536 * 1024;
    const MOST_ENDED: usize = 512 * 1024;
    let home = TestHome::new("privatememory");
    let _client = connect(&home);
    let memory = || private_memory(home.daemon_pid().expect("a running daemon"));
    let stop = |agents: Vec<String>| {
        for agent in agents {
            home.run_facade_ok(&["stop", &agent]);
        }
    };
    stop(home.start_plain(MANY));
    let before = memory();
    let agents = home.start_plain(MANY);
    let idle = memory();
    assert!(
        idle < before + MANY * MOST_IDLE,
        "{MANY} idle agents take {} KiB",
        idle.saturating_sub(before) / 1024
    );
    stop(agents);
    let mut ended = memory();
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            ended = memory();
            ended < before + MANY * MOST_ENDED
        }),
        "{MANY} ended agents take {} KiB",
        ended.saturating_sub(before) / 1024
    );
}

/// The daemon's memory in KiB: its physical footprint on macOS, which counts compressed pages, and
/// its resident memory on Linux.
fn daemon_memory(home: &TestHome) -> u64 {
    let pid = home
        .hello_result()
        .and_then(|hello| hello["pid"].as_i64())
        .expect("a running daemon") as i32;
    #[cfg(target_os = "macos")]
    {
        let mut usage: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
        // SAFETY: the buffer is a rusage_info_v4, the flavour asked for.
        let read =
            unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, (&raw mut usage).cast()) };
        assert_eq!(read, 0, "could not read the daemon's memory");
        usage.ri_phys_footprint / 1024
    }
    #[cfg(not(target_os = "macos"))]
    {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:"))
            .and_then(|kib| kib.trim().trim_end_matches(" kB").trim().parse().ok())
            .unwrap()
    }
}

/// Not a stress test and not for CI: it measures fixed situations and holds them to the bounds.
/// Each reading follows the event that ends its situation: every agent idle, the flood's last line
/// shown and its checkpoint published, the stopped agent's screen let go, every agent idle again
/// after the restart. Run it with
/// `cargo test -p facade-scenarios --test memory -- --ignored --nocapture`.
#[test]
#[ignore = "starts 100 terminals: run on purpose"]
fn the_daemon_s_memory_with_idle_agents_a_flood_and_a_restart() {
    let home = TestHome::new("memory");
    start_marking(&home);
    let mut table: Vec<(String, u64)> = Vec::new();
    let mut started = 0;
    for count in [1, 10, 100] {
        while started < count {
            home.start_fake_with(&format!("idle{started}"), &[("FAKECLI_STATUS", "1")]);
            started += 1;
        }
        let idle = || {
            home.agents()
                .iter()
                .filter(|agent| agent["state"] == "idle")
                .count()
        };
        assert!(
            wait_until(secs(120), || idle() == count),
            "{} of {count} idle",
            idle()
        );
        table.push((format!("{count} idle"), daemon_memory(&home)));
    }
    let idle = table.last().unwrap().1;
    // 100,000 lines of 60 characters: 6 MB, past the 4 MiB after which a checkpoint is taken.
    let line = "flood line $i: the quick brown fox jumps over the lazy dog";
    let script = format!(
        "i=0; while [ $i -lt 100000 ]; do echo \"{line}\"; i=$((i+1)); done; echo FLOOD-DONE; \
         exec sleep 600"
    );
    let flood = start_script(&mut connect(&home), &home, "flood", &script);
    assert!(
        wait_until(secs(300), || home.screen(&flood).contains("FLOOD-DONE")),
        "{}",
        home.screen(&flood)
    );
    assert!(reaches(&home, &format!("checkpoint-published-{flood}")));
    table.push((
        "100 idle and one that printed 100,000 lines".into(),
        daemon_memory(&home),
    ));
    let flooded = table.last().unwrap().1;
    home.run_facade_ok(&["stop", &flood]);
    assert!(reaches(&home, &format!("screen-dropped-{flood}")));
    table.push((
        "the flooding agent stopped, its record kept".into(),
        daemon_memory(&home),
    ));
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(60))
        .expect("a replacement daemon");
    assert!(wait_until(secs(120), || home
        .agents()
        .iter()
        .filter(|agent| agent["state"] == "idle")
        .count()
        == 100));
    table.push((
        "after the daemon was killed and recovered".into(),
        daemon_memory(&home),
    ));
    for (situation, kib) in &table {
        println!("{situation:<48} {:>8.1} MiB", *kib as f64 / 1024.0);
    }
    assert!(idle < 300 * 1000, "100 idle agents take {idle} KiB");
    assert!(
        flooded.saturating_sub(idle) < 8 * 1024,
        "the flood added {} KiB",
        flooded.saturating_sub(idle)
    );
    assert!(
        table.last().unwrap().1 < 300 * 1000,
        "after the restart: {} KiB",
        table.last().unwrap().1
    );
}
