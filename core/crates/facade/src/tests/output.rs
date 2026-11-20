//! The words and structured output of the terminal commands.

use facade_base::v3::{AgentListResult, AgentListRow, SendResult, StatusResult};
use serde_json::{Value, json};

use super::{agent, before, inspection, now};
use crate::commands::{
    Inspection, age, agent_list_json, list_text, quiet_text, sent, sleeping_text, state_words,
    status_text,
};
use crate::table;

/// Remove the last column's padding from each line.
fn trimmed(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn agent_list_json_projects_the_daemons_public_rows_and_machine_states() {
    let rows = json!([{
        "id": "a3@peer", "name": "Pixel", "type": "managed",
        "state": "working", "cli": "claude", "title": "Review",
        "folder": "/work/site", "started_at": before(60),
    }]);
    let mut wire_rows = rows.clone();
    wire_rows[0]["reference"] = json!({ "agent_id": "a3", "machine_id": "peer-id" });

    for (state, status) in [
        ("online", "answered"),
        ("online", "timed_out"),
        ("online", "error"),
        ("connecting", "unavailable"),
        ("sleeping", "unavailable"),
        ("unreachable", "unavailable"),
        ("ssh_interaction_required", "unavailable"),
    ] {
        let mut machine = json!({
            "machine_id": "401b070c-c174-4c94-abb1-cd1efda7a62b",
            "short_id": "401b070c",
            "name": "peer",
            "selector": "peer",
            "state": state,
            "status": status,
        });
        if state == "online" {
            machine["build"] = json!("0.1.6+test");
        } else {
            machine["last_seen"] = json!(before(60));
        }
        if state == "unreachable" || state == "ssh_interaction_required" {
            machine["ssh_error"] = json!("Could not connect");
        }
        let wire = json!({ "agents": wire_rows, "machines": [machine] });
        let list: AgentListResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&list).unwrap(), wire);
        assert_eq!(
            agent_list_json(&list).unwrap(),
            json!({ "agents": rows, "machines": [machine] })
        );
    }
}

#[test]
fn a_table_pads_each_column_to_its_widest_cell_and_keeps_each_row_on_one_line() {
    let rows = vec![
        vec!["a3".to_string(), "Pixel".to_string(), "working".to_string()],
        vec![
            "a10".to_string(),
            "名前".to_string(),
            "waiting for you: question".to_string(),
        ],
        vec![
            "a4".to_string(),
            "two\nlines".to_string(),
            "idle\u{1b}".to_string(),
        ],
    ];
    assert_eq!(
        trimmed(&table(&["ID", "NAME", "STATE"], &rows)),
        "ID    NAME        STATE\n\
         a3    Pixel       working\n\
         a10   名前        waiting for you: question\n\
         a4    two lines   idle"
    );
}

#[test]
fn age_uses_whole_minutes_hours_or_days() {
    for (seconds, words) in [
        (12, "0m"),
        (61, "1m"),
        (5 * 60 + 10, "5m"),
        (60 * 60 + 5, "1h"),
        (3 * 3600 + 300, "3h"),
        (2 * 86400 + 3600, "2d"),
        (21 * 86400 + 3600, "21d"),
    ] {
        assert_eq!(age(&before(seconds), now()), words, "{seconds} seconds");
    }
}

#[test]
fn every_state_has_its_words() {
    let ended = |exit: Value, how: &str| json!({ "process": "ended", "state": "ended", "exit": exit, "state_detail": { "how": how } });
    let at = before(60);
    for (changes, words) in [
        (json!({ "state": "starting" }), "starting"),
        (json!({ "state": "working" }), "working"),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "permission", "text": "Run it?" } }),
            "waiting for you: permission",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "question" } }),
            "waiting for you: question",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "auth" } }),
            "waiting for you: sign-in",
        ),
        (
            json!({ "state": "waiting_for_you", "state_detail": { "kind": "unknown" } }),
            "waiting for you",
        ),
        (json!({ "state": "just_done" }), "turn finished"),
        (json!({ "state": "idle" }), "idle"),
        (
            json!({ "state": "error", "state_detail": { "text": "Out of credits" } }),
            "error",
        ),
        (ended(json!({ "code": 0, "at": at }), "stopped"), "stopped"),
        (
            ended(json!({ "code": 0, "at": at }), "normal"),
            "exited: code 0",
        ),
        (
            ended(json!({ "code": 3, "at": at }), "crashed"),
            "exited: code 3",
        ),
        (
            ended(json!({ "signal": "SIGKILL", "at": at }), "crashed"),
            "ended by SIGKILL",
        ),
        (
            ended(json!({ "reason": "terminal_closed", "at": at }), "unknown"),
            "ended",
        ),
        (json!({ "state": "unknown" }), "unknown"),
        (json!({ "type": "guest", "state": "online" }), "online"),
    ] {
        assert_eq!(state_words(&agent(changes.clone())), words, "{changes}");
    }
}

#[test]
fn the_list_is_one_row_per_agent_and_quiet_prints_addresses() {
    let title = "A title with forty visible characters and some more";
    let rows: Vec<AgentListRow> = serde_json::from_value(json!([
        {
            "id": "a5@laptop", "name": "Visor", "type": "guest", "state": "online",
            "cli": "cursor", "folder": "/work/site", "started_at": before(60),
        },
        {
            "id": "a3@devbox", "name": "Pixel", "type": "managed", "state": "working",
            "cli": "claude", "title": title, "folder": "/work/site", "started_at": before(120),
        },
        {
            "id": "a4@devbox", "name": "Ada", "type": "managed", "state": "waiting_for_you",
            "cli": "codex", "folder": "/work/site", "started_at": before(300),
        },
    ]))
    .unwrap();
    let rows: Vec<&AgentListRow> = rows.iter().collect();
    assert_eq!(
        trimmed(&list_text(&rows, now())),
        "ID          NAME    TYPE      STATE             CLI      TITLE                                      FOLDER       AGE\n\
         a5@laptop   Visor   guest     online            cursor   -                                          /work/site   1m\n\
         a3@devbox   Pixel   managed   working           claude   A title with forty visible characters a…   /work/site   2m\n\
         a4@devbox   Ada     managed   waiting_for_you   codex    -                                          /work/site   5m"
    );
    assert_eq!(quiet_text(&rows), "a5@laptop\na3@devbox\na4@devbox");
}

/// The value after a field's label.
fn field(text: &str, label: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix(label)?.strip_prefix(':'))
        .map(|value| value.trim().to_string())
}

#[test]
fn inspect_shows_the_same_facts_in_text_and_json() {
    let pixel = agent(json!({
        "cwd": "D:\\apps\\facadecode",
        "state": "waiting_for_you",
        "state_detail": { "kind": "permission", "text": "Allow the build?" },
        "args": ["--flag", "two words"],
        "model": "sonnet",
        "effort": "high",
        "session": "86da4482-2bae-4a45-b193-a5664c19826a",
        "yolo": true,
    }));
    let inspected = inspection(
        &pixel,
        Some("claude"),
        &["Terminal on laptop", "VS Code"],
        Some(json!({ "kind": "command_line" })),
    );
    let output = Inspection::from(&inspected);
    let detail = "waiting for you: permission (Allow the build?)";
    let text = output.text();
    let fields = [
        ("ID", "a3@laptop"),
        ("Name", "Pixel"),
        ("Type", "managed"),
        ("State", detail),
        ("Machine", "laptop"),
        ("CLI", "claude"),
        ("Folder", "D:\\apps\\facadecode"),
        ("Args", r#"["--flag","two words"]"#),
        ("Model", "sonnet"),
        ("Effort", "high"),
        ("Session", "86da4482-2bae-4a45-b193-a5664c19826a"),
        ("Started by", "command line"),
        ("Viewers", "Terminal on laptop, VS Code"),
        ("YOLO", "on"),
    ];
    assert_eq!(text.lines().count(), fields.len());
    for (label, expected) in fields {
        assert_eq!(field(&text, label).as_deref(), Some(expected), "{text}");
    }
    assert_eq!(
        serde_json::to_value(&output).unwrap(),
        json!({
            "id": "a3@laptop", "name": "Pixel", "type": "managed",
            "state": "waiting_for_you", "state_detail": detail, "machine": "laptop",
            "cli": "claude", "custom_program": false, "folder": "D:\\apps\\facadecode",
            "args": ["--flag", "two words"], "model": "sonnet", "effort": "high",
            "session": "86da4482-2bae-4a45-b193-a5664c19826a",
            "started_by": { "kind": "command_line" },
            "viewers": ["Terminal on laptop", "VS Code"],
            "yolo": true,
        })
    );
}

#[test]
fn inspect_describes_custom_programs_guests_and_ended_agents() {
    let shown = |changes: Value, rule: Option<&str>, started_by: Option<Value>| {
        Inspection::from(&inspection(&agent(changes), rule, &[], started_by)).text()
    };
    let added = shown(
        json!({
            "cli": "fake work", "creator": "a2", "yolo": true
        }),
        Some("claude"),
        Some(json!({ "kind": "agent", "address": "a2@devbox" })),
    );
    assert_eq!(field(&added, "CLI").as_deref(), Some("fake work"));
    assert_eq!(field(&added, "Started by").as_deref(), Some("a2@devbox"));
    assert_eq!(field(&added, "YOLO").as_deref(), Some("on"));
    assert_eq!(field(&added, "Session").as_deref(), Some("none"));

    let custom = shown(
        json!({ "cli": "build tool" }),
        None,
        Some(json!({ "kind": "vs_code" })),
    );
    assert_eq!(
        field(&custom, "CLI").as_deref(),
        Some("build tool (custom program)")
    );
    assert_eq!(field(&custom, "Started by").as_deref(), Some("VS Code"));
    assert_eq!(field(&custom, "Session").as_deref(), Some("none"));

    let guest = shown(
        json!({
            "type": "guest", "cli": "cursor", "state": "online",
            "pid": null, "cols": null, "rows": null,
        }),
        None,
        None,
    );
    assert_eq!(field(&guest, "Type").as_deref(), Some("guest"));
    assert_eq!(field(&guest, "CLI").as_deref(), Some("cursor"));
    assert_eq!(field(&guest, "Started by").as_deref(), Some("none"));

    let ended = shown(
        json!({
            "process": "ended", "state": "ended", "state_detail": { "how": "normal" },
            "exit": { "code": 0, "at": before(60) },
        }),
        Some("claude"),
        None,
    );
    assert_eq!(field(&ended, "State").as_deref(), Some("exited: code 0"));
}

#[test]
fn status_shows_settings_services_and_connected_machines() {
    let (home, settings, build) = (
        "/home/you/.facade",
        "/home/you/.facade/facade.json",
        "0.1.6+abc",
    );
    let mut status: StatusResult = serde_json::from_value(json!({
        "home": home,
        "settings_file": settings,
        "build": build,
        "daemon_pid": 16968,
        "keeper_pid": 16752,
        "agents": 12,
        "machines": [
            { "machine_id": "peer-id", "short_id": "peer", "name": "peer",
              "selector": "peer", "state": "online", "status": "answered" },
            { "machine_id": "dim-id", "short_id": "dim", "name": "dim",
              "selector": "dim", "state": "sleeping", "status": "unavailable" },
        ],
    }))
    .unwrap();
    assert_eq!(
        status_text(&status, build),
        "Orchestrator running.\n  Home:      /home/you/.facade\n  Settings:  /home/you/.facade/facade.json\n  Version:   0.1.6\n  Daemon:    pid 16968\n  Keeper:    pid 16752\n  Agents:    12\n  Machines:  peer"
    );
    status.build = "0.1.5".into();
    status.keeper_pid = None;
    assert_eq!(
        status_text(&status, build),
        "Orchestrator running.\n  Home:      /home/you/.facade\n  Settings:  /home/you/.facade/facade.json\n  Version:   0.1.5\n  Daemon:    pid 16968 (0.1.5)\n  Keeper:    none\n  Agents:    12\n  Machines:  peer"
    );
    assert_eq!(
        sleeping_text(home, settings, "0.1.6"),
        "Orchestrator sleeping.\n  Home:      /home/you/.facade\n  Settings:  /home/you/.facade/facade.json\n  Version:   0.1.6"
    );
}

fn receipt(delivery: Value) -> SendResult {
    serde_json::from_value(json!({
        "id": "m42@peer",
        "message": {
            "message_id": "m42", "from": "command_line", "to": "a3", "text": "hi",
            "at": before(1), "delivery": delivery,
        },
    }))
    .expect("a valid send result")
}

#[test]
fn a_send_only_prints_the_daemons_address_after_delivery() {
    for via in ["terminal", "read"] {
        let result = receipt(json!({
            "status": "success", "text_written": "full", "delivered_via": via
        }));
        assert_eq!(sent(result, "a3@peer").unwrap(), "m42@peer");
    }
    let waiting = sent(
        receipt(json!({ "status": "pending", "text_written": "none" })),
        "a3@peer",
    )
    .expect_err("a pending delivery has no successful receipt")
    .to_string();
    assert!(
        waiting.starts_with("error: m42@peer was not delivered to a3@peer: "),
        "{waiting}"
    );
    let unconfirmed = sent(
        receipt(json!({
            "status": "failure", "reason": "submission_unconfirmed", "text_written": "full",
            "enter_written": true,
        })),
        "a3@peer",
    )
    .expect_err("an unconfirmed delivery fails")
    .to_string();
    assert!(
        unconfirmed.starts_with("error: could not confirm delivery of m42@peer to a3@peer")
            && unconfirmed.ends_with(
                "\n  tip: run 'facade screen a3@peer' and look for m42@peer in the input box or recent \
                 output before sending it again"
            ),
        "{unconfirmed}"
    );
    let failed = sent(
        receipt(json!({
            "status": "failure", "reason": "input_draft", "text_written": "none"
        })),
        "a3@peer",
    )
    .expect_err("a held message fails")
    .to_string();
    assert!(
        failed.starts_with("error: m42@peer was not delivered to a3@peer: ")
            && failed.contains("a draft held a3@peer's input")
            && !failed.contains('\n'),
        "{failed}"
    );
}
