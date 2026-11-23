//! Asynchronous Facade notices observed in a managed agent's terminal and inbox.

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
    let reserved = started["result_message"].as_str().unwrap();
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
    for fact in [
        address,
        reserved,
        "initial message",
        "permission",
        "read_screen",
    ] {
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
    assert_eq!(rows[0]["id"], reserved, "{rows:?}");
    let text = rows[0]["text"].as_str().unwrap();
    for fact in [address, "initial message", "permission", "read_screen"] {
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
    let relay = home.path.join("core/bin").join(program_name("facade-mcp"));
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
    assert!(submitted("\nqueue while working"));
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
    assert!(submitted("\nsend at rest"));
    assert_eq!(
        submission_keys(),
        b"\r\t\r\r",
        "an ordinary resting send uses Enter"
    );
}
