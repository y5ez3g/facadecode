//! `facade-mcp`, run as an agent's CLI runs it: its tools against a real daemon, the result
//! envelope, and its own start and end. And how each CLI Facade starts is given the tools, and
//! whether it can use them.

use std::io::Write;
use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

fn type_draft(home: &TestHome, agent: &str, draft: &str) {
    home.run_facade_ok(&["type", agent, draft]);
    assert!(
        wait_until(secs(10), || home
            .screen(agent)
            .contains(&format!("❯ {draft}"))),
        "{}",
        home.screen(agent)
    );
}

#[test]
fn mcp_zero_wait_sends_are_kept_and_invalid_waits_send_nothing() {
    let home = TestHome::new("mcpwait");
    let sender = home.start_named_fake("sender", &[]);
    let recipient = home.start_named_fake("recipient", &[]);
    type_draft(&home, &recipient.id, "hold delivery");
    let mut sender_mcp = McpTestClient::open_configured(&home, &sender.id);
    let mut recipient_mcp = McpTestClient::open_configured(&home, &recipient.id);

    for arguments in [
        json!({ "timeout_seconds": 1 }),
        json!({ "wait_for": "none" }),
    ] {
        let mut send = json!({ "to": recipient.address, "text": "refuse this send" });
        send.as_object_mut()
            .unwrap()
            .extend(arguments.as_object().unwrap().clone());
        let refused = sender_mcp.call("send_message", send);
        assert_eq!(refused["status"], "failure", "{refused}");
        assert_eq!(refused["reason"], "invalid_argument", "{refused}");
        assert!(refused["data"].get("id").is_none(), "{refused}");
        assert!(refused["data"].get("next").is_none(), "{refused}");
    }
    let removed = recipient_mcp.call("read_messages", json!({ "wait": true }));
    assert_eq!(removed["status"], "failure", "{removed}");
    assert_eq!(removed["reason"], "invalid_argument", "{removed}");
    assert!(removed["data"].get("next").is_none(), "{removed}");

    for timeout in [json!({}), json!({ "timeout_seconds": 0 })] {
        let empty = recipient_mcp.call("read_messages", timeout);
        assert_eq!(empty["status"], "success", "{empty}");
        assert_eq!(empty["data"]["messages"], json!([]), "{empty}");
        assert!(empty["data"].get("next").is_none(), "{empty}");
    }
    let expired = recipient_mcp.call("read_messages", json!({ "timeout_seconds": 1 }));
    assert_eq!(expired["status"], "failure", "{expired}");
    assert_eq!(expired["reason"], "timeout", "{expired}");
    assert!(expired["data"].get("next").is_none(), "{expired}");

    let expected: Vec<_> = [
        ("omitted", json!({})),
        ("zero", json!({ "timeout_seconds": 0 })),
        ("delivery alone", json!({ "wait_for": "delivery" })),
        ("result alone", json!({ "wait_for": "result" })),
    ]
    .into_iter()
    .map(|(text, options)| {
        let mut send = json!({ "to": recipient.address, "text": text });
        send.as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let receipt = sender_mcp.call("send_message", send);
        assert_eq!(receipt["status"], "success", "{receipt}");
        assert_eq!(receipt["data"]["delivery"], "waiting_in_inbox", "{receipt}");
        assert!(receipt["data"].get("next").is_none(), "{receipt}");
        let id = receipt["data"]["id"].as_str().unwrap();
        let (inbox_number, _) = id.split_once('@').expect("full send ID");
        (inbox_number.to_owned(), text)
    })
    .collect();
    let read = recipient_mcp.call("read_messages", json!({ "timeout_seconds": 0 }));
    assert_eq!(read["status"], "success", "{read}");
    assert!(read["data"].get("next").is_none(), "{read}");
    let messages = read["data"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), expected.len(), "{read}");
    for (message, (id, text)) in messages.iter().zip(expected) {
        assert_eq!(message["id"], id, "{message}");
        assert_eq!(message["text"], text, "{message}");
        assert_eq!(message["from"], sender.address, "{message}");
    }
    let history = recipient_mcp.call("read_messages", json!({ "last": 10 }));
    assert_eq!(history["data"]["messages"], json!(messages), "{history}");
}

#[test]
fn a_matching_read_finds_a_reply_already_typed_into_a_managed_terminal() {
    let home = TestHome::new("mcptypedreply");
    let ada = home.start_named_fake("ada", &[]);
    let bob = home.start_named_fake("bob", &[]);
    let mut ada_mcp = McpTestClient::open_configured(&home, &ada.id);
    let mut bob_mcp = McpTestClient::open_configured(&home, &bob.id);
    let sent = ada_mcp.call(
        "send_message",
        json!({
            "to": bob.address, "text": "Please answer in a linked reply",
            "wait_for": "delivery", "timeout_seconds": 30,
        }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["delivery"], "typed_into_input", "{sent}");
    let original = sent["data"]["id"].as_str().expect("full send ID");
    let (inbox_id, _) = original.split_once('@').unwrap();
    let text = "The linked reply is ready";
    let replied = bob_mcp.call(
        "send_message",
        json!({
            "to": ada.address, "text": text, "reply_to": inbox_id,
            "wait_for": "delivery", "timeout_seconds": 30,
        }),
    );
    assert_eq!(replied["status"], "success", "{replied}");
    assert_eq!(replied["data"]["delivery"], "typed_into_input", "{replied}");
    assert!(
        wait_until(secs(10), || home
            .submitted_messages()
            .iter()
            .any(|message| { message.lines().skip(1).eq([text]) })),
        "the reply did not reach the fake terminal: {}",
        home.screen(&ada.address)
    );
    let empty = ada_mcp.call("read_messages", json!({}));
    assert_eq!(empty["status"], "success", "{empty}");
    assert_eq!(empty["data"]["messages"], json!([]), "{empty}");
    let read = ada_mcp.call("read_messages", json!({ "reply_to": original }));
    assert_eq!(read["status"], "success", "{read}");
    assert!(read["data"].get("next").is_none(), "{read}");
    let messages = read["data"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "{read}");
    let reply_id = replied["data"]["id"]
        .as_str()
        .unwrap()
        .split_once('@')
        .unwrap()
        .0;
    assert_eq!(messages[0]["id"], reply_id, "{read}");
    assert_eq!(messages[0]["from"], bob.address, "{read}");
    assert_eq!(messages[0]["text"], text, "{read}");
    assert_eq!(messages[0]["reply_to"], inbox_id, "{read}");
}

fn available_cli_names(list: &Value) -> Value {
    assert!(list.get("settings_problem").is_none(), "{list}");
    json!(
        list["clis"]
            .as_array()
            .expect("cli.list rows")
            .iter()
            .filter(|row| row["available"] == true)
            .map(|row| row["cli"].as_str().expect("a CLI name"))
            .collect::<Vec<_>>()
    )
}

fn mcp_machine<'a>(roster: &'a Value, machine_id: &str) -> &'a Value {
    assert_eq!(roster["status"], "success", "{roster}");
    roster["data"]["machines"]
        .as_array()
        .expect("MCP machine rows")
        .iter()
        .find(|row| row["machine_id"] == machine_id)
        .unwrap_or_else(|| panic!("missing machine {machine_id}: {roster}"))
}

#[test]
fn mcp_cli_names_match_the_managed_and_guest_default_start_contexts() {
    let home = TestHome::new("mcpclis");
    let fake = &test_binaries().fakecli;
    install_program(&home.project, "project-only", fake);
    let command = format!("./project-only{}", std::env::consts::EXE_SUFFIX);
    std::fs::write(
        home.path.join("facade.json"),
        json!({
            "yolo": true,
            "clis": { "project-only": { "type": "fake", "command": command } },
        })
        .to_string(),
    )
    .unwrap();
    let agent = home.start_named_fake("observer", &[]);
    let mut wire = connect(&home);
    let hello = home.hello_result().unwrap();
    let machine_id = hello["machine_id"].as_str().unwrap();
    let env = home
        .isolating_env()
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    let managed_names = available_cli_names(
        &wire.call_ok("cli.list", json!({ "folder": home.project, "env": env })),
    );
    let guest_names = available_cli_names(&wire.call_ok("cli.list", json!({})));
    assert!(
        managed_names
            .as_array()
            .unwrap()
            .contains(&json!("project-only"))
    );
    assert!(
        !guest_names
            .as_array()
            .unwrap()
            .contains(&json!("project-only"))
    );

    let mut managed = McpTestClient::open_configured(&home, &agent.id);
    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    for (mcp, expected) in [(&mut managed, managed_names), (&mut guest, guest_names)] {
        let roster = mcp.call("list_agents", json!({}));
        let row = mcp_machine(&roster, machine_id);
        assert_eq!(row["status"], "answered", "{roster}");
        assert_eq!(row["clis"], expected, "{roster}");
        assert!(row.get("cli_error").is_none(), "{roster}");
    }
}

#[test]
fn mcp_remote_cli_lookup_preserves_the_roster_when_settings_fail() {
    let local = TestHome::new("mcpclis-local");
    let remote = TestHome::new("mcpclis-remote");
    let programs = test_binaries();
    install_machine_ssh(
        &[("mcp-local", &local), ("mcp-peer", &remote)],
        &programs.facade,
    );
    std::fs::write(local.path.join("facade.json"), r#"{"yolo":true}"#).unwrap();
    let settings = remote.path.join("facade.json");
    std::fs::write(
        &settings,
        json!({
            "yolo": true,
            "clis": {
                "peer-only": { "type": "fake", "command": programs.fakecli },
                "peer-missing": { "type": "fake", "command": remote.folder().join("no-program") },
            },
        })
        .to_string(),
    )
    .unwrap();
    let mut local_wire = connect(&local);
    let _remote_wire = connect(&remote);
    let local_hello = local.hello_result().unwrap();
    let remote_hello = remote.hello_result().unwrap();
    let local_id = local_hello["machine_id"].as_str().unwrap();
    let remote_id = remote_hello["machine_id"].as_str().unwrap();
    for (home, id, name) in [
        (&local, local_id, "mcp-local"),
        (&remote, remote_id, "mcp-peer"),
    ] {
        home.run_facade_ok(&["machine", "rename", &id.replace('-', ""), name]);
    }
    local.run_facade_ok(&[
        "machine",
        "add",
        "--home",
        remote.path.to_str().unwrap(),
        "mcp-peer",
    ]);
    let witness = remote.start_named_fake("peer-witness", &[]);
    let observer = local.start_named_fake("observer", &[]);
    let mut mcp = McpTestClient::open_configured(&local, &observer.id);
    let scope = json!({ "scope": { "kind": "machine", "machine": "mcp-peer" } });
    let expected = available_cli_names(&local_wire.call_ok("cli.list", scope.clone()));
    assert!(expected.as_array().unwrap().contains(&json!("peer-only")));
    assert!(
        !expected
            .as_array()
            .unwrap()
            .contains(&json!("peer-missing"))
    );
    let roster = mcp.call("list_agents", json!({}));
    let peer = mcp_machine(&roster, remote_id);
    assert_eq!(peer["selector"], "mcp-peer", "{roster}");
    assert_eq!(peer["status"], "answered", "{roster}");
    assert_eq!(peer["clis"], expected, "{roster}");
    assert!(peer.get("cli_error").is_none(), "{roster}");

    std::fs::write(settings, "{").unwrap();
    let failed = local_wire.call_ok("cli.list", scope);
    let error = failed["settings_problem"]
        .as_str()
        .expect("a CLI settings error");
    let roster = mcp.call("list_agents", json!({}));
    let peer = mcp_machine(&roster, remote_id);
    assert_eq!(peer["status"], "answered", "{roster}");
    assert!(peer.get("clis").is_none(), "{roster}");
    assert_eq!(peer["cli_error"], error, "{roster}");
    assert!(
        mcp_machine(&roster, local_id)["clis"].is_array(),
        "{roster}"
    );
    assert!(
        roster["data"]["agents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|agent| agent["id"] == witness.address),
        "{roster}"
    );
}

/// Both accepted argument shorthands use the public limit and reject invalid batches before typing.
#[test]
fn press_keys_checks_normalized_batches_before_typing() {
    let home = TestHome::new("mcpkeys");
    let pressed = home.project.join("pressed");
    let agent = home.start_named_fake("ada", &[("FAKECLI_KEYS", pressed.to_str().unwrap())]);
    assert!(wait_for_screen_text(&home, &agent.id, "❯"));
    let mut client = McpTestClient::open_configured(&home, &agent.id);

    let mut keys = vec!["界"];
    keys.extend(std::iter::repeat_n("A", 99));
    let arguments = json!({ "agent": agent.id, "keys": json!(keys).to_string() });
    let result = client.call("press_keys", arguments);
    assert_eq!(result["status"], "success", "{result}");

    let result = client.call("press_keys", json!({ "agent": agent.id, "keys": [] }));
    assert_eq!(result["reason"], "invalid_argument", "{result}");

    let too_many = json!(vec!["z"; 101]).to_string();
    let result = client.call("press_keys", json!({ "agent": agent.id, "keys": too_many }));
    assert_eq!(result["reason"], "invalid_argument", "{result}");
    assert!(
        result["message"].as_str().unwrap().contains("at most 100"),
        "{result}"
    );

    let result = client.call(
        "press_keys",
        json!({ "agent": agent.id, "keys": ["z", "eScApE"] }),
    );
    assert_eq!(result["reason"], "invalid_argument", "{result}");
    assert!(
        result["message"].as_str().unwrap().contains(r#"Use "Esc""#),
        "{result}"
    );

    let result = client.call("press_keys", json!({ "agent": agent.id, "keys": "eSc" }));
    assert_eq!(result["status"], "success", "{result}");
    let result = client.call(
        "press_keys",
        json!({ "agent": agent.id, "keys": ["ENTER"] }),
    );
    assert_eq!(result["status"], "success", "{result}");

    let mut expected = Vec::from("界".as_bytes());
    expected.extend_from_slice(&[b'A'; 99]);
    expected.extend_from_slice(b"\x1b\r");
    assert!(
        wait_until(secs(10), || std::fs::read(&pressed)
            .is_ok_and(|bytes| bytes == expected)),
        "{:?}",
        std::fs::read(&pressed)
    );
}

/// A managed agent can take whole long messages from its inbox while a draft holds terminal
/// delivery. Only the messages included in each inline page are delivered by the read.
#[test]
fn a_managed_read_delivers_only_whole_inline_messages() {
    let home = TestHome::new("mcp-managed-pages");
    let ada = home.start_named_fake("ada", &[]);
    let bob = home.start_named_fake("bob", &[]);
    type_draft(&home, "ada", "hold");
    let mut receiver = McpTestClient::open_configured(&home, &ada.id);
    let mut sender = McpTestClient::open_configured(&home, &bob.id);
    let long = ["x".repeat(5000), "y".repeat(5000)];
    let sends = long.each_ref().map(|text| {
        sender.send(
            "tools/call",
            json!({
                "name": "send_message",
                "arguments": { "to": "ada", "text": text, "wait_for": "delivery", "timeout_seconds": 30 },
            }),
        )
    });
    let store = rusqlite::Connection::open_with_flags(
        home.path.join("core/facade.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    store.busy_timeout(secs(5)).unwrap();
    let pending = || {
        store
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE status = 'pending' AND text IN (?1, ?2)",
                [&long[0], &long[1]],
                |row| row.get::<_, u32>(0),
            )
            .unwrap()
    };
    assert!(
        wait_until(secs(10), || pending() == 2),
        "both sends are waiting behind the managed agent's draft"
    );

    let first = receiver.call("read_messages", json!({}));
    let first_page = first["data"]["messages"].as_array().expect("inline page");
    assert_eq!(first["status"], "success", "{first}");
    assert_eq!(first_page.len(), 1, "{first}");
    assert!(first["data"].get("file").is_none(), "{first}");
    assert!(first["data"].get("next").is_none(), "{first}");
    assert_eq!(pending(), 1, "only the returned message was delivered");
    let cursor = first["data"]["next_cursor"]
        .as_str()
        .expect("the second pending message needs another page");
    let second = receiver.call("read_messages", json!({ "after": cursor }));
    assert!(second["data"].get("next").is_none(), "{second}");
    let second_page = second["data"]["messages"].as_array().expect("inline page");
    assert_eq!(second["status"], "success", "{second}");
    assert_eq!(second_page.len(), 1, "{second}");
    assert!(second["data"].get("file").is_none(), "{second}");
    assert!(second["data"].get("next_cursor").is_none(), "{second}");

    let messages = [&first_page[0], &second_page[0]];
    let mut texts = messages.map(|message| message["text"].as_str().unwrap());
    texts.sort_unstable();
    assert_eq!(texts, [long[0].as_str(), long[1].as_str()]);
    let roster = home.agent_list();
    let bob_address = &roster["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "bob")
        .expect("Bob is still running")["address"];
    for message in messages {
        assert_eq!(&message["from"], bob_address, "{message}");
        let id = message["id"].as_str().expect("the inbox message number");
        assert!(id.strip_prefix('m').is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        }));
    }
    for id in sends {
        let receipt = sender.tool_answer(id);
        assert_eq!(receipt["status"], "success", "{receipt}");
        assert_eq!(
            receipt["data"]["delivery"], "read_by_recipient",
            "{receipt}"
        );
        let address = receipt["data"]["id"].as_str().expect("the send receipt");
        let (number, _) = address.split_once('@').expect("a complete receipt address");
        assert!(messages.iter().any(|message| message["id"] == number));
    }
    let unread = receiver.call("read_messages", json!({}));
    assert_eq!(unread["data"]["messages"], json!([]), "{unread}");
    assert!(home.submitted_messages().is_empty());
}

/// facade-mcp serves a managed run or joins as a Guest at the first tool call. At the end of its
/// input it answers the calls still under way, then exits.
#[test]
fn facade_mcp_serves_its_agent_until_its_input_ends() {
    let home = TestHome::new("mcpends");
    home.start_facade_with(&[]);
    // An external relay receives connection instructions before it joins.
    let mut unconfigured = home
        .command(&test_binaries().mcp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let lines = [
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" },
        }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "list_agents", "arguments": {} },
        }),
    ];
    // As a client does, it waits for the answer to initialize before its other requests.
    let mut input = unconfigured.stdin.take().unwrap();
    let mut output = std::io::BufReader::new(unconfigured.stdout.take().unwrap());
    let mut written = String::new();
    input
        .write_all(format!("{}\n", lines[0]).as_bytes())
        .unwrap();
    std::io::BufRead::read_line(&mut output, &mut written).unwrap();
    for line in &lines[1..] {
        input.write_all(format!("{line}\n").as_bytes()).unwrap();
    }
    drop(input);
    std::io::Read::read_to_string(&mut output, &mut written).unwrap();
    assert!(unconfigured.wait().unwrap().success());
    let answers: Vec<Value> = written
        .lines()
        .map(|line| facade_scenarios::serde_json::from_str(line).unwrap())
        .collect();
    let answered = |id: u64| {
        answers
            .iter()
            .find(|answer| answer["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(
        answered(1)["result"]["instructions"],
        facade_base::instructions::for_connection()
    );
    assert_eq!(
        answered(2)["result"]["tools"].as_array().map(Vec::len),
        Some(8)
    );
    assert_eq!(
        answered(3)["result"]["structuredContent"]["status"],
        "success"
    );

    let ada = home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open(&home, &ada.id);
    let ping = ada.send("ping", json!({}));
    let listed = ada.send(
        "tools/call",
        json!({ "name": "list_agents", "arguments": {} }),
    );
    let (answers, status) = ada.close(secs(20));
    assert!(status.success(), "{status:?}");
    let answered = |id: u64| {
        answers
            .iter()
            .find(|answer| answer["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(answered(ping)["result"], json!({}));
    assert_eq!(
        answered(listed)["result"]["structuredContent"]["data"]["agents"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
}

/// Requested screen lines are complete and inline in both Shell and MCP, above the former file
/// threshold. Read Screen can still read the saved screen after the agent has stopped.
#[test]
fn a_long_screen_is_complete_and_inline() {
    let empty = TestHome::new("mcp-screen-empty");
    for count in ["0", "2001", "-1"] {
        let refused = empty.run_facade(&["screen", "a1", "--lines", count]);
        assert_eq!(refused.status.code(), Some(2), "{}", stderr(&refused));
        assert!(stdout(&refused).is_empty());
        assert!(stderr(&refused).contains("must be between 1 and 2,000"));
        assert!(!socket_exists(&empty.daemon_socket()) && empty.processes().is_empty());
    }
    let home = TestHome::new("mcp-screen-inline");
    let screen_file = home.folder().join("initial-screen.txt");
    let expected = (1..=120)
        .map(|line| format!("line {line:03} [{}]", "x".repeat(62)))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(expected.chars().count() > 8_000);
    std::fs::write(&screen_file, &expected).unwrap();
    let target = home.start_named_fake(
        "long",
        &[("FAKECLI_SCREEN_FILE", screen_file.to_str().unwrap())],
    );
    let observer = home.start_named_fake("observer", &[]);
    let unrelated = home.start_named_fake("unrelated", &[]);
    let mut reader = McpTestClient::open_configured(&home, &observer.id);
    let read = reader.call(
        "read_screen",
        json!({ "agent": target.address, "lines": 200 }),
    );
    assert_eq!(read["status"], "success", "{read}");
    let data = &read["data"];
    assert_eq!(data["address"], target.address, "{read}");
    assert_eq!(data["agent_id"], target.id, "{read}");
    assert!(data.get("file").is_none() && data.get("next_cursor").is_none());
    let text = data["text"].as_str().expect("inline screen text");
    assert!(
        facade_base::model::terminal::plain(text).contains(&expected),
        "the screen must include all 120 output lines in order"
    );

    let shorter = reader.call("read_screen", json!({ "agent": "long", "lines": 4 }));
    assert_eq!(shorter["status"], "success", "{shorter}");
    let tail = shorter["data"]["text"]
        .as_str()
        .expect("inline screen minimum");
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(tail, lines[lines.len() - 4..].join("\n"));
    assert_eq!(shorter["data"]["line_count"], 4, "{shorter}");
    assert!(shorter["data"].get("next_cursor").is_none());
    let reference = home.inspect_agent(&target.address)["agent"]["reference"].clone();
    let wire = connect(&home).call_ok("agent.screen", json!({ "target": reference, "lines": 4 }));
    assert_eq!(wire["reference"], reference, "{wire}");
    assert_eq!(wire["line_count"], 4, "{wire}");
    assert_eq!(wire["text"], tail, "{wire}");
    assert_eq!(
        home.run_facade_ok(&["screen", &target.address, "--lines", "4"]),
        facade_base::model::terminal::plain(tail)
    );

    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    assert_eq!(guest.call("list_agents", json!({}))["status"], "success");
    let roster = home.agent_list();
    let guests: Vec<&Value> = roster["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|agent| agent["type"] == "guest")
        .collect();
    assert_eq!(guests.len(), 1, "{guests:?}");
    let guest_address = guests[0]["address"].as_str().unwrap();
    let no_terminal = reader.call("read_screen", json!({ "agent": guest_address }));
    assert_eq!(no_terminal["status"], "failure", "{no_terminal}");
    assert_eq!(no_terminal["reason"], "unsupported", "{no_terminal}");
    assert!(
        no_terminal["message"]
            .as_str()
            .unwrap()
            .contains("Guest without a terminal"),
        "{no_terminal}"
    );

    let stopped = reader.call("stop_agent", json!({ "agent": target.address }));
    assert_eq!(stopped["status"], "success", "{stopped}");
    assert_eq!(
        stopped["data"],
        json!({ "id": target.address, "state": "ended" })
    );
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&target.process)));
    for other in [&observer, &unrelated] {
        let live = home.inspect_agent(&other.address);
        assert_eq!(live["agent"]["pid"], other.pid, "{live}");
        assert_eq!(live["agent"]["process"], "running", "{live}");
        assert_eq!(process_identity(other.pid), other.process);
    }
    let after = reader.call("read_screen", json!({ "agent": "long", "lines": 200 }));
    assert_eq!(after["status"], "success", "{after}");
    assert!(
        facade_base::model::terminal::plain(after["data"]["text"].as_str().unwrap())
            .contains(&expected),
        "the stopped agent retains the output"
    );
    let screen = connect(&home).call_ok("agent.screen", json!({ "target": "long", "lines": 200 }));
    assert_eq!(screen["text"], after["data"]["text"]);
    let shell = home.run_facade_ok(&["screen", "long", "--lines", "200"]);
    assert_eq!(
        shell,
        facade_base::model::terminal::plain(screen["text"].as_str().unwrap())
    );

    let address = after["data"]["address"].as_str().expect("an agent address");
    for (tool, args) in [
        ("stop_agent", json!({ "agent": address })),
        (
            "type_text",
            json!({ "agent": address, "text": "late input" }),
        ),
        ("press_keys", json!({ "agent": address, "keys": ["Enter"] })),
    ] {
        let denied = reader.call(tool, args);
        assert_eq!(denied["status"], "failure", "{tool}: {denied}");
        assert_eq!(denied["reason"], "ended", "{tool}: {denied}");
        assert!(denied["message"].as_str().unwrap().contains(address));
    }
}

/// A stop whose exit is not seen within the daemon's stop wait says the termination is unconfirmed:
/// the stop went out and goes on. The final screen remains available after it leaves the roster.
#[test]
fn a_stop_that_runs_out_of_time_says_its_termination_is_unconfirmed() {
    let home = TestHome::new("mcpstopwait");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-exit-reaches-agent")]);
    let ada = home.start_named_fake("ada", &[]);
    home.start_named_fake("helper", &[]);
    let mut ada = McpTestClient::open_configured(&home, &ada.id);
    let stopped = ada.call("stop_agent", json!({ "agent": "helper" }));
    assert_eq!(stopped["status"], "failure", "{stopped}");
    assert_eq!(stopped["reason"], "unavailable", "{stopped}");
    let message = stopped["message"].as_str().expect("a stop diagnostic");
    assert!(
        message.contains("did not end within the 10-second stop wait"),
        "{stopped}"
    );
    assert!(!message.contains("list_agents"), "{stopped}");
    home.release_gate("before-exit-reaches-agent");
    let ended = || {
        home.agent_from_watch("helper")
            .is_some_and(|agent| agent["process"] == "ended")
    };
    assert!(wait_until(secs(10), ended), "the stop went on");
    let after = ada.call("read_screen", json!({ "agent": "helper" }));
    assert_eq!(after["status"], "success", "{after}");
    assert_eq!(after["data"]["process"], "ended", "{after}");
}

/// A daemon that starts deletes the result files no one can use any more: a file of messages once
/// the first message in it is no longer kept, or whose name gives no message, and files of screens
/// older than thirty days. Other files stay.
#[test]
fn a_starting_daemon_deletes_result_files_no_one_can_use() {
    let home = TestHome::new("mcpcleanup");
    connect(&home);
    home.wait_for_idle_exit();
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    connection
        .execute(
            "INSERT INTO messages (number, \"from\", \"to\", text, at, status, text_written) \
             VALUES (1, 'human', 'a1', 'hi', ?1, 'failure', 'none')",
            [facade_base::time::iso_now()],
        )
        .unwrap();
    drop(connection);
    let results = home.path.join("core/results");
    facade_base::files::create_private_folder_all(&results).unwrap();
    let month = std::time::Duration::from_secs(31 * 24 * 60 * 60);
    for (name, age) in [
        (
            "messages-20261111T000000000Z-1-0.txt",
            std::time::Duration::ZERO,
        ),
        ("messages-m1-20261111T000000000Z-1-1.txt", month),
        (
            "messages-m9-20261111T000000000Z-1-2.txt",
            std::time::Duration::ZERO,
        ),
        ("screen-20261010T000000000Z-1-0.json", month),
        (
            "screen-20261111T000000000Z-1-1.json",
            std::time::Duration::ZERO,
        ),
        ("notes.txt", month),
    ] {
        std::fs::write(results.join(name), "x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(results.join(name))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - age)
            .unwrap();
    }
    connect(&home);
    let mut left: Vec<String> = std::fs::read_dir(&results)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort_unstable();
    assert_eq!(
        left,
        [
            "messages-m1-20261111T000000000Z-1-1.txt",
            "notes.txt",
            "screen-20261111T000000000Z-1-1.json"
        ],
        "a file of messages goes with its first message, whatever its age"
    );
}

/// A CLI started by its rule is given Facade's tools: the test CLI runs facade-mcp, whose
/// connection makes them available, and the run has a folder of its own. Once that server ends
/// while the CLI goes on, the tools are unavailable and the agent is an error, saying why.
#[test]
fn a_cli_started_by_its_rule_gets_facade_s_tools_while_their_server_is_connected() {
    let home = TestHome::new("mcpwired");
    std::fs::write(home.path.join("facade.json"), r#"{"yolo":true}"#).unwrap();
    let ada = home.start_named_fake("ada", &[]);
    let bob = home.start_named_fake("bob", &[]);
    let row = || home.agent_record(&ada.id).unwrap();
    assert!(
        wait_until(secs(10), || row()["tools_state"] == "available"),
        "{}",
        row()
    );
    assert_eq!(
        std::fs::read_dir(home.path.join("core/runs").join(&ada.id))
            .unwrap()
            .count(),
        1,
        "a folder for the run"
    );
    let mut bob = McpTestClient::open_configured(&home, &bob.id);
    home.run_facade_ok(&["type", "ada", "/fake mcp stop", "--enter"]);
    assert!(
        wait_until(secs(10), || row()["tools_state"] == "unavailable"),
        "{}",
        row()
    );
    let row = row();
    assert_eq!(
        (&row["tools_reason"], &row["state"], &row["state_detail"]),
        (
            &json!("disconnected"),
            &json!("error"),
            &json!({ "reason": "tools_unavailable" })
        )
    );
    let roster = bob.call("list_agents", json!({}));
    let listed = roster["data"]["agents"]
        .as_array()
        .expect("the MCP roster")
        .iter()
        .find(|row| row["id"] == ada.address)
        .expect("Ada remains listed while her process runs");
    assert_eq!(listed["state"], "error", "{roster}");
}

/// A prompt given to `facade start claude` stays its prompt: Claude Code's `--mcp-config` and
/// `--allowedTools` take every value up to the next option, so an option that takes one value comes
/// between them and the person's words.
#[test]
fn a_prompt_given_to_claude_stays_its_prompt() {
    let home = TestHome::new("claudeprompt");
    let folder = home.project.parent().unwrap().to_path_buf();
    let (bin, argv) = (folder.join("bin"), folder.join("argv"));
    stand_in(&bin, "claude", &argv);
    let path = format!("{}{PATH_SEPARATOR}{}", bin.display(), SYSTEM_PATH.as_str());
    let started = home
        .facade_in_an_empty_home()
        .env("PATH", &path)
        .args(["start", "-d", "claude", "fix the bug"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let args = arguments(&argv);
    let at = args
        .iter()
        .position(|arg| arg == "--allowedTools")
        .unwrap_or_else(|| panic!("{args:?}"));
    assert_eq!(args[at + 1], "mcp__facade", "{args:?}");
    assert!(
        args[at + 2].starts_with('-'),
        "the next word is an option: {args:?}"
    );
    assert_eq!(
        args.last().map(String::as_str),
        Some("fix the bug"),
        "{args:?}"
    );
}

/// A terminal client's start through Facade API v1 gives the agent its first message once its
/// CLI's tools connected, however long after the start that is, as its time to be delivered counts
/// from then: the person's words under a header naming them, as `facade send` sends them, and what
/// was last said to the agent.
#[test]
fn a_start_prompt_is_the_agent_s_first_message_once_its_tools_connected() {
    let home = TestHome::new("startprompt");
    let started = home.start_with_prompt(
        "ada",
        "fake",
        "say hi",
        &[("FAKECLI_MCP_DELAY_MS", "32000")],
    );
    assert!(started["result"].is_object(), "{started}");
    // The CLI starts its Facade server 32 seconds after its own start, past the 29.5 seconds a
    // message has to be delivered: the CLI shows its empty input while its tools connect.
    assert!(
        wait_until(secs(30), || home.screen("ada").contains("❯")),
        "{}",
        home.screen("ada")
    );
    std::thread::sleep(secs(25));
    assert_eq!(
        home.agent_from_watch("ada").unwrap()["tools_state"],
        "connecting"
    );
    assert_eq!(
        home.submitted_messages(),
        Vec::<String>::new(),
        "the prompt waits for the tools"
    );
    assert!(
        wait_until(secs(30), || !home.submitted_messages().is_empty()),
        "{}",
        home.screen("ada")
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from the command line · m1\nsay hi"]
    );
    // What was said is recorded once the daemon has seen the CLI take the prompt, a moment after
    // the CLI logs it.
    let said = || {
        home.agent_from_watch("ada")
            .is_some_and(|row| row["said"]["text"] == "say hi")
    };
    assert!(
        wait_until(secs(10), said),
        "{:?}",
        home.agent_from_watch("ada")
    );
    let row = home.agent_from_watch("ada").unwrap();
    assert_eq!(
        (
            &row["tools_state"],
            &row["said"]["text"],
            &row["said"]["from"]
        ),
        (
            &json!("available"),
            &json!("say hi"),
            &json!("command_line")
        ),
        "{row}"
    );
    assert!(
        wait_until(secs(10), || home
            .daemon_log()
            .contains("#a1's start prompt, m1, was delivered")),
        "{}",
        home.daemon_log()
    );
}

/// A CLI's tools connect once its Facade server answered the CLI's `tools/list`, not its
/// `initialize`: while that answer is held, the tools read `connecting` and a start's prompt waits,
/// though the server answered `initialize`, which reads where the agent works.
#[test]
fn the_tools_connect_once_the_cli_has_asked_for_them() {
    let home = TestHome::new("toolslisted");
    home.start_facade_with(&[("FACADE_TEST_GATES", "mcp-before-tools-list")]);
    let started = home.start_with_prompt("ada", "fake", "say hi", &[]);
    assert!(started["result"].is_object(), "{started}");
    home.wait_for_gate("mcp-before-tools-list");
    assert!(
        wait_until(secs(30), || home.screen("ada").contains("❯")),
        "{}",
        home.screen("ada")
    );
    std::thread::sleep(secs(2));
    assert_eq!(
        home.agent_from_watch("ada").unwrap()["tools_state"],
        "connecting"
    );
    assert_eq!(
        home.submitted_messages(),
        Vec::<String>::new(),
        "the prompt waits for the tools"
    );
    home.release_gate("mcp-before-tools-list");
    assert!(
        wait_until(secs(30), || !home.submitted_messages().is_empty()),
        "{}",
        home.screen("ada")
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from the command line · m1\nsay hi"]
    );
    assert_eq!(
        home.agent_from_watch("ada").unwrap()["tools_state"],
        "available"
    );
}

/// Shell commands from an agent's terminal still act for the command line, whether starting
/// an agent or sending it a message.
#[test]
fn a_start_and_send_from_an_agent_s_terminal_come_from_the_command_line() {
    let home = TestHome::new("startpromptfrom");
    let mut wire = connect(&home);
    let (facade, path, log) = (
        test_binaries().facade.display().to_string(),
        home.path_with_test_programs(),
        home.fake_log.display().to_string(),
    );
    let script = format!(
        "FAKECLI_LOG='{log}' PATH='{path}' '{facade}' start -d --name child fake </dev/null && \
         '{facade}' send child 'from the boss' </dev/null; sleep 60"
    );
    let boss = start_script(&mut wire, &home, "boss", &script);
    assert!(
        wait_until(secs(30), || !home.submitted_messages().is_empty()),
        "{}",
        home.screen(&boss)
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from the command line · m1\nfrom the boss"]
    );
    let child = wire.call("agent.inspect", json!({ "target": "child" }));
    assert_eq!(
        child["result"]["started_by"],
        json!({ "kind": "command_line" }),
        "{child}"
    );
}

/// A prompt that could not be sent is refused before anything starts: one a message could not
/// carry, as one of more than 540 lines, and one for a custom program whose input Facade cannot
/// read.
#[test]
fn a_start_prompt_that_could_not_be_sent_starts_nothing() {
    let home = TestHome::new("startpromptrefused");
    let lines = vec!["a line"; 600].join("\n");
    home.add_custom_cli("script", std::path::Path::new(SH.as_str()));
    for (prompt, cli, said) in [
        (
            "  ",
            "fake",
            "the prompt cannot go as a message: text is blank",
        ),
        (
            "hi",
            "script",
            "script is a custom program and cannot receive a prompt",
        ),
        (
            lines.as_str(),
            "fake",
            "the prompt cannot go as a message: text has 600 lines; a message carries at most 540",
        ),
    ] {
        let refused = home.start_with_prompt("never-started", cli, prompt, &[]);
        let diagnostic = refused["error"]["message"].as_str().unwrap_or_default();
        assert!(diagnostic.contains(said), "{cli}: {refused}");
    }
    assert_eq!(home.agents(), Vec::<Value>::new(), "nothing started");
}

/// A managed relay can initialize while the keeper's response is held. Once the run is installed
/// and tools/list completes, the same run has working tools.
#[test]
fn a_server_started_before_its_agent_is_listed_serves_the_installed_run() {
    let home = TestHome::new("mcpearly");
    home.start_facade_with(&[(
        "FACADE_TEST_GATES",
        "after-run-start-response,mcp-before-tools-list",
    )]);
    let mut start = home
        .command(&test_binaries().facade)
        .env("PATH", home.path_with_test_programs())
        .args(["start", "-d", "--name", "ada", "fake"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    home.wait_for_gate("after-run-start-response");
    home.wait_for_gate("mcp-before-tools-list");
    home.release_gate("after-run-start-response");
    assert!(start.wait().unwrap().success());
    assert_eq!(
        home.agent_from_watch("ada").unwrap()["tools_state"],
        "connecting"
    );
    home.release_gate("mcp-before-tools-list");
    let tools = || home.agent_from_watch("ada").unwrap()["tools_state"].clone();
    assert!(
        wait_until(secs(10), || tools() == "available"),
        "{}",
        tools()
    );
}

/// A `facade` command acting for an agent sends its own environment: only a start from an agent's
/// Facade server takes that agent's. A command in a shell agent's terminal, whose environment macOS
/// would hide, starts an agent with a variable of its own.
#[test]
fn a_facade_command_in_an_agent_s_terminal_starts_with_its_own_environment() {
    let home = TestHome::new("terminalenv");
    let mut wire = connect(&home);
    let facade = test_binaries().facade.display().to_string();
    let path = home.path_with_test_programs();
    let script = format!(
        "PATH='{path}' FAKECLI_NAME='named by the command' '{facade}' start -d --name child fake \
         </dev/null; sleep 60"
    );
    let shell = start_script(&mut wire, &home, "shell", &script);
    assert!(
        wait_until(secs(30), || home.listed_agent("child").is_some()),
        "{}",
        home.screen(&shell)
    );
    assert!(
        wait_until(secs(30), || home
            .screen("child")
            .contains("named by the command (Facade test CLI)")),
        "{}",
        home.screen("child")
    );
}

/// A Muse Code run gets Facade's server by `-c` for the run alone, with a hook that gives the model
/// its instructions, unless a project MCP file it reads names a `facade` server, beside which Muse
/// Code would refuse to run: then it starts without the tools, and the file stays as it is. A
/// stand-in `muse` keeps its arguments.
#[test]
fn a_muse_code_run_gets_its_server_by_c_unless_its_project_names_one() {
    let home = TestHome::new("museserver");
    let folder = home.project.parent().unwrap().to_path_buf();
    let argv = folder.join("argv");
    stand_in(&folder.join("bin"), "muse", &argv);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        folder.join("bin").display(),
        SYSTEM_PATH.as_str()
    );
    let start = |name: &str| {
        let started = home
            .facade_in_an_empty_home()
            .env("PATH", &path)
            .args(["start", "-d", "--name", name, "muse"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{}", stderr(&started));
        arguments(&argv)
    };
    let given = |args: &[String], key: &str| {
        args.iter().find_map(|arg| {
            arg.strip_prefix(&format!("{key}="))
                .map(|value| serde_json::from_str::<Value>(value).unwrap())
        })
    };
    let ada = start("ada");
    let server = given(&ada, "mcpServers.facade").unwrap_or_else(|| panic!("{ada:?}"));
    assert_eq!(server["mode"], "optional", "{server}");
    assert_eq!(server["env"], json!({ "FACADE_HOME": "${FACADE_HOME}" }));
    let args = server["args"]
        .as_array()
        .expect("the managed relay arguments");
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], facade_rules::RUN_CREDENTIAL_ARG);
    assert!(
        args[1]
            .as_str()
            .is_some_and(|credential| !credential.is_empty())
    );
    let hook = given(&ada, "hooks").unwrap();
    // On Windows the command is encoded PowerShell, its script `& '…' 'hook' 'instructions' 'muse'`.
    let command = hook["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    #[cfg(windows)]
    let command = powershell_script(command).unwrap_or_default();
    assert!(
        command.ends_with("hook instructions muse")
            || command.ends_with("'hook' 'instructions' 'muse'; exit $LASTEXITCODE"),
        "{hook}"
    );
    assert_eq!(
        home.agent_from_watch("ada").unwrap()["tools_state"],
        "connecting"
    );

    let mine = r#"{ "mcpServers": { "facade": { "command": "mine" } } }"#;
    std::fs::write(home.project.join(".mcp.json"), mine).unwrap();
    let bob = start("bob");
    assert!(given(&bob, "mcpServers.facade").is_none(), "{bob:?}");
    // Its session is reported all the same: the run's session hook alone, without the tools' hooks.
    let hooks = given(&bob, "hooks").unwrap_or_else(|| panic!("{bob:?}"));
    assert_eq!(
        hooks.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["SessionStart"],
        "{hooks}"
    );
    let command = hooks["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    #[cfg(windows)]
    let command = powershell_script(command).unwrap_or_default();
    assert!(
        command.contains(" hook session-start ") || command.contains(" 'hook' 'session-start' "),
        "{hooks}"
    );
    let row = home.agent_from_watch("bob").unwrap();
    assert_eq!(
        (&row["tools_state"], &row["tools_reason"]),
        (&json!("unavailable"), &json!("not_given")),
        "{row}"
    );
    assert_eq!(
        std::fs::read_to_string(home.project.join(".mcp.json")).unwrap(),
        mine
    );
}

/// A daemon that starts again lets go of the plugin of a folder whose Antigravity runs ended while
/// no daemon ran.
#[test]
fn a_daemon_that_starts_again_lets_go_of_a_plugin_whose_runs_ended_meanwhile() {
    let home = TestHome::new("agyrecover");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let started = home
        .facade_in_an_empty_home()
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .args(["start", "-d", "--name", "ada", "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let plugin = home.project.join(".agents/plugins/facade");
    assert!(plugin.join("mcp_config.json").exists());
    let pid = home.agent_from_watch("ada").unwrap()["pid"]
        .as_i64()
        .unwrap() as i32;
    let old = home.kill_daemon();
    let cli = process_identity(pid);
    kill_process(pid);
    assert!(wait_until(secs(10), || !alive(&cli)), "the CLI ended");
    home.run_facade_ok(&["list"]);
    home.wait_for_daemon_after(old, secs(10))
        .expect("a daemon started again");
    assert!(
        wait_until(secs(10), || !home.project.join(".agents").exists()),
        "the plugin goes"
    );
}

/// A daemon that starts again lets go of the plugin of a folder whose Antigravity run ended while
/// the daemon before it could not let go of it: that daemon ended between the run's end and its
/// letting go.
#[test]
fn a_daemon_that_starts_again_lets_go_of_a_plugin_its_predecessor_kept() {
    let home = TestHome::new("agyleftover");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-plugin-let-go")]);
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let started = home
        .facade_in_an_empty_home()
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .args(["start", "-d", "--name", "ada", "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    assert!(
        home.project
            .join(".agents/plugins/facade/mcp_config.json")
            .exists()
    );
    home.run_facade_ok(&["stop", "ada"]);
    home.wait_for_gate("before-plugin-let-go");
    let old = home.kill_daemon();
    home.run_facade_ok(&["list"]);
    home.wait_for_daemon_after(old, secs(10))
        .expect("a daemon started again");
    assert!(
        wait_until(secs(10), || !home.project.join(".agents").exists()),
        "the plugin goes"
    );
}

/// An Antigravity run gets Facade's plugin in the folder it starts in, the only file Facade writes
/// into the person's project, and its start readies the tools through the CLI's MCP panel before
/// its first turn. The plugin's hook gives the model its instructions, and the plugin holds the
/// skill; the runs in a folder share the plugin, and it goes once the last of them ends. A plugin
/// of the person's own there is left as it is, and the run starts without the tools. The test CLI
/// draws Antigravity's screen.
#[test]
fn an_antigravity_run_gets_the_plugin_and_readies_its_tools_before_its_first_turn() {
    let home = TestHome::new("agyplugin");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let start = |name: &str| {
        let mut command = home.facade_in_an_empty_home();
        let started = command
            .env("PATH", &path)
            .env("FAKECLI_LOOK", "agy")
            .args(["start", "-d", "--name", name, "agy"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{}", stderr(&started));
    };
    let row = |name: &str| home.agent_from_watch(name).unwrap();
    let plugin = home.project.join(".agents/plugins/facade");
    start("ada");
    let mut files: Vec<String> = std::fs::read_dir(&plugin)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort_unstable();
    assert_eq!(
        files,
        ["hooks.json", "mcp_config.json", "plugin.json", "skills"]
    );
    assert_eq!(
        std::fs::read_to_string(plugin.join("skills/facade/SKILL.md")).unwrap(),
        facade_base::skill::text(),
        "and the skill"
    );
    let servers: Value =
        serde_json::from_str(&std::fs::read_to_string(plugin.join("mcp_config.json")).unwrap())
            .unwrap();
    let launcher = home
        .path
        .join("core")
        .join("bin")
        .join(program_name("facade-mcp"))
        .display()
        .to_string();
    let entry = &servers["mcpServers"]["facade"];
    #[cfg(windows)]
    {
        assert_eq!(entry["command"], "powershell.exe");
        let line = format!(
            "powershell.exe {}",
            entry["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(" ")
        );
        let script = powershell_script(&line).expect("the plugin's launcher script");
        assert!(script.contains(&launcher), "the plugin names the launcher");
        assert!(
            script.contains(facade_rules::RUN_CREDENTIAL_ARG),
            "{script}"
        );
    }
    #[cfg(unix)]
    {
        assert_eq!(entry["command"], "/bin/sh");
        assert_eq!(entry["args"][3], launcher);
        assert!(
            entry["args"][1]
                .as_str()
                .unwrap()
                .contains(facade_rules::RUN_CREDENTIAL_ARG)
        );
    }
    let hooks: Value =
        serde_json::from_str(&std::fs::read_to_string(plugin.join("hooks.json")).unwrap()).unwrap();
    let hook = hooks["facade"]["PreInvocation"][0]["command"]
        .as_str()
        .unwrap_or_default();
    // Quoted for sh on Unix ('…'), and for cmd.exe on Windows (@"…").
    let program = hook.strip_suffix(" hook instructions agy").map(|program| {
        program
            .trim_start_matches('@')
            .trim_matches('"')
            .trim_matches('\'')
    });
    assert_eq!(
        program,
        Some(
            home.path
                .join("core")
                .join("bin")
                .join(program_name("facade"))
                .display()
                .to_string()
                .as_str()
        ),
        "and its hook: {hook}"
    );
    assert!(
        wait_until(secs(15), || row("ada")["tools_state"] == "available"),
        "{}",
        row("ada")
    );
    assert!(
        home.submitted_messages()
            .iter()
            .any(|message| message == "/mcp"),
        "the start opened the panel"
    );
    let mut wire = connect(&home);
    let mut input =
        || wire.call("agent.inspect", json!({ "target": "ada" }))["result"]["input"].clone();
    assert!(
        wait_until(secs(15), || input()["state"] == "usable"),
        "the panel closed: {} {}",
        input(),
        home.screen("ada")
    );
    home.run_facade_ok(&["send", "ada", "hello"]);
    // The hook says where the agent works, as facade-mcp's instructions say it to the other CLIs.
    let address = row("ada")["address"].as_str().unwrap().to_owned();
    let instructions = |messages: Vec<String>| {
        messages.iter().any(|message| {
            message.starts_with("PreInvocation ")
                && message.contains(&format!("You are managed agent {address}, working in "))
        })
    };
    assert!(
        wait_until(secs(10), || instructions(home.submitted_messages())),
        "{:?}",
        home.submitted_messages()
    );

    start("bob");
    home.run_facade_ok(&["stop", "ada"]);
    assert!(plugin.join("mcp_config.json").exists(), "bob's run uses it");
    home.run_facade_ok(&["stop", "bob"]);
    assert!(
        wait_until(secs(10), || !home.project.join(".agents").exists()),
        "the plugin goes with the folder's last run"
    );

    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("plugin.json"), r#"{"name":"mine"}"#).unwrap();
    start("carol");
    let carol = row("carol");
    assert_eq!(
        (&carol["tools_state"], &carol["tools_reason"]),
        (&json!("unavailable"), &json!("not_given")),
        "{carol}"
    );
    assert_eq!(
        std::fs::read_to_string(plugin.join("plugin.json")).unwrap(),
        r#"{"name":"mine"}"#
    );
    assert_eq!(
        std::fs::read_dir(&plugin).unwrap().count(),
        1,
        "nothing written beside it"
    );
}

/// An Antigravity run's first turn has Facade's tools. Keys the person types in an attached
/// terminal while the start readies them, through a panel that shows them ready two seconds late,
/// wait until that is done, then go in.
#[test]
fn keys_typed_while_an_antigravity_start_readies_its_tools_wait_for_it() {
    let home = TestHome::new("agyhold");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let mut command = home.facade_in_an_empty_home();
    command
        .env("PATH", &path)
        .env("FAKECLI_LOOK", "agy")
        .env("FAKECLI_PANEL_DELAY_MS", "2000");
    let started = command
        .args(["start", "-d", "--name", "ada", "agy"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let term = TestTerminal::spawn(
        home.command(&test_binaries().facade)
            .args(["attach", "ada"]),
        80,
        24,
    );
    term.send(b"hello\r");
    assert!(
        wait_until(secs(30), || home
            .submitted_messages()
            .iter()
            .any(|message| message == "hello")),
        "{:?}",
        home.submitted_messages()
    );
    let messages = home.submitted_messages();
    assert_eq!(
        messages.first().map(String::as_str),
        Some("/mcp"),
        "the start went first: {messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|message| message == "turn without Facade's server"),
        "the first turn had the tools: {messages:?}"
    );
    assert!(
        wait_until(
            secs(10),
            || home.agent_from_watch("ada").unwrap()["tools_state"] == "available"
        ),
        "{}",
        home.agent_from_watch("ada").unwrap()
    );
}

/// A start prompt to Antigravity goes once its start readied its tools, through a panel that shows
/// them ready two seconds late, so that the prompt's turn has them.
#[test]
fn a_start_prompt_to_antigravity_goes_once_its_tools_are_ready() {
    let home = TestHome::new("agyprompt");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    install_program(&programs, "agy", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let started = home.start_with_prompt(
        "ada",
        "agy",
        "say hi",
        &[
            ("PATH", &path),
            ("FAKECLI_LOOK", "agy"),
            ("FAKECLI_PANEL_DELAY_MS", "2000"),
        ],
    );
    assert!(started["result"].is_object(), "{started}");
    let prompt = "📨 Message from the command line · m1\nsay hi";
    assert!(
        wait_until(secs(30), || home
            .submitted_messages()
            .iter()
            .any(|message| message == prompt)),
        "{:?}",
        home.submitted_messages()
    );
    let messages = home.submitted_messages();
    assert_eq!(
        messages.first().map(String::as_str),
        Some("/mcp"),
        "the start readied the tools first: {messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|message| message == "turn without Facade's server"),
        "the prompt's turn had the tools: {messages:?}"
    );
}

/// Runs `facade hook <hook> <cli>` as the CLI's hook would, with `input` on standard input and the
/// variables `env`, and returns what it printed.
fn run_hook(home: &TestHome, hook: &str, cli: &str, input: &str, env: &[(&str, &str)]) -> String {
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", hook, cli])
        .env_remove("MUSE_SESSION_ID")
        .envs(env.iter().copied());
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success() && output.stderr.is_empty(),
        "{output:?}"
    );
    String::from_utf8(output.stdout).unwrap()
}

/// The hook that gives the model of a CLI that shows it no server's instructions those its run's
/// start wrote in the run's folder: Muse Code's to the session the run starts alone, not to one a
/// subagent starts, followed by the skill there, and Antigravity's to each invocation, whose plugin
/// holds the skill. Outside an agent's run, or without its run's files, it gives none.
#[test]
fn the_instructions_hook_gives_the_run_s_own_session_its_agent_s_instructions() {
    let home = TestHome::new("instructionshook");
    let starts =
        |session: &str| format!(r#"{{"hook_event_name":"SessionStart","session_id":"{session}"}}"#);
    let run = [("FACADE_AGENT", "a3"), ("MUSE_SESSION_ID", "s1")];
    assert_eq!(
        run_hook(&home, "instructions", "muse", &starts("s1"), &run),
        "",
        "no files of the run's"
    );
    // The run's folder, as its start wrote it.
    let folder = home.path.join("core/runs/a3/5a1f00d1c0ffee00");
    std::fs::create_dir_all(folder.join("skills/facade")).unwrap();
    let (instructions, skill) = (
        "You are Facade agent #a3, as your run began.",
        "The skill of the build that started the run.",
    );
    std::fs::write(folder.join("instructions.md"), instructions).unwrap();
    std::fs::write(folder.join("skills/facade/SKILL.md"), skill).unwrap();
    let given: Value = serde_json::from_str(&run_hook(
        &home,
        "instructions",
        "muse",
        &starts("s1"),
        &run,
    ))
    .unwrap();
    assert_eq!(
        given["hookSpecificOutput"]["hookEventName"], "SessionStart",
        "{given}"
    );
    assert_eq!(
        given["hookSpecificOutput"]["additionalContext"],
        format!("{instructions}\n\n{skill}"),
        "the instructions, then the skill"
    );
    for (input, env) in [
        (starts("s2"), &run[..]),
        (starts("s1"), &run[1..]),
        (
            r#"{"hook_event_name":"Stop","session_id":"s1"}"#.to_string(),
            &run[..],
        ),
        ("{not json".to_string(), &run[..]),
    ] {
        assert_eq!(
            run_hook(&home, "instructions", "muse", &input, env),
            "",
            "{input} {env:?}"
        );
    }
    let given: Value =
        serde_json::from_str(&run_hook(&home, "instructions", "agy", "{}", &run[..1])).unwrap();
    assert_eq!(
        given["injectSteps"][0]["ephemeralMessage"], instructions,
        "the instructions alone"
    );
    assert_eq!(run_hook(&home, "instructions", "agy", "{}", &[]), "{}");
}

/// The instructions Muse Code's and Antigravity's runs take from their hook, which their start
/// wrote, say where the run's agent works, as facade-mcp's instructions say it to the other CLIs:
/// its folder, machine, creator and the reach of its YOLO setting.
#[test]
fn the_instructions_hook_says_where_the_run_s_agent_works() {
    let home = TestHome::new("instructionsplace");
    let programs = home.project.parent().unwrap().join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        programs.display(),
        home.path_with_test_programs()
    );
    let starts = r#"{"hook_event_name":"SessionStart","session_id":"s1"}"#;
    for cli in ["muse", "agy"] {
        install_program(&programs, cli, &test_binaries().fakecli);
        let mut command = home.facade_in_an_empty_home();
        match cli {
            "agy" => command.env("FAKECLI_LOOK", "agy"),
            _ => command.env(
                "FAKECLI_MCP",
                home.path
                    .join("core")
                    .join("bin")
                    .join(program_name("facade-mcp")),
            ),
        };
        let started = command
            .env("PATH", &path)
            .args(["start", "-d", "--name", cli, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(started.status.success(), "{cli}: {}", stderr(&started));
        let record = home.agent_from_watch(cli).expect("the agent is listed");
        let id = record["reference"]["agent_id"].as_str().unwrap();
        let address = record["address"].as_str().unwrap();
        let (_, machine) = address.split_once('@').expect("a complete address");
        let place = format!(
            "You are managed agent {address}, working in {} on machine {machine}.",
            record["cwd"].as_str().unwrap(),
        );
        let run = [("FACADE_AGENT", id), ("MUSE_SESSION_ID", "s1")];
        let given: Value = serde_json::from_str(&run_hook(
            &home,
            "instructions",
            cli,
            if cli == "muse" { starts } else { "{}" },
            &run,
        ))
        .unwrap();
        let told = given["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .or(given["injectSteps"][0]["ephemeralMessage"].as_str())
            .unwrap_or_default();
        let started_by = format!("{place} You were started from the command line.");
        assert!(
            told.starts_with(&started_by)
                && told
                    .contains(" YOLO is on. Your tools reach agents on all reachable machines. "),
            "{cli}: {told}"
        );
    }
}

/// The hook that approves Facade's own tools where Muse Code would ask the person: a call of a tool
/// of Facade's server, with or without the run's variables, which Muse Code passes to no hook. Any
/// other tool is left to Muse Code.
#[test]
fn the_approve_hook_approves_facade_s_own_tools_alone() {
    let home = TestHome::new("approvehook");
    let asks = |tool: &str| {
        format!(
            r#"{{"hook_event_name":"PermissionRequest","session_id":"s1","tool_name":"{tool}","tool_input":{{}}}}"#
        )
    };
    let run = [("FACADE_AGENT", "a3")];
    let allowed = json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" },
        },
    });
    for env in [&run[..], &[][..]] {
        let given: Value = serde_json::from_str(&run_hook(
            &home,
            "approve",
            "muse",
            &asks("mcp__facade__send_message"),
            env,
        ))
        .unwrap();
        assert_eq!(given, allowed, "{env:?}");
    }
    for (input, env) in [
        (asks("mcp__other__send_message"), &run[..]),
        (asks("shell"), &run[..]),
        (
            asks("mcp__facade__send_message").replace("PermissionRequest", "PreToolUse"),
            &run[..],
        ),
        ("{not json".to_string(), &[][..]),
    ] {
        assert_eq!(
            run_hook(&home, "approve", "muse", &input, env),
            "",
            "{input} {env:?}"
        );
    }
}

/// A daemon that replaces another finds the tools there again: the CLI's server connects to it at
/// once.
#[test]
fn a_daemon_that_replaces_another_finds_the_tools_there_again() {
    let home = TestHome::new("mcpreconnect");
    let agent = home.start_named_fake("ada", &[]);
    let started = std::time::Instant::now();
    let mut polls = Vec::new();
    let tools = |home: &TestHome, polls: &mut Vec<Value>, phase: &str| {
        let begin = reconnect_time(started);
        let record = home.agent_record(&agent.id).unwrap();
        let state = record["tools_state"].clone();
        polls.push(json!({ "phase": phase, "begin": begin,
            "end": reconnect_time(started), "record": record }));
        state
    };
    assert!(
        wait_until(secs(10), || tools(&home, &mut polls, "initial")
            == "available"),
        "{}",
        tools(&home, &mut polls, "initial failure value")
    );
    // This read precedes the kill; it is not the kill instant or proof of what recovery reads.
    let before_kill = reconnect_state(&home, &agent, started);
    let kill_begin = reconnect_time(started);
    let old = home.kill_daemon();
    let kill_end = reconnect_time(started);
    let replacement_begin = reconnect_time(started);
    let replacement = home
        .wait_for_daemon_after(old, secs(30))
        .expect("a replacement daemon");
    let replacement_end = reconnect_time(started);
    let available = wait_until(secs(10), || {
        tools(&home, &mut polls, "replacement") == "available"
    });
    if !available {
        // Freeze the original assertion's extra tools() read before any late diagnostic reads.
        let failure = format!("{}", tools(&home, &mut polls, "original failure value"));
        let diagnostic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reconnect_diagnostics(
                &home,
                &agent,
                started,
                json!({
                    "agent_id": agent.id, "agent_pid": agent.pid, "polls": polls,
                    "before_kill": before_kill,
                    "kill": { "begin": kill_begin, "end": kill_end, "returned_old_pid": old },
                    "replacement": { "begin": replacement_begin, "end": replacement_end,
                        "hello_returned_new_pid": replacement },
                    "original_failure": failure,
                    "limits": "pre-kill sampling window, not kill instant or recovery input; sampling affects scheduling; late inspect is current public state",
                }),
            );
        }));
        if diagnostic.is_err() {
            let _ = writeln!(
                std::io::stderr(),
                "MCP reconnect diagnostics unavailable: diagnostic panicked"
            );
        }
        assert!(available, "{failure}");
    }
}

/// UTC epoch and monotonic times share the case's origin, without a clock/hash dependency.
fn reconnect_time(started: std::time::Instant) -> Value {
    let utc = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(time) => json!(time.as_nanos().to_string()),
        Err(error) => json!({ "unavailable": error.to_string() }),
    };
    json!({ "utc_unix_ns": utc, "monotonic_elapsed_ns": started.elapsed().as_nanos().to_string() })
}

/// One open and one read of this agent's state, with metadata from that same handle. No default facts.
fn reconnect_state(home: &TestHome, agent: &TestAgent, started: std::time::Instant) -> Value {
    let begin = reconnect_time(started);
    let file = home.path.join("core/screens").join(&agent.id).join("state");
    let mut raw = Vec::new();
    let mut metadata = json!({ "unavailable": "state was not opened" });
    let error = match std::fs::File::open(&file) {
        Ok(mut handle) => {
            metadata = match handle.metadata() {
                Ok(metadata) => {
                    json!({ "len": metadata.len(), "handle_metadata": format!("{metadata:?}") })
                }
                Err(error) => json!({ "unavailable": error.to_string() }),
            };
            std::io::Read::read_to_end(&mut handle, &mut raw)
                .err()
                .map(|error| error.to_string())
        }
        Err(error) => Some(error.to_string()),
    };
    json!({ "file": file, "begin": begin, "end": reconnect_time(started),
        "metadata": metadata, "len": raw.len(), "raw_bytes": raw, "unavailable": error })
}

/// Only the reconnect case's second failed wait calls this; its original assertion still decides failure.
fn reconnect_diagnostics(
    home: &TestHome,
    agent: &TestAgent,
    started: std::time::Instant,
    mut evidence: Value,
) {
    evidence["diagnostic_begin"] = reconnect_time(started);
    let deadline = std::time::Instant::now() + secs(2);
    evidence["public"] = json!({ "hello": { "unavailable": "not connected" },
        "inspect": { "unavailable": "no successful diagnostic hello" } });
    if let Some(mut wire) = DaemonTestClient::try_open(home) {
        for (label, method, params) in [
            (
                "hello",
                "hello",
                json!({ "api_versions": DAEMON_API_VERSIONS, "build": "test", "kind": "terminal" }),
            ),
            (
                "inspect",
                "call",
                json!({ "op": "agent.inspect", "args": { "agent": agent.id } }),
            ),
        ] {
            let begin = reconnect_time(started);
            let response = if std::time::Instant::now() < deadline {
                wire.try_send(method, params).and_then(|id| {
                    wire.wait_for_response(
                        id,
                        deadline.saturating_duration_since(std::time::Instant::now()),
                    )
                })
            } else {
                None
            };
            let answered = response
                .as_ref()
                .is_some_and(|response| response.get("result").is_some());
            evidence["public"][label] = json!({ "begin": begin, "end": reconnect_time(started),
                "response": response.unwrap_or_else(|| json!({ "unavailable": "send failed or shared 2s response deadline expired" })) });
            if label == "hello" && !answered {
                break;
            }
        }
    }
    evidence["after_failure"] = reconnect_state(home, agent, started);
    for (label, file) in [
        ("daemon.log", home.path.join("core/logs/daemon.log")),
        ("keeper.log", home.path.join("core/logs/keeper.log")),
        ("fake.log", home.fake_log.clone()),
    ] {
        let begin = reconnect_time(started);
        evidence["logs"][label] = match std::fs::read_to_string(&file) {
            Ok(text) => {
                json!({ "file": file, "begin": begin, "end": reconnect_time(started), "text": text })
            }
            Err(error) => {
                json!({ "file": file, "begin": begin, "end": reconnect_time(started), "unavailable": error.to_string() })
            }
        };
    }
    evidence["diagnostic_end"] = reconnect_time(started);
    // TestHome::drop removes folder(), so its unique sibling survives without KEEP or other cases' data.
    let package = home.folder().with_file_name(format!(
        "{}-reconnect-diagnostics",
        home.folder().file_name().unwrap().to_string_lossy()
    ));
    evidence["package"] = json!(package);
    let output = format!("{evidence:#}");
    let write = std::fs::create_dir(&package)
        .and_then(|()| std::fs::write(package.join("diagnostics.json"), &output));
    if let Err(error) = write {
        let _ = writeln!(
            std::io::stderr(),
            "MCP reconnect diagnostic package unavailable: {error}"
        );
    }
    let _ = writeln!(
        std::io::stderr(),
        "MCP reconnect failure diagnostics:\n{output}"
    );
}

/// A start from facade-mcp gets its agent's environment, read from that agent's CLI, whatever the
/// CLI gives its MCP server: here nothing but FACADE_HOME and FACADE_AGENT. A creator whose
/// environment cannot be read starts nothing.
#[test]
fn an_agent_started_through_facade_mcp_gets_its_creator_s_environment() {
    let home = TestHome::new("mcpenv");
    let launches = home.folder().join("launches");
    let agent = home.start_named_fake(
        "boss",
        &[
            ("FAKECLI_NAME", "named by the boss"),
            ("FAKECLI_STARTS", launches.to_str().unwrap()),
        ],
    );
    let mut boss = McpTestClient::open_stripped(&home, &agent.id);
    let requested = home.folder().join("requested-folder");
    std::fs::create_dir(&requested).unwrap();
    let cwd = facade_base::files::real_path(&requested).unwrap();
    let start = |name: &str| json!({ "name": name, "cli": "fake", "folder": cwd });
    let started = boss.call("start_agent", start("helper"));
    assert_eq!(started["status"], "success", "{started}");
    let address = started["data"]["id"].as_str().expect("the child address");
    assert!(
        wait_until(secs(30), || home
            .screen(address)
            .contains("named by the boss (Facade test CLI)")),
        "{}",
        home.screen(address)
    );
    let child = home.inspect_agent(address)["agent"].clone();
    let parent = home.inspect_agent(&agent.address)["agent"]["reference"].clone();
    assert_eq!(child["address"], address, "{child}");
    assert_eq!(child["name"], "helper", "{child}");
    assert_eq!(child["type"], "managed", "{child}");
    assert_eq!(child["cli"], "fake", "{child}");
    assert_eq!(child["cwd"], json!(cwd), "{child}");
    assert_eq!(started["data"]["folder"], child["cwd"], "{started}");
    assert_eq!(
        started["data"]["machine_id"], parent["machine_id"],
        "{started}"
    );
    assert_eq!(child["creator"], parent, "{child}");
    assert_eq!(home.agents().len(), 2);
    let child_pid = child["pid"].as_i64().unwrap() as i32;
    assert!(alive(&process_identity(child_pid)), "{child}");
    #[cfg(target_os = "linux")]
    assert_eq!(
        std::fs::read_link(format!("/proc/{child_pid}/cwd")).unwrap(),
        cwd
    );
    let expected_launches = format!("{}\n{child_pid}\n", agent.pid);
    assert_eq!(
        std::fs::read_to_string(&launches).unwrap(),
        expected_launches
    );
    home.run_facade_ok(&["stop", "boss"]);
    let ended = boss.call("start_agent", start("late"));
    assert_eq!(ended["status"], "failure", "{ended}");
    assert_eq!(ended["reason"], "unavailable", "{ended}");
    assert!(
        ended["message"].as_str().unwrap().contains("run has ended"),
        "{ended}"
    );
    assert!(
        home.agent_from_watch("late").is_none(),
        "nothing more started"
    );
    assert_eq!(
        std::fs::read_to_string(&launches).unwrap(),
        expected_launches
    );
}

/// A daemon that ends during an Antigravity start, before its record was saved, leaves no plugin in
/// the project: the next daemon lets go of the plugin that start placed, as its run folder named it
/// before the plugin went there, whether it ended right after placing it or after the keeper
/// started the run, which the next daemon stops and removes.
#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses the test pause hook of debug builds"
)]
fn an_antigravity_start_cut_before_its_record_leaves_no_plugin() {
    for (point, keeper) in [("after-plugin-placed", false), ("after-run-start", true)] {
        let home = TestHome::new("agyhalf");
        let own = home.project.parent().unwrap().join("home");
        std::fs::create_dir_all(&own).unwrap();
        let programs = home.project.parent().unwrap().join("programs");
        std::fs::create_dir_all(&programs).unwrap();
        install_program(&programs, "agy", &test_binaries().fakecli);
        let path = format!(
            "{}{PATH_SEPARATOR}{}",
            programs.display(),
            home.path_with_test_programs()
        );
        home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", point)]);
        let daemon = home
            .hello_result()
            .and_then(|hello| hello["pid"].as_i64())
            .unwrap() as i32;
        let mut wire = DaemonTestClient::open(&home);
        assert!(wire.hello("terminal", DAEMON_API_VERSIONS, json!({}))["result"].is_object());
        let env = json!({
            "PATH": path, "HOME": own, "XDG_CONFIG_HOME": own.join(".config"),
            "FACADE_HOME": home.path, "FAKECLI_LOOK": "agy",
        });
        let args = json!({
            "cli": "agy", "name": "half", "folder": home.project, "env": env,
            "size": { "cols": 80, "rows": 24 },
        });
        wire.send("call", json!({ "op": "agent.start", "args": args }));
        assert!(
            wait_until(secs(15), || stopped(daemon)),
            "{point}: the daemon did not stop: {}",
            home.daemon_log()
        );
        let plugin = home.project.join(".agents/plugins/facade");
        assert!(
            plugin.join("mcp_config.json").exists(),
            "{point}: the start placed the plugin"
        );
        kill_process(daemon);
        // The keeper replaces a daemon that ends once it runs the agent; before that, the next
        // command starts one.
        if keeper {
            home.wait_for_daemon_after(daemon, secs(30))
                .expect("a replacement daemon");
        } else {
            home.start_facade_with(&[]);
        }
        assert!(home.agents().is_empty(), "{point}: {:?}", home.agents());
        assert!(
            wait_until(secs(15), || !home.project.join(".agents").exists()),
            "{point}: the plugin stays: {}",
            home.daemon_log()
        );
    }
}

/// The calls whose responses a golden file records, each with its response. What differs from one
/// run to the next is written as a placeholder: the test's folders, machine IDs, build version,
/// and timestamps.
struct Golden {
    cases: serde_json::Map<String, Value>,
    /// Texts that differ from run to run, longest first, each with what stands for it.
    placeholders: Vec<(String, &'static str)>,
    /// Whole values that differ from run to run, such as the name the Orchestrator picks for a
    /// guest from its pool, each with what stands for it.
    values: Vec<(String, &'static str)>,
}

impl Golden {
    /// Responses given in `home`, whose runs work in its project and whose guests in its Facade home,
    /// where their servers start.
    fn new(home: &TestHome) -> Golden {
        let canonical =
            |path: &std::path::Path| facade_base::files::real_path(path).unwrap_or(path.into());
        let mut placeholders = Vec::new();
        for folder in [home.folder().to_path_buf(), canonical(home.folder())] {
            placeholders.push((folder.to_string_lossy().into_owned(), "<test>"));
        }
        placeholders.push((env!("CARGO_PKG_VERSION").to_string(), "<version>"));
        let hello = home.hello_result().expect("the golden test's daemon");
        let machine = hello["machine_id"].as_str().expect("the machine ID");
        let selector = machine.replace('-', "");
        home.run_facade_ok(&["machine", "rename", &selector, "golden-host"]);
        placeholders.push((machine.to_string(), "<machine ID>"));
        placeholders.push((selector, "<compact machine ID>"));
        placeholders.push((
            facade_base::address::short_machine_id(machine),
            "<short machine ID>",
        ));
        placeholders.sort_by_key(|(text, _)| std::cmp::Reverse(text.len()));
        Golden {
            cases: serde_json::Map::new(),
            placeholders,
            values: Vec::new(),
        }
    }

    /// Records that a value equal to `varies`, such as a guest's picked name, is written as
    /// `placeholder`.
    fn value_varies(&mut self, varies: &str, placeholder: &'static str) {
        self.values.push((varies.to_string(), placeholder));
    }

    /// Records `response` to `call` as case `case`.
    fn record(&mut self, case: &str, call: Value, response: &Value) {
        let recorded = self.with_placeholders(&json!({ "call": call, "response": response }));
        assert!(
            self.cases.insert(case.to_string(), recorded).is_none(),
            "case {case:?} is recorded twice"
        );
    }

    /// Calls `tool` with `arguments` and records its result envelope as case `case`.
    fn call(
        &mut self,
        client: &mut McpTestClient,
        case: &str,
        tool: &str,
        arguments: Value,
    ) -> Value {
        self.call_in(client, case, tool, arguments, Value::Null)
    }

    /// Calls `tool` with `arguments`, and with `meta` as its `_meta` unless it is null, as a CLI
    /// names a call's session there, and records its result envelope as case `case`.
    fn call_in(
        &mut self,
        client: &mut McpTestClient,
        case: &str,
        tool: &str,
        arguments: Value,
        meta: Value,
    ) -> Value {
        let envelope = client.call_in(tool, arguments.clone(), meta.clone());
        let mut call = json!({ "tool": tool, "arguments": arguments });
        if !meta.is_null() {
            call["_meta"] = meta;
        }
        self.record(case, call, &envelope);
        envelope
    }

    /// `value` with each placeholder in place of what it stands for, and each time in Facade's form
    /// as `<time>`, also inside a text such as the model's copy of a result. A time in any other
    /// form stays as it is, so that a change to the form shows.
    fn with_placeholders(&self, value: &Value) -> Value {
        match value {
            Value::Object(members) => Value::Object(
                members
                    .iter()
                    .map(|(name, member)| (name.clone(), self.with_placeholders(member)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| self.with_placeholders(item))
                    .collect(),
            ),
            Value::String(text) if is_facade_time(text) => json!("<time>"),
            Value::String(text) => match self.values.iter().find(|(varies, _)| varies == text) {
                Some((_, placeholder)) => json!(placeholder),
                None => Value::String(slashed_after_placeholders(&with_facade_times(
                    &self
                        .placeholders
                        .iter()
                        .fold(text.clone(), |text, (varies, placeholder)| {
                            text.replace(varies.as_str(), placeholder)
                        }),
                ))),
            },
            other => other.clone(),
        }
    }

    /// Checks the recorded responses against `core/tests/golden/<name>`, after writing them there
    /// where `FACADE_REGENERATE` is set. The file holds each response's values with their keys in
    /// order.
    fn check(self, name: &str) {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("golden")
            .join(name);
        let cases = Value::Object(self.cases);
        let now = format!("{}\n", serde_json::to_string_pretty(&cases).unwrap());
        if std::env::var_os("FACADE_REGENERATE").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &now).unwrap();
        }
        // A checkout may turn the file's line endings into CRLF, as Git does on Windows.
        let recorded = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        if recorded == now {
            return;
        }
        let recorded: Value = serde_json::from_str(&recorded).unwrap_or_default();
        let differs = cases.as_object().unwrap().iter().find(|(case, response)| {
            recorded.get(case.as_str()).map(Value::to_string) != Some(response.to_string())
        });
        let how = match differs {
            Some((case, now)) => {
                format!(
                    "case {case:?}\nrecorded: {}\nnow:      {now}",
                    recorded[case]
                )
            }
            None => "its cases differ in number or order".to_string(),
        };
        panic!(
            "core/tests/golden/{name} differs: {how}\nWhere the change is meant, regenerate it: \
             FACADE_REGENERATE=1 cargo test -p facade-scenarios --test mcp golden_file_records"
        );
    }
}

/// A local MCP send delayed after computing its budget still settles a blocked draft by its
/// original deadline. Clearing the draft after the receipt only writes the requested control key.
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn a_delayed_mcp_send_withdraws_its_message_by_the_original_deadline() {
    let home = TestHome::new("relay-send-deadline");
    home.start_facade_with(&[("FACADE_TEST_GATES", "mcp-before-send")]);
    let keys = home.project.join("worker-keys");
    let worker = home.start_named_fake("worker", &[("FAKECLI_KEYS", keys.to_str().unwrap())]);
    let boss = home.start_named_fake("boss", &[]);
    type_draft(&home, &worker.id, "my draft");
    let before = std::fs::read(&keys).unwrap();
    let mut sender = McpTestClient::relay_configured(&home, &boss.id);
    let request = sender.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": {
                "to": worker.address, "text": "never paste this delayed message",
                "wait_for": "delivery", "timeout_seconds": 6,
            }
        }),
    );
    home.wait_for_gate("mcp-before-send");
    // This exceeds the time reserved for settlement and the reply, so restarting the relative
    // budget at admission would let this send stay pending beyond the original tool deadline.
    std::thread::sleep(secs(2));
    home.release_gate("mcp-before-send");

    let receipt = sender.tool_answer(request);
    assert_eq!(receipt["status"], "failure", "{receipt}");
    assert!(
        matches!(receipt["reason"].as_str(), Some("input_draft" | "timeout")),
        "{receipt}"
    );
    assert!(receipt["data"]["id"].is_string(), "{receipt}");
    assert!(
        receipt["message"]
            .as_str()
            .is_some_and(|message| message.contains("nothing was typed; it was withdrawn from")),
        "{receipt}"
    );
    assert_eq!(std::fs::read(&keys).unwrap(), before);
    assert!(home.screen(&worker.id).contains("❯ my draft"));

    home.run_facade_ok(&["type", &worker.address, "--key", "Ctrl+C"]);
    assert!(wait_until(secs(10), || !home
        .screen(&worker.id)
        .contains("❯ my draft")));
    std::thread::sleep(secs(2));
    let inbox = McpTestClient::open_configured(&home, &worker.id)
        .call("read_messages", json!({ "last": 10 }));
    assert_eq!(inbox["data"]["messages"], json!([]), "{inbox}");
    let mut expected = before;
    expected.push(0x03);
    assert_eq!(std::fs::read(&keys).unwrap(), expected);
}

/// Over a relay connection, a `send_message` its client cancels while its message waits is
/// withdrawn, and answered all the same, so that every request has one answer: MCP has the client
/// ignore it.
#[test]
fn a_send_cancelled_over_a_relay_connection_is_withdrawn_and_answered() {
    let home = TestHome::new("relaycancel");
    let keys = home.project.join("worker-keys");
    let worker = home.start_named_fake("worker", &[("FAKECLI_KEYS", keys.to_str().unwrap())]);
    let boss = home.start_named_fake("boss", &[]);
    type_draft(&home, "worker", "my draft");
    let before = std::fs::read(&keys).unwrap();
    let text = "never paste this relay cancellation";
    let mut boss = McpTestClient::relay_configured(&home, &boss.id);
    let held = boss.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": { "to": worker.address, "text": text, "wait_for": "delivery", "timeout_seconds": 30 },
        }),
    );
    let store = rusqlite::Connection::open_with_flags(
        home.path.join("core/facade.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    store.busy_timeout(secs(5)).unwrap();
    assert!(
        wait_until(secs(10), || store
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE status = 'pending' AND text = ?1)",
                [text],
                |row| row.get::<_, bool>(0)
            )
            .unwrap()),
        "the send is pending behind the draft"
    );
    let cancel = json!({
        "jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": { "requestId": held, "reason": "changed my mind" },
    });
    boss.write(&cancel.to_string());
    let answered = boss
        .answer(held, secs(10))
        .expect("the cancelled call's answer");
    assert_eq!(
        answered["error"],
        json!({ "code": -32800, "message": "the client cancelled this call; nothing was sent" }),
        "{answered}"
    );
    assert!(
        wait_until(secs(10), || home
            .daemon_log()
            .contains("withdrawn by its send's cancel")),
        "{}",
        home.daemon_log()
    );
    let inbox = McpTestClient::open_configured(&home, &worker.id)
        .call("read_messages", json!({ "last": 10 }));
    assert_eq!(inbox["status"], "success", "{inbox}");
    assert_eq!(inbox["data"]["messages"], json!([]), "{inbox}");
    assert!(home.screen(&worker.address).contains("❯ my draft"));
    assert_eq!(std::fs::read(&keys).unwrap(), before);
    home.run_facade_ok(&["type", &worker.address, "--key", "Ctrl+C"]);
    let after = "delivery after the relay cancellation";
    let sent = boss.call(
        "send_message",
        json!({ "to": worker.address, "text": after, "wait_for": "delivery", "timeout_seconds": 30 }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert!(
        home.submitted_messages()
            .iter()
            .any(|message| message.contains(after))
    );
    assert!(!String::from_utf8_lossy(&std::fs::read(keys).unwrap()).contains(text));
    assert!(
        !store
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE text = ?1)",
                [text],
                |row| row.get::<_, bool>(0)
            )
            .unwrap()
    );
}

/// The way a golden test reaches the MCP server: through the `facade-mcp` program, or straight to
/// the daemon's own server over a relay connection, as the relay reaches it. Both get the same
/// responses.
#[derive(Clone, Copy)]
enum Through {
    Program,
    Relay,
}

impl Through {
    /// The MCP server of `agent`.
    fn open(self, home: &TestHome, agent: &str) -> McpTestClient {
        match self {
            Through::Program => McpTestClient::open_configured(home, agent),
            Through::Relay => McpTestClient::relay_configured(home, agent),
        }
    }

    /// The server in `cli`'s own settings, `--guest <cli>`, with `env` in its environment.
    fn open_guest(self, home: &TestHome, cli: &str, env: &[(&str, &str)]) -> McpTestClient {
        match self {
            Through::Program => McpTestClient::open_guest(home, cli, env),
            Through::Relay => McpTestClient::relay(home, &["--guest", cli], env),
        }
    }
}

/// Waits until the tools of each agent `named` are there: its CLI's own server has answered its
/// `tools/list`, as the test CLI's does soon after it starts.
fn wait_for_tools(home: &TestHome, named: &[&str]) {
    for name in named {
        assert!(
            wait_until(secs(30), || home
                .agent_from_watch(name)
                .is_some_and(|row| row["tools_state"] == "available")),
            "{name}'s tools: {:?}",
            home.agent_from_watch(name)
        );
    }
}

/// `text` with each path that follows a placeholder, such as `<test>\project`, written with `/`, as
/// the golden files record it on every system. On Unix nothing changes.
fn slashed_after_placeholders(text: &str) -> String {
    if cfg!(unix) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut in_path = false;
    for c in text.chars() {
        match c {
            '>' => in_path = true,
            '\\' if in_path => {
                out.push('/');
                continue;
            }
            c if c.is_whitespace() || c == '"' || c == '\'' || c == ',' => in_path = false,
            _ => {}
        }
        out.push(c);
    }
    out
}

/// `text` with each time in Facade's form inside it written as `<time>`.
fn with_facade_times(text: &str) -> String {
    const LENGTH: usize = "dddd-dd-ddTdd:dd:dd.dddZ".len();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(next) = rest.chars().next() {
        if rest.is_char_boundary(LENGTH.min(rest.len()))
            && rest.len() >= LENGTH
            && is_facade_time(&rest[..LENGTH])
        {
            out.push_str("<time>");
            rest = &rest[LENGTH..];
        } else {
            out.push(next);
            rest = &rest[next.len_utf8()..];
        }
    }
    out
}

/// Whether `text` is a time as Facade writes one: UTC, with milliseconds, such as
/// `2026-11-14T21:41:37.642Z`. The form is written out here rather than read from Facade's own
/// code, so that a change to the form shows.
fn is_facade_time(text: &str) -> bool {
    const FORM: &str = "dddd-dd-ddTdd:dd:dd.dddZ";
    text.len() == FORM.len()
        && text
            .bytes()
            .zip(FORM.bytes())
            .all(|(byte, form)| match form {
                b'd' => byte.is_ascii_digit(),
                _ => byte == form,
            })
}

/// Each tool responds to its usual calls, and to the most common mistakes with it, as
/// `core/tests/golden/mcp-responses.json` records: each response's values, with their keys in
/// order, and the model's text reading as the same value as the structured result. Moving the tools
/// changes none of them; a change meant to a response regenerates the file in the same commit.
#[test]
fn each_tool_responds_as_its_golden_file_records() {
    each_tool_responds_as_recorded(Through::Program);
}

/// The daemon's own MCP server, reached over a relay connection, responds as `facade-mcp` does.
#[test]
fn each_tool_responds_through_a_relay_connection_as_its_golden_file_records() {
    each_tool_responds_as_recorded(Through::Relay);
}

fn each_tool_responds_as_recorded(through: Through) {
    let home = TestHome::new("mcpgolden");
    home.start_facade_with(&[]);
    let mut golden = Golden::new(&home);
    let ada = home.start_named_fake("ada", &[]);
    let bob = home.start_named_fake("bob", &[]);
    wait_for_tools(&home, &["ada", "bob"]);
    let cwd = home.agent_from_watch("ada").unwrap()["cwd"].clone();
    let mut ada = through.open(&home, &ada.id);
    let mut bob = through.open(&home, &bob.id);
    golden.record(
        "initialize",
        json!({ "method": "initialize" }),
        &ada.initialized(),
    );
    let listed = ada.request("tools/list", json!({}));
    golden.record("tools/list", json!({ "method": "tools/list" }), &listed);

    golden.call(&mut ada, "list_agents", "list_agents", json!({}));
    golden.call(
        &mut ada,
        "start_agent",
        "start_agent",
        json!({ "name": "helper", "cli": "fake", "folder": cwd }),
    );
    golden.call(
        &mut ada,
        "start_agent with the old path argument",
        "start_agent",
        json!({ "name": "other", "cli": "fake", "path": cwd }),
    );
    golden.call(
        &mut ada,
        "start_agent with the old worktree object",
        "start_agent",
        json!({ "name": "other", "cli": "fake", "worktree": { "branch": "review" } }),
    );
    golden.call(
        &mut ada,
        "start_agent with the old window argument",
        "start_agent",
        json!({ "name": "other", "cli": "fake", "window": "terminal" }),
    );
    golden.call(
        &mut ada,
        "start_agent of a CLI that is not configured",
        "start_agent",
        json!({ "name": "other", "cli": "nope", "folder": cwd }),
    );

    let sent = golden.call(
        &mut ada,
        "send_message",
        "send_message",
        json!({ "to": "a2@golden-host", "text": "hello bob", "wait_for": "delivery", "timeout_seconds": 30 }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["id"], "m1@golden-host", "{sent}");
    assert_eq!(sent["data"]["delivery"], "typed_into_input", "{sent}");
    assert!(sent["data"].get("next").is_none(), "{sent}");
    golden.call(
        &mut ada,
        "send_message without a recipient",
        "send_message",
        json!({ "text": "hello" }),
    );
    golden.call(
        &mut ada,
        "send_message to an agent that does not exist",
        "send_message",
        json!({ "to": "a99@golden-host", "text": "hello" }),
    );
    golden.call(
        &mut ada,
        "send_message to the retired human recipient",
        "send_message",
        json!({ "to": "#human", "text": "bob has the task" }),
    );
    golden.call(
        &mut ada,
        "read_messages with nothing new",
        "read_messages",
        json!({}),
    );
    // Ada waits for Bob's reply while a draft holds terminal delivery.
    type_draft(&home, "ada", "my draft");
    let waiting = json!({
        "name": "read_messages",
        "arguments": { "timeout_seconds": 30, "reply_to": sent["data"]["id"] },
    });
    let awaiting = ada.send("tools/call", waiting.clone());
    let reply = json!({
        "name": "send_message",
        "arguments": {
            "to": "ada", "text": "hi ada", "reply_to": "m1",
            "wait_for": "delivery", "timeout_seconds": 30,
        },
    });
    let replying = bob.send("tools/call", reply.clone());
    let read = ada
        .answer(awaiting, secs(40))
        .expect("Ada's read is answered");
    assert_eq!(
        read["result"]["structuredContent"]["data"]["messages"][0]["text"], "hi ada",
        "{read}"
    );
    golden.record(
        "read_messages waiting for a reply",
        json!({ "method": "tools/call", "params": waiting }),
        &read,
    );
    let replied = bob
        .answer(replying, secs(40))
        .expect("bob's send is answered");
    assert_eq!(
        replied["result"]["structuredContent"]["data"]["delivery"], "read_by_recipient",
        "{replied}"
    );
    golden.record(
        "send_message replying to a local inbox number",
        json!({ "method": "tools/call", "params": reply }),
        &replied,
    );
    home.run_facade_ok(&["type", "ada", "--key", "Ctrl+C"]);
    golden.call(
        &mut ada,
        "read_messages after a message",
        "read_messages",
        json!({ "after": "m2" }),
    );
    golden.call(
        &mut ada,
        "read_messages of the last message",
        "read_messages",
        json!({ "last": 1 }),
    );

    assert!(
        wait_for_screen_text(&home, "helper", "❯"),
        "{}",
        home.screen("helper")
    );
    golden.call(
        &mut ada,
        "type_text",
        "type_text",
        json!({ "agent": "a3@golden-host", "text": "hello there", "enter": true }),
    );
    golden.call(
        &mut ada,
        "type_text to an agent that does not exist",
        "type_text",
        json!({ "agent": "a99@golden-host", "text": "hello" }),
    );
    golden.call(
        &mut ada,
        "type_text with empty text and enter",
        "type_text",
        json!({ "agent": "helper", "text": "", "enter": true }),
    );
    golden.call(
        &mut ada,
        "type_text with a control character",
        "type_text",
        json!({ "agent": "helper", "text": "before\u{1b}after" }),
    );
    golden.call(
        &mut ada,
        "press_keys",
        "press_keys",
        json!({ "agent": "a3@golden-host", "keys": ["h", "i", "Enter"] }),
    );
    golden.call(
        &mut ada,
        "press_keys without keys",
        "press_keys",
        json!({
            "agent": "helper",
            "keys": ["Escape", "Return", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"],
        }),
    );
    golden.call(
        &mut ada,
        "press_keys of a key it does not know",
        "press_keys",
        json!({ "agent": "helper", "keys": ["Hyper+Q"] }),
    );
    // The test CLI logs a submitted line before it draws it: the screen is read once it shows the
    // last one.
    assert!(
        wait_for_screen_text(&home, "helper", "> hi"),
        "{}",
        home.screen("helper")
    );
    golden.call(
        &mut ada,
        "read_screen",
        "read_screen",
        json!({ "agent": "a3@golden-host" }),
    );
    golden.call(
        &mut ada,
        "press_keys of Esc",
        "press_keys",
        json!({ "agent": "helper", "keys": ["Esc"] }),
    );
    golden.call(
        &mut ada,
        "read_screen of lines that are not a number",
        "read_screen",
        json!({ "agent": "helper", "lines": "12" }),
    );
    golden.call(
        &mut ada,
        "read_screen with the old last argument",
        "read_screen",
        json!({ "agent": "helper", "last": 4 }),
    );
    golden.call(
        &mut ada,
        "read_screen with both last and lines",
        "read_screen",
        json!({ "agent": "helper", "last": 4, "lines": 4 }),
    );
    let retried = golden.call(
        &mut ada,
        "read_screen retried with lines",
        "read_screen",
        json!({ "agent": "helper", "lines": 4 }),
    );
    assert_eq!(retried["status"], "success", "{retried}");
    assert_eq!(retried["data"]["process"], "running");
    assert_eq!(retried["data"]["text"].as_str().unwrap().lines().count(), 4);
    golden.call(
        &mut ada,
        "read_screen of an agent that does not exist",
        "read_screen",
        json!({ "agent": "a99@golden-host" }),
    );
    golden.call(
        &mut ada,
        "stop_agent",
        "stop_agent",
        json!({ "agent": "a3@golden-host" }),
    );
    golden.call(
        &mut ada,
        "stop_agent of an agent that does not exist",
        "stop_agent",
        json!({ "agent": "a99@golden-host" }),
    );
    for (tool, arguments) in [
        ("stop_agent", json!({ "agent": "a3@golden-host" })),
        (
            "type_text",
            json!({ "agent": "a3@golden-host", "text": "late" }),
        ),
        (
            "press_keys",
            json!({ "agent": "a3@golden-host", "keys": ["Enter"] }),
        ),
        (
            "read_screen",
            json!({ "agent": "a3@golden-host", "lines": 4 }),
        ),
    ] {
        golden.call(
            &mut ada,
            &format!("{tool} of a stopped agent"),
            tool,
            arguments,
        );
    }

    golden.call(
        &mut ada,
        "start_agent with a prompt",
        "start_agent",
        json!({
            "name": "twin", "cli": "fake", "folder": cwd,
            "prompt": "Read the README and summarize it.",
        }),
    );
    let defaulted = golden.call(
        &mut ada,
        "start_agent without a folder",
        "start_agent",
        json!({ "name": "defaulted", "cli": "fake" }),
    );
    assert_eq!(defaulted["status"], "success", "{defaulted}");
    assert_eq!(defaulted["data"]["folder"], cwd);
    let subfolder = home.project.join("inside");
    std::fs::create_dir(&subfolder).unwrap();
    let relative = golden.call(
        &mut ada,
        "start_agent in a relative folder",
        "start_agent",
        json!({ "name": "relative", "cli": "fake", "folder": "inside" }),
    );
    assert_eq!(relative["status"], "success", "{relative}");
    let subfolder = facade_base::files::real_path(&subfolder).unwrap();
    assert_eq!(relative["data"]["folder"], json!(subfolder));
    golden.check("mcp-responses.json");
}

/// Each built-in CLI's user entry can open a Guest connection with the same eight tools. The
/// fixture records discovery, the first tool call, and a complete conversation with a Guest.
#[test]
fn each_cli_s_guest_server_responds_as_its_golden_file_records() {
    each_cli_s_guest_server_responds_as_recorded(Through::Program);
}

/// The daemon's own MCP server, reached over a relay connection, serves each CLI's guests as
/// `facade-mcp --guest` does.
#[test]
fn each_cli_s_guest_server_responds_through_a_relay_connection_as_its_golden_file_records() {
    each_cli_s_guest_server_responds_as_recorded(Through::Relay);
}

fn each_cli_s_guest_server_responds_as_recorded(through: Through) {
    let mut recorded = Golden {
        cases: serde_json::Map::new(),
        placeholders: Vec::new(),
        values: Vec::new(),
    };
    // In each call's `_meta`, under the CLI's key, or else in the server's environment.
    for (cli, variable, meta_key) in [
        ("claude", Some("CLAUDE_CODE_SESSION_ID"), None),
        ("codex", None, Some("sessionId")),
        ("agy", None, Some("antigravity.google/root_conversation_id")),
        ("muse", Some("MUSE_SESSION_ID"), None),
        ("opencode", None, Some("ai.opencode/sessionID")),
        ("pi", None, None),
    ] {
        // Each direct relay case uses a fresh machine so the test process's PID does not
        // reconnect a Guest from the preceding CLI's case.
        let home = TestHome::new(&format!("mcpgold-{cli}"));
        std::fs::write(home.path.join("facade.json"), "{ \"names\": [] }\n").unwrap();
        let host = home.start_named_fake("host", &[]);
        wait_for_tools(&home, &["host"]);
        // The host's server is its own relay program. A direct connection comes from this test's
        // process, which the daemon knows as the guest once the guest joins: each relay is a
        // process of its own.
        let mut host = Through::Program.open(&home, &host.id);
        let tools = host.request("tools/list", json!({}))["result"].clone();
        let mut golden = Golden::new(&home);

        let session = format!("{cli}-golden");
        let named = variable.map(|key| (key, session.as_str()));
        let mut server = through.open_guest(&home, cli, named.as_slice());
        let mut started = json!({ "method": "initialize", "server": ["--guest", cli] });
        if let Some((key, value)) = named {
            started["environment"] = json!({ key: value });
        }
        golden.record(
            &format!("initialize by {cli}'s guest server"),
            started,
            &server.initialized(),
        );
        assert_eq!(
            server.request("tools/list", json!({}))["result"],
            tools,
            "{cli}'s guests get a run's tools"
        );
        let meta = meta_key.map_or(Value::Null, |key| json!({ key: session }));
        assert_eq!(home.list_table().column("REF"), ["a1@golden-host"]);
        let listed = server.call_in("list_agents", json!({}), meta.clone());
        assert_eq!(listed["status"], "success", "{listed}");
        let rows = listed["data"]["agents"]
            .as_array()
            .expect("the active roster");
        let guests: Vec<&Value> = rows.iter().filter(|row| row["type"] == "guest").collect();
        assert_eq!(
            guests.len(),
            1,
            "each user entry joins once when it calls a tool"
        );
        // The Orchestrator names a guest from its pool of names.
        let name = guests[0]["name"].as_str().expect("the guest's name");
        golden.value_varies(name, "<guest name>");
        let mut call = json!({ "tool": "list_agents", "arguments": {} });
        if !meta.is_null() {
            call["_meta"] = meta.clone();
        }
        golden.record(&format!("list_agents by {cli}'s guest"), call, &listed);
        if cli == "codex" {
            record_guest_exchange(&mut golden, &mut host, &mut server, &meta);
        }
        recorded.cases.append(&mut golden.cases);
    }
    recorded.check("mcp-guest-responses.json");
}

fn record_guest_exchange(
    golden: &mut Golden,
    host: &mut McpTestClient,
    guest: &mut McpTestClient,
    meta: &Value,
) {
    let message = json!({
        "to": "a2@golden-host", "text": "hello guest", "wait_for": "delivery", "timeout_seconds": 30,
    });
    let sent = host.send(
        "tools/call",
        json!({ "name": "send_message", "arguments": message }),
    );
    let read = golden.call_in(
        guest,
        "read_messages waiting as a guest",
        "read_messages",
        json!({ "timeout_seconds": 30 }),
        meta.clone(),
    );
    assert_eq!(read["data"]["messages"][0]["text"], "hello guest", "{read}");
    let receipt = host.tool_answer(sent);
    assert_eq!(
        receipt["data"]["delivery"], "read_by_recipient",
        "{receipt}"
    );
    golden.record(
        "send_message to a guest",
        json!({ "tool": "send_message", "arguments": message }),
        &receipt,
    );
    let reply = golden.call_in(
        guest,
        "send_message from a guest",
        "send_message",
        json!({
            "to": "a1@golden-host",
            "text": "hello host",
            "reply_to": read["data"]["messages"][0]["id"],
            "wait_for": "delivery",
            "timeout_seconds": 30,
        }),
        meta.clone(),
    );
    assert_eq!(reply["status"], "success", "{reply}");
    assert_eq!(reply["data"]["delivery"], "typed_into_input", "{reply}");
    assert!(reply["data"].get("next").is_none(), "{reply}");
}

/// A line of 1 MiB goes through the relay each way, and the connection goes on: a request whose
/// method is that long, which the daemon's answer names in full, then a ping.
#[test]
fn a_line_of_a_mebibyte_goes_through_the_relay_each_way() {
    let home = TestHome::new("relaymib");
    home.start_named_fake("ada", &[]);
    let mut ada = McpTestClient::open(&home, "a1");
    let method = "x".repeat(1 << 20);
    let long = ada.send(&method, json!({}));
    let answered = ada
        .answer(long, secs(30))
        .expect("the long line is answered");
    assert_eq!(answered["error"]["code"], -32601);
    assert!(
        answered["error"]["message"]
            .as_str()
            .is_some_and(|message| message.len() > 1 << 20),
        "the answer names the method in full"
    );
    assert_eq!(ada.request("ping", json!({}))["result"], json!({}));
}
