//! Agent and screen snapshots, ordered changes, and viewers that fall behind.

use std::collections::HashSet;
use std::time::Instant;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

#[test]
fn agents_watch_delivers_snapshot_and_changes_until_unwatch() {
    let home = TestHome::new("watchagents");
    home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    let watching = wire.request("watch", json!({ "topic": "agents" }));
    let watch = watching["result"]["watch"]
        .as_u64()
        .expect("expected a watch ID");
    let snapshot = watching["result"]["snapshot"]["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        snapshot.iter().any(|agent| agent["name"] == "w1"),
        "{watching}"
    );
    let second = home.start_fake("w2");
    assert!(
        wait_until(secs(5), || wire
            .changes(watch)
            .iter()
            .any(
                |c| c["change"]["kind"] == "updated" && c["change"]["agent"]["name"] == "w2"
            )),
        "{:?}",
        wire.changes(watch)
    );
    home.run_facade_ok(&["stop", "w2"]);
    assert!(
        wait_until(secs(10), || wire
            .changes(watch)
            .iter()
            .any(|c| c["change"]["agent"]["agent_id"] == second.id.as_str()
                && c["change"]["agent"]["process"] == "ended")),
        "{:?}",
        wire.changes(watch)
    );
    // No changes should follow unwatch.
    assert!(wire.request("unwatch", json!({ "watch": watch }))["result"].is_object());
    let count = wire.changes(watch).len();
    home.start_fake("w3");
    std::thread::sleep(secs(1));
    assert_eq!(wire.changes(watch).len(), count);
    assert_eq!(
        error_reason(&wire.request("unwatch", json!({ "watch": watch }))),
        "not_found"
    );
}

#[test]
fn agents_watch_observes_immediate_start_then_remove() {
    let home = TestHome::new("quickwatch");
    home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    let watch = wire.request("watch", json!({ "topic": "agents" }))["result"]["watch"]
        .as_u64()
        .expect("expected a watch ID");
    // Publish both a start and immediate removal; polling could miss the agent entirely.
    let cwd = home.project.to_string_lossy().into_owned();
    let started = wire.call(
        "agent.start",
        json!({
            "cli": home.shell_cli(), "args": ["-c", "sleep 60"], "name": "brief", "folder": cwd,
            "cols": 80, "rows": 24,
        }),
    );
    let id = started["result"]["agent"]["agent_id"]
        .as_str()
        .expect("expected an agent ID")
        .to_string();
    assert!(wire.call("agent.remove", json!({ "agent": id }))["error"].is_null());
    assert!(
        wait_until(secs(5), || {
            let changes = wire.changes(watch);
            let came = changes.iter().position(|c| {
                c["change"]["kind"] == "updated" && c["change"]["agent"]["agent_id"] == id.as_str()
            });
            let went = changes.iter().position(|c| {
                c["change"]["kind"] == "removed" && c["change"]["agent_id"] == id.as_str()
            });
            matches!((came, went), (Some(came), Some(went)) if came < went)
        }),
        "{:?}",
        wire.changes(watch)
    );
}

#[test]
fn screen_watch_delivers_snapshot_then_output() {
    let home = TestHome::new("watchscreen");
    let worker = home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    let watching = wire.request(
        "watch",
        json!({ "topic": "screen", "args": { "agent": "w1" } }),
    );
    let watch = watching["result"]["watch"]
        .as_u64()
        .expect("expected a watch ID");
    assert!(
        watching["result"]["snapshot"]["redraw"].is_string(),
        "{watching}"
    );
    assert!(
        watching["result"]["snapshot"]["cols"].is_number(),
        "{watching}"
    );
    assert_eq!(
        watching["result"]["snapshot"]["agent_id"],
        worker.id.as_str(),
        "{watching}"
    );
    let data = facade_base::base64::encode(b"seen by a viewer");
    wire.write(&json!({
        "jsonrpc": "2.0", "method": "call",
        "params": { "op": "agent.type", "args": { "agent": worker.id, "raw": data } },
    }));
    assert!(
        wait_until(secs(5), || wire
            .changes(watch)
            .iter()
            .any(
                |c| c["change"]["kind"] == "output" && c["change"]["data"].is_string()
            )),
        "{:?}",
        wire.changes(watch)
    );
    assert_eq!(
        error_reason(&wire.request(
            "watch",
            json!({ "topic": "screen", "args": { "agent": "nobody" } })
        )),
        "not_found"
    );
}

/// A screen read gives the screen's text with its styles marked: the fake CLI's dim words between
/// `{{` and `}}`.
#[test]
fn a_screen_read_marks_the_screen_s_styles() {
    let home = TestHome::new("read");
    let worker = home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    let read = wire.call("agent.screen", json!({ "agent": worker.id, "lines": 40 }));
    let screen = &read["result"];
    assert!(
        screen["text"]
            .as_str()
            .is_some_and(|text| text.contains("fakecli {{(Facade test CLI)}}")),
        "{read}"
    );
    assert_eq!(
        (&screen["agent_id"], &screen["process"], &screen["buffer"]),
        (&json!("a1"), &json!("running"), &json!("normal")),
        "{read}"
    );
    assert_eq!(
        screen["line_count"].as_u64(),
        screen["text"]
            .as_str()
            .map(|text| text.lines().count() as u64),
        "{read}"
    );
    assert_eq!(
        error_reason(&wire.call("agent.screen", json!({ "agent": "nobody" }))),
        "not_found"
    );
}

/// A viewer that pauses reads must still receive a complete screen before the exit.
#[test]
fn a_viewer_behind_gets_a_redraw_before_the_exit() {
    let home = TestHome::new("slowviewer");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "flood",
        "echo READY; read go; head -c 20000000 /dev/zero | tr '\\0' X; exit 0",
    );
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let mut slow = ManualReadClient::open(&home);
    slow.send(
        1,
        "watch",
        json!({ "topic": "screen", "args": { "agent": agent } }),
    );
    type_raw(&mut wire, &agent, "go\r");
    // Twenty megabytes through the debug build's terminal take 10 to 25 seconds on a loaded Mac,
    // and over a minute on the loaded Linux machine.
    assert!(
        wait_until(LOADED_TIMEOUT * 3, || home.agents()[0]["process"]
            == "ended"),
        "{:?}",
        home.agents()
    );
    std::thread::sleep(secs(1));
    let mut kinds = Vec::new();
    while let Some(line) = slow.read_message() {
        if let Some(kind) = line["params"]["change"]["kind"].as_str() {
            kinds.push(kind.to_string());
            if kind == "exit" {
                break;
            }
        }
    }
    assert_eq!(
        kinds.last().map(String::as_str),
        Some("exit"),
        "no exit received after {} changes",
        kinds.len()
    );
    assert!(
        kinds.iter().any(|kind| kind == "redraw"),
        "viewer received no redraw after falling behind: {} changes",
        kinds.len()
    );
    // This CLI leaves no terminal-holding process, so no output should follow its exit.
    slow.set_read_timeout(secs(2));
    let after: Vec<Value> = std::iter::from_fn(|| slow.read_message())
        .filter(|line| line["params"]["change"]["kind"].is_string())
        .collect();
    assert!(after.is_empty(), "changes after the exit: {after:?}");
}

/// A watch response must precede its changes, even for a busy agent. The server queues the response
/// before starting the forwarder; this test checks the observed order.
#[test]
fn watch_response_precedes_changes() {
    let home = TestHome::new("watchorder");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "busy",
        "while :; do echo tick; sleep 0.001; done",
    );
    assert!(wait_for_screen_text(&home, &agent, "tick"));
    let mut raw = ManualReadClient::open(&home);
    let mut answered = HashSet::new();
    let mut changed = HashSet::new();
    for id in 1..=30u64 {
        raw.send(
            id,
            "watch",
            json!({ "topic": "screen", "args": { "agent": agent } }),
        );
        loop {
            let line = raw.read_message().expect("expected a daemon response");
            if line["id"] == id {
                answered.insert(
                    line["result"]["watch"]
                        .as_u64()
                        .expect("expected a watch ID"),
                );
                break;
            }
            note_change_after_its_response(&line, &answered, &mut changed);
        }
    }
    // Require changes on every watch so the ordering assertion is exercised.
    let until = Instant::now() + secs(10);
    while changed.len() < answered.len() && Instant::now() < until {
        let line = raw
            .read_message()
            .expect("expected the daemon connection to remain open");
        note_change_after_its_response(&line, &answered, &mut changed);
    }
    assert_eq!(
        changed.len(),
        answered.len(),
        "each watch must receive a change"
    );
}

/// A viewer that is behind during removal must receive the last screen, any missed exit, then
/// removal.
#[test]
fn remove_delivers_final_redraw_then_exit_then_removed() {
    let home = TestHome::new("removebehind");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "flood",
        "echo READY; read go; head -c 20000000 /dev/zero | tr '\\0' X; echo; echo \
         FINAL-MARKER; sleep 60",
    );
    assert!(wait_for_screen_text(&home, &agent, "READY"));
    let mut slow = ManualReadClient::open(&home);
    slow.send(
        1,
        "watch",
        json!({ "topic": "screen", "args": { "agent": agent } }),
    );
    type_raw(&mut wire, &agent, "go\r");
    // Twenty megabytes through the debug build's terminal take 10 to 25 seconds on a loaded Mac,
    // and over a minute on the loaded Linux machine.
    assert!(
        wait_until(LOADED_TIMEOUT * 3, || home
            .screen(&agent)
            .contains("FINAL-MARKER")),
        "{}",
        home.screen(&agent)
    );
    home.run_facade_ok(&["remove", &agent]);
    let mut kinds = Vec::new();
    let mut since_redraw = Vec::new();
    while let Some(line) = slow.read_message() {
        let change = &line["params"]["change"];
        let Some(kind) = change["kind"].as_str() else {
            continue;
        };
        kinds.push(kind.to_string());
        match kind {
            "redraw" => {
                since_redraw =
                    facade_base::base64::decode(change["data"].as_str().unwrap()).unwrap()
            }
            "output" => since_redraw
                .extend(facade_base::base64::decode(change["data"].as_str().unwrap()).unwrap()),
            "removed" => break,
            _ => {}
        }
    }
    let last: Vec<&str> = kinds
        .iter()
        .rev()
        .take(2)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(last, ["exit", "removed"], "{} changes", kinds.len());
    assert!(
        kinds.iter().any(|kind| kind == "redraw"),
        "no redraw received after {} changes",
        kinds.len()
    );
    assert!(
        String::from_utf8_lossy(&since_redraw).contains("FINAL-MARKER"),
        "the last screen lacks the agent's last output"
    );
}

/// Records a change and checks that its watch response arrived first.
fn note_change_after_its_response(
    line: &Value,
    answered: &HashSet<u64>,
    changed: &mut HashSet<u64>,
) {
    if let Some(watch) = line["params"]["watch"].as_u64() {
        assert!(
            answered.contains(&watch),
            "watch {watch} received a change before its response"
        );
        changed.insert(watch);
    }
}

/// A redraw carries the size it is drawn for, so a viewer that only watches the screen draws it
/// right after another client resized the agent.
#[test]
fn screen_redraw_after_resize_carries_the_new_size() {
    let home = TestHome::new("redrawsize");
    let agent = home.start_fake("w1");
    let mut wire = connect(&home);
    let watching = wire.request(
        "watch",
        json!({ "topic": "screen", "args": { "agent": agent.id } }),
    );
    let watch = watching["result"]["watch"].as_u64().expect("a watch");
    let resized = wire.call(
        "agent.resize",
        json!({ "agent": agent.id, "cols": 70, "rows": 20 }),
    );
    assert!(resized["result"].is_object(), "{resized}");
    let carries_size = |c: &Value| {
        c["change"]["kind"] == "redraw" && c["change"]["cols"] == 70 && c["change"]["rows"] == 20
    };
    assert!(
        wait_until(secs(5), || wire.changes(watch).iter().any(carries_size)),
        "{:?}",
        wire.changes(watch)
            .iter()
            .map(|c| c["change"]["kind"].clone())
            .collect::<Vec<_>>()
    );
}
