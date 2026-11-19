//! Start prompts and Facade's results: a prompt kept with its agent and answered pending, delivered
//! before any other message once the CLI's tools connected or will not, and the one result it owes
//! the agent that started it, written as the prompt is settled, across daemon restarts too.

use std::process::{Child, Output, Stdio};

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

/// Starts `boss`, a test CLI, and a Facade server acting for it, as boss's CLI runs one. Returns
/// the server and the location of boss's folder in the terminal window.
fn boss(home: &TestHome) -> (McpTestClient, String) {
    home.start_named_fake("boss", &[]);
    let cwd = home.agent_from_list_json("boss").unwrap()["folder"]
        .as_str()
        .unwrap()
        .to_string();
    (McpTestClient::open(home, "a1"), cwd)
}

/// Starts `child`, a test CLI, in folder `path` of the terminal window from boss's server with
/// `prompt`, and returns the answer.
fn start_child(boss: &mut McpTestClient, path: &str, prompt: &str) -> Value {
    let started = boss.call(
        "start_agent",
        json!({
            "name": "child", "cli": "fake", "window": "terminal", "folder": path, "prompt": prompt,
        }),
    );
    assert_eq!(started["status"], "success", "{started}");
    started
}

/// Runs `facade start --prompt <prompt> --name <name> fake`, as a command in a plain terminal does,
/// or in agent `agent`'s.
fn start_with_prompt(home: &TestHome, agent: Option<&str>, name: &str, prompt: &str) -> Output {
    let mut command = home.command(&test_binaries().facade);
    if let Some(agent) = agent {
        command.env("FACADE_AGENT", agent);
    }
    command
        .env("PATH", home.path_with_test_programs())
        .args(["start", "--prompt", prompt, "--name", name, "fake"])
        .stdin(Stdio::null());
    command.output().expect("could not run facade start")
}

/// Starts `facade send` in the background, as the person.
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
/// is kept.
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

const PROMPT: &str = "📨 Message from boss (#a1) · #m1\nfix the bug";
const RESULT: &str =
    "🔔 child (#a2) has started. · #m2\nYour initial message #m1 has been passed on.";

/// start_agent with a prompt answers once the CLI runs: the prompt pending, with no deadline yet,
/// with the call and the result to follow. The new agent's first submission is the prompt under its
/// header; the caller's terminal then shows the result, which names the prompt, under 🔔 and its
/// own number. Each comes once, and the result reads as its facts.
#[test]
fn start_agent_s_prompt_goes_first_and_its_caller_gets_one_result() {
    let home = TestHome::new("promptfirst");
    let (mut boss, here) = boss(&home);
    let started = start_child(&mut boss, &here, "fix the bug");
    assert_eq!(
        (&started["data"]["id"], &started["data"]["name"]),
        (&json!("#a2"), &json!("child")),
        "{started}"
    );
    assert!(
        wait_for_submission(&home, RESULT),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        home.submitted_messages(),
        [PROMPT, RESULT],
        "the prompt first, then its result, each once"
    );
    // The result is delivered once the daemon has seen the CLI take it, a moment after the CLI logs
    // it: a read before then would deliver it.
    assert!(
        wait_until(LOADED_TIMEOUT, || kept(&home, 2)
            .is_some_and(|kept| kept.2 == "success")),
        "{:?}",
        kept(&home, 2)
    );
    let read = boss.call("read_messages", json!({ "after": "#m1" }));
    let row = &read["data"]["messages"][0];
    assert_eq!(
        (&row["id"], &row["from"]),
        (&json!("#m2"), &json!("facade")),
        "{read}"
    );
    assert!(
        row["text"]
            .as_str()
            .is_some_and(|text| text.contains("child (#a2) has started")),
        "a result says what it is in words: {read}"
    );
    assert_eq!(started["data"]["result_message"], row["id"], "{started}");
    for after in [&row["address"], &started["data"]["result_message"]] {
        let again = boss.call("read_messages", json!({ "after": after }));
        assert_eq!(again["status"], "success", "{again}");
        assert_eq!(again["data"]["messages"], json!([]), "{again}");
    }
}

/// A message sent to the new agent while its prompt waits for the tools goes after the prompt.
#[test]
fn a_message_sent_while_the_prompt_waits_goes_after_it() {
    let home = TestHome::new("promptbefore");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    let (mut boss, here) = boss(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-prompt-delivery");
    let send = send_in_background(&home, &["child", "and then this"]);
    assert!(
        wait_until(secs(10), || kept(&home, 3).is_some()),
        "the message is kept"
    );
    home.release_gate("before-prompt-delivery");
    assert_eq!(
        stdout(&send.wait_with_output().unwrap()).trim(),
        "m3 delivered to a2"
    );
    assert_eq!(
        submitted(&home, "📨"),
        [PROMPT, "📨 Message from #human · #m3\nand then this"]
    );
    assert!(
        wait_for_submission(&home, RESULT),
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
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-prompt-delivery");
    home.run_facade_ok(&["stop", "child"]);
    home.release_gate("before-prompt-delivery");
    let result = "🔔 child (#a2) has started. · #m2\nIts Facade tools are unavailable: its CLI \
                  ended.\nYour initial message #m1 could not be \
                  delivered. Nothing was entered in the terminal.\n#a2 ended before the message \
                  was delivered.";
    assert!(
        wait_for_submission(&home, result),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        submitted(&home, "📨"),
        Vec::<String>::new(),
        "the prompt was never typed"
    );
    assert_eq!(
        kept(&home, 1),
        Some(("a1".into(), "a2".into(), "failure".into()))
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
    let cwd = home.agent_from_list_json("boss").unwrap()["folder"]
        .as_str()
        .unwrap()
        .to_string();
    let mut boss = McpTestClient::open(&home, "a1");
    start_child(&mut boss, &cwd, "fix the bug");
    assert_eq!(
        home.agent_from_list_json("child").unwrap()["tools_state"],
        "connecting"
    );
    home.run_facade_ok(&["stop", "child"]);
    let result = "🔔 child (#a2) has started. · #m2\nIts Facade tools are unavailable: its CLI \
                  ended.\nYour initial message #m1 could not be \
                  delivered. Nothing was entered in the terminal.\n#a2 ended before the message \
                  was delivered.";
    assert!(
        wait_for_submission(&home, result),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        submitted(&home, "📨"),
        Vec::<String>::new(),
        "the prompt was never typed"
    );
    assert_eq!(
        kept(&home, 1),
        Some(("a1".into(), "a2".into(), "failure".into()))
    );
}

/// A guest, Claude Code's session `s1`, which joins through its session-start hook. Returns the
/// client its hooks call through.
fn guest(home: &TestHome) -> DaemonTestClient {
    connect(home);
    let mut hooks = DaemonTestClient::open(home);
    hooks.hello("terminal", DAEMON_RANGE, json!({}));
    assert_eq!(
        hooks.call(
            "hook.session-start",
            json!({ "cli": "claude", "session": "s1" })
        )["result"]["agent_id"],
        "a1"
    );
    hooks
}

/// Runs `facade start --prompt <prompt> --name child fake` as the guest's model does, its session
/// named in its environment, with `env` added.
fn start_from_the_guest(home: &TestHome, prompt: &str, env: &[(&str, &str)]) {
    let mut command = home.command(&test_binaries().facade);
    command
        .env("CLAUDE_CODE_SESSION_ID", "s1")
        .env("PATH", home.path_with_test_programs())
        .envs(env.iter().copied());
    let started = command
        .args(["start", "--prompt", prompt, "--name", "child", "fake"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "{}{}",
        stdout(&started),
        stderr(&started)
    );
}

/// A guest's start with a prompt is owed one result, as an agent's is: it waits in the guest's
/// inbox, as the guest's other messages do, and its turn-end hook hands it over, with its facts.
/// Nothing is typed: a guest's terminal is not Facade's.
#[test]
fn a_guest_s_start_prompt_owes_it_a_result_that_a_take_delivers() {
    let home = TestHome::new("promptguest");
    let mut hooks = guest(&home);
    start_from_the_guest(&home, "hello child", &[]);
    let prompted = || {
        home.submitted_messages().iter().any(|text| {
            text.starts_with("📨 Message from ") && text.ends_with(" (#a1) · #m1\nhello child")
        })
    };
    assert!(
        wait_until(secs(40), prompted),
        "{:?}",
        home.submitted_messages()
    );
    assert!(
        wait_until(secs(10), || kept(&home, 2).is_some()),
        "the result is kept"
    );
    assert_eq!(
        kept(&home, 2),
        Some(("facade".into(), "a1".into(), "pending".into()))
    );
    let ended = hooks.call("hook.turn-end", json!({ "cli": "claude", "session": "s1" }));
    let taken = &ended["result"]["messages"];
    assert_eq!(taken.as_array().map(Vec::len), Some(1), "{ended}");
    assert_eq!(
        (
            &taken[0]["message_id"],
            &taken[0]["from"],
            &taken[0]["result"]["agent"]["agent_id"]
        ),
        (&json!("m2"), &json!("facade"), &json!("a2"))
    );
    assert_eq!(
        taken[0]["result"]["prompt"]["delivery"]["status"],
        "success"
    );
    assert_eq!(
        kept(&home, 2).map(|(_, _, status)| status),
        Some("success".into()),
        "the take delivered it"
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
    let mut hooks = guest(&home);
    // The child's Facade server starts a minute after it, so its prompt is still waiting when the
    // guest ends.
    start_from_the_guest(&home, "hello child", &[("FAKECLI_MCP_DELAY_MS", "60000")]);
    assert_eq!(
        home.agent_from_list_json("child").unwrap()["tools_state"],
        "connecting"
    );
    assert!(
        hooks.call(
            "hook.session-end",
            json!({ "cli": "claude", "session": "s1" })
        )["result"]
            .is_object()
    );
    home.run_facade_ok(&["stop", "child"]);
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
    let mut hooks = guest(&home);
    start_from_the_guest(&home, "hello child", &[("FAKECLI_MCP_DELAY_MS", "60000")]);
    assert_eq!(
        home.agent_from_list_json("child").unwrap()["tools_state"],
        "connecting"
    );
    let ending = hooks.send(
        "call",
        json!({ "op": "hook.session-end", "args": { "cli": "claude", "session": "s1" } }),
    );
    home.wait_for_gate("before-guest-inbox-removal");
    home.run_facade_ok(&["stop", "child"]);
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
        hooks
            .wait_for_response(ending, secs(10))
            .is_some_and(|ended| ended["result"].is_object()),
        "the guest's end goes on"
    );
}

/// A guest's start prompt still waiting when its daemon ends is delivered by the next daemon, which
/// lists the guest again from the store: the result the prompt owes waits in the guest's inbox for
/// its next take, as it would have without the restart.
#[test]
fn a_guest_s_start_prompt_that_outlives_its_daemon_still_owes_it_its_result() {
    let home = TestHome::new("promptguestrestart");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    guest(&home);
    start_from_the_guest(&home, "hello child", &[]);
    home.wait_for_gate("before-prompt-delivery");
    crash(&home);
    let prompted = || {
        home.submitted_messages().iter().any(|text| {
            text.starts_with("📨 Message from ") && text.ends_with(" (#a1) · #m1\nhello child")
        })
    };
    assert!(
        wait_until(secs(40), prompted),
        "{:?}\n{}",
        home.submitted_messages(),
        home.daemon_log()
    );
    assert!(
        wait_until(secs(10), || kept(&home, 2).is_some()),
        "no result was kept for the guest: {}",
        home.daemon_log()
    );
    assert_eq!(
        kept(&home, 2),
        Some(("facade".into(), "a1".into(), "pending".into()))
    );
    let mut hooks = DaemonTestClient::open(&home);
    hooks.hello("terminal", DAEMON_RANGE, json!({}));
    let ended = hooks.call("hook.turn-end", json!({ "cli": "claude", "session": "s1" }));
    let taken = &ended["result"]["messages"];
    assert_eq!(
        (
            &taken[0]["message_id"],
            &taken[0]["result"]["agent"]["agent_id"]
        ),
        (&json!("m2"), &json!("a2")),
        "{ended}"
    );
}

/// A result read before it is typed is delivered by the read, with its facts, and never typed.
#[test]
fn a_result_read_before_it_is_typed_is_never_typed() {
    let home = TestHome::new("promptread");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-result-delivery")]);
    let (mut boss, here) = boss(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-result-delivery");
    let read = boss.call("read_messages", json!({}));
    let row = &read["data"]["messages"][0];
    assert_eq!(
        (&row["id"], &row["from"]),
        (&json!("#m2"), &json!("facade")),
        "{read}"
    );
    home.release_gate("before-result-delivery");
    std::thread::sleep(secs(3));
    assert_eq!(
        home.submitted_messages(),
        [PROMPT],
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
        (vec![PROMPT.to_string()], 1),
        "each once: {results:?}"
    );
    let (first, last) = (results[0].lines().next(), results[0].lines().last());
    assert_eq!(
        (first, last),
        (
            Some("🔔 child (#a2) has started. · #m2"),
            Some("Your initial message #m1 has been passed on.")
        )
    );
}

/// A daemon that ends after the prompt was settled, before its result was typed, leaves the result
/// to the next daemon, which types it once.
#[test]
fn a_result_its_daemon_did_not_type_is_typed_once_by_the_next() {
    let home = TestHome::new("resultrestart");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-result-delivery")]);
    let (mut boss, here) = boss(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-result-delivery");
    assert_eq!(home.submitted_messages(), [PROMPT]);
    crash(&home);
    assert!(
        wait_for_submission(&home, RESULT),
        "{:?}\n{}",
        home.submitted_messages(),
        home.daemon_log()
    );
    std::thread::sleep(secs(2));
    assert_eq!(home.submitted_messages(), [PROMPT, RESULT], "each once");
}

/// A caller removed before its prompt is settled gets no result: the prompt is still delivered, no
/// result is kept, and the number taken for it goes unused.
#[test]
fn a_caller_removed_before_its_result_gets_none() {
    let home = TestHome::new("promptorphan");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-prompt-delivery")]);
    let (mut boss, here) = boss(&home);
    start_child(&mut boss, &here, "fix the bug");
    home.wait_for_gate("before-prompt-delivery");
    drop(boss);
    home.run_facade_ok(&["stop", "boss"]);
    home.run_facade_ok(&["remove", "boss"]);
    home.release_gate("before-prompt-delivery");
    assert!(
        wait_until(secs(30), || kept(&home, 1)
            .is_some_and(|kept| kept.2 == "success")),
        "{:?}",
        kept(&home, 1)
    );
    assert_eq!(
        home.run_facade_ok(&["send", "child", "next"]).trim(),
        "m3 delivered to a2"
    );
    assert_eq!(kept(&home, 2), None, "no result");
    assert_eq!(submitted(&home, "🔔"), Vec::<String>::new());
}

/// `facade start --prompt` in a plain terminal sends the person's prompt and owes no result; in an
/// agent's terminal, the prompt comes from that agent, which gets the result.
#[test]
fn facade_start_s_prompt_owes_a_result_only_to_an_agent() {
    let home = TestHome::new("promptcli");
    home.start_named_fake("boss", &[]);
    let solo = start_with_prompt(&home, None, "solo", "from the person");
    assert!(solo.status.success(), "{}", stderr(&solo));
    assert!(
        wait_for_submission(&home, "📨 Message from #human · #m1\nfrom the person"),
        "{:?}",
        home.submitted_messages()
    );
    let child = start_with_prompt(&home, Some("a1"), "child", "from the boss");
    assert!(child.status.success(), "{}", stderr(&child));
    let result = "🔔 child (#a3) has started. · #m3\nYour initial message #m2 has been passed on.";
    assert!(
        wait_for_submission(&home, result),
        "{:?}",
        home.submitted_messages()
    );
    assert_eq!(
        submitted(&home, "📨"),
        [
            "📨 Message from #human · #m1\nfrom the person",
            "📨 Message from boss (#a1) · #m2\nfrom the boss"
        ]
    );
    assert_eq!(
        submitted(&home, "🔔"),
        [result],
        "no result for the person's prompt"
    );
    // The result's delivery is recorded once its typist saw the CLI take it, a moment after the CLI
    // logged it.
    let delivered = Some(("facade".into(), "a1".into(), "success".into()));
    assert!(
        wait_until(secs(10), || kept(&home, 3) == delivered),
        "{:?}",
        kept(&home, 3)
    );
}
