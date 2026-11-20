//! Start prompts and Facade's results: a prompt kept with its agent and answered pending, delivered
//! before any other message once the CLI's tools connected or will not, and the one result it owes
//! the agent that started it, written as the prompt is settled, across daemon restarts too.

use std::process::{Child, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Starts `boss`, a test CLI, and a Facade server acting for it, as boss's CLI runs one. Returns
/// the server and boss's folder.
fn boss(home: &TestHome) -> (McpTestClient, String) {
    home.start_named_fake("boss", &[]);
    let cwd = home.listed_agent("boss").unwrap()["folder"]
        .as_str()
        .unwrap()
        .to_string();
    (McpTestClient::open(home, "a1"), cwd)
}

/// The machine part of the addresses Facade gives in this test's home.
fn host(home: &TestHome) -> String {
    let listed = home.agent_list();
    listed["agents"][0]["id"]
        .as_str()
        .unwrap()
        .split_once('@')
        .expect("an agent address")
        .1
        .to_string()
}

/// The record of the agent named `name`, from the `agents` topic.
fn record(home: &TestHome, name: &str) -> Value {
    home.agents()
        .into_iter()
        .find(|agent| agent["name"] == name)
        .unwrap_or_else(|| panic!("no {name}: {:?}", home.agents()))
}

/// Starts `child`, a test CLI, in folder `path` from boss's server with `prompt`, and returns the
/// answer.
fn start_child(boss: &mut McpTestClient, path: &str, prompt: &str) -> Value {
    let started = boss.call(
        "start_agent",
        json!({ "name": "child", "cli": "fake", "folder": path, "prompt": prompt }),
    );
    assert_eq!(started["status"], "success", "{started}");
    started
}

/// Starts `facade send` in the background, from the command line.
fn send_in_background(home: &TestHome, args: &[&str]) -> Child {
    let mut command = home.command(&test_binaries().facade);
    command
        .arg("send")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.spawn().expect("could not run facade send")
}

/// What the test CLIs submitted that starts with `start`: a message's 📨 or a result's 🔔.
fn submitted(home: &TestHome, start: &str) -> Vec<String> {
    home.submitted_messages()
        .into_iter()
        .filter(|text| text.starts_with(start))
        .collect()
}

/// Waits until the test CLIs submitted `text`.
fn wait_for_submission(home: &TestHome, text: &str) -> bool {
    wait_until(secs(40), || {
        home.submitted_messages()
            .iter()
            .any(|submitted| submitted == text)
    })
}

/// Message `number` as the store keeps it: who it is from and to, and its delivery's status, if it
/// is kept. Only for what no client can see: whether a message is kept before anyone reads it, and
/// that a result nobody can receive was never written.
fn kept(home: &TestHome, number: u64) -> Option<(String, String, String)> {
    let connection = rusqlite::Connection::open(home.path.join("core/facade.db")).ok()?;
    connection
        .query_row(
            "SELECT \"from\", \"to\", status FROM messages WHERE number = ?1",
            [number as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
}

/// Kills the daemon, as a crash would, and waits for the next daemon the keeper starts.
fn crash(home: &TestHome) {
    let old = home.kill_daemon();
    home.wait_for_daemon_after(old, secs(30))
        .expect("the keeper starts the next daemon");
}

/// boss's prompt as the child's CLI takes it.
fn prompt(host: &str) -> String {
    format!("📨 Message from boss (a1@{host}) · m1\nfix the bug")
}

/// The result boss's prompt owes boss, as boss's CLI takes it.
fn result(host: &str) -> String {
    format!(
        "🔔 child (a2@{host}) has started. · m2\nYour initial message m1@{host} has been passed on."
    )
}

/// The result of boss's prompt where the child ended before it was delivered.
fn ended_result(host: &str) -> String {
    format!(
        "🔔 child (a2@{host}) has started. · m2\nIts Facade tools are unavailable: its CLI \
         ended.\nYour initial message m1@{host} could not be delivered. Nothing was entered in the \
         terminal.\na2@{host} ended before the message was delivered."
    )
}

/// start_agent with a prompt answers once the CLI runs: the prompt pending, with no deadline yet,
/// with the call and the result to follow. The new agent's first submission is the prompt under its
/// header; the caller's terminal then shows the result, which names the prompt, under 🔔 and its
/// own number. Each comes once, and the result reads as its facts.
#[test]
fn start_agent_s_prompt_goes_first_and_its_caller_gets_one_result() {
    let home = TestHome::new("promptfirst");
    let (mut boss, here) = boss(&home);
    let host = host(&home);
    let started = start_child(&mut boss, &here, "fix the bug");
    assert_eq!(
        (&started["data"]["id"], &started["data"]["name"]),
        (&json!(format!("a2@{host}")), &json!("child")),
        "{started}"
    );
    assert!(
        wait_for_submission(&home, &result(&host)),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        home.submitted_messages(),
        [prompt(&host), result(&host)],
        "the prompt first, then its result, each once"
    );
    // The result is delivered once the daemon has seen the CLI take it, a moment after the CLI logs
    // it, when boss's record says Facade said it: a read before then would deliver it.
    assert!(
        wait_until(LOADED_TIMEOUT, || record(&home, "boss")["said"]["from"]
            == "facade"),
        "{}",
        record(&home, "boss")
    );
    let read = boss.call("read_messages", json!({ "after": "m1" }));
    let row = &read["data"]["messages"][0];
    assert_eq!(
        (&row["id"], &row["from"]),
        (&json!("m2"), &json!("facade")),
        "{read}"
    );
    assert!(
        row["text"]
            .as_str()
            .is_some_and(|text| text.contains(&format!("child (a2@{host}) has started"))),
        "a result says what it is in words: {read}"
    );
    assert_eq!(started["data"]["result_message"], row["id"], "{started}");
    let again = boss.call("read_messages", json!({ "after": row["id"] }));
    assert_eq!(again["status"], "success", "{again}");
    assert_eq!(again["data"]["messages"], json!([]), "{again}");
}

/// A message sent to the new agent while its prompt waits for the tools goes after the prompt.
#[test]
fn a_message_sent_while_the_prompt_waits_goes_after_it() {
    let home = TestHome::new("promptbefore");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    let (mut boss, here) = boss(&home);
    let host = host(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-prompt-delivery");
    let send = send_in_background(&home, &["child", "and then this"]);
    // The send answers only once the message is delivered, after the gate: the store alone shows
    // that it is kept while the prompt waits.
    assert!(
        wait_until(secs(10), || kept(&home, 3).is_some()),
        "the message is kept"
    );
    home.release_gate("before-prompt-delivery");
    let sent = send.wait_with_output().unwrap();
    assert!(sent.status.success(), "{}", stderr(&sent));
    let message = "📨 Message from the command line · m3\nand then this";
    assert!(
        wait_for_submission(&home, message),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(submitted(&home, "📨"), [prompt(&host), message.to_string()]);
    assert!(
        wait_for_submission(&home, &result(&host)),
        "{:?}",
        home.submitted_messages()
    );
}

/// A prompt whose agent ends before it is delivered fails as ended, nothing typed, and its result
/// says so, its tools too.
#[test]
fn a_prompt_whose_agent_ends_first_gets_a_result_saying_so() {
    let home = TestHome::new("promptended");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    let (mut boss, here) = boss(&home);
    let host = host(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-prompt-delivery");
    home.run_facade_ok(&["stop", "child"]);
    home.release_gate("before-prompt-delivery");
    assert!(
        wait_for_submission(&home, &ended_result(&host)),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        submitted(&home, "📨"),
        Vec::<String>::new(),
        "the prompt was never typed"
    );
}

/// A prompt whose agent ends while its tools still connect fails as ended too, not at a deadline it
/// never had, and its result says so.
#[test]
fn a_prompt_whose_agent_ends_before_its_tools_settle_fails_as_ended() {
    let home = TestHome::new("promptendedearly");
    // The child takes boss's environment, so its CLI starts its Facade server a minute after its
    // own start.
    home.start_named_fake("boss", &[("FAKECLI_MCP_DELAY_MS", "60000")]);
    let host = host(&home);
    let cwd = home.listed_agent("boss").unwrap()["folder"]
        .as_str()
        .unwrap()
        .to_string();
    let mut boss = McpTestClient::open(&home, "a1");
    start_child(&mut boss, &cwd, "fix the bug");
    assert_eq!(record(&home, "child")["tools_state"], "connecting");
    home.run_facade_ok(&["stop", "child"]);
    assert!(
        wait_for_submission(&home, &ended_result(&host)),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        submitted(&home, "📨"),
        Vec::<String>::new(),
        "the prompt was never typed"
    );
}

/// A guest: an MCP connection no managed agent's CLI made, with `env` added to its environment,
/// which the agents it starts take. It joins at its first tool call; returns it and its address.
fn guest(home: &TestHome, env: &[(&str, &str)]) -> (McpTestClient, String) {
    let mut command = home.command(&test_binaries().mcp);
    command
        .env("PATH", home.path_with_test_programs())
        .envs(env.iter().copied());
    let mut guest = McpTestClient::spawn(home, command);
    let roster = guest.call("list_agents", json!({}));
    let address = roster["data"]["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["type"] == "guest"))
        .and_then(|agent| agent["id"].as_str())
        .unwrap_or_else(|| panic!("the connection is no guest: {roster}"))
        .to_string();
    (guest, address)
}

/// Starts `child` from the guest's server with `prompt`.
fn start_from_the_guest(home: &TestHome, guest: &mut McpTestClient, prompt: &str) {
    let started = guest.call(
        "start_agent",
        json!({ "name": "child", "cli": "fake", "folder": home.project, "prompt": prompt }),
    );
    assert_eq!(started["status"], "success", "{started}");
}

/// Whether the child's CLI took the guest's prompt, under the guest's address.
fn prompted_by(home: &TestHome, guest: &str) -> bool {
    home.submitted_messages().iter().any(|text| {
        text.starts_with("📨 Message from ")
            && text.ends_with(&format!(" ({guest}) · m1\nhello child"))
    })
}

/// A guest's start with a prompt is owed one result, as an agent's is: it waits in the guest's
/// inbox, as the guest's other messages do, and a read that waits takes it, with its facts.
/// Nothing is typed: a guest's terminal is not Facade's.
#[test]
fn a_guest_s_start_prompt_owes_it_a_result_that_a_read_delivers() {
    let home = TestHome::new("promptguest");
    let (mut guest, address) = guest(&home, &[]);
    let waiting = guest.send(
        "tools/call",
        json!({ "name": "read_messages", "arguments": { "wait": true } }),
    );
    start_from_the_guest(&home, &mut guest, "hello child");
    assert!(
        wait_until(secs(40), || prompted_by(&home, &address)),
        "{:?}",
        home.submitted_messages()
    );
    let read = guest.tool_answer(waiting);
    let taken = &read["data"]["messages"];
    assert_eq!(taken.as_array().map(Vec::len), Some(1), "{read}");
    assert_eq!(taken[0]["from"], "facade", "{read}");
    assert!(
        taken[0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("has started.")),
        "{read}"
    );
    let again = guest.call("read_messages", json!({}));
    assert_eq!(
        again["data"]["messages"],
        json!([]),
        "the read delivered it: {again}"
    );
    assert_eq!(
        submitted(&home, "🔔"),
        Vec::<String>::new(),
        "nothing is typed for a guest"
    );
}

/// A guest that ends before its start's prompt is settled is owed nothing more, as an agent that
/// went: no result is written.
#[test]
fn a_guest_that_ends_before_its_start_s_prompt_is_settled_gets_no_result() {
    let home = TestHome::new("promptguestgone");
    // The child takes the guest's environment, so its Facade server starts a minute after it, and
    // its prompt is still waiting when the guest ends.
    let (mut guest, _) = guest(&home, &[("FAKECLI_MCP_DELAY_MS", "60000")]);
    start_from_the_guest(&home, &mut guest, "hello child");
    assert_eq!(record(&home, "child")["tools_state"], "connecting");
    let (_, status) = guest.close(secs(20));
    assert!(status.success(), "{status:?}");
    home.run_facade_ok(&["stop", "child"]);
    // With the guest gone, no client can read its inbox: the store alone shows that the prompt was
    // settled and that no result was written.
    assert!(
        wait_until(secs(10), || kept(&home, 1)
            .is_some_and(|(_, _, status)| status == "failure")),
        "{:?}",
        kept(&home, 1)
    );
    // The prompt's settlement and its result are written in one transaction.
    assert_eq!(kept(&home, 2), None, "no result for a guest that went");
}

/// A guest's end says it ended before its inbox goes: a prompt settled in between owes it nothing
/// more, so no result goes into an inbox that is going.
#[test]
fn a_prompt_settled_while_a_guest_s_inbox_goes_writes_it_no_result() {
    let home = TestHome::new("promptguestgoing");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-guest-inbox-removal")]);
    let (mut guest, address) = guest(&home, &[("FAKECLI_MCP_DELAY_MS", "60000")]);
    start_from_the_guest(&home, &mut guest, "hello child");
    assert_eq!(record(&home, "child")["tools_state"], "connecting");
    let (_, status) = guest.close(secs(20));
    assert!(status.success(), "{status:?}");
    home.wait_for_gate("before-guest-inbox-removal");
    home.run_facade_ok(&["stop", "child"]);
    // The guest is going and no client can read its inbox: the store alone shows that the prompt
    // was settled and that no result was written.
    assert!(
        wait_until(secs(10), || kept(&home, 1)
            .is_some_and(|(_, _, status)| status == "failure")),
        "{:?}",
        kept(&home, 1)
    );
    assert_eq!(
        kept(&home, 2),
        None,
        "no result for a guest whose inbox is going"
    );
    home.release_gate("before-guest-inbox-removal");
    assert!(
        wait_until(secs(10), || !home
            .list_table()
            .column("REF")
            .contains(&address.as_str())),
        "the guest's end goes on"
    );
}

/// A guest's start prompt still waiting when its daemon ends is delivered by the next daemon, to
/// which the guest's server connects again: the result the prompt owes waits in the guest's inbox
/// for its next read, as it would have without the restart.
#[test]
fn a_guest_s_start_prompt_that_outlives_its_daemon_still_owes_it_its_result() {
    let home = TestHome::new("promptguestrestart");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    let (mut guest, address) = guest(&home, &[]);
    start_from_the_guest(&home, &mut guest, "hello child");
    home.wait_for_gate("before-prompt-delivery");
    crash(&home);
    assert!(
        wait_until(secs(40), || prompted_by(&home, &address)),
        "{:?}\n{}",
        home.submitted_messages(),
        home.daemon_log()
    );
    let read = guest.call("read_messages", json!({ "wait": true }));
    let taken = &read["data"]["messages"];
    assert_eq!(
        (taken.as_array().map(Vec::len), &taken[0]["from"]),
        (Some(1), &json!("facade")),
        "{read}"
    );
}

/// A result read before it is typed is delivered by the read, with its facts, and never typed.
#[test]
fn a_result_read_before_it_is_typed_is_never_typed() {
    let home = TestHome::new("promptread");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-result-delivery")]);
    let (mut boss, here) = boss(&home);
    let host = host(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-result-delivery");
    let read = boss.call("read_messages", json!({}));
    let row = &read["data"]["messages"][0];
    assert_eq!(
        (&row["id"], &row["from"]),
        (&json!("m2"), &json!("facade")),
        "{read}"
    );
    home.release_gate("before-result-delivery");
    std::thread::sleep(secs(3));
    assert_eq!(
        home.submitted_messages(),
        [prompt(&host)],
        "the result is never typed"
    );
}

/// A daemon that ends while a prompt waits for its CLI's tools leaves it to the next daemon, which
/// delivers it, and the result follows, once. The next daemon does not wait for the tools again:
/// the result says where they were.
#[test]
fn a_prompt_waiting_for_the_tools_outlives_its_daemon_and_its_result_follows_once() {
    let home = TestHome::new("promptrestart");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    let (mut boss, here) = boss(&home);
    let host = host(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-prompt-delivery");
    crash(&home);
    assert!(
        wait_until(secs(40), || !submitted(&home, "🔔").is_empty()),
        "{:?}\n{}",
        home.submitted_messages(),
        home.daemon_log()
    );
    std::thread::sleep(secs(2));
    let results = submitted(&home, "🔔");
    assert_eq!(
        (submitted(&home, "📨"), results.len()),
        (vec![prompt(&host)], 1),
        "each once: {results:?}"
    );
    let (first, last) = (results[0].lines().next(), results[0].lines().last());
    let started = format!("🔔 child (a2@{host}) has started. · m2");
    let passed = format!("Your initial message m1@{host} has been passed on.");
    assert_eq!(
        (first, last),
        (Some(started.as_str()), Some(passed.as_str()))
    );
}

/// A daemon that ends after the prompt was settled, before its result was typed, leaves the result
/// to the next daemon, which types it once.
#[test]
fn a_result_its_daemon_did_not_type_is_typed_once_by_the_next() {
    let home = TestHome::new("resultrestart");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-result-delivery")]);
    let (mut boss, here) = boss(&home);
    let host = host(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-result-delivery");
    assert_eq!(home.submitted_messages(), [prompt(&host)]);
    crash(&home);
    assert!(
        wait_for_submission(&home, &result(&host)),
        "{:?}\n{}",
        home.submitted_messages(),
        home.daemon_log()
    );
    std::thread::sleep(secs(2));
    assert_eq!(
        home.submitted_messages(),
        [prompt(&host), result(&host)],
        "each once"
    );
}

/// A caller removed before its prompt is settled gets no result: the prompt is still delivered, no
/// result is kept, and the number taken for it goes unused.
#[test]
fn a_caller_removed_before_its_result_gets_none() {
    let home = TestHome::new("promptorphan");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    let (mut boss, here) = boss(&home);
    let host = host(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-prompt-delivery");
    drop(boss);
    home.run_facade_ok(&["stop", "boss"]);
    home.remove_agent("boss");
    home.release_gate("before-prompt-delivery");
    assert!(
        wait_for_submission(&home, &prompt(&host)),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        home.run_facade_ok(&["send", "child", "next"]).trim(),
        format!(
            "Delivered m3@{host} to child ({}).",
            record(&home, "child")["address"].as_str().unwrap()
        )
    );
    // The caller is gone and no client can read its inbox: the store alone shows that the number
    // taken for the result holds no message.
    assert_eq!(kept(&home, 2), None, "no result");
    assert_eq!(submitted(&home, "🔔"), Vec::<String>::new());
}

/// A v3 start from a terminal caller sends the prompt from the command line and owes no result.
/// An inherited agent value in the launch environment does not change the caller's identity.
#[test]
fn a_terminal_start_s_prompt_comes_from_the_command_line_and_owes_no_result() {
    let home = TestHome::new("promptcli");
    home.start_named_fake("boss", &[]);
    let solo = home.start_with_prompt("solo", "fake", "from the person", &[]);
    assert!(solo["result"].is_object(), "{solo}");
    let person = "📨 Message from the command line · m1\nfrom the person";
    assert!(
        wait_for_submission(&home, person),
        "{:?}",
        home.submitted_messages()
    );
    let child = home.start_with_prompt(
        "child",
        "fake",
        "from the boss's terminal",
        &[("FACADE_AGENT", "a1")],
    );
    assert!(child["result"].is_object(), "{child}");
    let boss = "📨 Message from the command line · m2\nfrom the boss's terminal";
    assert!(
        wait_for_submission(&home, boss),
        "{:?}",
        home.submitted_messages()
    );
    std::thread::sleep(secs(2));
    assert_eq!(submitted(&home, "📨"), [person, boss]);
    assert_eq!(
        submitted(&home, "🔔"),
        Vec::<String>::new(),
        "no result for a prompt from the command line"
    );
    let host = host(&home);
    assert_eq!(
        home.run_facade_ok(&["send", "child", "next"]).trim(),
        format!(
            "Delivered m3@{host} to child ({}).",
            record(&home, "child")["address"].as_str().unwrap()
        ),
        "no number was taken for a result"
    );
}
