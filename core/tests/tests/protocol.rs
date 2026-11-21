//! Daemon protocol handshake, methods, validation, line limits, and bounded response queues.

use facade_base::paths::ClientSocket;
use std::io::Write;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

fn hello_v1(wire: &mut DaemonTestClient) -> Value {
    let welcome = wire.request(
        "hello",
        json!({ "api_versions": [1], "build": "test", "kind": "terminal" }),
    );
    assert_eq!(welcome["result"]["api_version"], 1, "{welcome}");
    welcome
}

#[test]
fn hello_selects_api_version_and_advertises_the_session_catalog() {
    let home = TestHome::new("hello");
    home.start_fake("w1");

    let terminal_operations = [
        "agent.inspect",
        "agent.list",
        "agent.remove",
        "agent.rename",
        "agent.resume",
        "agent.resume_list",
        "agent.screen",
        "agent.send",
        "agent.start",
        "agent.stop",
        "agent.type",
        "attach.resize",
        "cli.list",
        "daemon.log",
        "daemon.status",
        "daemon.upgrade",
        "location.list",
        "machine.connect",
        "machine.list",
        "machine.remove",
        "machine.rename",
    ];
    for kind in ["terminal", "ide"] {
        let mut wire = DaemonTestClient::open(&home);
        let hello = json!({ "api_versions": [2, 1, 1], "build": "test", "kind": kind });
        let welcome = wire.request("hello", hello.clone());
        let result = &welcome["result"];
        assert_eq!(welcome["id"], 1, "{welcome}");
        assert_eq!(result["api_version"], 1, "{welcome}");
        assert_eq!(result["build"], env!("CARGO_PKG_VERSION"), "{welcome}");
        assert_eq!(result["agent_count"], 1, "{welcome}");
        assert!(result["machine_id"].is_string(), "{welcome}");
        assert!(
            result["pid"].is_number() && result["keeper"]["pid"].is_number(),
            "{welcome}"
        );
        assert!(
            result.get("protocol").is_none() && result.get("agents").is_none(),
            "{welcome}"
        );

        let mut operations: Vec<_> = result["ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| op.as_str().unwrap())
            .collect();
        operations.sort_unstable();
        let expected: Vec<_> = terminal_operations
            .iter()
            .copied()
            .filter(|op| kind == "terminal" || !matches!(*op, "daemon.upgrade" | "machine.connect"))
            .collect();
        assert_eq!(operations, expected, "{welcome}");
        let mut topics: Vec<_> = result["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|topic| topic.as_str().unwrap())
            .collect();
        topics.sort_unstable();
        assert_eq!(topics, ["agents", "attach", "machines"], "{welcome}");

        let duplicate = wire.request("hello", hello);
        assert_eq!(error_reason(&duplicate), "invalid_argument", "{duplicate}");
        assert!(wire.call_ok("agent.screen", json!({ "target": "w1" }))["text"].is_string());
    }
}

#[test]
fn invalid_offers_and_external_mcp_are_refused_before_admission() {
    let home = TestHome::new("versions");
    home.start_fake("w1");
    let mut hello = json!({ "build": "test", "kind": "terminal" });
    let mut absent = DaemonTestClient::open(&home);
    let response = absent.request("hello", hello.clone());
    assert_eq!(response["id"], 1, "{response}");
    assert_eq!(response["error"]["code"], -32602, "{response}");
    assert_eq!(error_reason(&response), "invalid_argument", "{response}");

    for offer in [
        json!([]),
        json!(null),
        json!([0]),
        json!([-1]),
        json!(["1"]),
        json!("1"),
    ] {
        let mut wire = DaemonTestClient::open(&home);
        hello["api_versions"] = offer;
        let rejected = wire.request("hello", hello.clone());
        assert_eq!(rejected["id"], 1, "{rejected}");
        assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
        assert_eq!(error_reason(&rejected), "invalid_argument", "{rejected}");
        assert!(rejected.get("result").is_none(), "{rejected}");
    }

    let mut wire = DaemonTestClient::open(&home);
    hello["api_versions"] = json!([2]);
    let incompatible = wire.request("hello", hello.clone());
    assert_eq!(incompatible["id"], 1, "{incompatible}");
    assert_eq!(incompatible["error"]["code"], -32000, "{incompatible}");
    assert_eq!(
        error_reason(&incompatible),
        "protocol_incompatible",
        "{incompatible}"
    );
    assert_eq!(
        incompatible["error"]["data"]["details"]["supported_api_versions"],
        json!([1])
    );

    let mut external = DaemonTestClient::open(&home);
    let refused = external.request(
        "hello",
        json!({ "api_versions": [1], "build": "test", "kind": "mcp" }),
    );
    assert_eq!(refused["id"], 1, "{refused}");
    assert_eq!(error_reason(&refused), "refused", "{refused}");
}

#[test]
fn a_prerelease_range_offer_is_refused_and_the_keeper_keeps_the_live_process() {
    let home = TestHome::new("prerelease-refusal");
    let agent = home.start_fake("kept");
    let keeper = home.lock_record("keeper").expect("the keeper");
    let mut client = DaemonTestClient::open(&home);
    let refusal = client.hello_prerelease("terminal", [3, 3], json!({}));
    assert_eq!(refusal["error"]["code"], -32602, "{refusal}");
    assert_eq!(error_reason(&refusal), "invalid_argument", "{refusal}");
    assert_eq!(home.lock_record("keeper"), Some(keeper));
    assert!(alive(&agent.process));
    assert_eq!(home.agent_record(&agent.id).unwrap()["pid"], agent.pid);
}

#[test]
fn requests_require_hello_and_reject_unknown_methods_operations_and_topics() {
    let home = TestHome::new("tables");
    let agent = home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    assert!(
        wire.call(
            "agent.stop",
            json!({ "selection": { "kind": "targets", "targets": ["w1"] } })
        )["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("hello"))
    );
    hello_v1(&mut wire);
    assert!(alive(&agent.process));
    assert_eq!(
        error_reason(&wire.call("agent.teleport", json!({}))),
        "invalid_argument"
    );
    assert_eq!(
        error_reason(&wire.request("watch", json!({ "topic": "weather", "args": {} }))),
        "invalid_argument"
    );
    let retired = wire.call("agent.start_preflight", json!({}));
    assert_eq!(retired["error"]["code"], -32602, "{retired}");
    let non_object = wire.call("agent.list", json!([]));
    assert_eq!(non_object["error"]["code"], -32602, "{non_object}");
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
fn a_start_with_no_cli_or_no_terminal_size_is_an_invalid_argument() {
    let home = TestHome::new("startargs");
    home.start_fake("w1");
    let mut wire = DaemonTestClient::open(&home);
    hello_v1(&mut wire);
    let cwd = home.project.to_string_lossy().into_owned();
    for args in [
        json!({ "folder": cwd, "size": { "cols": 80, "rows": 24 } }),
        json!({ "cli": "fake", "folder": cwd, "size": { "cols": 0, "rows": 24 } }),
        json!({ "cli": "fake", "folder": cwd }),
        json!({ "cli": "fake", "folder": cwd, "size": { "cols": 80, "rows": 24 }, "unknown_field": true }),
        json!({ "cli": "fake", "folder": cwd, "size": { "cols": 80, "rows": 24 }, "name": null }),
    ] {
        assert_eq!(
            error_reason(&wire.call("agent.start", args.clone())),
            "invalid_argument",
            "{args}"
        );
    }
    let listed = wire.call_ok("agent.list", json!({ "scope": { "kind": "local" } }));
    let agents = listed["agents"].as_array().unwrap();
    assert_eq!(
        agents.len(),
        1,
        "invalid starts must not add agents: {listed}"
    );
    assert_eq!(agents[0]["name"], "w1", "{listed}");
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
            b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"hello\",\"params\":{\"api_versions\":[1],\
              \"build\":\"t\",\"kind\":\"terminal\"}}\n",
        )
        .unwrap();
    let hello = response();
    assert_eq!(hello["id"], 7, "{hello}");
    assert_eq!(hello["result"]["api_version"], 1, "{hello}");
    // Reject an unterminated line that exceeds the limit, then close the connection.
    let chunk = vec![b'a'; 1 << 20];
    for _ in 0..65 {
        if stream.write_all(&chunk).is_err() {
            break;
        }
    }
    let refused = response();
    assert_eq!(refused["id"], Value::Null, "{refused}");
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
    home.run_facade_ok(&["daemon", "--detach"]);
    let mut wire = DaemonTestClient::open(&home);
    let welcome = hello_v1(&mut wire);
    let started = wire.call_ok("agent.start", json!({
        "cli": home.shell_cli(), "name": "scrollback", "folder": home.project,
        "size": { "cols": 80, "rows": 24 },
        "args": ["-c", "seq 1 3000 | sed 's/$/ some text to fill the line up/'; echo DONE; sleep 60"],
    }));
    let agent = started["agent"]["address"]
        .as_str()
        .expect("the Shell agent address");
    assert!(wait_for_screen_text(&home, agent, "DONE"));
    let daemon = welcome["result"]["pid"].as_i64().unwrap() as i32;
    let rss = || resident_kib(daemon);
    let before = rss();
    let stream = ClientSocket::connect(home.daemon_socket()).unwrap();
    let mut writer = stream.try_clone().unwrap();
    writer
        .write_all(
            format!(
                "{}\n",
                json!({
                    "jsonrpc": "2.0", "id": 0, "method": "hello",
                    "params": { "api_versions": [1], "build": "t", "kind": "terminal" },
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
                    "op": "agent.screen", "args": { "target": "scrollback", "lines": 2000 },
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
        wire.call("agent.screen", json!({ "target": agent, "lines": 1 }))["result"]["text"]
            .is_string()
    );
    drop(stream);
}

/// The person's client reads the last log lines, oldest first, without message text. A managed
/// agent's tools do not expose the log.
#[test]
fn the_person_s_client_reads_the_daemon_s_log_and_an_agent_s_tool_is_refused() {
    let home = TestHome::new("daemonlog");
    let ada = home.start_named_fake("ada", &[]);
    home.run_facade_ok(&["send", "ada", "hello ada"]);
    let mut wire = DaemonTestClient::open(&home);
    hello_v1(&mut wire);
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
    let mut managed = McpTestClient::open(&home, &ada.id);
    let refused = managed.call("daemon.log", json!({}));
    assert_eq!(refused["reason"], "unsupported", "{refused}");

    let mut relay = McpTestClient::relay_configured(&home, &ada.id);
    let catalog = relay.request("tools/list", json!({}));
    assert!(
        catalog["result"]["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == "list_agents")),
        "{catalog}"
    );
    let roster = relay.call("list_agents", json!({}));
    assert_eq!(roster["status"], "success", "{roster}");
}
