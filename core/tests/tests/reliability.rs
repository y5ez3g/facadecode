//! Reliability (MCP-1.1, 1.2, 1.3; RULES-1.2, 5.2): a send or a start repeated by its request ID
//! answers what the first call did, across a daemon restart too, and does nothing again; a
//! cancelled send whose paste has not begun is withdrawn, through the protocol's `cancel` or MCP's
//! `notifications/cancelled`, and kept nowhere; and a send's 30 seconds count from facade-mcp,
//! across its hop to the daemon.

use std::time::Duration;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Puts a draft into the agent's input, as a person typing does, and waits until its screen shows
/// it: a message waits behind it, its paste not begun.
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

/// Clears the agent's draft, as a person's Ctrl+C does, so the messages waiting go in.
fn clear_draft(home: &TestHome, agent: &str) {
    home.run_facade_ok(&["type", agent, "--key", "Ctrl+C"]);
}

/// The IDs of the messages agent `agent`'s own `read_messages` gives with `arguments`.
fn read_ids(home: &TestHome, agent: &str, arguments: Value) -> Vec<String> {
    let read = McpTestClient::open_configured(home, agent).call("read_messages", arguments);
    assert_eq!(read["status"], "success", "{read}");
    read["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["id"].as_str().unwrap().to_string())
        .collect()
}

/// The facts of a send's receipt: its message's ID and delivery status, and whether it repeated
/// an earlier call.
fn facts(answer: &Value) -> (&Value, &Value, Option<&Value>) {
    let result = &answer["result"];
    (
        &result["message"]["message_id"],
        &result["message"]["delivery"]["status"],
        result.get("repeated"),
    )
}

/// The start of the test CLI as agent `name` in the test project, as a client asks for it.
fn fake_start(home: &TestHome, name: &str) -> Value {
    json!({
        "cli": "fake", "name": name, "folder": home.project,
        "env": { "PATH": home.path_with_test_programs() }, "size": { "cols": 80, "rows": 24 },
    })
}

/// `facade.db`, opened beside the running daemon.
fn store(home: &TestHome) -> rusqlite::Connection {
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    connection.busy_timeout(secs(5)).unwrap();
    connection
}

/// Message `number`'s delivery status and request ID, as `facade.db` keeps them: read from the
/// store itself, since a read through Facade would deliver it, and a send's receipt comes only
/// once it is settled. None where it is not kept.
fn kept(home: &TestHome, number: u64) -> Option<(String, Option<String>)> {
    store(home)
        .query_row(
            "SELECT status, request_id FROM messages WHERE number = ?1",
            [number as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()
}

/// How many messages `facade.db` keeps whose text is `text`.
fn kept_with_text(home: &TestHome, text: &str) -> i64 {
    store(home)
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE text = ?1",
            [text],
            |row| row.get(0),
        )
        .unwrap()
}

/// How many of the texts the fake CLI submitted hold `text`.
fn typed(home: &TestHome, text: &str) -> usize {
    home.submitted_messages()
        .iter()
        .filter(|submitted| submitted.contains(text))
        .count()
}

/// Moves message `number`'s sending time back to `at`, as the hour passing would.
fn sent_at(home: &TestHome, number: u64, at: &str) {
    store(home)
        .execute(
            "UPDATE messages SET at = ?1 WHERE number = ?2",
            rusqlite::params![at, number as i64],
        )
        .unwrap();
}

/// A send repeated by its request ID answers its first message as it stands, `repeated`, and types
/// nothing again; another sender's same ID, a refused send's ID and an ID older than the hour send
/// anew.
#[test]
fn a_send_repeated_by_its_request_id_answers_its_message_and_types_it_once() {
    let home = TestHome::new("relsend");
    home.start_named_fake("worker", &[]);
    let boss = home.start_named_fake("boss", &[]);
    let carol = home.start_named_fake("carol", &[]);
    let mut person = connect(&home);
    let send = |wire: &mut DaemonTestClient, text: &str, request: &str| {
        wire.call(
            "agent.send",
            json!({ "to": "worker", "text": text, "request_id": request }),
        )
    };
    let first = send(&mut person, "hello", "r1");
    assert_eq!(
        facts(&first),
        (&json!("m1"), &json!("success"), None),
        "{first}"
    );
    let again = send(&mut person, "hello again", "r1");
    assert_eq!(
        (facts(&again), &again["result"]["message"]["text"]),
        (
            (&json!("m1"), &json!("success"), Some(&json!(true))),
            &json!("hello")
        ),
        "the first message, whatever the repeat says: {again}"
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from the command line · m1\nhello"],
        "typed once"
    );
    // Two agents' relays, both run by this test's process, give their first calls the same
    // request ID: each sender's is its own.
    let theirs: Vec<Value> = [&boss.id, &carol.id]
        .map(|agent| {
            McpTestClient::relay_configured(&home, agent).call(
                "send_message",
                json!({ "to": "worker", "text": format!("from {agent}") }),
            )
        })
        .into_iter()
        .collect();
    let receipts: Vec<&str> = theirs
        .iter()
        .map(|sent| {
            assert_eq!(sent["status"], "success", "{sent}");
            sent["data"]["id"].as_str().unwrap()
        })
        .collect();
    assert!(
        receipts[0].starts_with("m2@") && receipts[1].starts_with("m3@"),
        "another sender's own: {theirs:?}"
    );
    let refused = person.call(
        "agent.send",
        json!({ "to": "nobody", "text": "lost", "request_id": "r2" }),
    );
    assert_eq!(error_reason(&refused), "not_found", "{refused}");
    assert_eq!(
        facts(&send(&mut person, "found", "r2")).0,
        "m4",
        "a refused send keeps nothing"
    );
    sent_at(&home, 1, "2020-01-01T00:00:00.000Z");
    let later = send(&mut person, "an hour later", "r1");
    assert_eq!(
        facts(&later),
        (&json!("m5"), &json!("success"), None),
        "after the hour: {later}"
    );
    assert_eq!(typed(&home, "hello"), 1);
    home.run_facade_ok(&["stop", "worker"]);
    let ended = send(&mut person, "to an ended agent", "r1");
    assert_eq!(
        facts(&ended),
        (&json!("m5"), &json!("success"), Some(&json!(true))),
        "looked for before `to` is: {ended}"
    );
}

/// The daemon takes a request ID of 1 to 200 characters, on a send and a start alike, and refuses
/// any other before it does anything. facade-mcp's tools stop a longer one first, so only a client
/// of the daemon meets this.
#[test]
fn a_request_id_of_1_to_200_characters_is_taken_and_any_other_refused() {
    let home = TestHome::new("relidlength");
    home.start_named_fake("worker", &[]);
    let mut person = connect(&home);
    let send = |person: &mut DaemonTestClient, id: &str| {
        person.call(
            "agent.send",
            json!({ "to": "worker", "text": "hi", "request_id": id }),
        )
    };
    let start = |id: &str| {
        let mut start = fake_start(&home, "helper");
        start["request_id"] = json!(id);
        start
    };
    for id in [String::new(), "r".repeat(201)] {
        let refused = send(&mut person, &id);
        assert_eq!(
            error_reason(&refused),
            "invalid_argument",
            "{} characters: {refused}",
            id.len()
        );
        let refused = person.call("agent.start", start(&id));
        assert_eq!(
            error_reason(&refused),
            "invalid_argument",
            "{} characters: {refused}",
            id.len()
        );
    }
    assert_eq!(home.agents().len(), 1, "nothing started");
    let taken = send(&mut person, &"r".repeat(200));
    assert_eq!(
        facts(&taken),
        (&json!("m1"), &json!("success"), None),
        "nothing was sent before: {taken}"
    );
}

/// A send to a Guest is delivered once the Guest's read takes it, and its repeat by its request ID
/// is answered at once as the first call was: it waits for no read again.
#[test]
fn a_repeated_send_to_a_guest_is_answered_at_once_as_its_first_call_was() {
    let home = TestHome::new("relguest");
    connect(&home);
    // A facade-mcp connection that no managed agent's run made is a Guest, listed from its first
    // tool call.
    let mut guest = McpTestClient::relay(&home, &[], &[]);
    let listed = guest.call("list_agents", json!({}));
    assert_eq!(listed["status"], "success", "{listed}");
    let address = home
        .agents()
        .into_iter()
        .find(|agent| agent["type"] == "guest")
        .unwrap_or_else(|| panic!("no Guest is listed: {:?}", home.agents()))["address"]
        .as_str()
        .unwrap()
        .to_string();
    let mut person = connect(&home);
    let send = json!({ "to": address, "text": "read me", "request_id": "g1" });
    let sending = person.send("call", json!({ "op": "agent.send", "args": send.clone() }));
    let read = guest.call("read_messages", json!({ "wait": true }));
    assert_eq!(read["data"]["messages"][0]["id"], "m1", "{read}");
    let first = person
        .wait_for_response(sending, secs(10))
        .expect("the send answers once the Guest takes its message");
    assert_eq!(
        (
            facts(&first),
            &first["result"]["message"]["delivery"]["delivered_via"]
        ),
        ((&json!("m1"), &json!("success"), None), &json!("read")),
        "{first}"
    );
    let asked = std::time::Instant::now();
    let again = person.call("agent.send", send);
    assert!(asked.elapsed() < secs(5), "answered at once");
    assert_eq!(
        (facts(&again), &again["result"]["message"]["delivery"]),
        (
            (&json!("m1"), &json!("success"), Some(&json!(true))),
            &first["result"]["message"]["delivery"]
        ),
        "{again}"
    );
}

/// A repeat while the first send's message waits joins its delivery, and two calls with one ID at
/// once keep one message: both answer it once it is typed, once.
#[test]
fn calls_with_one_request_id_at_once_keep_one_message_and_both_answer_it() {
    let home = TestHome::new("relsendjoin");
    let worker = home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (mut one, mut two) = (connect(&home), connect(&home));
    let call = json!({
        "op": "agent.send", "args": { "to": "worker", "text": "once", "request_id": "r1" },
    });
    let (first, second) = (one.send("call", call.clone()), two.send("call", call));
    assert!(
        wait_until(secs(10), || kept(&home, 1)
            .is_some_and(|kept| kept.0 == "pending")),
        "{:?}",
        kept(&home, 1)
    );
    std::thread::sleep(Duration::from_millis(500));
    clear_draft(&home, "worker");
    let answers = [
        one.wait_for_response(first, secs(30)).expect("an answer"),
        two.wait_for_response(second, secs(30)).expect("an answer"),
    ];
    for answer in &answers {
        assert_eq!(
            (facts(answer).0, facts(answer).1),
            (&json!("m1"), &json!("success")),
            "{answer}"
        );
    }
    assert_eq!(
        answers
            .iter()
            .filter(|answer| answer["result"]["repeated"] == true)
            .count(),
        1,
        "{answers:?}"
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from the command line · m1\nonce"]
    );
    assert_eq!(
        read_ids(&home, &worker.id, json!({ "last": 10 })),
        ["m1"],
        "one message"
    );
}

/// A send cut off by a daemon restart goes again by the request ID its relay made: the repeat joins
/// the message the next daemon took up, and the call answers what became of it, typed once. A
/// send withdrawn before typing also answers with its original settlement on a new connection.
/// Stopping or removing the original recipient leaves these receipts bound to that recipient,
/// even when the sender's daemon restarts after a replacement takes the same name.
#[test]
fn a_send_cut_off_by_a_restart_is_repeated_by_its_request_id_and_typed_once() {
    let home = TestHome::new("relrestart");
    let worker = home.start_named_fake("worker", &[]);
    let boss = home.start_named_fake("boss", &[]);
    type_draft(&home, "worker", "my draft");
    let mut boss = McpTestClient::open_configured(&home, &boss.id);
    let own = boss.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": { "to": "worker", "text": "survive" },
        }),
    );
    let made = boss.send(
        "tools/call",
        json!({ "name": "send_message", "arguments": { "to": "worker", "text": "also" } }),
    );
    assert!(
        wait_until(secs(10), || kept(&home, 1).is_some()
            && kept(&home, 2).is_some()),
        "both kept"
    );
    let request_ids = [1, 2].map(|number| {
        kept(&home, number)
            .unwrap()
            .1
            .expect("every send carries a request ID")
    });
    assert_ne!(
        request_ids[0], request_ids[1],
        "each new send gets its own ID"
    );
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    clear_draft(&home, "worker");
    for (call, text) in [(own, "survive"), (made, "also")] {
        let receipt = boss.tool_answer(call);
        assert_eq!(receipt["status"], "success", "{receipt}");
        let address = receipt["data"]["id"].as_str().expect("the send receipt");
        let (id, machine) = address
            .split_once('@')
            .expect("a machine-qualified receipt");
        assert!(!machine.is_empty(), "{receipt}");
        assert!(receipt["data"].get("repeated").is_none(), "{receipt}");
        assert!(receipt["data"].get("request_id").is_none(), "{receipt}");
        let number: i64 = store(&home)
            .query_row(
                "SELECT number FROM messages WHERE text = ?1",
                [text],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(id, format!("m{number}"), "{receipt}");
        assert_eq!(kept_with_text(&home, text), 1, "the original row survives");
    }
    for (index, request_id) in request_ids.into_iter().enumerate() {
        assert_eq!(kept(&home, index as u64 + 1).unwrap().1, Some(request_id));
    }
    assert!(
        wait_until(secs(30), || typed(&home, "also") == 1),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        typed(&home, "survive"),
        1,
        "typed once: {:?}",
        home.submitted_messages()
    );

    type_draft(&home, "worker", "my next draft");
    let withdrawn_args = json!({
        "to": "worker",
        "text": "this one expired before delivery",
        "request_id": "withdrawn-during-reconnect",
        "time_left_ms": 2_000,
    });
    let first = connect(&home).call("agent.send", withdrawn_args.clone());
    let withdrawn = &first["result"];
    assert_eq!(withdrawn["withdrawn"], true, "{first}");
    assert_eq!(
        withdrawn["message"]["delivery"]["status"], "failure",
        "{first}"
    );
    assert_eq!(withdrawn["message"]["message_id"], "m3", "{first}");

    let repeated = |connection: &mut DaemonTestClient, args, original: &Value| {
        let replay = connection.call("agent.send", args);
        let result = &replay["result"];
        assert_eq!(result["repeated"], true, "{replay}");
        assert_eq!(result["id"], original["id"], "{replay}");
        assert_eq!(
            result.get("withdrawn"),
            original.get("withdrawn"),
            "{replay}"
        );
        assert_eq!(result["message"]["to"], worker.id, "{replay}");
        assert_eq!(
            result["message"]["delivery"], original["message"]["delivery"],
            "the repeat returns the original delivery result: {replay}"
        );
    };
    clear_draft(&home, "worker");
    let mut reconnected = connect(&home);
    repeated(&mut reconnected, withdrawn_args.clone(), withdrawn);
    let mut inbox = McpTestClient::open_configured(&home, &worker.id);
    let history = inbox.call("read_messages", json!({ "last": 10 }));
    assert_eq!(history["status"], "success", "{history}");
    let kept = history["data"]["messages"]
        .as_array()
        .expect("inline history");
    assert_eq!(kept.len(), 2, "{history}");
    assert!(
        kept.iter().all(|message| message["id"] != "m3"),
        "{history}"
    );
    drop(inbox);

    let success_args = json!({
        "to": "worker", "text": "new request", "request_id": "success-before-removal"
    });
    let sent = reconnected.call("agent.send", success_args.clone());
    let success = &sent["result"];
    assert_eq!(success["message"]["message_id"], "m4", "{sent}");
    assert_eq!(
        success["message"]["delivery"]["status"], "success",
        "{sent}"
    );

    home.run_facade_ok(&["stop", "worker"]);
    repeated(&mut reconnected, withdrawn_args.clone(), withdrawn);
    repeated(&mut reconnected, success_args.clone(), success);
    let ended = reconnected.call(
        "agent.send",
        json!({ "to": "worker", "text": "a fresh request", "request_id": "new-while-stopped" }),
    );
    assert_eq!(error_reason(&ended), "ended", "{ended}");

    home.remove_agent("worker");
    let replacement = home.start_named_fake("worker", &[]);
    assert_ne!(replacement.id, worker.id);
    drop(reconnected);
    let origin = home.kill_daemon();
    home.wait_for_daemon_after(origin, secs(30))
        .expect("the sending daemon restarts while the replacement is running");
    let mut reconnected = connect(&home);
    repeated(&mut reconnected, withdrawn_args, withdrawn);
    repeated(&mut reconnected, success_args, success);

    let next = reconnected.call(
        "agent.send",
        json!({ "to": "worker", "text": "for the replacement", "request_id": "new-send" }),
    );
    assert_eq!(next["result"]["message"]["message_id"], "m5", "{next}");
    assert_eq!(next["result"]["message"]["to"], replacement.id, "{next}");
    assert_eq!(typed(&home, "this one expired before delivery"), 0);
    assert_eq!(typed(&home, "new request"), 1);
    assert_eq!(typed(&home, "for the replacement"), 1);
}

/// A committed start survives the loss of its reply and a daemon restart, with its original CLI.
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn a_start_whose_reply_is_lost_is_replayed_after_a_daemon_restart() {
    let home = TestHome::new("relstartlost");
    let gate = "after-start-record";
    home.start_facade_with(&[("FACADE_TEST_GATES", gate)]);
    let keeper = home.lock_record("keeper").expect("the original keeper");
    let launches = home.project.join("launches");
    let mut args = fake_start(&home, "worker");
    args["request_id"] = json!("lost-start");
    args["env"]["FAKECLI_STARTS"] = json!(launches);
    args["env"]["FAKECLI_LOG"] = json!(home.fake_log);

    let mut first = ManualReadClient::open(&home);
    first.send(1, "call", json!({ "op": "agent.start", "args": args }));
    home.wait_for_gate(gate);
    // The record is durable and the call cannot answer while it is held here.
    drop(first);
    home.release_gate(gate);

    assert!(wait_until(LOADED_TIMEOUT, || home
        .listed_agent("worker")
        .is_some()));
    let original = home.inspect_agent("worker")["agent"].clone();
    let address = original["address"].as_str().unwrap();
    let pid = original["pid"].as_i64().unwrap() as i32;
    let process = process_identity(pid);
    assert_eq!(original["cli"], "fake");
    let folder = original["cwd"].as_str().unwrap();
    assert_eq!(
        facade_base::files::real_path(std::path::Path::new(folder)).unwrap(),
        facade_base::files::real_path(&home.project).unwrap()
    );
    let attach = || {
        TestTerminal::spawn(
            home.command(&test_binaries().facade)
                .args(["attach", address]),
            80,
            24,
        )
    };
    let mut terminal = attach();
    assert!(terminal.wait_for(LOADED_TIMEOUT, |screen| screen.contains("❯")));
    terminal.send(b"before restart");
    assert!(terminal.wait_for(LOADED_TIMEOUT, |screen| screen.contains("❯ before restart")));
    terminal.send(b"\x1d");
    assert!(
        terminal
            .wait_exit(LOADED_TIMEOUT)
            .is_some_and(|exit| exit.success())
    );
    assert!(home.submitted_messages().is_empty());

    let old = home.kill_daemon();
    let new = home
        .wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("a replacement daemon");
    let replayed = connect(&home).call_ok("agent.start", args);
    assert_eq!(replayed["repeated"], true, "{replayed}");
    assert_eq!(replayed["agent"]["reference"], original["reference"]);
    assert_eq!(replayed["agent"]["address"], address);
    assert_eq!(replayed["agent"]["cwd"], folder);
    assert_eq!(replayed["agent"]["pid"], pid);
    assert_eq!(process_identity(pid), process);
    assert_eq!(home.lock_record("keeper"), Some(keeper));
    let agents = home.agents();
    assert_eq!(agents.len(), 1, "{agents:?}");
    assert_eq!(agents[0]["reference"], original["reference"]);

    let mut terminal = attach();
    assert!(terminal.wait_for(LOADED_TIMEOUT, |screen| screen.contains("❯ before restart")));
    terminal.send(b" and after\r");
    assert!(terminal.wait_for(LOADED_TIMEOUT, |screen| {
        screen.contains("> before restart and after")
    }));
    assert_eq!(home.submitted_messages(), ["before restart and after"]);
    assert_eq!(
        std::fs::read_to_string(launches).unwrap(),
        format!("{pid}\n")
    );
    terminal.send(b"\x1d");
    assert!(
        terminal
            .wait_exit(LOADED_TIMEOUT)
            .is_some_and(|exit| exit.success())
    );
    println!("daemon {old} -> {new}, one launch of {address} with process {process:?}");
}

/// Two starts with one request ID at once start one agent: the second waits for the first's answer
/// and gives it.
#[test]
fn two_starts_with_one_request_id_at_once_start_one_agent() {
    let home = TestHome::new("relstarttwo");
    home.start_facade_with(&[("FACADE_TEST_GATES", "after-run-start-response")]);
    let (mut one, mut two) = (connect(&home), connect(&home));
    let mut args = fake_start(&home, "helper");
    args["request_id"] = json!("s1");
    let first = one.send("call", json!({ "op": "agent.start", "args": args.clone() }));
    home.wait_for_gate("after-run-start-response");
    let second = two.send("call", json!({ "op": "agent.start", "args": args }));
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        two.wait_for_response(second, Duration::from_millis(100))
            .is_none(),
        "the second waits for the first"
    );
    home.release_gate("after-run-start-response");
    let answers = [
        one.wait_for_response(first, secs(30)).expect("an answer"),
        two.wait_for_response(second, secs(30)).expect("an answer"),
    ];
    for answer in &answers {
        assert_eq!(
            answer["result"]["agent"]["reference"]["agent_id"], "a1",
            "{answer}"
        );
    }
    assert_eq!(answers[1]["result"]["repeated"], true);
    assert_eq!(home.agents().len(), 1, "one agent");
}

/// A git repository with one commit on `main`, made without the person's own Git settings.
fn repository(folder: &std::path::Path) {
    std::fs::create_dir_all(folder).unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &[
            "-c",
            "user.name=Facade",
            "-c",
            "user.email=facade@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "first",
        ],
    ] {
        let done = std::process::Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            done.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&done.stderr)
        );
    }
}

/// A start repeated by its request ID with a worktree makes no second worktree: its repeat answers
/// the agent the first started in the one it made, before Git is asked again.
#[test]
fn a_repeated_start_with_a_worktree_makes_no_second_worktree() {
    let home = TestHome::new("relworktree");
    let repo = home.project.parent().unwrap().join("repo");
    repository(&repo);
    let mut person = connect(&home);
    let mut args = fake_start(&home, "branch");
    args["folder"] = json!(repo);
    args["request_id"] = json!("w1");
    args["worktree"] = json!("feat-x");
    let first = person.call("agent.start", args.clone());
    let cwd = first["result"]["agent"]["cwd"]
        .as_str()
        .unwrap_or_else(|| panic!("{first}"))
        .to_string();
    assert!(
        std::path::Path::new(&cwd).ends_with(std::path::Path::new("repo.worktrees").join("feat-x")),
        "{cwd}"
    );
    let again = person.call("agent.start", args);
    assert_eq!(
        (
            &again["result"]["agent"]["reference"]["agent_id"],
            &again["result"]["repeated"]
        ),
        (&json!("a1"), &json!(true)),
        "{again}"
    );
    let listed = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&listed.stdout)
            .matches("worktree ")
            .count(),
        2,
        "the checkout and one worktree"
    );
}

/// A send whose message waits behind a draft is withdrawn by its client's `cancel`: it answers
/// `cancelled`, nothing of it is typed, no read returns it, and its number is not given again. A
/// `cancel` with an ID of its own is answered `{}`; one of a send already answered changes nothing.
#[test]
fn a_cancelled_send_whose_paste_has_not_begun_is_withdrawn_and_kept_nowhere() {
    let home = TestHome::new("relcancel");
    let worker = home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let mut person = connect(&home);
    let sending = person.send(
        "call",
        json!({ "op": "agent.send", "args": { "to": "worker", "text": "withdraw me" } }),
    );
    assert!(wait_until(secs(10), || kept(&home, 1).is_some()));
    let cancelled = person.request("cancel", json!({ "id": sending }));
    assert_eq!(cancelled["result"], json!({}), "{cancelled}");
    let answer = person
        .wait_for_response(sending, secs(10))
        .expect("the send answers");
    assert_eq!(error_reason(&answer), "cancelled", "{answer}");
    assert!(
        read_ids(&home, &worker.id, json!({})).is_empty(),
        "no read returns it"
    );
    clear_draft(&home, "worker");
    let next = person.call("agent.send", json!({ "to": "worker", "text": "after" }));
    assert_eq!(
        facts(&next),
        (&json!("m2"), &json!("success"), None),
        "its number is not given again: {next}"
    );
    assert_eq!(
        read_ids(&home, &worker.id, json!({ "last": 10 })),
        ["m2"],
        "kept nowhere"
    );
    assert!(
        !home
            .submitted_messages()
            .iter()
            .any(|text| text.contains("withdraw me")),
        "{:?}",
        home.submitted_messages()
    );
    let late = person.request("cancel", json!({ "id": 999 }));
    assert_eq!(
        late["result"],
        json!({}),
        "a call no longer under way is left as it ended"
    );
}

/// A `cancel` at the beginning of a paste races it under the lock that guards that beginning:
/// either the paste began and the send goes on, typed, or the message is withdrawn and nothing of
/// it is typed. Held at that beginning, the cancel wins.
#[test]
fn a_cancel_at_the_beginning_of_a_paste_wins_or_loses_whole() {
    let home = TestHome::new("relcancelrace");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-paste-begins")]);
    home.start_named_fake("worker", &[]);
    let mut person = connect(&home);
    let held = person.send(
        "call",
        json!({ "op": "agent.send", "args": { "to": "worker", "text": "held at its paste" } }),
    );
    home.wait_for_gate("before-paste-begins");
    person.write(&json!({ "jsonrpc": "2.0", "method": "cancel", "params": { "id": held } }));
    std::thread::sleep(Duration::from_millis(300));
    home.release_gate("before-paste-begins");
    assert_eq!(
        error_reason(&person.wait_for_response(held, secs(10)).expect("an answer")),
        "cancelled"
    );
    // The gate holds only its first paste: each later one races its cancel.
    for round in 0..3 {
        let text = format!("raced {round}");
        let sending = person.send(
            "call",
            json!({ "op": "agent.send", "args": { "to": "worker", "text": text } }),
        );
        person.write(&json!({ "jsonrpc": "2.0", "method": "cancel", "params": { "id": sending } }));
        let answer = person
            .wait_for_response(sending, secs(30))
            .expect("an answer");
        std::thread::sleep(Duration::from_millis(500));
        match error_reason(&answer) {
            "cancelled" => assert_eq!(
                (typed(&home, &text), kept_with_text(&home, &text)),
                (0, 0),
                "withdrawn whole: {answer}"
            ),
            _ => assert_eq!(
                (
                    answer["result"]["message"]["delivery"]["status"].as_str(),
                    typed(&home, &text)
                ),
                (Some("success"), 1),
                "typed whole: {answer}"
            ),
        }
    }
    assert_eq!(typed(&home, "held at its paste"), 0);
}

/// A send whose paste began goes on whatever cancels it, and answers what reached the terminal.
#[test]
fn a_cancelled_send_whose_paste_began_goes_on() {
    let home = TestHome::new("relcancelbegun");
    let worker = home.start_named_fake("worker", &[("FAKECLI_IGNORE_ENTER", "1")]);
    let mut person = connect(&home);
    let sending = person.send(
        "call",
        json!({ "op": "agent.send", "args": { "to": "worker", "text": "already pasting" } }),
    );
    // The fake CLI shows a paste of more than one line as a placeholder, as Claude Code does.
    assert!(
        wait_until(secs(10), || home
            .screen("worker")
            .contains("[Pasted text #1")),
        "{}",
        home.screen("worker")
    );
    person.write(&json!({ "jsonrpc": "2.0", "method": "cancel", "params": { "id": sending } }));
    let answer = person
        .wait_for_response(sending, secs(40))
        .expect("an answer");
    assert_ne!(error_reason(&answer), "cancelled", "{answer}");
    assert_eq!(
        answer["result"]["message"]["delivery"]["text_written"], "full",
        "{answer}"
    );
    assert_eq!(
        read_ids(&home, &worker.id, json!({ "last": 1 })),
        ["m1"],
        "kept"
    );
}
