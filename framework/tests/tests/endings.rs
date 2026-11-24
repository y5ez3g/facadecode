//! What ends leaves nothing open in the daemon: not the handles of an ended run's terminal, and not
//! the connections that acted for it, however the run ends and whichever daemon and keeper held it.
//!
//! Each scenario ends many and counts the daemon's handles, which come back to what they were but for
//! the few its threads hold for a while: what one would leave shows as many times.

use std::process::Stdio;

use facade_scenarios::serde_json::json;
use facade_scenarios::*;

/// How many agents or Guests a scenario ends.
const MANY: usize = 12;
/// How many relays a run has. Each leaves less than an agent would.
const RELAYS: usize = 24;
/// How many handles may come and go with the daemon's threads.
const PASSING: usize = 10;

const SESSION: &str = "86da4482-2bae-4a45-b193-a5664c19826a";

fn stop(home: &TestHome, agents: &[String]) {
    for agent in agents {
        home.run_facade_ok(&["stop", agent]);
    }
}

/// Has each CLI end by itself, as Ctrl+D ends it, and waits until each agent ended.
fn exit(home: &TestHome, agents: &[String]) {
    let mut wire = connect(home);
    for agent in agents {
        type_raw(&mut wire, agent, "\x04");
    }
    let ended = |agent: &String| {
        home.agent_record(agent)
            .is_some_and(|record| record["process"] == "ended")
    };
    assert!(
        wait_until(LOADED_TIMEOUT, || agents.iter().all(ended)),
        "each CLI ends: {}",
        home.daemon_log()
    );
}

/// Resumes `agent` in the background.
fn resume(home: &TestHome, agent: &str) {
    let resumed = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(["resume", "-d", agent])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        resumed.status.success(),
        "{}{}",
        stdout(&resumed),
        stderr(&resumed)
    );
}

/// Starts a fake CLI whose session Facade knows, so that it can be resumed.
fn start_with_session(home: &TestHome, name: &str, session: &str) -> String {
    let agent = home.start_named_fake(name, &[("FAKECLI_SESSION", session)]);
    assert!(
        wait_until(LOADED_TIMEOUT, || home
            .agent_record(&agent.id)
            .is_some_and(|record| record["session"] == session)),
        "{name}'s session is recorded"
    );
    agent.id
}

/// Ends the keeper and waits until another holds the CLIs of `agents`.
fn replace_keeper(home: &TestHome, agents: &[String]) {
    let (keeper, _) = home.lock_record("keeper").expect("a running keeper");
    kill_process(keeper);
    let held = |agent: &String| {
        home.keeper_log()
            .contains(&format!("holding {agent}'s CLI"))
    };
    assert!(
        wait_until(LOADED_TIMEOUT, || agents.iter().all(held)),
        "another keeper holds the CLIs: {}",
        home.keeper_log()
    );
}

/// Ends the daemon and waits until another serves.
fn replace_daemon(home: &TestHome) {
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("a replacement daemon");
}

/// The daemon's handles once one agent's whole life is over: what it opens once is open.
fn before_agents(home: &TestHome) -> usize {
    connect(home);
    stop(home, &home.start_plain(1));
    home.daemon_handles()
}

#[test]
fn stopped_agents_leave_no_handle_of_their_terminals() {
    let home = TestHome::new("endstop");
    let before = before_agents(&home);
    stop(&home, &home.start_plain(MANY));
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn agents_that_exit_leave_no_handle_of_their_terminals() {
    let home = TestHome::new("endexit");
    let before = before_agents(&home);
    exit(&home, &home.start_plain(MANY));
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn resumed_agents_leave_no_handle_of_their_terminals() {
    let home = TestHome::new("endresume");
    let before = before_agents(&home);
    for n in 0..MANY / 2 {
        let session = format!("{}{n:02x}", &SESSION[..SESSION.len() - 2]);
        let agent = [start_with_session(&home, &format!("resumed{n}"), &session)];
        stop(&home, &agent);
        resume(&home, &agent[0]);
        stop(&home, &agent);
    }
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn agents_another_keeper_took_over_leave_no_handle_of_their_terminals() {
    let home = TestHome::new("endkeeper");
    let before = before_agents(&home);
    let agents = home.start_plain(MANY);
    replace_keeper(&home, &agents);
    stop(&home, &agents);
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn agents_another_daemon_took_over_leave_no_handle_of_their_terminals() {
    let home = TestHome::new("enddaemon");
    let agents = home.start_plain(MANY);
    replace_daemon(&home);
    let running = home.daemon_handles();
    stop(&home, &agents);
    home.expect_daemon_handles(running - MANY * TERMINAL_HANDLES + PASSING);
}

/// Connections that act for `agent`'s run, as its CLI's MCP servers do. The test closes them, so that
/// the run ends first.
fn relays(home: &TestHome, agent: &str) -> Vec<McpTestClient> {
    (0..RELAYS)
        .map(|_| McpTestClient::relay_configured(home, agent))
        .collect()
}

/// The daemon's handles once a run with a relay is over.
fn before_relays(home: &TestHome) -> usize {
    let agent = [home.start_fake("before").id];
    let relay = McpTestClient::relay_configured(home, &agent[0]);
    stop(home, &agent);
    drop(relay);
    home.daemon_handles()
}

#[test]
fn relays_of_a_stopped_run_leave_no_handle() {
    let home = TestHome::new("relaystop");
    let before = before_relays(&home);
    let agent = [home.start_fake("stopped").id];
    let relays = relays(&home, &agent[0]);
    stop(&home, &agent);
    drop(relays);
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn relays_of_a_run_that_exits_leave_no_handle() {
    let home = TestHome::new("relayexit");
    let before = before_relays(&home);
    let agent = [home.start_fake("exits").id];
    let relays = relays(&home, &agent[0]);
    exit(&home, &agent);
    drop(relays);
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn relays_of_a_resumed_agent_s_runs_leave_no_handle() {
    let home = TestHome::new("relayresume");
    let before = before_relays(&home);
    let agent = [start_with_session(&home, "resumed", SESSION)];
    let first = relays(&home, &agent[0]);
    stop(&home, &agent);
    resume(&home, &agent[0]);
    let second = relays(&home, &agent[0]);
    stop(&home, &agent);
    drop((first, second));
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn relays_of_a_run_another_keeper_took_over_leave_no_handle() {
    let home = TestHome::new("relaykeeper");
    let before = before_relays(&home);
    let agent = [home.start_fake("kept").id];
    let relays = relays(&home, &agent[0]);
    replace_keeper(&home, &agent);
    stop(&home, &agent);
    drop(relays);
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn relays_of_a_run_another_daemon_took_over_leave_no_handle() {
    let home = TestHome::new("relaydaemon");
    let agent = [home.start_fake("kept").id];
    replace_daemon(&home);
    let before = home.daemon_handles();
    let relays = relays(&home, &agent[0]);
    stop(&home, &agent);
    drop(relays);
    home.expect_daemon_handles(before + PASSING);
}

#[test]
fn guests_that_leave_leave_no_handle() {
    let home = TestHome::new("guestends");
    // A connection keeps the daemon from ending while no Guest is there.
    let _client = connect(&home);
    let guest = || {
        let mut guest = McpTestClient::open_guest(&home, "codex", &[]);
        let listed = guest.call("list_agents", json!({}));
        assert_eq!(listed["status"], "success", "{listed}");
        guest
    };
    drop(guest());
    let before = home.daemon_handles();
    let guests: Vec<_> = (0..MANY).map(|_| guest()).collect();
    drop(guests);
    home.expect_daemon_handles(before + PASSING);
}
