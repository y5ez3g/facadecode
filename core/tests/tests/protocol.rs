//! Daemon protocol handshake, methods, validation, line limits, and bounded response queues.

use facade_base::paths::ClientSocket;
use std::io::Write;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

#[test]
fn hello_reports_protocol_build_and_capabilities() {
    let home = TestHome::new("hello");
    home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    let welcome = wire.hello("terminal", [1, 9], json!({}));
    let result = &welcome["result"];
    assert_eq!(result["protocol"], 2, "{welcome}");
    assert!(
        result["machine_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "{welcome}"
    );
    assert!(
        result.get("window").is_none(),
        "only editors bind a window: {welcome}"
    );
    assert!(
        result["build"]
            .as_str()
            .is_some_and(|build| build == env!("CARGO_PKG_VERSION")),
        "{welcome}"
    );
    assert_eq!(
        result["topics"],
        json!(["agents", "screen", "messages", "windows"]),
        "{welcome}"
    );
    assert!(
        result["ops"].as_array().is_some_and(|ops| [
            "agent.start",
            "agent.adopt",
            "agent.rename",
            "agent.send"
        ]
        .iter()
        .all(|wanted| ops.iter().any(|op| op == wanted))),
        "{welcome}"
    );
    // Hello identifies the daemon, keeper, and agent count.
    assert!(
        result["pid"].is_number() && result["keeper"]["pid"].is_number(),
        "{welcome}"
    );
    assert_eq!(result["agents"], 1, "{welcome}");
    // A second hello fails without closing the connection.
    assert_eq!(
        error_reason(&wire.hello("terminal", DAEMON_RANGE, json!({}))),
        "invalid_argument"
    );
    assert!(wire.call("agent.screen", json!({ "agent": "w1" }))["result"]["text"].is_string());
    let (_editor, logical) = ide_binding(
        &home,
        &json!({
            "id": "protocol-probe", "label": "Editor", "workspace": "workspace",
            "environment": "local", "folders": [home.project],
        }),
    );
    assert_eq!(result["machine_id"], logical.machine_id);
}

#[test]
fn a_client_without_a_shared_protocol_or_of_an_unknown_kind_is_refused() {
    let home = TestHome::new("versions");
    home.start_fake("w1");
    let mut old = DaemonTestClient::open(&home);
    assert_eq!(
        error_reason(&old.hello("terminal", [0, 0], json!({}))),
        "protocol_incompatible"
    );
    let mut newer = DaemonTestClient::open(&home);
    assert_eq!(
        error_reason(&newer.hello("terminal", [3, 3], json!({}))),
        "protocol_incompatible"
    );
    let mut stranger = DaemonTestClient::open(&home);
    assert_eq!(
        error_reason(&stranger.hello("hologram", DAEMON_RANGE, json!({}))),
        "protocol_incompatible"
    );
}

#[test]
fn a_v1_client_is_refused_and_the_keeper_keeps_the_live_process() {
    let home = TestHome::new("v1refusal");
    let agent = home.start_fake("kept");
    let keeper = home.keeper_pid().expect("the keeper");
    let mut client = DaemonTestClient::open(&home);
    let v1 = client.hello("terminal", [1, 1], json!({}));
    assert_eq!(error_reason(&v1), "protocol_incompatible", "{v1}");
    assert_eq!(home.keeper_pid(), Some(keeper));
    assert!(alive(&agent.process));
    assert_eq!(home.agent_from_list_json("kept").unwrap()["pid"], agent.pid);
}

#[test]
fn requests_require_hello_and_reject_unknown_methods_operations_and_topics() {
    let home = TestHome::new("tables");
    home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    assert!(
        wire.call("agent.stop", json!({ "agent": "w1" }))["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("hello"))
    );
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    assert_eq!(
        error_reason(&wire.call("agent.teleport", json!({}))),
        "invalid_argument"
    );
    assert_eq!(
        error_reason(&wire.request("watch", json!({ "topic": "weather" }))),
        "invalid_argument"
    );
    let unknown = wire.request("subscribe", json!({}));
    assert_eq!(unknown["error"]["code"], -32601, "{unknown}");
    assert!(
        unknown["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("hello, call, watch, unwatch, and cancel")),
        "{unknown}"
    );
}

#[test]
fn a_start_with_no_program_or_no_terminal_size_is_an_invalid_argument() {
    let home = TestHome::new("startargs");
    home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    wire.hello("terminal", DAEMON_RANGE, json!({}));
    let cwd = home.project.to_string_lossy().into_owned();
    for args in [
        json!({ "command": [], "cwd": cwd, "cols": 80, "rows": 24 }),
        json!({ "command": [SH.as_str()], "cwd": cwd, "cols": 0, "rows": 24 }),
        json!({ "command": [SH.as_str()], "cwd": cwd }),
    ] {
        assert_eq!(
            error_reason(&wire.call("agent.start", args.clone())),
            "invalid_argument",
            "{args}"
        );
    }
    assert_eq!(home.agents().len(), 1, "invalid starts must not add agents");
}

/// Malformed requests receive JSON-RPC errors with null IDs: -32700 for invalid JSON, -32600 for an
/// invalid request. Reading continues. Oversized lines receive an error and close the connection.
#[test]
fn malformed_requests_get_json_rpc_errors_and_oversized_lines_close_connection() {
    use std::io::{BufRead, Write};
    let home = TestHome::new("norequest");
    home.start_fake("w1");
    let mut stream = ClientSocket::connect(home.daemon_socket()).expect("the daemon's socket");
    stream.set_read_timeout(Some(secs(10))).unwrap();
    let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
    let mut response = || {
        let mut line = String::new();
        reader.read_line(&mut line).expect("expected a response");
        serde_json::from_str::<Value>(&line).expect("JSON")
    };
    stream.write_all(b"this is not json\n").unwrap();
    let parse = response();
    assert_eq!(
        (parse["id"].clone(), parse["error"]["code"].clone()),
        (Value::Null, json!(-32700)),
        "{parse}"
    );
    stream.write_all(b"{\"not\": \"a request\"}\n").unwrap();
    let invalid = response();
    assert_eq!(
        (invalid["id"].clone(), invalid["error"]["code"].clone()),
        (Value::Null, json!(-32600)),
        "{invalid}"
    );
    // A valid hello must work after malformed requests.
    stream
        .write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"hello\",\"params\":{\"protocol\":[1,\
              1],\"build\":\"t\",\"kind\":\"terminal\",\"client\":{\"name\":\"t\",\
              \"version\":\"1\"}}}\n",
        )
        .unwrap();
    assert_eq!(response()["id"], 7);
    // Reject an unterminated line that exceeds the limit, then close the connection.
    let chunk = vec![b'a'; 1 << 20];
    for _ in 0..65 {
        if stream.write_all(&chunk).is_err() {
            break;
        }
    }
    let refused = response();
    assert_eq!(
        refused["error"]["data"]["reason"], "capacity_exceeded",
        "{refused}"
    );
    let mut rest = String::new();
    assert_eq!(
        reader.read_line(&mut rest).unwrap_or(0),
        0,
        "the oversized-line connection must close: {rest}"
    );
}

/// Responses must use bounded memory when a client sends calls faster than it reads.
#[test]
fn unread_responses_backpressure_the_connection() {
    let home = TestHome::new("outbox");
    let mut wire = connect(&home);
    let agent = start_script(
        &mut wire,
        &home,
        "scrollback",
        "seq 1 3000 | sed 's/$/ some text to fill the line up/'; echo DONE; sleep 60",
    );
    assert!(wait_for_screen_text(&home, &agent, "DONE"));
    let rss = || -> u64 { resident_kib(home.daemon_pid().expect("expected a running daemon")) };
    let before = rss();
    let stream = ClientSocket::connect(home.daemon_socket()).unwrap();
    let mut writer = stream.try_clone().unwrap();
    writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "jsonrpc": "2.0", "id": 0, "method": "hello",
                    "params": { "protocol": DAEMON_RANGE, "build": "t", "kind": "terminal" },
                })
            )
            .as_bytes(),
        )
        .unwrap();
    std::thread::spawn(move || {
        for id in 1..=300 {
            let call = json!({
                "jsonrpc": "2.0", "id": id, "method": "call",
                "params": {
                    "op": "agent.screen", "args": { "agent": "scrollback", "lines": 2000 },
                },
            });
            if writer.write_all(format!("{call}\n").as_bytes()).is_err() {
                return;
            }
        }
    });
    std::thread::sleep(secs(3));
    let grown = rss().saturating_sub(before);
    // Each result is about 170 KB. The limit is 16 call tasks plus the 8 MiB outbox, below the
    // roughly 50 MB for 300 results.
    assert!(grown < 40_000, "the daemon grew by {grown} KiB");
    // Other clients must still receive responses.
    assert!(
        wire.call("agent.screen", json!({ "agent": agent, "lines": 1 }))["result"]["text"]
            .is_string()
    );
    drop(stream);
}

/// The person's client reads the daemon's log: the last lines, oldest first, which say what was
/// done and hold no message's text. A call that acts for an agent is refused, as the log names
/// every agent and who sent whom a message.
#[test]
fn the_person_s_client_reads_the_daemon_s_log_and_an_agent_s_call_is_refused() {
    let home = TestHome::new("daemonlog");
    let ada = home.start_named_fake("ada", &[]);
    home.run_facade_ok(&["send", "ada", "hello ada"]);
    let mut wire = connect(&home);
    let read = wire.call("daemon.log", json!({}));
    let lines: Vec<String> = read["result"]["lines"]
        .as_array()
        .unwrap_or_else(|| panic!("{read}"))
        .iter()
        .map(|line| line.as_str().unwrap().to_string())
        .collect();
    let at = |what: &str| lines.iter().position(|line| line.contains(what));
    let started = at(&format!("started #{}", ada.id));
    let sent = at(&format!("to #{}", ada.id));
    assert!(
        started.is_some() && sent.is_some() && started < sent,
        "the start, then the send: {lines:#?}"
    );
    assert!(at("hello ada").is_none(), "{lines:#?}");
    let mut for_ada = DaemonTestClient::open(&home);
    for_ada.hello("terminal", DAEMON_RANGE, json!({ "agent": ada.id }));
    let refused = for_ada.call("daemon.log", json!({}));
    assert_eq!(error_reason(&refused), "refused", "{refused}");
}
