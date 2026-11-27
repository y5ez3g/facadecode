//! External relays join as Guests when they first call a tool. The scenarios exercise their
//! identity, reach, reply waits and delivery through Facade Code Framework.

use std::process::Stdio;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

fn managed_relay(home: &TestHome, name: &str) -> (String, McpTestClient) {
    let started = home.run_facade_ok(&["start", "-d", "--name", name, "fake"]);
    let address = started_ref(&started);
    let (id, _) = address.split_once('@').expect("start gives an address");
    (address.into(), McpTestClient::open_configured(home, id))
}

/// A Guest waits by its original send ID and continues with the same ID after a reply timeout.
/// When the managed sender omits the reference, a send queued before or during the wait explains
/// how to resend the reply after withdrawal.
#[test]
fn a_guest_waits_for_the_reply_to_its_message() {
    let home = TestHome::new("guest-reply");
    std::fs::write(home.path.join("facade.json"), r#"{"yolo":true}"#).unwrap();
    let (ada_address, mut ada) = managed_relay(&home, "ada");
    let ada_address = ada_address.as_str();
    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    assert_eq!(
        home.list_table().column("REFERENCE"),
        [ada_address],
        "the external connection joins on its first tool call"
    );

    let roster = guest.call("list_agents", json!({}));
    assert_eq!(roster["status"], "success", "{roster}");
    let agents = roster["data"]["agents"].as_array().expect("the agent list");
    assert!(
        agents
            .iter()
            .any(|row| row["type"] == "managed" && row["id"] == ada_address),
        "{roster}"
    );
    let guest_row = agents
        .iter()
        .find(|row| row["type"] == "guest")
        .expect("the external connection is a Guest");
    assert_eq!(guest_row["state"], "online", "{guest_row}");
    let guest_address = guest_row["id"].as_str().expect("the Guest's address");
    let (guest_id, _) = guest_address
        .split_once('@')
        .expect("a complete Guest address");

    let request = "Please check the isolated test project";
    let sent = guest.call(
        "send_message",
        json!({ "to": ada_address, "text": request, "wait_for": "delivery", "timeout_seconds": 30 }),
    );
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["delivery"], "typed_into_input", "{sent}");
    let original = sent["data"]["id"].as_str().expect("the send receipt ID");
    let (inbox_id, _) = original.split_once('@').expect("the full message address");
    let guest_name = guest_row["name"].as_str().expect("the Guest's name");
    let expected = format!("📨 Message {inbox_id} from {guest_name} ({guest_address})\n{request}");
    assert!(
        wait_until(secs(10), || home.submitted_messages().contains(&expected)),
        "the fake terminal did not accept the Guest's message: {}",
        home.screen(ada_address)
    );
    assert!(sent["data"].get("next").is_none(), "{sent}");
    let response = "I checked the isolated test project";
    let send_without_reference = |ada: &mut McpTestClient| {
        ada.send(
            "tools/call",
            json!({
                "name": "send_message",
                "arguments": {
                    "to": guest_address, "text": response, "wait_for": "delivery", "timeout_seconds": 15,
                },
            }),
        )
    };
    let queued_first = send_without_reference(&mut ada);
    assert!(
        wait_until(secs(10), || waiting_for(&home, guest_id) == 1),
        "the Guest's inbox has the first send before it starts waiting"
    );
    // The unlinked sends must reach their delivery deadlines while the Guest is still waiting.
    let read_reply = |guest: &mut McpTestClient, reply_to: &str| {
        guest.send(
            "tools/call",
            json!({
                "name": "read_messages",
                "arguments": { "reply_to": reply_to, "timeout_seconds": 30 },
            }),
        )
    };
    let waiting = read_reply(&mut guest, original);
    assert!(
        guest
            .answer(waiting, std::time::Duration::from_millis(250))
            .is_none(),
        "the Guest waits for a matching reply"
    );
    let queued_during_wait = send_without_reference(&mut ada);
    let hints = [queued_first, queued_during_wait].map(|send| {
        let omitted = ada.tool_answer(send);
        assert_eq!(omitted["status"], "failure", "{omitted}");
        assert_eq!(omitted["reason"], "timeout", "{omitted}");
        let diagnostic = omitted["message"]
            .as_str()
            .expect("the delivery diagnostic");
        assert!(diagnostic.contains("withdrawn"), "{omitted}");
        assert!(diagnostic.contains("waiting for a reply"), "{omitted}");
        diagnostic
            .split_once("reply_to")
            .and_then(|(_, argument)| {
                argument
                    .split(|ch: char| {
                        ch.is_whitespace() || matches!(ch, ':' | '=' | '`' | '"' | ',' | ';')
                    })
                    .map(|word| word.trim_end_matches('.'))
                    .find(|word| *word == inbox_id || *word == original)
            })
            .unwrap_or_else(|| {
                panic!("missing the original message number after reply_to: {omitted}")
            })
            .to_owned()
    });
    assert_eq!(hints[0], hints[1], "both orders suggest the same reply");
    let unmatched = guest.tool_answer(waiting);
    assert_eq!(unmatched["status"], "failure", "{unmatched}");
    assert_eq!(unmatched["reason"], "reply_timeout", "{unmatched}");
    assert_eq!(unmatched["data"]["id"], original, "{unmatched}");
    assert!(unmatched["data"].get("delivery").is_none(), "{unmatched}");
    assert!(unmatched["data"].get("next").is_none(), "{unmatched}");

    let waiting = read_reply(&mut guest, original);
    let replied = ada.call(
        "send_message",
        json!({
            "to": guest_address, "text": response, "reply_to": hints[0],
            "wait_for": "delivery", "timeout_seconds": 30,
        }),
    );
    assert_eq!(replied["status"], "success", "{replied}");
    assert_eq!(
        replied["data"]["delivery"], "read_by_recipient",
        "{replied}"
    );
    let read = guest.tool_answer(waiting);
    assert_eq!(read["status"], "success", "{read}");
    let messages = read["data"]["messages"].as_array().expect("inline replies");
    assert_eq!(messages.len(), 1, "{read}");
    assert_eq!(messages[0]["text"], response, "{read}");
    assert_eq!(messages[0]["from"], ada_address, "{read}");
    let history = guest.call("read_messages", json!({ "last": 10 }));
    assert_eq!(history["data"]["messages"], json!(messages), "{history}");

    let (_, status) = guest.close(secs(20));
    assert!(status.success(), "{status:?}");
    assert!(
        wait_until(secs(10), || !home
            .list_table()
            .column("REFERENCE")
            .contains(&guest_address)),
        "the Guest stayed listed after disconnecting"
    );
}

/// A second relay cannot read or settle a reply addressed to the first Guest.
#[test]
fn a_guest_cannot_fetch_another_guests_pending_reply() {
    let home = TestHome::new("guest-reply-owner");
    let (ada_address, mut ada) = managed_relay(&home, "ada");
    let (ada_id, _) = ada_address.split_once('@').unwrap();
    let mut recipient = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let listed = recipient.call("list_agents", json!({}));
    let rows = listed["data"]["agents"].as_array().unwrap();
    let address = rows.iter().find(|row| row["type"] == "guest").unwrap()["id"]
        .as_str()
        .unwrap();
    let (guest_id, _) = address.split_once('@').unwrap();
    let mut other = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let joined = other.call("list_agents", json!({}));
    let guests: Vec<_> = joined["data"]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["type"] == "guest")
        .collect();
    assert_eq!(guests.len(), 2, "{joined}");
    assert!(guests.iter().any(|row| row["id"] == address), "{joined}");
    assert_ne!(guests[0]["id"], guests[1]["id"]);

    let request = recipient.call(
        "send_message",
        json!({
            "to": ada_address, "text": "request from the recipient",
            "wait_for": "delivery", "timeout_seconds": 30,
        }),
    );
    assert_eq!(request["status"], "success", "{request}");
    assert_eq!(request["data"]["delivery"], "typed_into_input", "{request}");
    let original = request["data"]["id"].as_str().unwrap();
    let (original_number, machine) = original.split_once('@').unwrap();
    let owner_history = ada.call("read_messages", json!({ "last": 10 }));
    assert_eq!(owner_history["status"], "success", "{owner_history}");
    let owner_inbox = owner_history["data"]["messages"].as_array().unwrap();
    assert_eq!(owner_inbox.len(), 1, "{owner_history}");
    assert_eq!(owner_inbox[0]["id"], original_number, "{owner_history}");
    assert_eq!(owner_inbox[0]["from"], address, "{owner_history}");
    assert_eq!(
        owner_inbox[0]["text"], "request from the recipient",
        "{owner_history}"
    );
    let owner_unread = ada.call("read_messages", json!({}));
    assert_eq!(owner_unread["status"], "success", "{owner_unread}");
    assert_eq!(
        owner_unread["data"]["messages"],
        json!([]),
        "{owner_unread}"
    );
    let reply = "reply for the recipient only";
    let pending = ada.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": {
                "to": address, "text": reply, "reply_to": original,
                "wait_for": "delivery", "timeout_seconds": 30,
            },
        }),
    );
    let mut wire = connect(&home);
    let posted = format!("#{ada_id} sent ");
    let target = format!(" to #{guest_id}");
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            let log = wire.call_ok("daemon.log", json!({}));
            log["lines"].as_array().unwrap().iter().any(|line| {
                line.as_str()
                    .is_some_and(|line| line.contains(&posted) && line.contains(&target))
            })
        }),
        "the reply was never posted to the intended Guest"
    );

    let filter = json!({ "reply_to": original });
    let wrong = other.call("read_messages", filter.clone());
    assert_eq!(wrong["status"], "success", "{wrong}");
    assert_eq!(wrong["data"]["messages"], json!([]), "{wrong}");
    assert!(
        ada.answer(pending, std::time::Duration::from_millis(250))
            .is_none()
    );

    let read = recipient.call("read_messages", filter);
    assert_eq!(read["status"], "success", "{read}");
    let messages = read["data"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "{read}");
    assert_eq!(messages[0]["text"], reply, "{read}");
    assert_eq!(messages[0]["from"], ada_address, "{read}");
    assert_eq!(messages[0]["reply_to"], original_number, "{read}");
    let sent = ada.tool_answer(pending);
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["delivery"], "read_by_recipient", "{sent}");
    let number = messages[0]["id"].as_str().unwrap();
    assert_eq!(sent["data"]["id"], format!("{number}@{machine}"), "{sent}");
    let settled = recipient.call("read_messages", json!({ "reply_to": original }));
    assert_eq!(settled["status"], "success", "{settled}");
    // The reply filter can read the same retained record. It is no longer unread.
    assert_eq!(
        settled["data"]["messages"], read["data"]["messages"],
        "{settled}"
    );
    let unread = recipient.call("read_messages", json!({}));
    assert_eq!(unread["status"], "success", "{unread}");
    assert_eq!(unread["data"]["messages"], json!([]), "{unread}");
    let history = other.call("read_messages", json!({ "last": 10 }));
    assert_eq!(history["status"], "success", "{history}");
    assert_eq!(history["data"]["messages"], json!([]), "{history}");
}

#[test]
fn a_guest_result_wait_returns_the_linked_reply_or_continues_by_the_same_id() {
    let home = TestHome::new("guest-result");
    std::fs::write(home.path.join("facade.json"), r#"{"yolo":true}"#).unwrap();
    let (ada_address, mut ada) = managed_relay(&home, "ada");
    let (mut guest, row) = member(&home);
    let guest_address = row["address"].as_str().unwrap();

    for (request, response, timeout, continue_wait) in [
        ("Answer while I wait", "Here is the result", 30, false),
        (
            "Answer after my send returns",
            "Here is the late result",
            5,
            true,
        ),
    ] {
        let sending = guest.send(
            "tools/call",
            json!({
                "name": "send_message",
                "arguments": {
                    "to": ada_address, "text": request,
                    "wait_for": "result", "timeout_seconds": timeout,
                },
            }),
        );
        assert!(
            wait_until(secs(10), || home
                .submitted_messages()
                .iter()
                .any(|message| { message.lines().skip(1).eq([request]) })),
            "the request did not reach the fake terminal: {}",
            home.screen(&ada_address)
        );
        let inbox = ada.call("read_messages", json!({ "last": 1 }));
        assert_eq!(inbox["status"], "success", "{inbox}");
        let original = &inbox["data"]["messages"][0];
        assert_eq!(original["text"], request, "{inbox}");
        assert_eq!(original["from"], guest_address, "{inbox}");
        let inbox_id = original["id"].as_str().unwrap();

        let expired_id = continue_wait.then(|| {
            let expired = guest.tool_answer(sending);
            assert_eq!(expired["status"], "failure", "{expired}");
            assert_eq!(expired["reason"], "reply_timeout", "{expired}");
            assert_eq!(expired["data"]["delivery"], "typed_into_input", "{expired}");
            assert!(expired["data"].get("next").is_none(), "{expired}");
            let id = expired["data"]["id"]
                .as_str()
                .expect("original full send ID");
            assert_eq!(id.split_once('@').unwrap().0, inbox_id, "{expired}");
            id.to_owned()
        });
        let reading = expired_id.as_ref().map_or(sending, |id| {
            guest.send(
                "tools/call",
                json!({
                    "name": "read_messages",
                    "arguments": { "reply_to": id, "timeout_seconds": 30 },
                }),
            )
        });
        let replied = ada.call(
            "send_message",
            json!({
                "to": guest_address, "text": response, "reply_to": inbox_id,
                "wait_for": "delivery", "timeout_seconds": 30,
            }),
        );
        assert_eq!(replied["status"], "success", "{replied}");
        assert_eq!(
            replied["data"]["delivery"], "read_by_recipient",
            "{replied}"
        );
        let read = guest.tool_answer(reading);
        assert_eq!(read["status"], "success", "{read}");
        assert!(read["data"].get("next").is_none(), "{read}");
        if !continue_wait {
            let id = read["data"]["id"].as_str().expect("original full send ID");
            assert_eq!(id.split_once('@').unwrap().0, inbox_id, "{read}");
            assert_eq!(read["data"]["delivery"], "typed_into_input", "{read}");
        }
        let messages = read["data"]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1, "{read}");
        let reply_id = replied["data"]["id"]
            .as_str()
            .unwrap()
            .split_once('@')
            .unwrap()
            .0;
        assert_eq!(messages[0]["id"], reply_id, "{read}");
        assert_eq!(messages[0]["from"], ada_address, "{read}");
        assert_eq!(messages[0]["text"], response, "{read}");
        assert_eq!(messages[0]["reply_to"], inbox_id, "{read}");
    }
    let inbox = ada.call("read_messages", json!({ "last": 10 }));
    assert_eq!(inbox["status"], "success", "{inbox}");
    let requests: Vec<_> = inbox["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        requests,
        ["Answer while I wait", "Answer after my send returns"]
    );
}

/// With YOLO off, a Guest starts and can reach a child but cannot reach a separate creation tree.
#[test]
fn a_guest_with_yolo_off_sees_the_agent_it_started() {
    let home = TestHome::new("guest-tree");
    std::fs::write(home.path.join("facade.json"), r#"{"yolo":false}"#).unwrap();
    let outside = home.run_facade_ok(&["start", "-d", "--name", "outside", "fake"]);
    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let work = home.project.to_str().expect("the isolated project path");
    let started = guest.call(
        "start_agent",
        json!({ "cli": "fake", "name": "helper", "folder": work }),
    );
    assert_eq!(started["status"], "success", "{started}");

    let roster = guest.call("list_agents", json!({}));
    assert_eq!(roster["status"], "success", "{roster}");
    let agents = roster["data"]["agents"].as_array().expect("the agent list");
    assert!(
        agents.iter().all(|row| row["id"] != started_ref(&outside)),
        "{roster}"
    );
    let helper = agents
        .iter()
        .find(|row| row["name"] == "helper")
        .expect("the Guest lists its own child");
    assert_eq!(helper["type"], "managed", "{helper}");
    let screen = guest.call("read_screen", json!({ "agent": helper["id"] }));
    assert_eq!(screen["status"], "success", "{screen}");
    let refused = guest.call("read_screen", json!({ "agent": "outside" }));
    assert_eq!(refused["reason"], "refused", "{refused}");
    assert!(!refused.to_string().contains(outside.trim()), "{refused}");
}

/// An external client can read long messages from the result and follow the returned cursor.
#[test]
fn guest_history_keeps_long_messages_inline_across_pages() {
    let home = TestHome::new("guest-pages");
    let (_, mut sender) = managed_relay(&home, "ada");
    let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let roster = guest.call("list_agents", json!({}));
    let guest_id = roster["data"]["agents"]
        .as_array()
        .expect("the roster")
        .iter()
        .find(|row| row["type"] == "guest")
        .expect("the external connection is listed")["id"]
        .as_str()
        .expect("the Guest address");
    let texts: Vec<String> = (1..=3)
        .map(|number| format!("Message {number} {}", "x".repeat(4_500)))
        .collect();
    for text in &texts {
        let pending = sender.send(
            "tools/call",
            json!({
                "name": "send_message",
                "arguments": { "to": guest_id, "text": text, "wait_for": "delivery", "timeout_seconds": 30 },
            }),
        );
        let read = guest.call("read_messages", json!({ "timeout_seconds": 30 }));
        assert_eq!(read["status"], "success", "{read}");
        assert_eq!(read["data"]["messages"][0]["text"], text.as_str(), "{read}");
        let sent = sender.tool_answer(pending);
        assert_eq!(sent["status"], "success", "{sent}");
        assert_eq!(sent["data"]["delivery"], "read_by_recipient", "{sent}");
    }

    let mut query = json!({ "last": texts.len() });
    for (index, text) in texts.iter().enumerate() {
        let read = guest.call("read_messages", query);
        assert_eq!(read["status"], "success", "{read}");
        let page = read["data"]["messages"]
            .as_array()
            .expect("inline messages");
        assert_eq!(
            page.len(),
            1,
            "two complete messages exceed the page target"
        );
        assert_eq!(page[0]["text"], text.as_str());
        assert!(read["data"].get("file").is_none());
        let cursor = &read["data"]["next_cursor"];
        if index + 1 < texts.len() {
            query = json!({ "after": cursor.as_str().expect("the next page cursor") });
        } else {
            assert!(cursor.is_null(), "the last page has no continuation");
            break;
        }
    }
}

/// The full active roster remains readable by an MCP client without access to the daemon's files.
#[test]
fn a_large_roster_matches_the_protocol_and_shell_rosters_inline() {
    let home = TestHome::new("large-roster");
    let (_, mut observer) = managed_relay(&home, "observer");
    let guests: Vec<_> = (0..56)
        .map(|_| {
            let mut guest = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
            let joined = guest.call("read_messages", json!({}));
            assert_eq!(joined["status"], "success", "{joined}");
            guest
        })
        .collect();

    let roster = home.agent_list();
    let mut rows = roster["agents"].as_array().expect("the v1 roster").clone();
    let table = home.list_table();
    assert_eq!(
        table.column("REFERENCE"),
        rows.iter()
            .map(|row| row["address"].as_str().unwrap())
            .collect::<Vec<_>>()
    );
    for row in &mut rows {
        let row = row.as_object_mut().unwrap();
        row.shift_remove("reference");
        let address = row.shift_remove("address").unwrap();
        row.insert("id".into(), address);
    }
    assert_eq!(rows.len(), guests.len() + 1);
    assert!(
        facade_scenarios::serde_json::to_string(&rows)
            .unwrap()
            .chars()
            .count()
            > 8_000,
        "the fixture crosses the old threshold for file results"
    );
    let mcp = observer.call("list_agents", json!({}));
    assert_eq!(mcp["status"], "success", "{mcp}");
    assert!(mcp["data"].get("file").is_none(), "{mcp}");
    assert_eq!(mcp["data"]["agents"], json!(rows));
}

/// A guest's server serves whatever its variables and words: a variable that is not UTF-8, which
/// JSON cannot carry, is left out of the environment it joins with, and a word that is not UTF-8
/// is left aside. Each joins as a Guest at its first tool call.
#[cfg(unix)]
#[test]
fn a_guest_server_with_a_variable_or_a_word_that_is_not_utf8_serves() {
    use std::os::unix::ffi::OsStrExt;
    let home = TestHome::new("notutf8server");
    connect(&home);
    let not_utf8 = std::ffi::OsStr::from_bytes(b"caf\xe9");
    let server = |session: &str, word: Option<&std::ffi::OsStr>| {
        let mut command = home.command(&test_binaries().mcp);
        command
            .args(["--guest", "claude"])
            .args(word)
            .env("CLAUDE_CODE_SESSION_ID", session)
            .env("PATH", home.path_with_test_programs());
        if word.is_none() {
            command.env("NOT_UTF8", not_utf8);
        }
        McpTestClient::spawn(&home, command)
    };
    let mut with_variable = server("c1", None);
    let listed = with_variable.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    assert_eq!(guest_rows(&home).len(), 1, "the first server joined");
    let mut with_word = server("c2", Some(not_utf8));
    let listed = with_word.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    assert_eq!(guest_rows(&home).len(), 2, "the second server joined");
}

/// Reports `session` as the session of `agent`'s run, as its CLI's session-start hook in the run
/// does.
fn report_run_session(home: &TestHome, agent: &str, session: &str) {
    let runs: Vec<_> = std::fs::read_dir(home.path.join("framework/runs").join(agent))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    let mut command = home.command(&test_binaries().facade);
    command
        .args(["hook", "session-start"])
        .arg(runs[0].join("session"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    let mut child = command.spawn().unwrap();
    let input = json!({ "hook_event_name": "SessionStart", "session_id": session });
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        input.to_string().as_bytes(),
    )
    .unwrap();
    assert!(child.wait().unwrap().success());
}

fn inspected(home: &TestHome, agent: &str) -> Value {
    home.inspect_agent(agent)["agent"].clone()
}

/// A session nested in a Facade Code Framework run of its own CLI, as `claude -p` that the run's model starts,
/// inherits the run's `FACADE_AGENT` and runs the CLI's own `facade-mcp` entry with a session of its
/// own: on all six CLIs it is a Guest of its own, and the run stays the run.
#[test]
fn a_session_nested_in_a_run_of_its_own_cli_is_a_guest_of_its_own() {
    let home = TestHome::new("nested");
    connect(&home);
    let folder = home.project.parent().unwrap().to_path_buf();
    let bin = folder.join("bin");
    // Only the test's stand-ins and the system's folders: no CLI installed for the person.
    let path = format!("{}{PATH_SEPARATOR}{}", bin.display(), SYSTEM_PATH.as_str());
    let tools = |server: &mut McpTestClient| {
        server.request("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .map_or(0, Vec::len)
    };
    for (index, cli) in ["claude", "codex", "opencode", "pi", "muse", "agy"]
        .into_iter()
        .enumerate()
    {
        stand_in(&bin, cli, &folder.join(format!("{cli}.argv")));
        let name = format!("{cli}run");
        let started = home
            .facade_in_an_empty_home()
            .env("PATH", &path)
            .args(["start", "-d", "--name", &name, cli])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            started.status.success(),
            "{cli}: {}{}",
            stdout(&started),
            stderr(&started)
        );
        let address = started_ref(&stdout(&started)).to_string();
        let run = started_id(&stdout(&started));
        // A run's session is reported as its CLI names it: a UUID here.
        let (own, nested) = (
            format!("0000000{index}-0000-4000-8000-000000000001"),
            format!("0000000{index}-0000-4000-8000-000000000002"),
        );
        report_run_session(&home, &run, &own);
        assert!(
            wait_until(secs(10), || inspected(&home, &address)["session"] == own),
            "{cli}: {}",
            inspected(&home, &address)
        );
        let variable = facade_rules::session_variable(cli).unwrap();
        let meta = json!({
            "sessionId": nested, "ai.opencode/sessionID": nested,
            "antigravity.google/root_conversation_id": nested,
        });
        let mut server =
            McpTestClient::open_guest(&home, cli, &[("FACADE_AGENT", &run), (variable, &nested)]);
        assert_eq!(
            server.initialized()["result"]["instructions"],
            facade_base::instructions::for_connection(),
            "{cli}: the nested session receives the Guest instructions"
        );
        assert_eq!(tools(&mut server), 8, "{cli}: the nested session's server");
        let listed = server.call_in("list_agents", json!({}), meta);
        assert_eq!(listed["status"], "success", "{cli}: {listed}");
        assert_eq!(
            guest_rows(&home).len(),
            1,
            "{cli}: the nested session is a Guest of its own"
        );
        assert_eq!(
            inspected(&home, &address)["type"],
            "managed",
            "{cli}: the run stays the run"
        );
        let (_, status) = server.close(secs(20));
        assert!(status.success(), "{cli}: {status:?}");
        assert!(
            wait_until(secs(10), || guest_rows(&home).is_empty()),
            "{cli}: the Guest stayed after its relay ended"
        );
    }
}

/// The environment of the process `pid` names, as the system has it.
fn environment_of(pid: u32) -> std::collections::BTreeMap<String, String> {
    let birth = facade_base::unix_process::birth(pid)
        .unwrap()
        .expect("the process runs");
    let identity = facade_base::process::ProcessIdentity { pid, birth };
    facade_base::unix_process::environment(&identity)
        .unwrap()
        .expect("its environment")
}

/// An agent a Guest starts gets none of the CLIs' session variables of the Guest's environment, and
/// a `facade` command in its terminal acts as the command line: its message is the command line's,
/// not the Guest's.
#[test]
fn a_started_agent_s_commands_act_for_it_not_for_the_guest_that_started_it() {
    let home = TestHome::new("guestinherit");
    let host = home.start_named_fake("host", &[]);
    let facade = sh_path(&test_binaries().facade);
    let script = format!(
        "env | grep -c _SESSION_ID; echo STARTED; read go; {facade} send {} from-the-helper; \
         sleep 60",
        host.address
    );
    // The helper is a custom program whose entry gives it the script.
    home.add_custom_cli_with("helper-sh", &shell(), &["-c", &script]);
    let mut guest = McpTestClient::spawn(&home, {
        let mut relay = home.command(&test_binaries().mcp);
        relay
            .env("OPENCODE_SESSION_ID", "ses_guest")
            .env("CLAUDE_CODE_SESSION_ID", "c-x");
        relay
    });
    let started = guest.call(
        "start_agent",
        json!({ "name": "helper", "cli": "helper-sh", "folder": home.project }),
    );
    assert_eq!(started["status"], "success", "{started}");
    let helper = started["data"]["id"].as_str().unwrap().to_string();
    assert!(
        wait_for_screen_text(&home, &helper, "STARTED"),
        "{}",
        home.screen(&helper)
    );
    assert!(
        home.screen(&helper).starts_with("0\n"),
        "the helper kept a session variable: {}",
        home.screen(&helper)
    );
    home.run_facade_ok(&["type", &helper, "--key", "Enter"]);
    assert!(
        wait_until(secs(10), || !home.submitted_messages().is_empty()),
        "no message reached the host: {}",
        home.screen(&helper)
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message m1 from command line\nfrom-the-helper"],
        "the message is the command line's, not the Guest's"
    );
}

/// A Guest's model starts an agent with `start_agent`, which runs with the environment the Guest's
/// connection came with: its `facade-mcp`'s (PM 32).
#[test]
fn a_guest_starts_an_agent_with_its_cli_s_environment() {
    let home = TestHome::new("gueststart");
    let mut guest = McpTestClient::spawn(&home, {
        let mut relay = home.command(&test_binaries().mcp);
        relay.env("GUEST_MARK", "server");
        relay
    });
    let started = guest.call(
        "start_agent",
        json!({ "name": "first", "cli": "fake", "folder": home.project }),
    );
    assert_eq!(started["status"], "success", "{started}");
    let pid = home.agent_from_watch("first").expect("the agent is listed")["pid"]
        .as_u64()
        .expect("a pid") as u32;
    assert_eq!(
        environment_of(pid).get("GUEST_MARK").map(String::as_str),
        Some("server")
    );
}

/// The Guests of the active daemon roster.
fn guest_rows(home: &TestHome) -> Vec<Value> {
    let listed = home.agent_list();
    listed["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|agent| agent["type"] == "guest")
        .cloned()
        .collect()
}

/// A `facade-mcp` outside any Facade Code Framework run, as an MCP client that is none of the CLIs runs it. It is
/// a Guest from its first tool call, and listed from then on. Returns it and its roster row.
fn member(home: &TestHome) -> (McpTestClient, Value) {
    let mut member = McpTestClient::spawn(home, home.command(&test_binaries().mcp));
    assert!(
        guest_rows(home).is_empty(),
        "a connection is listed only once it calls a tool"
    );
    let listed = member.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    let rows = guest_rows(home);
    assert_eq!(rows.len(), 1, "{rows:?}");
    (member, rows[0].clone())
}

/// Any MCP client becomes a Guest at its first tool call: it is listed while its connection
/// lasts, takes the message sent to it with `read_messages`, which delivers it, and leaves with its
/// relay.
#[test]
fn an_mcp_client_joins_as_a_member_reads_its_messages_and_leaves_with_its_relay() {
    let home = TestHome::new("member");
    let ada = home.start_named_fake("ada", &[]);
    let (mut member, record) = member(&home);
    let address = record["address"].as_str().unwrap().to_string();
    let mut sender = McpTestClient::open(&home, &ada.id);
    let sending = sender.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": { "to": address, "text": "for the member", "wait_for": "delivery", "timeout_seconds": 30 },
        }),
    );
    let read = member.call("read_messages", json!({ "timeout_seconds": 30 }));
    assert_eq!(
        read["data"]["messages"][0]["text"], "for the member",
        "{read}"
    );
    let sent = sender.tool_answer(sending);
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["delivery"], "read_by_recipient", "{sent}");
    let (_, status) = member.close(secs(20));
    assert!(status.success(), "{status:?}");
    assert!(
        wait_until(secs(10), || guest_rows(&home).is_empty()),
        "the Guest stayed after its relay ended: {}",
        home.run_facade_ok(&["list"])
    );
}

/// A recipient leaving before it reads ends the delivery wait with the number Facade Code Framework assigned.
#[test]
fn a_guest_leaving_before_read_keeps_the_admitted_message_id() {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};

    let home = TestHome::new("guest-leaves");
    std::fs::write(home.path.join("facade.json"), r#"{"yolo":true}"#).unwrap();
    let (mut sender, sender_row) = member(&home);
    let mut recipient = McpTestClient::spawn(&home, home.command(&test_binaries().mcp));
    let listed = recipient.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    let guests = guest_rows(&home);
    assert_eq!(guests.len(), 2, "{guests:?}");
    let recipient_row = guests
        .iter()
        .find(|row| row["reference"] != sender_row["reference"])
        .expect("the other Guest");
    let address = recipient_row["address"].as_str().unwrap();
    let recipient_id = recipient_row["reference"]["agent_id"].as_str().unwrap();
    let machine = recipient_row["reference"]["machine_id"].as_str().unwrap();

    let text = "Waiting for the Guest to read";
    let send = sender.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": { "to": address, "text": text, "wait_for": "delivery", "timeout_seconds": 30 },
        }),
    );
    let db = Connection::open_with_flags(
        home.path.join("framework/facade.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut number = None;
    assert!(wait_until(secs(10), || {
        number = db
            .query_row(
                "SELECT number FROM messages WHERE \"to\" = ?1 AND text = ?2 AND status = 'pending'",
                [recipient_id, text],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .unwrap();
        number.is_some()
    }));
    let expected = facade_base::address::selector::format_message_address(
        &format!("m{}", number.unwrap()),
        machine,
    );
    drop(db);
    let (_, closed) = recipient.close(secs(10));
    assert!(closed.success(), "{closed:?}");

    let ended = sender.tool_answer(send);
    assert_eq!(ended["status"], "failure", "{ended}");
    assert_eq!(ended["reason"], "ended", "{ended}");
    assert_eq!(ended["data"]["id"], expected, "{ended}");
    assert!(ended["data"].get("delivery").is_none(), "{ended}");
}

/// A Guest outlasts the daemon: its relay reconnects to the next daemon, which knows it by the same
/// address, and a message sent to it across the restart reaches it once it reads.
#[test]
fn a_member_and_what_waits_for_it_outlast_a_daemon_restart() {
    let home = TestHome::new("memberkept");
    let ada = home.start_named_fake("ada", &[]);
    let (mut member, record) = member(&home);
    let address = record["address"].as_str().unwrap().to_string();
    let mut sender = McpTestClient::open(&home, &ada.id);
    let sending = sender.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": {
                "to": address, "text": "kept for the member",
                "wait_for": "delivery", "timeout_seconds": 30,
            },
        }),
    );
    let old = home.kill_daemon();
    assert!(
        wait_until(secs(10), || home
            .hello_result()
            .is_some_and(|hello| hello["pid"].as_i64() != Some(old as i64))),
        "no daemon took over"
    );
    let read = member.call("read_messages", json!({ "timeout_seconds": 30 }));
    assert_eq!(
        read["data"]["messages"][0]["text"], "kept for the member",
        "{read}"
    );
    let sent = sender.tool_answer(sending);
    assert_eq!(sent["status"], "success", "{sent}");
    assert_eq!(sent["data"]["delivery"], "read_by_recipient", "{sent}");
    let kept = guest_rows(&home);
    assert_eq!(
        kept.iter().map(|row| &row["address"]).collect::<Vec<_>>(),
        [&json!(address)],
        "{kept:?}"
    );
}

/// A read delivers only the messages it returns: `last` takes the newest of the inbox, and the rest
/// wait to be read; a read that fills a page says where the next one starts, and what it did not
/// return is still unread. Each send is answered once its message is read.
#[test]
fn a_read_delivers_only_what_it_returns_and_last_is_the_newest() {
    let home = TestHome::new("memberread");
    let ada = home.start_named_fake("ada", &[]);
    let (mut member, record) = member(&home);
    let address = record["address"].as_str().unwrap().to_string();
    let id = address.split_once('@').unwrap().0.to_string();
    let mut sender = McpTestClient::open(&home, &ada.id);
    let text = |n: u32| {
        if matches!(n, 4 | 5) {
            format!("message {n} {}", "x".repeat(4_500))
        } else {
            format!("message {n}")
        }
    };
    // Sends the messages one by one, each once the one before waits in the inbox, so that the
    // inbox has them in this order. Returns the calls, which their reads answer.
    let mut send = |numbers: std::ops::RangeInclusive<u32>| -> Vec<u64> {
        numbers
            .map(|n| {
                let waiting = waiting_for(&home, &id);
                let arguments = json!({
                    "to": address, "text": text(n), "wait_for": "delivery", "timeout_seconds": 30,
                });
                let call = sender.send(
                    "tools/call",
                    json!({ "name": "send_message", "arguments": arguments }),
                );
                assert!(
                    wait_until(secs(10), || waiting_for(&home, &id) == waiting + 1),
                    "message {n} does not wait for the Guest"
                );
                call
            })
            .collect()
    };
    let mut read = |arguments: Value| {
        let read = member.call("read_messages", arguments);
        assert_eq!(read["status"], "success", "{read}");
        assert!(read["data"].get("next").is_none(), "{read}");
        let texts: Vec<String> = read["data"]["messages"]
            .as_array()
            .expect("inline messages")
            .iter()
            .map(|message| message["text"].as_str().unwrap().to_string())
            .collect();
        (texts, read["data"].get("next_cursor").cloned())
    };
    let numbered =
        |numbers: std::ops::RangeInclusive<u32>| -> Vec<String> { numbers.map(text).collect() };

    let first = send(1..=3);
    assert_eq!(read(json!({ "last": 1 })), (numbered(3..=3), None));
    assert_eq!(
        read(json!({})),
        (numbered(1..=2), None),
        "the older two wait"
    );
    assert_eq!(read(json!({})), (Vec::new(), None));

    let second = send(4..=5);
    let (page, next) = read(json!({}));
    assert_eq!(page, numbered(4..=4), "two long messages exceed a page");
    let next = next.expect("a cursor for the next page");
    assert_eq!(
        read(json!({ "after": next })),
        (numbered(5..=5), None),
        "what the first page did not return was not delivered"
    );
    for call in first.into_iter().chain(second) {
        let sent = sender.tool_answer(call);
        assert_eq!(sent["status"], "success", "{sent}");
        assert_eq!(sent["data"]["delivery"], "read_by_recipient", "{sent}");
    }
}

/// How many messages wait in agent `id`'s inbox, as the store keeps them. A Guest's waiting
/// messages show through the protocol only as it reads them, which delivers them.
fn waiting_for(home: &TestHome, id: &str) -> i64 {
    let connection = rusqlite::Connection::open(home.path.join("framework/facade.db")).unwrap();
    connection
        .query_row(
            "SELECT count(*) FROM messages WHERE \"to\" = ?1 AND status = 'pending'",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}
