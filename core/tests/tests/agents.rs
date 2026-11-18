//! Agent startup, IDs, names, stopping, and removal.

use std::collections::HashSet;

use facade_scenarios::serde_json::json;
use facade_scenarios::*;

#[test]
fn remove_ends_a_running_agent_first_and_removes_an_ended_one() {
    let home = TestHome::new("remove");
    let worker = home.start_fake("worker");
    let ended = home.start_fake("ended");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", [1, 1], json!({}));
    // Removing a running agent must stop it before removing its record.
    let removed = wire.call("agent.remove", json!({ "agent": worker.id }));
    assert!(removed["error"].is_null(), "{removed}");
    assert!(!alive(&worker.process), "the removed agent must stop");
    assert!(
        home.agent_from_list_json("worker").is_none(),
        "the removed agent must not be listed"
    );
    // An ended agent can be removed immediately.
    wire.call("agent.stop", json!({ "agent": ended.id }));
    assert!(
        wait_until(secs(10), || home
            .agent_from_list_json("ended")
            .is_some_and(|record| record["process"] == "ended")),
        "the agent did not end"
    );
    assert!(wire.call("agent.remove", json!({ "agent": ended.id }))["error"].is_null());
    assert!(home.agent_from_list_json("ended").is_none());
    assert_eq!(
        error_reason(&wire.call("agent.remove", json!({ "agent": ended.id }))),
        "not_found"
    );
}

/// Removing an agent stops its process group, including a leader and subprocess that ignore SIGHUP.
#[cfg(unix)]
#[test]
fn remove_terminates_the_agent_process_group() {
    let home = TestHome::new("descendants");
    let mut wire = connect(&home);
    let child = start_script(
        &mut wire,
        &home,
        "parent",
        "sh -c 'trap \"\" HUP; echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > child-pid; exec sleep 60' & echo READY; wait",
    );
    let stubborn = start_script(
        &mut wire,
        &home,
        "stubborn",
        "trap '' HUP; echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > leader-pid; echo READY; while :; do sleep 1; done",
    );
    assert!(
        wait_for_screen_text(&home, &child, "READY")
            && wait_for_screen_text(&home, &stubborn, "READY")
    );
    // The background process may write its PID after READY appears.
    let pid_in = |file: &str| -> i32 {
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
    };
    let (child_pid, leader_pid) = (pid_in("child-pid"), pid_in("leader-pid"));
    let leader_pid_process = process_identity(leader_pid);
    let child_pid_process = process_identity(child_pid);
    home.run_facade_ok(&["remove", &child]);
    home.run_facade_ok(&["remove", &stubborn]);
    assert!(
        wait_until(secs(6), || !alive(&child_pid_process)),
        "subprocess {child_pid} is still running after removal"
    );
    assert!(
        !alive(&leader_pid_process),
        "process group leader {leader_pid} is still running after the remove response"
    );
    assert!(home.agents().is_empty());
}

/// Stop must respond with the recorded exit after the agent ends. A stop of an agent that had ended
/// says so, with the same exit.
#[test]
fn stop_returns_process_exit() {
    let home = TestHome::new("stopexit");
    home.start_fake("w1");
    let mut wire = connect(&home);
    let stopped = wire.call("agent.stop", json!({ "agent": "w1" }));
    // A hang-up ends the CLI by SIGHUP on Unix; on Windows the console's closing ends it with
    // 0xC000013A, a code.
    #[cfg(unix)]
    let ended = stopped["result"]["signal"] == "SIGHUP";
    #[cfg(windows)]
    let ended = stopped["result"]["code"] == json!(0xC000013A_u32 as i32);
    assert!(ended && stopped["result"]["at"].is_string(), "{stopped}");
    assert!(
        stopped["result"].get("already_ended").is_none(),
        "{stopped}"
    );
    let again = wire.call("agent.stop", json!({ "agent": "w1" }));
    assert_eq!(
        (&again["result"]["already_ended"], &again["result"]["at"]),
        (&json!(true), &stopped["result"]["at"]),
        "{again}"
    );
}

/// Concurrent starts use distinct default names while unused suggestions remain.
#[test]
fn concurrent_starts_reserve_unused_default_names() {
    let home = TestHome::new("names40");
    let mut wire = connect(&home);
    let args = json!({ "command": [SH.as_str(), "-c", "exit 0"], "cwd": home.project, "cols": 80, "rows": 24 });
    let asked: Vec<u64> = (0..40)
        .map(|_| wire.send("call", json!({ "op": "agent.start", "args": args })))
        .collect();
    let names: Vec<String> = asked
        .iter()
        .map(|id| {
            let response = wire
                .wait_for_response(*id, secs(30))
                .expect("expected a response");
            response["result"]["agent"]["name"]
                .as_str()
                .unwrap_or_else(|| panic!("{response}"))
                .to_string()
        })
        .collect();
    assert_eq!(
        names.iter().collect::<HashSet<_>>().len(),
        names.len(),
        "{names:?}"
    );
}

/// Agent numbering continues after a restart in the same Facade home.
#[test]
fn agent_numbers_continue_after_restart() {
    let home = TestHome::new("renumber");
    assert_eq!(home.start_fake("w1").id, "a1");
    home.kill_home_processes();
    assert_eq!(home.start_fake("w2").id, "a2");
}

#[cfg(unix)]
#[test]
fn stop_sends_sigkill_after_the_kill_delay() {
    let home = TestHome::new("stubborn");
    // The shell and its sleep subprocesses ignore SIGHUP.
    let started = home.run_facade_ok(&[
        "start",
        "--name",
        "stubborn",
        SH.as_str(),
        "-c",
        "trap '' HUP; echo ready; while :; do sleep 1; done",
    ]);
    let TestAgent {
        pid,
        process: pid_process,
        ..
    } = home.started_agent(&started);
    assert!(
        wait_until(secs(30), || home.screen("stubborn").contains("ready")),
        "{}",
        home.screen("stubborn")
    );
    // This agent keeps running after SIGHUP. SIGKILL ends it, then stop returns the exit.
    let asked = std::time::Instant::now();
    home.run_facade_ok(&["stop", "stubborn"]);
    assert!(
        asked.elapsed() >= std::time::Duration::from_millis(2500),
        "the agent ended before the SIGKILL delay"
    );
    assert!(!alive(&pid_process), "its process {pid} still runs");
    assert!(
        wait_until(secs(5), || home
            .agent_from_list_json("stubborn")
            .is_some_and(
                |record| record["process"] == "ended" && record["exit"]["signal"] == "SIGKILL"
            )),
        "{:?}",
        home.agent_from_list_json("stubborn")
    );
}

/// A stop hangs up, closing the CLI's console, and ends the CLI and every process it started once 3
/// seconds pass, whichever of them holds the closing up or never sees it: here the CLI's handler
/// holds the closing up, and its child runs outside any console, which only ending the CLI's job
/// ends.
#[cfg(windows)]
#[test]
fn a_stop_ends_a_cli_that_holds_its_console_s_closing_up_and_its_children_at_3_seconds() {
    let home = TestHome::new("stubborn");
    let child_pid = home.folder().join("child-pid");
    let agent = home.start_named_fake(
        "stubborn",
        &[("FAKECLI_IGNORE_CLOSE", &child_pid.display().to_string())],
    );
    let mut child = None;
    assert!(
        wait_until(secs(30), || {
            child = std::fs::read_to_string(&child_pid)
                .ok()
                .and_then(|pid| pid.trim().parse::<i32>().ok());
            child.is_some()
        }),
        "the CLI reported no child PID: {}",
        home.screen("stubborn")
    );
    let child = child.unwrap();
    let child_process = process_identity(child);
    assert!(alive(&child_process), "the child {child} does not run");
    let asked = std::time::Instant::now();
    home.run_facade_ok(&["stop", "stubborn"]);
    assert!(
        asked.elapsed() >= std::time::Duration::from_millis(2500),
        "the CLI ended before the kill delay"
    );
    assert!(!alive(&agent.process), "the CLI {} still runs", agent.pid);
    assert!(
        wait_until(secs(5), || !alive(&child_process)),
        "its child {child} still runs"
    );
    assert!(
        wait_until(secs(5), || home
            .agent_from_list_json("stubborn")
            .is_some_and(
                |record| record["process"] == "ended" && record["exit"]["code"].is_number()
            )),
        "{:?}",
        home.agent_from_list_json("stubborn")
    );
}

#[test]
fn immediate_exit_is_listed_with_exit_code() {
    let home = TestHome::new("quick");
    // An immediate exit must be recorded even if it arrives before the agent is listed.
    let started = home.run_facade_ok(&["start", "--name", "quick", SH.as_str(), "-c", "exit 3"]);
    assert_eq!(started, "a1\n");
    assert!(
        wait_until(secs(10), || home.agent_from_list_json("quick").is_some_and(
            |record| record["process"] == "ended" && record["exit"]["code"] == 3
        )),
        "{:?}",
        home.agent_from_list_json("quick")
    );
    let record = home.agent_from_list_json("quick").expect("listed");
    assert!(
        record["exit"]["at"]
            .as_str()
            .is_some_and(|at| at.ends_with('Z'))
            && record["exit"].get("signal").is_none(),
        "{record}"
    );
    assert_eq!(home.list_state("quick").as_deref(), Some("exited: code 3"));
}

#[test]
fn blank_names_get_defaults_and_supplied_names_are_trimmed() {
    let home = TestHome::new("names");
    home.run_facade_ok(&["start", SH.as_str(), "-c", "sleep 60"]);
    home.run_facade_ok(&["start", "--name", "", SH.as_str(), "-c", "sleep 60"]);
    home.run_facade_ok(&["start", "--name", "   ", SH.as_str(), "-c", "sleep 60"]);
    home.run_facade_ok(&["start", "--name", "  Bob  ", SH.as_str(), "-c", "sleep 60"]);
    let agents = home.agents();
    let names: Vec<&str> = agents
        .iter()
        .filter_map(|agent| agent["name"].as_str())
        .collect();
    assert_eq!(names.len(), 4, "{agents:?}");
    assert!(
        names[..3]
            .iter()
            .all(|name| !name.trim().is_empty() && name.trim() == *name),
        "{names:?}"
    );
    assert_eq!(names[3], "Bob");
    let record = &agents[0];
    assert!(
        record["created_at"]
            .as_str()
            .is_some_and(|at| at.len() == 24 && at.ends_with('Z')),
        "{record}"
    );
    assert!(
        record.get("exit").is_none(),
        "a running agent must have no exit: {record}"
    );
}

/// Agent records name each CLI and working folder, so the store is readable only by the user.
#[cfg(unix)]
#[test]
fn the_agent_store_is_private_to_the_user() {
    use std::os::unix::fs::MetadataExt;
    let home = TestHome::new("privatestore");
    home.start_fake("w1");
    let core = home.path.join("core");
    assert_eq!(std::fs::metadata(&core).unwrap().mode() & 0o777, 0o700);
    for file in ["facade.db", "facade.db-wal", "facade.db-shm"] {
        assert_eq!(
            std::fs::metadata(core.join(file)).unwrap().mode() & 0o777,
            0o600,
            "{file}"
        );
    }
}

#[cfg(unix)]
#[test]
fn an_ended_cli_s_hangup_ignoring_descendant_runs_on_through_its_release_and_removal() {
    let home = TestHome::new("endedgroup");
    home.start_facade_with(&[]);
    let mut wire = connect(&home);
    let id = start_script(
        &mut wire,
        &home,
        "parent",
        "sh -c 'trap \"\" HUP; echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > descendant; exec sleep 600' & echo $(cat /proc/$$/winpid 2>/dev/null || echo $$) > leader; echo \
         READY; read line; exit 0",
    );
    assert!(wait_for_screen_text(&home, &id, "READY"));
    assert!(wait_until(secs(5), || std::fs::read_to_string(
        home.project.join("descendant")
    )
    .is_ok_and(|s| s.ends_with('\n'))));
    let pid: i32 = std::fs::read_to_string(home.project.join("descendant"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let descendant = process_identity(pid);
    let leader: u32 = std::fs::read_to_string(home.project.join("leader"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    type_raw(&mut wire, &id, "end\r");
    assert!(wait_until(secs(5), || home.agents()[0]["process"] == "ended"));
    assert!(
        wait_until(secs(5), || facade_base::unix_process::snapshot(leader)
            .unwrap()
            .is_none()),
        "the keeper reaps the ended leader"
    );
    assert!(
        alive(&descendant),
        "the descendant ignores the hangup, and an ordinary end sends no group signal"
    );
    home.run_facade_ok(&["remove", &id]);
    drop(wire);
    home.wait_for_idle_exit();
    assert!(
        alive(&descendant),
        "removing the ended record sends no group signal"
    );
    for log in [home.keeper_log(), home.daemon_log()] {
        assert!(
            !log.contains("sent SIGHUP") && !log.contains("sent SIGKILL"),
            "{log}"
        );
    }
    // This fixture owns the descendant and its FACADE_HOME; Facade deliberately left it alone.
    kill_process(pid);
    assert!(wait_until(secs(5), || !alive(&descendant)));
}
