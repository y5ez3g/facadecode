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
    wire.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    let watching = wire.request("watch", json!({ "topic": "agents", "args": {} }));
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
            .any(|c| c["change"]["agent"]["reference"]["agent_id"]
                == second.id.as_str()
                && c["change"]["agent"]["process"] == "ended")),
        "{:?}",
        wire.changes(watch)
    );
    let remaining =
        wire.request("watch", json!({ "topic": "agents", "args": {} }))["result"]["watch"]
            .as_u64()
            .expect("expected a second watch ID");
    assert_ne!(watch, remaining);
    // Unwatch ends this subscription and leaves the other one active.
    assert!(wire.request("unwatch", json!({ "watch": watch }))["result"].is_object());
    let count = wire.changes(watch).len();
    let third = home.start_fake("w3");
    assert!(
        wait_until(LOADED_TIMEOUT, || wire.changes(remaining).iter().any(|c| c
            ["change"]["agent"]["reference"]["agent_id"]
            == third.id.as_str())),
        "the second watch received no change for {}",
        third.id
    );
    assert_eq!(wire.changes(watch).len(), count);
    assert_eq!(
        error_reason(&wire.request("unwatch", json!({ "watch": watch }))),
        "not_found"
    );
}

#[test]
fn agents_watch_reconnects_with_a_fresh_snapshot() {
    let home = TestHome::new("watchreconnect");
    let kept = home.start_fake("kept");
    let options = json!({ "topic": "agents", "args": {} });
    let mut prior = connect(&home);
    let old_watch = prior.request("watch", options.clone())["result"]["watch"]
        .as_u64()
        .expect("expected the old watch ID");
    let retired = home.start_fake("retired");
    assert!(wait_until(LOADED_TIMEOUT, || prior
        .changes(old_watch)
        .iter()
        .any(
            |c| c["change"]["agent"]["reference"]["agent_id"] == retired.id.as_str()
        )));
    drop(prior);
    connect(&home).call_ok("agent.remove", json!({ "target": retired.id }));

    let mut current = connect(&home);
    let watching = current.request("watch", options);
    let watch = watching["result"]["watch"]
        .as_u64()
        .expect("expected the new watch ID");
    let snapshot = watching["result"]["snapshot"]["agents"]
        .as_array()
        .expect("expected the new agent snapshot");
    assert_eq!(snapshot.len(), 1, "{watching}");
    assert_eq!(snapshot[0]["reference"]["agent_id"], kept.id.as_str());

    let added = home.start_fake("added");
    assert!(wait_until(LOADED_TIMEOUT, || current
        .changes(watch)
        .iter()
        .any(
            |c| c["change"]["agent"]["reference"]["agent_id"] == added.id.as_str()
        )));
    for notice in current.changes(watch) {
        let change = &notice["change"];
        assert_ne!(
            change["agent"]["reference"]["agent_id"],
            retired.id.as_str(),
            "{notice}"
        );
        assert_ne!(change["agent_id"], retired.id.as_str(), "{notice}");
    }
}

#[test]
fn agents_watch_observes_immediate_start_then_remove() {
    let home = TestHome::new("quickwatch");
    home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    let watch = wire.request("watch", json!({ "topic": "agents", "args": {} }))["result"]["watch"]
        .as_u64()
        .expect("expected a watch ID");
    // Publish both a start and immediate removal; polling could miss the agent entirely.
    let cwd = home.project.to_string_lossy().into_owned();
    let started = wire.call(
        "agent.start",
        json!({
            "cli": home.shell_cli(), "args": ["-c", "sleep 60"], "name": "brief", "folder": cwd,
            "size": { "cols": 80, "rows": 24 },
        }),
    );
    let reference = &started["result"]["agent"]["reference"];
    let id = reference["agent_id"]
        .as_str()
        .expect("expected an agent ID");
    wire.call_ok("agent.remove", json!({ "target": reference }));
    assert!(
        wait_until(secs(5), || {
            let changes = wire.changes(watch);
            let came = changes.iter().position(|c| {
                c["change"]["kind"] == "updated" && c["change"]["agent"]["reference"] == *reference
            });
            let went = changes.iter().position(|c| {
                c["change"]["kind"] == "removed"
                    && c["change"]["agent_id"] == id
                    && c["change"]["machine_id"] == reference["machine_id"]
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
    let keys = home.project.join("watcher-keys");
    let worker = home.start_fake_with(
        "w1",
        &[
            ("FAKECLI_KEYS", keys.to_str().unwrap()),
            ("FAKECLI_STATUS", "1"),
        ],
    );
    assert!(wait_for_screen_text(&home, &worker.address, "❯"));
    let reference = home.inspect_agent(&worker.address)["agent"]["reference"].clone();
    let mut raw = ManualReadClient::open(&home);
    raw.send(1, "watch", json!({ "topic": "attach", "args": { "target": reference, "size": { "cols": 80, "rows": 24 } } }));
    let watching = raw.read_frame().unwrap().expect("the attach snapshot");
    assert_eq!(watching["id"], 1, "{watching}");
    let watch = watching["result"]["watch"]
        .as_u64()
        .expect("an Attach watch ID");
    let snapshot = &watching["result"]["snapshot"];
    let decoded = |field: &Value| {
        facade_base::base64::decode(field.as_str().expect("terminal bytes")).unwrap()
    };
    let initial = decoded(&snapshot["redraw"]);
    assert!(
        String::from_utf8_lossy(&initial).contains("fakecli"),
        "{snapshot}"
    );
    assert_eq!(snapshot["reference"], reference, "{snapshot}");
    assert_eq!(snapshot["address"], worker.address, "{snapshot}");
    assert_eq!(
        snapshot["size"],
        json!({ "cols": 80, "rows": 24 }),
        "{snapshot}"
    );
    assert_eq!(snapshot["process"], "running", "{snapshot}");

    let change = |frame: Value| {
        assert_eq!(frame["jsonrpc"], "2.0", "{frame}");
        assert_eq!(frame["method"], "changed", "{frame}");
        assert!(frame.get("id").is_none(), "{frame}");
        assert_eq!(frame["params"]["watch"], watch, "{frame}");
        frame["params"]["change"].clone()
    };
    let notify = |raw: &mut ManualReadClient, op: &str, args: Value| {
        let frame =
            json!({ "jsonrpc": "2.0", "method": "call", "params": { "op": op, "args": args } });
        std::io::Write::write_all(&mut raw.writer, format!("{frame}\n").as_bytes()).unwrap();
    };
    let size = json!({ "cols": 77, "rows": 22 });
    notify(
        &mut raw,
        "attach.resize",
        json!({ "watch": watch, "size": size }),
    );
    loop {
        let redraw = change(raw.read_frame().unwrap().expect("a resize redraw"));
        if redraw["kind"] == "redraw" && redraw["size"] == size {
            assert!(!decoded(&redraw["data"]).is_empty());
            break;
        }
    }

    // The fake terminal reports and receives the status negotiation before the raw input.
    let capability = b"states=idle,working,done";
    assert!(wait_until(LOADED_TIMEOUT, || std::fs::read(&keys)
        .is_ok_and(|bytes| bytes
            .windows(capability.len())
            .any(|window| window == capability))));
    let input_before = std::fs::read(&keys).unwrap();
    let marker = "seen by a viewer";
    let data = facade_base::base64::encode(marker.as_bytes());
    notify(
        &mut raw,
        "agent.type",
        json!({ "target": reference, "input": { "kind": "raw", "raw": data } }),
    );
    let mut output = Vec::new();
    while !output
        .windows(marker.len())
        .any(|bytes| bytes == marker.as_bytes())
    {
        let update = change(raw.read_frame().unwrap().expect("terminal output"));
        if update["kind"] == "output" {
            output.extend(decoded(&update["data"]));
        }
    }
    assert_eq!(
        std::fs::read(&keys).unwrap(),
        [input_before.as_slice(), marker.as_bytes()].concat()
    );

    // Only this explicit request gets a response. Intervening frames belong to the Attach watch.
    raw.send(2, "call", json!({ "op": "daemon.status", "args": {} }));
    loop {
        let frame = raw.read_frame().unwrap().expect("the status response");
        if frame["id"] == 2 {
            assert_eq!(frame["result"]["home"], json!(home.path));
            break;
        }
        change(frame);
    }
    home.run_facade_ok(&["type", &worker.address, "--key", "Ctrl+C"]);
    home.run_facade_ok(&["type", &worker.address, "/fake exit 23", "--enter"]);
    let exit = loop {
        let update = change(
            raw.read_frame()
                .unwrap()
                .expect("the same watch reports exit"),
        );
        if update["kind"] == "exit" {
            break update;
        }
    };
    assert_eq!(exit["exit"]["code"], 23, "{exit}");
    assert_eq!(exit["exit_status"], 23, "{exit}");
    let record = home.inspect_agent(&worker.address);
    assert_eq!(record["agent"]["reference"], reference);
    assert_eq!(record["agent"]["process"], "ended");
    assert_eq!(record["agent"]["exit"], exit["exit"]);
    assert!(!alive(&worker.process));

    assert_eq!(
        error_reason(&connect(&home).request(
            "watch",
            json!({ "topic": "attach", "args": { "target": "nobody" } })
        )),
        "not_found",
    );
}

/// A screen read gives the screen's text with its styles marked: the fake CLI's dim words between
/// `{{` and `}}`.
#[test]
fn a_screen_read_marks_the_screen_s_styles() {
    let home = TestHome::new("read");
    let worker = home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_API_VERSIONS, json!({}));
    let read = wire.call("agent.screen", json!({ "target": worker.id, "lines": 40 }));
    let screen = &read["result"];
    assert!(
        screen["text"]
            .as_str()
            .is_some_and(|text| text.contains("fakecli {{(Facade test CLI)}}")),
        "{read}"
    );
    assert_eq!(
        (
            &screen["reference"]["agent_id"],
            &screen["process"],
            &screen["buffer"]
        ),
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
        error_reason(&wire.call("agent.screen", json!({ "target": "nobody" }))),
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
        json!({ "topic": "attach", "args": { "target": agent } }),
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
            json!({ "topic": "attach", "args": { "target": agent } }),
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
        json!({ "topic": "attach", "args": { "target": agent } }),
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
    home.remove_agent(&agent);
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
        json!({ "topic": "attach", "args": { "target": agent.id } }),
    );
    let watch = watching["result"]["watch"].as_u64().expect("a watch");
    let resized = wire.call(
        "attach.resize",
        json!({ "watch": watch, "size": { "cols": 70, "rows": 20 } }),
    );
    assert!(resized["result"].is_object(), "{resized}");
    let carries_size = |c: &Value| {
        c["change"]["kind"] == "redraw" && c["change"]["size"] == json!({ "cols": 70, "rows": 20 })
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
