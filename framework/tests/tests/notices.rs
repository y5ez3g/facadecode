//! Asynchronous Facade notices observed in a managed agent's terminal and inbox.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use facade_scenarios::serde_json::{Value, json};
use facade_scenarios::*;

fn start_child(
    home: &TestHome,
    creator: &mut McpTestClient,
    name: &str,
    prompt: Option<&str>,
) -> Value {
    let mut args = json!({ "name": name, "cli": "fake", "folder": home.project });
    if let Some(prompt) = prompt {
        args["prompt"] = json!(prompt);
    }
    let started = creator.call("start_agent", args);
    assert_eq!(started["status"], "success", "{started}");
    started["data"].clone()
}

fn reaches(home: &TestHome, name: &str, state: &str) -> Value {
    let mut agent = Value::Null;
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            agent = home.agent_from_watch(name).unwrap_or_default();
            agent["state"] == state
        }),
        "{name} did not become {state}: {agent}"
    );
    agent
}

fn submit(home: &TestHome, name: &str, text: &str) {
    home.run_facade_ok(&["type", name, text, "--enter"]);
}

fn notices(home: &TestHome) -> Vec<String> {
    home.submitted_messages()
        .into_iter()
        .filter(|text| text.starts_with("🔔"))
        .collect()
}

fn system_inbox(tools: &mut McpTestClient) -> Vec<Value> {
    let read = tools.call("read_messages", json!({ "last": 20 }));
    assert_eq!(read["status"], "success", "{read}");
    read["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["from"] == "facade")
        .cloned()
        .collect()
}

#[test]
fn a_startup_permission_wait_and_prompt_failure_share_the_reserved_notice() {
    let home = TestHome::new("notice-startup");
    // The child inherits the delayed tools startup. Manual input can expose the prompt that
    // blocks it while its initial Facade message is still waiting for the tools.
    let boss = home.start_named_fake(
        "boss",
        &[("FAKECLI_STATUS", "1"), ("FAKECLI_MCP_DELAY_MS", "60000")],
    );
    let mut tools = McpTestClient::open(&home, &boss.id);
    let started = start_child(&home, &mut tools, "child", Some("initial instruction"));
    let address = started["id"].as_str().unwrap();
    assert!(wait_for_screen_text(&home, address, "❯"));
    let since = Instant::now();
    submit(&home, address, "/fake block permission Trust this folder?");
    let blocked = reaches(&home, "child", "waiting_for_you");
    assert_eq!(blocked["tools_state"], "connecting", "{blocked}");
    assert_eq!(blocked["state_detail"]["kind"], "permission", "{blocked}");
    // Keep the input occupied even if the CLI startup timer frees the normal prompt sender.
    home.run_facade_ok(&["type", address, "startup dialog draft"]);
    assert!(wait_for_screen_text(&home, address, "startup dialog draft"));

    assert!(
        wait_until(secs(40), || !notices(&home).is_empty()),
        "{}",
        home.daemon_log()
    );
    let terminal = notices(&home);
    assert!(
        since.elapsed() >= secs(30),
        "reported too soon: {terminal:?}"
    );
    assert_eq!(terminal.len(), 1, "{terminal:?}");
    let heading = format!("🔔 child ({address}) has started.");
    assert_eq!(terminal[0].lines().next(), Some(heading.as_str()));
    for fact in ["Your prompt", "permission", "read_screen"] {
        assert!(terminal[0].contains(fact), "missing {fact:?}: {terminal:?}");
    }
    assert!(
        terminal[0].contains("press_keys") || terminal[0].contains("type_text"),
        "{terminal:?}"
    );
    assert!(terminal[0].contains("Nothing was entered"), "{terminal:?}");

    home.run_facade_ok(&["type", address, "--key", "Ctrl+C"]);
    submit(&home, address, "/fake status idle");
    // A synchronous follow-up can be delivered after recovery. It must follow the withdrawn
    // prompt without resurrecting it or generating another receipt.
    home.run_facade_ok(&["send", address, "after recovery", "-w"]);
    let rows = system_inbox(&mut tools);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["id"], "m2", "{rows:?}");
    let text = rows[0]["text"].as_str().unwrap();
    for fact in [address, "Your prompt", "permission", "read_screen"] {
        assert!(text.contains(fact), "missing {fact:?}: {text}");
    }
    assert_eq!(notices(&home), terminal);
    assert!(
        home.submitted_messages()
            .iter()
            .all(|text| !text.contains("initial instruction")),
        "{:?}",
        home.submitted_messages()
    );
}

#[test]
fn only_an_unwaited_delivery_failure_reaches_the_managed_senders_inbox() {
    let home = TestHome::new("notice-sends");
    let boss = home.start_named_fake("boss", &[]);
    let worker = home.start_named_fake("worker", &[]);
    let mut tools = McpTestClient::open(&home, &boss.id);
    home.run_facade_ok(&["type", &worker.address, "draft already in the input"]);
    assert!(wait_for_screen_text(
        &home,
        &worker.address,
        "draft already in the input"
    ));
    // Naming a wait with zero timeout still resolves to inbox admission in MCP.
    let admitted = tools.call(
        "send_message",
        json!({
            "to": worker.address, "text": "unwaited request",
            "wait_for": "delivery", "timeout_seconds": 0,
        }),
    );
    assert_eq!(admitted["status"], "success", "{admitted}");
    assert_eq!(
        admitted["data"]["delivery"], "waiting_in_inbox",
        "{admitted}"
    );
    let message = admitted["data"]["id"].as_str().unwrap();
    let waiting = tools.send(
        "tools/call",
        json!({ "name": "send_message", "arguments": {
            "to": worker.address, "text": "waited request",
            "wait_for": "delivery", "timeout_seconds": 30,
        } }),
    );
    // Reading the recipient's inbox would complete delivery. The daemon log confirms that the
    // second send was admitted, so ending the run exercises settlement of both messages.
    assert!(wait_until(secs(10), || home
        .daemon_log()
        .contains("#a1 sent m2 to #a2")));
    assert!(tools.answer(waiting, secs(0)).is_none());
    home.run_facade_ok(&["stop", &worker.address]);
    let failed = tools.tool_answer(waiting);
    assert_eq!(failed["status"], "failure", "{failed}");
    assert_eq!(failed["reason"], "ended", "{failed}");
    assert_ne!(failed["data"]["id"], message, "{failed}");
    assert!(
        wait_until(secs(8), || !notices(&home).is_empty()),
        "the admitted send {message} never reported its failure: {}",
        home.daemon_log()
    );
    assert!(!wait_until(secs(2), || notices(&home).len() > 1));
    let terminal = notices(&home);
    assert_eq!(terminal.len(), 1, "{terminal:?}");
    for fact in [message, &worker.address, "ended"] {
        assert!(terminal[0].contains(fact), "missing {fact:?}: {terminal:?}");
    }
    let rows = system_inbox(&mut tools);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(
        rows[0]["text"].as_str().unwrap().contains(message),
        "{rows:?}"
    );
}

#[test]
fn a_creator_stop_is_silent_and_another_agents_stop_reports_the_end_once() {
    let home = TestHome::new("notice-stops");
    let boss = home.start_named_fake("boss", &[]);
    let other = home.start_named_fake("other", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let mut stopper = McpTestClient::open(&home, &other.id);
    let owned = start_child(&home, &mut creator, "owned", None);
    let outside = start_child(&home, &mut creator, "outside", None);

    let stopped = creator.call("stop_agent", json!({ "agent": owned["id"] }));
    assert_eq!(stopped["status"], "success", "{stopped}");
    assert_eq!(stopped["data"]["state"], "ended", "{stopped}");
    let stopped = stopper.call("stop_agent", json!({ "agent": outside["id"] }));
    assert_eq!(stopped["status"], "success", "{stopped}");
    assert_eq!(stopped["data"]["state"], "ended", "{stopped}");
    assert!(
        wait_until(secs(8), || !notices(&home).is_empty()),
        "{}",
        home.daemon_log()
    );
    let repeated = stopper.call("stop_agent", json!({ "agent": outside["id"] }));
    assert_eq!(repeated["status"], "failure", "{repeated}");
    assert_eq!(repeated["reason"], "ended", "{repeated}");
    assert!(!wait_until(secs(2), || notices(&home).len() > 1));

    let terminal = notices(&home);
    assert_eq!(terminal.len(), 1, "{terminal:?}");
    let text = terminal[0].to_lowercase();
    assert!(
        text.contains(outside["id"].as_str().unwrap()),
        "{terminal:?}"
    );
    assert!(
        text.contains("stop") && text.contains("resum"),
        "{terminal:?}"
    );
    assert_eq!(system_inbox(&mut creator).len(), 1, "{terminal:?}");
    assert!(system_inbox(&mut stopper).is_empty());
}

const NOTICE_ENTER_WRITTEN: &str = "message-enter-written";

/// The first notice stays in the input even after its Enter reaches the CLI. `env` adds settings
/// for the fake CLI.
fn start_notice_recipient(home: &TestHome, env: &[(&str, &str)]) -> (TestAgent, PathBuf) {
    let keys = home.folder().join("creator-keys");
    let mut settings = vec![
        ("FAKECLI_IGNORE_FIRST_ENTER", "1"),
        ("FAKECLI_KEYS", keys.to_str().unwrap()),
    ];
    settings.extend_from_slice(env);
    let boss = home.start_named_fake("boss", &settings);
    (boss, keys)
}

fn wait_for_untaken_notice(home: &TestHome, keys: &Path) {
    home.wait_for_gate(NOTICE_ENTER_WRITTEN);
    // The actor pauses after the write. The CLI can read that Enter while the actor is paused.
    let paste_and_enter = b"\x1b[201~\r";
    assert!(
        wait_until(LOADED_TIMEOUT, || {
            std::fs::read(keys).is_ok_and(|bytes| {
                bytes
                    .windows(paste_and_enter.len())
                    .any(|part| part == paste_and_enter)
            })
        }),
        "the CLI did not read Enter after the notice paste"
    );
    assert!(
        notices(home).is_empty(),
        "the Enter left the notice in the input"
    );
}

/// A terminal caller can stop several children while the creator's CLI survives a crash.
/// An expired paste on that terminal must be cleared before the later notices are delivered.
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn an_expired_notice_paste_does_not_block_concurrent_end_notices_after_a_crash() {
    let home = TestHome::new("expired-end-notice");
    home.start_facade_with(&[("FACADE_TEST_GATES", NOTICE_ENTER_WRITTEN)]);
    let (boss, keys) = start_notice_recipient(&home, &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let first = start_child(&home, &mut creator, "first", None);
    let children: Vec<_> = (0..24)
        .map(|i| start_child(&home, &mut creator, &format!("child-{i}"), None))
        .collect();

    home.run_facade_ok(&["stop", first["id"].as_str().unwrap()]);
    wait_for_untaken_notice(&home, &keys);
    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    let old = home.kill_daemon();
    // A keeper that has reached its maximum backoff can leave a paste past its original deadline.
    std::thread::sleep(secs(30));
    resume_process(keeper);
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");

    let mut terminal = connect(&home);
    let stops: Vec<_> = children
        .iter()
        .map(|child| stop_from_terminal(&mut terminal, &child["id"]))
        .collect();
    for stop in stops {
        let response = terminal.wait_for_response(stop, LOADED_TIMEOUT).unwrap();
        assert_eq!(
            response["result"]["items"][0]["status"], "stopped",
            "{response}"
        );
    }
    assert!(
        wait_until(secs(30), || notices(&home).len() >= children.len()),
        "{} of {} later notices submitted; creator screen:\n{}",
        notices(&home).len(),
        children.len(),
        home.screen(&boss.address),
    );
    assert_end_notices(&home, &children);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let unread = creator.call("read_messages", json!({}));
    let messages = unread["data"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "{unread}");
    assert!(
        messages[0]["text"]
            .as_str()
            .unwrap()
            .contains(first["id"].as_str().unwrap())
    );
    assert_end_notices(&home, &children);
}

#[cfg(windows)]
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn an_expired_notice_is_cleared_when_the_recovered_cli_misses_the_resize_window() {
    let home = TestHome::new("expired-end-notice");
    home.start_facade_with(&[
        ("FACADE_TEST_GATES", NOTICE_ENTER_WRITTEN),
        ("FACADE_TEST_DELIVERY_MS", "6000"),
    ]);
    let size_log = home.folder().join("creator-size.log");
    let (boss, keys) =
        start_notice_recipient(&home, &[("FAKECLI_SIZE_LOG", size_log.to_str().unwrap())]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let first = start_child(&home, &mut creator, "first", None);
    let later = start_child(&home, &mut creator, "later", None);
    home.run_facade_ok(&["stop", first["id"].as_str().unwrap()]);
    wait_for_untaken_notice(&home, &keys);
    let (deadline, observed): (String, bool) = read_store(&home)
        .query_row(
            "SELECT deadline, length(paste_draft) = 32 FROM messages WHERE number = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(observed, "the first daemon stored the draft before Enter");

    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    pause_process(boss.pid);
    let old = home.kill_daemon();
    assert!(wait_until(LOADED_TIMEOUT, || facade_base::time::iso_now() >= deadline));
    resume_process(keeper);
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");
    let cleanup_proof = || {
        read_store(&home)
            .query_row(
                "SELECT substr(paste_draft, 33) FROM messages WHERE number = 1",
                [],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .unwrap()
    };
    assert!(wait_until(LOADED_TIMEOUT, || cleanup_proof().as_deref()
        == Some(&[1, 0, 0, 0, 0])));
    // Simulate a CLI that gets no turn during the short restart resize.
    std::thread::sleep(std::time::Duration::from_millis(600));
    assert_eq!(cleanup_proof().as_deref(), Some(&[1, 0, 0, 0, 0][..]));
    resume_process(boss.pid);
    assert!(
        wait_until(secs(6), || cleanup_proof().is_none()),
        "the expired draft remained in the composer; CLI sizes:\n{}\nscreen:\n{}",
        std::fs::read_to_string(&size_log).unwrap(),
        home.screen(&boss.address),
    );
    assert!(
        wait_until(secs(6), || {
            let sizes = std::fs::read_to_string(&size_log).unwrap();
            let original = sizes.lines().next();
            sizes.lines().any(|size| Some(size) != original) && sizes.lines().last() == original
        }),
        "the CLI should see the resize and return to its original size",
    );

    let mut terminal = connect(&home);
    let stop = stop_from_terminal(&mut terminal, &later["id"]);
    let response = terminal.wait_for_response(stop, LOADED_TIMEOUT).unwrap();
    assert_eq!(response["result"]["items"][0]["status"], "stopped");
    assert!(wait_until(secs(8), || notices(&home).len() == 1));
    assert_end_notices(&home, &[later]);
}

/// An already saved exit and an exit that happens while no daemon runs both owe a notice.
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn a_saved_exit_and_an_exit_during_a_crash_each_reach_the_creator_once() {
    let home = TestHome::new("end-notice-crash");
    home.start_facade_with(&[("FACADE_TEST_GATES", "before-end-notice-delivery")]);
    let boss = home.start_named_fake("boss", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let saved = start_child(&home, &mut creator, "saved", None);
    let offline = start_child(&home, &mut creator, "offline", None);
    let offline_pid = home.inspect_agent(offline["id"].as_str().unwrap())["agent"]["pid"]
        .as_i64()
        .unwrap() as i32;
    let offline_process = process_identity(offline_pid);

    home.run_facade_ok(&["stop", saved["id"].as_str().unwrap()]);
    home.wait_for_gate("before-end-notice-delivery");
    assert!(wait_until(LOADED_TIMEOUT, || exit_is_saved(
        &home,
        &saved["id"]
    )));
    assert!(notices(&home).is_empty());
    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    let old = home.kill_daemon();
    assert!(alive(&offline_process));
    kill_process(offline_pid);
    assert!(wait_until(LOADED_TIMEOUT, || !alive(&offline_process)));
    resume_process(keeper);
    let new = home
        .wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");

    let children = [saved, offline];
    assert!(
        wait_until(secs(8), || notices(&home).len() >= children.len()),
        "notices: {:?}\n{}",
        notices(&home),
        home.daemon_log(),
    );
    assert_end_notices(&home, &children);
    assert_eq!(home.kill_daemon(), new);
    home.wait_for_daemon_after(new, LOADED_TIMEOUT)
        .expect("the keeper starts a second replacement");
    home.run_facade_ok(&["send", &boss.address, "after recovery", "-w"]);
    assert_end_notices(&home, &children);
    let mut creator = McpTestClient::open(&home, &boss.id);
    assert_eq!(system_inbox(&mut creator).len(), children.len());
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses a debug hold on the submission key"
)]
fn a_person_can_replace_a_notice_draft_before_recovery_without_losing_their_paste() {
    recover_a_replaced_notice_draft(true);
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "uses a debug hold on the submission key"
)]
fn a_persons_replacement_paste_is_not_submitted_when_recovery_beats_the_deadline() {
    recover_a_replaced_notice_draft(false);
}

fn recover_a_replaced_notice_draft(expired: bool) {
    let home = TestHome::new("notice-draft-replaced");
    let budget_ms = if expired { "12000" } else { "29500" };
    home.start_facade_with(&[("FACADE_TEST_DELIVERY_MS", budget_ms)]);
    home.fault("hold-message-enter", "");
    let keys = home.folder().join("creator-keys");
    let boss = home.start_named_fake("boss", &[("FAKECLI_KEYS", keys.to_str().unwrap())]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    home.run_facade_ok(&["stop", child["id"].as_str().unwrap()]);
    assert!(wait_until(LOADED_TIMEOUT, || home
        .screen(&boss.address)
        .contains("[Pasted text #1 +1 lines]")));
    let draft_digest_size = || {
        read_store(&home)
            .query_row(
                "SELECT length(paste_draft) FROM messages WHERE \"from\" = 'facade'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .unwrap()
    };
    assert!(wait_until(LOADED_TIMEOUT, || draft_digest_size() == Some(32)));

    let mut terminal = connect(&home);
    type_raw(
        &mut terminal,
        &boss.address,
        "\x03\x1b[200~A person's first line.\nTheir second line stays here.\x1b[201~",
    );
    let replacement = "[Pasted text #2 +1 lines]";
    assert!(wait_until(LOADED_TIMEOUT, || home
        .screen(&boss.address)
        .contains(replacement)));
    assert_eq!(
        draft_digest_size(),
        None,
        "the person's keys revoke the saved observation"
    );
    let editing_keys = || {
        std::fs::read(&keys)
            .unwrap()
            .into_iter()
            .filter(|&key| key == b'\r' || key == 0x7f)
            .collect::<Vec<_>>()
    };
    let before = editing_keys();
    let pending: bool = read_store(&home)
        .query_row(
            "SELECT status = 'pending' FROM messages WHERE \"from\" = 'facade'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(pending, "the notice must still be pending at the crash");

    let keeper = home.lock_record("keeper").unwrap().0;
    if expired {
        pause_process(keeper);
    }
    let old = home.kill_daemon();
    std::fs::remove_file(home.path.join("framework/hold-message-enter")).unwrap();
    if expired {
        std::thread::sleep(secs(12));
        resume_process(keeper);
    }
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");
    if !expired {
        let time_left: bool = read_store(&home)
            .query_row(
                "SELECT deadline > ?1 FROM messages WHERE \"from\" = 'facade'",
                [facade_base::time::iso_now()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            time_left,
            "the replacement must start before the original deadline"
        );
    }
    assert!(wait_until(LOADED_TIMEOUT, || {
        read_store(&home)
            .query_row(
                "SELECT status != 'pending' FROM messages WHERE \"from\" = 'facade'",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
    }));
    assert_eq!(
        editing_keys(),
        before,
        "recovery sent Enter or Backspace into the person's paste"
    );
    assert!(home.screen(&boss.address).contains(replacement));
    assert!(notices(&home).is_empty());
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gates of debug builds")]
fn an_expired_notice_is_cleared_after_a_crash_before_the_first_backspace() {
    recover_notice_cleanup(CleanupCrash::BeforeWrite);
}

#[cfg(windows)]
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gates of debug builds")]
fn an_expired_notice_is_cleared_after_a_second_daemon_misses_the_first_resize() {
    recover_notice_cleanup(CleanupCrash::BeforeWriteMissesResize);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gates of debug builds")]
fn an_expired_notice_keeps_the_cleanup_receipt_across_a_second_crash() {
    recover_notice_cleanup(CleanupCrash::AfterWrite);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gates of debug builds")]
fn a_settled_notice_recovers_its_unfinished_cleanup_without_reopening_the_receipt() {
    recover_notice_cleanup(CleanupCrash::AfterSettlement);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn an_expired_combining_notice_clears_without_a_declared_delete_unit() {
    let home = TestHome::new("combining-notice-cleanup");
    home.start_facade_with(&[
        ("FACADE_TEST_GATES", NOTICE_ENTER_WRITTEN),
        ("FACADE_TEST_DELIVERY_MS", "12000"),
    ]);
    let (boss, keys) = start_notice_recipient(&home, &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let name = "helloe\u{301}";
    let child = start_child(&home, &mut creator, name, None);
    home.run_facade_ok(&["stop", child["id"].as_str().unwrap()]);
    wait_for_untaken_notice(&home, &keys);
    let proof: Vec<u8> = read_store(&home)
        .query_row(
            "SELECT paste_draft FROM messages WHERE number = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(proof.len(), 32);

    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    let old = home.kill_daemon();
    std::thread::sleep(secs(12));
    resume_process(keeper);
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");
    assert!(
        wait_until(secs(5), || {
            std::fs::read(&keys).unwrap().contains(&0x7f)
                && !home.screen(&boss.address).contains("[Pasted text #1")
        }),
        "the recovered notification's draft did not leave the composer"
    );
    home.run_facade_ok(&["send", &boss.address, "after combining cleanup", "-w"]);
    assert!(notices(&home).is_empty());
    let inbox = system_inbox(&mut McpTestClient::open(&home, &boss.id));
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0]["id"], "m1");
    assert!(inbox[0]["text"].as_str().unwrap().contains(name));
}

#[derive(PartialEq, Eq)]
enum CleanupCrash {
    BeforeWrite,
    BeforeWriteMissesResize,
    AfterWrite,
    AfterSettlement,
}

fn recover_notice_cleanup(crash: CleanupCrash) {
    let home = TestHome::new("notice-cleanup-crash");
    let already_written = crash == CleanupCrash::AfterWrite;
    let misses_resize = crash == CleanupCrash::BeforeWriteMissesResize;
    let gate = if already_written {
        "after-paste-cleanup-write"
    } else {
        "before-paste-cleanup"
    };
    let gates = format!("{NOTICE_ENTER_WRITTEN},{gate}");
    home.start_facade_with(&[
        ("FACADE_TEST_GATES", &gates),
        ("FACADE_TEST_DELIVERY_MS", "12000"),
    ]);
    let sizes = home.folder().join("creator-sizes");
    let (boss, keys) =
        start_notice_recipient(&home, &[("FAKECLI_SIZE_LOG", sizes.to_str().unwrap())]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    let later = misses_resize.then(|| start_child(&home, &mut creator, "later", None));
    home.run_facade_ok(&["stop", child["id"].as_str().unwrap()]);
    wait_for_untaken_notice(&home, &keys);
    if misses_resize {
        // Start with a durable cleanup plan for the observed paste, before any erase was issued.
        // This makes the first replacement enter the redraw path even if startup itself paints.
        let store = rusqlite::Connection::open(home.path.join("framework/facade.db")).unwrap();
        let mut proof: Vec<u8> = store
            .query_row(
                "SELECT paste_draft FROM messages WHERE number = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(proof.len(), 32);
        proof.extend_from_slice(&[1, 0, 0, 0, 0]);
        assert_eq!(
            store
                .execute(
                    "UPDATE messages SET paste_draft = ?1 WHERE number = 1",
                    [&proof]
                )
                .unwrap(),
            1,
        );
    }

    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    let first = home.kill_daemon();
    std::thread::sleep(secs(12));
    resume_process(keeper);
    home.wait_for_gate(gate);
    let backspaces = || {
        std::fs::read(&keys)
            .unwrap()
            .iter()
            .filter(|&&b| b == 0x7f)
            .count()
    };
    let written = if already_written {
        let evidence: Vec<u8> = read_store(&home)
            .query_row(
                "SELECT paste_draft FROM messages WHERE number = 1 AND \"from\" = 'facade'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(evidence.len(), 37);
        assert_eq!(evidence[32], 1, "the terminal acknowledged the write");
        let written = u32::from_le_bytes(evidence[33..].try_into().unwrap()) as usize;
        assert!(written > 0);
        assert!(wait_until(LOADED_TIMEOUT, || backspaces() >= written));
        assert_eq!(backspaces(), written);
        written
    } else {
        assert_eq!(backspaces(), 0);
        0
    };
    if crash == CleanupCrash::AfterSettlement {
        pause_process(keeper);
    }
    // A recovered actor can reach the gate before its daemon starts serving hello.
    let (old, _) = home
        .lock_record("daemon")
        .expect("the replacement holds the home");
    assert_ne!(old, first);
    if misses_resize {
        assert!(wait_until(LOADED_TIMEOUT, || {
            std::fs::read_to_string(&sizes).unwrap().lines().last() == Some("120x29")
        }));
        assert_eq!(backspaces(), 0, "the first resize preceded the first erase");
        pause_process(boss.pid);
    }
    kill_process(old);
    if crash == CleanupCrash::AfterSettlement {
        // Reproduce the durable receipt at a crash after its deadline, with the planned cleanup
        // still unissued. The real Keeper and the CLI retain their terminal across the restart.
        let store = rusqlite::Connection::open(home.path.join("framework/facade.db")).unwrap();
        store
            .execute(
                "UPDATE messages SET status = 'failure', reason = 'submission_unconfirmed', \
             text_written = 'unknown', enter_written = NULL, deadline = NULL \
             WHERE number = 1 AND \"from\" = 'facade' AND status = 'pending'",
                [],
            )
            .unwrap();
        let progress: Vec<u8> = store.query_row(
            "SELECT substr(paste_draft, 33) FROM messages WHERE number = 1 AND \"from\" = 'facade' \
             AND status = 'failure' AND reason = 'submission_unconfirmed' AND deadline IS NULL",
            [],
            |row| row.get(0),
        ).expect("the notice receipt settled while the cleanup is still planned");
        assert_eq!(progress, [1, 0, 0, 0, 0]);
        drop(store);
        resume_process(keeper);
    }
    let replacement = home.wait_for_daemon_after(old, LOADED_TIMEOUT);
    if misses_resize {
        // The CLI still remembers the first changed size when the second daemon starts.
        std::thread::sleep(std::time::Duration::from_millis(600));
        let proof: Vec<u8> = read_store(&home)
            .query_row(
                "SELECT substr(paste_draft, 33) FROM messages WHERE number = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            proof,
            [1, 0, 0, 0, 0],
            "old paint must authorize no erasure"
        );
        resume_process(boss.pid);
    }
    replacement.expect("the keeper starts a second replacement");
    let clear_timeout = if misses_resize {
        secs(6)
    } else {
        LOADED_TIMEOUT
    };
    assert!(
        wait_until(clear_timeout, || {
            backspaces() > 0 && !home.screen(&boss.address).contains("[Pasted text #1")
        }),
        "cleanup did not clear the composer; CLI sizes:\n{}\nscreen:\n{}",
        std::fs::read_to_string(&sizes).unwrap(),
        home.screen(&boss.address),
    );
    if crash == CleanupCrash::AfterSettlement {
        assert!(wait_until(LOADED_TIMEOUT, || read_store(&home)
            .query_row(
                "SELECT status = 'failure' AND enter_written IS NULL AND withdrawn = 0 \
             AND delivered_via IS NULL AND deadline IS NULL AND paste_draft IS NULL \
             FROM messages WHERE number = 1",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()));
    }
    home.run_facade_ok(&["send", &boss.address, "after cleanup", "-w"]);
    if already_written {
        assert_eq!(
            backspaces(),
            written,
            "the recovered actor replayed the erase"
        );
    }
    assert!(notices(&home).is_empty());
    let mut creator = McpTestClient::open(&home, &boss.id);
    if crash == CleanupCrash::AfterSettlement {
        let unread = creator.call("read_messages", json!({}));
        let messages = unread["data"]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1, "{unread}");
        assert_eq!(messages[0]["id"], "m1", "{unread}");
        let next_read = creator.call("read_messages", json!({}));
        assert_eq!(next_read["data"]["messages"], json!([]), "{next_read}");
    } else {
        assert_eq!(system_inbox(&mut creator)[0]["id"], "m1");
    }
    if let Some(later) = later {
        assert!(wait_until(LOADED_TIMEOUT, || {
            std::fs::read_to_string(&sizes).unwrap().lines().last() == Some("120x30")
        }));
        let mut terminal = connect(&home);
        let stop = stop_from_terminal(&mut terminal, &later["id"]);
        let response = terminal.wait_for_response(stop, LOADED_TIMEOUT).unwrap();
        assert_eq!(response["result"]["items"][0]["status"], "stopped");
        assert!(wait_until(LOADED_TIMEOUT, || notices(&home).len() == 1));
        assert_end_notices(&home, &[later]);
    }
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses a debug store fault")]
fn an_end_notice_is_not_sent_until_its_exit_is_saved() {
    let home = TestHome::new("unsaved-end-notice");
    home.start_facade_with(&[("FACADE_TEST_GATES", "exit-commit")]);
    let boss = home.start_named_fake("boss", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    home.fault("fail-exit-commit", "");
    home.run_facade_ok(&["stop", child["id"].as_str().unwrap()]);
    home.wait_for_gate("failed-exit-commit");
    let sent_before_commit = wait_until(secs(2), || !notices(&home).is_empty());

    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    let old = home.kill_daemon();
    std::fs::remove_file(home.path.join("framework/fail-exit-commit")).unwrap();
    resume_process(keeper);
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");
    assert!(wait_until(secs(8), || !notices(&home).is_empty()));
    assert!(!sent_before_commit, "notice submitted with no exit record");
    assert_end_notices(&home, &[child]);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn a_notice_that_expires_before_its_paste_can_still_be_read_once() {
    let home = TestHome::new("expired-unpasted-notice");
    home.start_facade_with(&[
        ("FACADE_TEST_GATES", "before-paste-begins"),
        ("FACADE_TEST_DELIVERY_MS", "6000"),
    ]);
    let boss = home.start_named_fake("boss", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    home.run_facade_ok(&["stop", child["id"].as_str().unwrap()]);
    home.wait_for_gate("before-paste-begins");
    let id = {
        let store = read_store(&home);
        store
            .query_row(
                "SELECT number FROM messages WHERE \"from\" = 'facade' AND paste IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };
    let keeper = home.lock_record("keeper").unwrap().0;
    pause_process(keeper);
    let old = home.kill_daemon();
    std::thread::sleep(secs(6));
    resume_process(keeper);
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");

    let mut creator = McpTestClient::open(&home, &boss.id);
    let unread = creator.call("read_messages", json!({}));
    let read = unread["data"]["messages"].as_array().unwrap();
    assert_eq!(read.len(), 1, "{unread}");
    assert_eq!(read[0]["id"], format!("m{id}"));
    assert!(
        read[0]["text"]
            .as_str()
            .unwrap()
            .contains(child["id"].as_str().unwrap())
    );
    let second = creator.call("read_messages", json!({}));
    assert_eq!(second["data"]["messages"], json!([]), "{second}");
    assert!(notices(&home).is_empty());
}

/// Creator attribution survives a daemon dying before it saves the child's exit.
#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test pause of debug builds")]
fn a_creator_stop_stays_silent_when_the_daemon_crashes_before_saving_it() {
    let home = TestHome::new("creator-stop-crash");
    home.start_facade_with(&[("FACADE_TEST_PAUSE_AT", "before-exit-commit")]);
    let boss = home.start_named_fake("boss", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    let old = home.lock_record("daemon").unwrap().0;
    creator.send(
        "tools/call",
        json!({ "name": "stop_agent", "arguments": { "agent": child["id"] } }),
    );
    assert!(wait_until(LOADED_TIMEOUT, || stopped(old)));
    kill_process(old);
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");

    assert_eq!(
        home.inspect_agent(child["id"].as_str().unwrap())["agent"]["process"],
        "ended"
    );
    assert!(
        !wait_until(secs(2), || !notices(&home).is_empty()),
        "{:?}",
        notices(&home)
    );
    let mut creator = McpTestClient::open(&home, &boss.id);
    assert!(system_inbox(&mut creator).is_empty());
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn a_creator_stop_accepted_by_the_keeper_is_silent_even_if_its_reply_is_lost() {
    let home = TestHome::new("stop-reply-lost");
    home.start_facade_with(&[("FACADE_TEST_GATES", "keeper-stop-accepted")]);
    let boss = home.start_named_fake("boss", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    creator.send(
        "tools/call",
        json!({ "name": "stop_agent", "arguments": { "agent": child["id"] } }),
    );
    home.wait_for_gate("keeper-stop-accepted");
    let old = home.kill_daemon();
    home.release_gate("keeper-stop-accepted");
    home.wait_for_daemon_after(old, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");
    assert!(wait_until(LOADED_TIMEOUT, || exit_is_saved(
        &home,
        &child["id"]
    )));
    let mut creator = McpTestClient::open(&home, &boss.id);
    assert!(system_inbox(&mut creator).is_empty());
    assert!(notices(&home).is_empty());
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gates of debug builds")]
fn a_creator_stop_of_an_adopted_resume_stays_silent_through_a_second_crash() {
    let home = TestHome::new("adopted-resume-stop");
    home.start_facade_with(&[(
        "FACADE_TEST_GATES",
        "before-restart-commit,keeper-stop-accepted",
    )]);
    let session = "86da4482-2bae-4a45-b193-a5664c19826a";
    // Both processes inherit the fake session ID. Give the child a distinct CLI rule so the
    // creator's active session does not block its resume.
    let bin = home.folder().join("programs");
    install_program(&bin, "codex", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        bin.display(),
        home.path_with_test_programs()
    );
    let started = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .env("FAKECLI_SESSION", session)
        .args(["start", "-d", "--name", "boss", "fake"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(started.status.success(), "{}", stderr(&started));
    let boss = home.started_agent(&stdout(&started));
    let mut creator = McpTestClient::open(&home, &boss.id);
    let started = creator.call(
        "start_agent",
        json!({ "name": "child", "cli": "codex", "folder": home.project }),
    );
    assert_eq!(started["status"], "success", "{started}");
    let child = &started["data"];
    let id = child["id"].as_str().unwrap();
    assert!(wait_until(LOADED_TIMEOUT, || {
        home.inspect_agent(id)["agent"]["session"] == session
    }));
    let original = home.inspect_agent(id)["agent"]["pid"].clone();
    type_raw(&mut connect(&home), id, "\x04");
    assert!(wait_until(LOADED_TIMEOUT, || exit_is_saved(
        &home,
        &child["id"]
    )));
    assert!(wait_until(LOADED_TIMEOUT, || notices(&home).len() == 1));

    let resuming = home
        .command(&test_binaries().facade)
        .env("PATH", &path)
        .args(["resume", "-d", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    home.wait_for_gate("before-restart-commit");
    let daemon = home.kill_daemon();
    let _ = resuming.wait_with_output();
    home.wait_for_daemon_after(daemon, LOADED_TIMEOUT)
        .expect("the keeper replaces the daemon and the new daemon adopts the resume");
    let adopted = home.inspect_agent(id);
    assert_eq!(adopted["agent"]["process"], "running", "{adopted}");
    assert_ne!(adopted["agent"]["pid"], original, "{adopted}");

    let mut creator = McpTestClient::open(&home, &boss.id);
    creator.send(
        "tools/call",
        json!({ "name": "stop_agent", "arguments": { "agent": id } }),
    );
    home.wait_for_gate("keeper-stop-accepted");
    let daemon = home.kill_daemon();
    home.release_gate("keeper-stop-accepted");
    home.wait_for_daemon_after(daemon, LOADED_TIMEOUT)
        .expect("the keeper replaces the daemon again");
    assert!(wait_until(LOADED_TIMEOUT, || exit_is_saved(
        &home,
        &child["id"]
    )));

    let mut creator = McpTestClient::open(&home, &boss.id);
    let inbox = system_inbox(&mut creator);
    assert_eq!(
        inbox.len(),
        1,
        "only the first run's exit is reported: {inbox:?}"
    );
    assert_eq!(notices(&home).len(), 1);
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "uses the test gate of debug builds")]
fn an_exit_before_keeper_accepts_a_creator_stop_still_reaches_the_creator() {
    let home = TestHome::new("unaccepted-creator-stop");
    home.start_facade_with(&[
        ("FACADE_TEST_GATES", "before-keeper-stop"),
        ("FACADE_TEST_PAUSE_AT", "before-exit-commit"),
    ]);
    let boss = home.start_named_fake("boss", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    let id = child["id"].as_str().unwrap();
    let pid = home.inspect_agent(id)["agent"]["pid"].as_i64().unwrap() as i32;
    let process = process_identity(pid);
    let daemon = home.lock_record("daemon").unwrap().0;
    creator.send(
        "tools/call",
        json!({ "name": "stop_agent", "arguments": { "agent": id } }),
    );
    home.wait_for_gate("before-keeper-stop");
    assert!(alive(&process));
    kill_process(pid);
    assert!(wait_until(LOADED_TIMEOUT, || stopped(daemon)));
    assert!(!exit_is_saved(&home, &child["id"]));
    kill_process(daemon);
    home.wait_for_daemon_after(daemon, LOADED_TIMEOUT)
        .expect("the keeper starts a replacement");
    assert!(wait_until(LOADED_TIMEOUT, || exit_is_saved(
        &home,
        &child["id"]
    )));
    let count: i64 = read_store(&home)
        .query_row(
            "SELECT count(*) FROM messages WHERE \"from\" = 'facade' AND instr(text, ?1) > 0",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "the external exit owes one durable notice");
}

#[test]
#[ignore = "requires a real v6 facade binary in FACADE_TEST_V6_FACADE"]
fn a_new_daemon_saves_an_old_keepers_acknowledged_creator_stop() {
    exercise_mixed_keeper(true);
}

#[test]
#[ignore = "requires a real v6 facade binary in FACADE_TEST_V6_FACADE"]
fn an_old_daemon_can_stop_its_agent_through_a_new_keeper() {
    exercise_mixed_keeper(false);
}

fn exercise_mixed_keeper(new_daemon: bool) {
    let old = PathBuf::from(
        std::env::var_os("FACADE_TEST_V6_FACADE").expect("an independently compiled v6 binary"),
    );
    assert!(old.is_absolute() && old.is_file(), "{}", old.display());
    let current = &test_binaries().facade;
    let (daemon_program, keeper_program) = if new_daemon {
        (current, &old)
    } else {
        (&old, current)
    };
    let home = TestHome::new("mixed-creator-stop");
    let installed = home
        .command(daemon_program)
        .args(["daemon", "--install-only"])
        .output()
        .unwrap();
    assert!(installed.status.success(), "{}", stderr(&installed));
    let mut keeper = spawn_mixed_service(&home, keeper_program, "keeper", false);
    let mut daemon = spawn_mixed_service(&home, daemon_program, "daemon", new_daemon);
    assert!(
        wait_until(LOADED_TIMEOUT, || home.hello_result().is_some()),
        "{}",
        home.daemon_log()
    );

    let boss = home.start_named_fake("boss", &[]);
    let mut creator = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut creator, "child", None);
    let id = child["id"].as_str().unwrap().split_once('@').unwrap().0;
    creator.send(
        "tools/call",
        json!({ "name": "stop_agent", "arguments": { "agent": child["id"] } }),
    );
    if new_daemon {
        assert!(wait_until(LOADED_TIMEOUT, || stopped(daemon.id() as i32)));
        let accepted: bool = read_store(&home)
            .query_row(
                "SELECT creator_stop LIKE 'accepted:%' AND exit_at IS NULL FROM agents WHERE agent_id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(accepted, "the old Keeper's successful stop was saved");
        resume_process(daemon.id() as i32);
    }
    assert!(wait_until(LOADED_TIMEOUT, || exit_is_saved(
        &home,
        &child["id"]
    )));
    assert!(system_inbox(&mut creator).is_empty());
    assert!(notices(&home).is_empty());
    assert!(
        !home
            .path
            .join("framework/runs")
            .join(id)
            .join("creator-stop")
            .exists()
    );
    assert_eq!(home.lock_record("keeper").unwrap().0, keeper.id() as i32);
    assert_eq!(home.lock_record("daemon").unwrap().0, daemon.id() as i32);
    drop(creator);
    home.kill_home_processes();
    daemon.wait().unwrap();
    keeper.wait().unwrap();
}

fn spawn_mixed_service(
    home: &TestHome,
    program: &Path,
    kind: &str,
    pause: bool,
) -> std::process::Child {
    let errors = std::fs::File::create(home.folder().join(format!("mixed-{kind}.log"))).unwrap();
    let mut command = home.command(program);
    command
        .arg(kind)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(errors);
    if pause {
        command.env("FACADE_TEST_PAUSE_AT", "before-exit-commit");
    }
    let child = command.spawn().unwrap();
    assert!(
        wait_until(LOADED_TIMEOUT, || home
            .lock_record(kind)
            .is_some_and(|(pid, _)| pid == child.id() as i32)),
        "{} did not start {kind}",
        program.display()
    );
    child
}

fn stop_from_terminal(terminal: &mut DaemonTestClient, target: &Value) -> u64 {
    terminal.send(
        "call",
        json!({ "op": "agent.stop", "args": {
            "selection": { "kind": "targets", "targets": [target] },
        }}),
    )
}

fn assert_end_notices(home: &TestHome, children: &[Value]) {
    let submitted = notices(home);
    assert_eq!(submitted.len(), children.len(), "{submitted:?}");
    for child in children {
        let address = format!("({})", child["id"].as_str().unwrap());
        let count = submitted
            .iter()
            .filter(|notice| notice.contains(&address))
            .count();
        assert_eq!(count, 1, "{address}: {submitted:?}");
    }
}

fn exit_is_saved(home: &TestHome, address: &Value) -> bool {
    let id = address.as_str().unwrap().split_once('@').unwrap().0;
    read_store(home)
        .query_row(
            "SELECT exit_at IS NOT NULL FROM agents WHERE agent_id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn read_store(home: &TestHome) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(
        home.path.join("framework/facade.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}

#[test]
fn a_continuous_error_reports_again_only_after_recovery_and_30_more_seconds() {
    let home = TestHome::new("notice-errors");
    let boss = home.start_named_fake("boss", &[("FAKECLI_STATUS", "1")]);
    let mut tools = McpTestClient::open(&home, &boss.id);
    let child = start_child(&home, &mut tools, "child", None);
    let address = child["id"].as_str().unwrap();
    reaches(&home, "child", "idle");

    for (incident, marker) in ["out of credits", "service unavailable"]
        .into_iter()
        .enumerate()
    {
        let since = Instant::now();
        submit(&home, address, &format!("/fake error {marker}"));
        let error = reaches(&home, "child", "error");
        assert_eq!(error["state_detail"]["text"], marker, "{error}");
        assert!(
            wait_until(secs(40), || notices(&home).len() > incident),
            "error {marker:?} never reported: {}",
            home.daemon_log()
        );
        let terminal = notices(&home);
        assert!(
            since.elapsed() >= secs(30),
            "reported too soon: {terminal:?}"
        );
        assert_eq!(terminal.len(), incident + 1, "{terminal:?}");
        for fact in [address, marker] {
            assert!(
                terminal[incident].contains(fact),
                "missing {fact:?}: {terminal:?}"
            );
        }
        if incident == 0 {
            // Leave the error unchanged through another entire watchdog interval.
            assert!(!wait_until(secs(31), || notices(&home).len() > 1));
            submit(&home, address, "/fake clear");
            reaches(&home, "child", "unknown");
        }
    }
    assert_eq!(system_inbox(&mut tools).len(), 2, "{:?}", notices(&home));
}

#[test]
fn codex_uses_tab_only_for_an_ordinary_delivery_while_working() {
    let home = TestHome::new("notice-codex-input");
    let bin = home.folder().join("programs");
    install_program(&bin, "codex", &test_binaries().fakecli);
    let path = format!(
        "{}{PATH_SEPARATOR}{}",
        bin.display(),
        home.path_with_test_programs()
    );
    let keys = home.folder().join("codex-keys");
    let relay = home
        .path
        .join("framework/bin")
        .join(program_name("facade-mcp"));
    let started = home.start_with_prompt(
        "codex",
        "codex",
        "first instruction",
        &[
            ("PATH", &path),
            ("FAKECLI_CODEX_INPUT", "working"),
            ("FAKECLI_STATUS", "1"),
            ("FAKECLI_TURN_MS", "600000"),
            ("FAKECLI_MCP_DELAY_MS", "2500"),
            ("FAKECLI_MCP", relay.to_str().unwrap()),
            ("FAKECLI_KEYS", keys.to_str().unwrap()),
        ],
    );
    assert!(started["result"].is_object(), "{started}");
    reaches(&home, "codex", "working");
    let submitted = |text: &str| {
        wait_until(LOADED_TIMEOUT, || {
            home.submitted_messages()
                .iter()
                .any(|line| line.ends_with(text))
        })
    };
    let submission_keys = || {
        let bytes = std::fs::read(&keys).unwrap();
        // Count the keys outside bracketed pastes. On Windows a pasted newline can arrive as CR.
        String::from_utf8_lossy(&bytes)
            .split("\x1b[200~")
            .flat_map(|part| part.rsplit("\x1b[201~").next().unwrap().bytes())
            .filter(|byte| matches!(byte, b'\r' | b'\t'))
            .collect::<Vec<_>>()
    };
    assert!(submitted("\nfirst instruction"), "{}", home.daemon_log());
    assert_eq!(submission_keys(), b"\r", "the first prompt uses Enter");

    let delivered = home.run_facade_ok(&["send", "codex", "queue while working", "-w"]);
    assert!(delivered.contains("Delivered"), "{delivered}");
    assert!(submitted("\nqueue while working "));
    assert_eq!(
        submission_keys(),
        b"\r\t",
        "an ordinary Working send uses Tab"
    );

    reaches(&home, "codex", "working");
    submit(&home, "codex", "/fake status idle");
    assert!(submitted("/fake status idle"));
    assert_eq!(submission_keys(), b"\r\t\r", "manual Enter while Working");
    assert!(wait_until(LOADED_TIMEOUT, || {
        let agent = home.agent_from_watch("codex").unwrap();
        matches!(agent["state"].as_str(), Some("idle" | "just_done"))
    }));
    let delivered = home.run_facade_ok(&["send", "codex", "send at rest", "-w"]);
    assert!(delivered.contains("Delivered"), "{delivered}");
    assert!(submitted("\nsend at rest "));
    assert_eq!(
        submission_keys(),
        b"\r\t\r\r",
        "an ordinary resting send uses Enter"
    );
}
