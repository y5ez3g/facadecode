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

/// A connection acting for agent `agent`.
fn acting_for(home: &TestHome, agent: &str) -> DaemonTestClient {
    drop(connect(home));
    let mut wire = DaemonTestClient::open(home);
    assert!(wire.hello("terminal", [1, 1], json!({ "agent": agent }))["result"].is_object());
    wire
}

/// A connection acting for `agent` that follows its inbox from an empty snapshot, which delivers
/// nothing.
fn follow_inbox(home: &TestHome, agent: &str) -> (DaemonTestClient, u64) {
    let mut wire = acting_for(home, agent);
    let watching = wire.request("watch", json!({ "topic": "messages" }));
    assert_eq!(
        watching["result"]["snapshot"]["messages"],
        json!([]),
        "{watching}"
    );
    (wire, watching["result"]["watch"].as_u64().unwrap())
}

/// The messages changes the inbox watch got, by their kind and message ID.
fn inbox_changes(inbox: &DaemonTestClient, watch: u64) -> Vec<(String, String)> {
    inbox
        .changes(watch)
        .iter()
        .map(|changed| {
            let change = &changed["change"];
            let id = change["message"]["message_id"]
                .as_str()
                .or(change["message_id"].as_str())
                .unwrap_or_default();
            (
                change["kind"].as_str().unwrap_or_default().to_string(),
                id.to_string(),
            )
        })
        .collect()
}

/// `facade.db`, opened beside the running daemon.
fn store(home: &TestHome) -> rusqlite::Connection {
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).unwrap();
    connection.busy_timeout(secs(5)).unwrap();
    connection
}

/// Message `number`'s delivery status and request ID, as `facade.db` keeps them: read from the
/// store itself, since a read through Facade would deliver it. None where it is not kept.
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

/// How many messages `facade.db` keeps whose text is like `pattern`, as SQL's LIKE reads it.
fn kept_like(home: &TestHome, pattern: &str) -> i64 {
    store(home)
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE text LIKE ?1",
            [pattern],
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
    home.start_named_fake("boss", &[]);
    let mut person = connect(&home);
    let send = |wire: &mut DaemonTestClient, text: &str, request: &str| {
        wire.call(
            "agent.send",
            json!({ "to": "worker", "text": text, "request_id": request }),
        )
    };
    let first = send(&mut person, "hello", "r1");
    assert_eq!(
        (
            &first["result"]["message_id"],
            &first["result"]["delivery"]["status"]
        ),
        (&json!("m1"), &json!("success")),
        "{first}"
    );
    assert!(first["result"].get("repeated").is_none(), "{first}");
    let again = send(&mut person, "hello again", "r1");
    let facts = (
        &again["result"]["message_id"],
        &again["result"]["repeated"],
        &again["result"]["text"],
    );
    assert_eq!(
        facts,
        (&json!("m1"), &json!(true), &json!("hello")),
        "the first message, whatever the repeat says: {again}"
    );
    assert_eq!(
        home.submitted_messages(),
        ["📨 Message from #human · #m1\nhello"],
        "typed once"
    );
    let mut boss = acting_for(&home, "a2");
    let theirs = send(&mut boss, "from the boss", "r1");
    assert_eq!(
        (
            &theirs["result"]["message_id"],
            theirs["result"].get("repeated")
        ),
        (&json!("m2"), None),
        "another sender's own: {theirs}"
    );
    let refused = person.call(
        "agent.send",
        json!({ "to": "nobody", "text": "lost", "request_id": "r2" }),
    );
    assert_eq!(error_reason(&refused), "not_found", "{refused}");
    assert_eq!(
        send(&mut person, "found", "r2")["result"]["message_id"],
        "m3",
        "a refused send keeps nothing"
    );
    sent_at(&home, 1, "2020-01-01T00:00:00.000Z");
    let later = send(&mut person, "an hour later", "r1");
    assert_eq!(
        (
            &later["result"]["message_id"],
            later["result"].get("repeated")
        ),
        (&json!("m4"), None),
        "after the hour: {later}"
    );
    assert_eq!(typed(&home, "hello"), 1);
    home.run_facade_ok(&["stop", "worker"]);
    let ended = send(&mut person, "to an ended agent", "r1");
    assert_eq!(
        (&ended["result"]["message_id"], &ended["result"]["repeated"]),
        (&json!("m4"), &json!(true)),
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
        json!({
            "command": ["fake"], "name": "helper", "cwd": home.project,
            "env": { "PATH": home.path_with_test_programs() }, "cols": 80, "rows": 24,
            "request_id": id,
        })
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
    assert_eq!(
        (kept_with_text(&home, "hi"), home.agents().len()),
        (0, 1),
        "nothing sent or started"
    );
    let taken = send(&mut person, &"r".repeat(200));
    assert_eq!(taken["result"]["delivery"]["status"], "success", "{taken}");
}

/// A send to a guest is answered at once, pending until the guest's next turn takes it, and so is
/// its repeat by its request ID: the repeat waits for no turn either.
#[test]
fn a_repeated_send_to_a_guest_is_answered_at_once_as_its_first_call_was() {
    let home = TestHome::new("relguest");
    connect(&home);
    let mut hooks = DaemonTestClient::open(&home);
    hooks.hello("terminal", [1, 1], json!({}));
    assert_eq!(
        hooks.call(
            "hook.session-start",
            json!({ "cli": "claude", "session": "s1" })
        )["result"]["agent_id"],
        "a1"
    );
    let mut person = connect(&home);
    let send = json!({ "to": "a1", "text": "at your next turn", "request_id": "g1" });
    let first = person.call("agent.send", send.clone());
    assert_eq!(
        (
            &first["result"]["message_id"],
            &first["result"]["delivery"]["status"]
        ),
        (&json!("m1"), &json!("pending")),
        "{first}"
    );
    let asked = std::time::Instant::now();
    let again = person.call("agent.send", send);
    assert!(asked.elapsed() < secs(5), "answered at once");
    let facts = (
        &again["result"]["message_id"],
        &again["result"]["delivery"]["status"],
        &again["result"]["repeated"],
    );
    assert_eq!(
        facts,
        (&json!("m1"), &json!("pending"), &json!(true)),
        "{again}"
    );
}

/// A repeat while the first send's message waits joins its delivery, and two calls with one ID at
/// once keep one message: both answer it once it is typed, once.
#[test]
fn calls_with_one_request_id_at_once_keep_one_message_and_both_answer_it() {
    let home = TestHome::new("relsendjoin");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch) = follow_inbox(&home, "a1");
    let (mut one, mut two) = (connect(&home), connect(&home));
    let call = json!({
        "op": "agent.send", "args": { "to": "worker", "text": "once", "request_id": "r1" },
    });
    let (first, second) = (one.send("call", call.clone()), two.send("call", call));
    assert!(
        wait_until(secs(10), || inbox_changes(&inbox, watch)
            .contains(&("updated".into(), "m1".into()))),
        "{:?}",
        inbox_changes(&inbox, watch)
    );
    std::thread::sleep(Duration::from_millis(500));
    assert!(kept(&home, 2).is_none(), "one message");
    clear_draft(&home, "worker");
    let answers = [
        one.wait_for_response(first, secs(30)).expect("an answer"),
        two.wait_for_response(second, secs(30)).expect("an answer"),
    ];
    for answer in &answers {
        assert_eq!(
            (
                &answer["result"]["message_id"],
                &answer["result"]["delivery"]["status"]
            ),
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
        ["📨 Message from #human · #m1\nonce"]
    );
}

/// A send cut off by a daemon restart goes again by the request ID its relay made: the repeat joins
/// the message the next daemon took up, and the call answers what became of it, typed once. The
/// model sees no repeat of its own.
#[test]
fn a_send_cut_off_by_a_restart_is_repeated_by_its_request_id_and_typed_once() {
    let home = TestHome::new("relrestart");
    home.start_named_fake("worker", &[]);
    home.start_named_fake("boss", &[]);
    type_draft(&home, "worker", "my draft");
    let mut boss = McpTestClient::open(&home, "a2");
    let own = boss.send(
        "tools/call",
        json!({
            "name": "send_message",
            "arguments": { "to": "#a1", "text": "survive" },
        }),
    );
    let made = boss.send(
        "tools/call",
        json!({ "name": "send_message", "arguments": { "to": "#a1", "text": "also" } }),
    );
    assert!(
        wait_until(secs(10), || kept(&home, 1).is_some()
            && kept(&home, 2).is_some()),
        "both kept"
    );
    assert!(
        kept(&home, 1).unwrap().1.is_some() && kept(&home, 2).unwrap().1.is_some(),
        "every send carries a request ID"
    );
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
    clear_draft(&home, "worker");
    let envelope = |answer: Option<Value>| {
        answer.expect("the cut call is answered")["result"]["structuredContent"].clone()
    };
    let kept_own = envelope(boss.answer(own, secs(30)));
    let number: i64 = store(&home)
        .query_row(
            "SELECT number FROM messages WHERE text = 'survive'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let facts = (
        &kept_own["status"],
        &kept_own["data"]["id"],
        kept_own["data"].get("repeated"),
        kept_own["data"].get("request_id"),
    );
    assert_eq!(
        facts,
        (&json!("success"), &json!(format!("#m{number}")), None, None),
        "answered as a first call: {kept_own}"
    );
    let kept_made = envelope(boss.answer(made, secs(30)));
    assert!(
        kept_made["status"] == "success" && kept_made["data"].get("request_id").is_none(),
        "{kept_made}"
    );
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
}

/// Two starts with one request ID at once start one agent: the second waits for the first's answer
/// and gives it.
#[test]
fn two_starts_with_one_request_id_at_once_start_one_agent() {
    let home = TestHome::new("relstarttwo");
    home.start_facade_with(&[("FACADE_TEST_GATES", "after-run-start-response")]);
    let (mut one, mut two) = (connect(&home), connect(&home));
    let args = json!({
        "command": ["fake"], "name": "helper", "cwd": home.project,
        "env": { "PATH": home.path_with_test_programs() }, "cols": 80, "rows": 24,
        "request_id": "s1",
    });
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
        assert_eq!(answer["result"]["agent"]["agent_id"], "a1", "{answer}");
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
    let args = json!({
        "command": ["fake"], "name": "branch", "cwd": repo,
        "env": { "PATH": home.path_with_test_programs() }, "cols": 80, "rows": 24,
        "request_id": "w1", "worktree": { "branch": "feat-x", "base_ref": "HEAD" },
    });
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
            &again["result"]["agent"]["agent_id"],
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
/// `cancelled`, nothing of it is typed, no read returns it, the inbox's watchers learn it is
/// removed, and its number is not given again. A `cancel` with an ID of its own is answered `{}`;
/// one of a send already answered changes nothing.
#[test]
fn a_cancelled_send_whose_paste_has_not_begun_is_withdrawn_and_kept_nowhere() {
    let home = TestHome::new("relcancel");
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (mut inbox, watch) = follow_inbox(&home, "a1");
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
    assert!(kept(&home, 1).is_none(), "not kept");
    assert!(
        wait_until(secs(5), || inbox_changes(&inbox, watch)
            .contains(&("removed".into(), "m1".into()))),
        "{:?}",
        inbox_changes(&inbox, watch)
    );
    let read = inbox.request(
        "watch",
        json!({ "topic": "messages", "args": { "all": true } }),
    );
    assert_eq!(
        read["result"]["snapshot"]["messages"],
        json!([]),
        "no read returns it"
    );
    clear_draft(&home, "worker");
    let next = person.call("agent.send", json!({ "to": "worker", "text": "after" }));
    assert_eq!(
        next["result"]["message_id"], "m2",
        "its number is not given again: {next}"
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
    assert_eq!(kept(&home, 2).map(|kept| kept.0), Some("success".into()));
}

/// A `messages` watch that fell behind more changes than its channel holds resends its inbox as it
/// stands, and removes what it had given that is no longer kept: here a message withdrawn while the
/// watch was held, whose own removal is among the changes the watch missed.
#[test]
fn a_watch_that_fell_behind_removes_a_message_withdrawn_meanwhile() {
    let home = TestHome::new("rellag");
    home.start_facade_with(&[("FACADE_TEST_GATES", "after-messages-change")]);
    home.start_named_fake("worker", &[]);
    type_draft(&home, "worker", "my draft");
    let (inbox, watch) = follow_inbox(&home, "a1");
    let mut person = connect(&home);
    let send = |person: &mut DaemonTestClient, text: &str| {
        person.send(
            "call",
            json!({ "op": "agent.send", "args": { "to": "worker", "text": text } }),
        )
    };
    let first = send(&mut person, "withdrawn meanwhile");
    // The watch gives the message, and is held after it.
    home.wait_for_gate("after-messages-change");
    assert_eq!(
        person.request("cancel", json!({ "id": first }))["result"],
        json!({})
    );
    assert_eq!(
        error_reason(
            &person
                .wait_for_response(first, secs(10))
                .expect("its send answers")
        ),
        "cancelled"
    );
    // More changes than the channel's 1,024, each message kept and then withdrawn: 15 at a time, as
    // a connection runs 16 calls.
    for round in 0..40 {
        let sends: Vec<u64> = (0..15)
            .map(|n| send(&mut person, &format!("more {round}.{n}")))
            .collect();
        assert!(
            wait_until(secs(10), || kept_like(&home, &format!("more {round}.%"))
                == 15),
            "round {round}"
        );
        for id in &sends {
            person.request("cancel", json!({ "id": id }));
        }
        assert!(
            sends
                .iter()
                .all(|id| person.wait_for_response(*id, secs(10)).is_some()),
            "round {round}"
        );
    }
    home.release_gate("after-messages-change");
    let removed = ("removed".to_string(), "m1".to_string());
    assert!(
        wait_until(secs(10), || inbox_changes(&inbox, watch).contains(&removed)),
        "{:?}",
        inbox_changes(&inbox, watch)
            .iter()
            .take(4)
            .collect::<Vec<_>>()
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
                    answer["result"]["delivery"]["status"].as_str(),
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
    home.start_named_fake("worker", &[("FAKECLI_IGNORE_ENTER", "1")]);
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
        answer["result"]["delivery"]["text_written"], "full",
        "{answer}"
    );
    assert!(kept(&home, 1).is_some(), "kept");
}
